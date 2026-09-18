//! WebAssembly pixel kernels: a registry of image operations that mirror the
//! everyday Photoshop retouch / After Effects compositing vocabulary.
//!
//! ABI is deliberately tiny so the JS side stays generated from data:
//!   kernel_count() -> i32
//!   kernel_names(buf, cap) -> i32        // '\0'-joined, in registry order
//!   kernel_class(buf, cap) -> i32        // same order, "point" | "area" | "blend"
//!   process(id, rgba, len, w, h, params, n) -> i32
//!
//! `rgba` is in-place RGBA8. `params` is f32. Area kernels need width/height;
//! point kernels ignore them. Returns 0 on success, negative on bad input.
//!
//! No allocation happens anywhere: area kernels use a fixed scratch window, so a
//! single wasm linear memory is enough and there is no allocator dependency.

const MAX_SIDE: usize = 4096;

#[inline]
fn clamp255(v: f32) -> u8 {
    if v <= 0.0 { 0 } else if v >= 255.0 { 255 } else { v + 0.5 } as u8
}

#[inline]
fn luma(r: u8, g: u8, b: u8) -> f32 {
    0.2126 * r as f32 + 0.7152 * g as f32 + 0.0722 * b as f32
}

/// The W3C compositing blend functions, one per channel, normalised to 0..=1.
fn blend(mode: u8, cb: f32, cs: f32) -> f32 {
    let (x, y) = (cb.clamp(0.0, 1.0), cs.clamp(0.0, 1.0));
    match mode {
        0 => x * y,                                     // multiply
        1 => x + y - x * y,                             // screen
        2 => if y <= 0.5 { 2.0 * x * y } else { 1.0 - 2.0 * (1.0 - x) * (1.0 - y) }, // overlay
        3 => x.min(y),                                  // darken
        4 => x.max(y),                                  // lighten
        5 => if y >= 1.0 { 1.0 } else { (x / (1.0 - y)).min(1.0) },        // color-dodge
        6 => if x <= 0.0 { 0.0 } else { 1.0 - ((1.0 - y) / x).min(1.0) }, // color-burn
        7 => if y <= 0.5 { 2.0 * x * y } else { 1.0 - 2.0 * (1.0 - x) * y }, // hard-light
        8 => {
            // soft-light (W3C)
            let q = if x <= 0.25 { ((16.0 * x - 12.0) * x + 4.0) * x } else { x.sqrt() };
            if y <= 0.5 { x - (1.0 - 2.0 * y) * x * (1.0 - x) } else { x + (2.0 * y - 1.0) * (q - x) }
        }
        9 => (x - y).abs(),                             // difference
        10 => x + y - 2.0 * x * y,                      // exclusion
        11 => x + y,                                    // plus-lighter
        12 => if y > 0.5 { 1.0 - 2.0 * (1.0 - x) * (1.0 - y) } else { 2.0 * x * y }, // pin-light
        13 => if y <= 0.5 { x * (2.0 * y) } else { x + (2.0 * y - 1.0) * (1.0 - x) }, // vivid-ish
        14 => (2.0 * x * y).min(1.0),                   // hard-mix approximation
        15 => 0.5 * (x + y),                            // average
        16 => (x + y - 0.5).max(0.0).min(1.0),          // linear-light
        17 => x * y / (1.0 - (1.0 - x) * (1.0 - y)).max(1e-6), // division-safe screen variant
        _ => x * y,
    }
}

#[inline]
fn hsl_to_rgb(h: f32, s: f32, l: f32) -> (f32, f32, f32) {
    fn hue(p: f32, q: f32, mut t: f32) -> f32 {
        if t < 0.0 { t += 1.0 }
        if t > 1.0 { t -= 1.0 }
        if t < 1.0 / 6.0 { return p + (q - p) * 6.0 * t }
        if t < 1.0 / 2.0 { return q }
        if t < 2.0 / 3.0 { return p + (q - p) * (2.0 / 3.0 - t) * 6.0 }
        p
    }
    if s <= 0.0 { return (l, l, l) }
    let q = if l < 0.5 { l * (1.0 + s) } else { l + s - l * s };
    let p = 2.0 * l - q;
    (hue(p, q, h + 1.0 / 3.0), hue(p, q, h), hue(p, q, h - 1.0 / 3.0))
}

#[inline]
fn rgb_to_hsl(r: f32, g: f32, b: f32) -> (f32, f32, f32) {
    let (mx, mn) = (r.max(g).max(b), r.min(g).min(b));
    let l = (mx + mn) * 0.5;
    if mx == mn { return (0.0, 0.0, l) }
    let d = mx - mn;
    let s = if l > 0.5 { d / (2.0 - mx - mn) } else { d / (mx + mn) };
    let h = if mx == r { (g - b) / d + if g < b { 6.0 } else { 0.0 } }
        else if mx == g { (b - r) / d + 2.0 }
        else { (r - g) / d + 4.0 };
    (h / 6.0, s, l)
}

#[derive(Clone, Copy)]
pub struct Def {
    pub name: &'static str,
    pub class: &'static str,
    pub category: &'static str,
    pub analogue: &'static str,
}

/// Registry order is part of the ABI: the JS side indexes by these ids.
pub const KERNELS: &[Def] = &[
    Def { name: "identity", class: "point", category: "tone", analogue: "no-op" },
    Def { name: "invert", class: "point", category: "tone", analogue: "PS Image > Adjustments > Invert" },
    Def { name: "grayscale_luma", class: "point", category: "tone", analogue: "PS Desaturate (Ctrl+Shift+U)" },
    Def { name: "grayscale_luminosity", class: "point", category: "tone", analogue: "PS Channel Mixer, monochrome" },
    Def { name: "sepia", class: "point", category: "tone", analogue: "PS Photo Filter > Sepia" },
    Def { name: "brightness", class: "point", category: "tone", analogue: "PS Brightness/Contrast" },
    Def { name: "contrast", class: "point", category: "tone", analogue: "PS Brightness/Contrast" },
    Def { name: "brightness_contrast", class: "point", category: "tone", analogue: "PS Brightness/Contrast (both)" },
    Def { name: "exposure", class: "point", category: "tone", analogue: "PS Exposure (EV)" },
    Def { name: "gamma", class: "point", category: "tone", analogue: "PS Curves, midtone" },
    Def { name: "levels", class: "point", category: "tone", analogue: "PS Levels" },
    Def { name: "levels_rgb", class: "point", category: "tone", analogue: "PS Levels, per channel" },
    Def { name: "lut_rgb", class: "point", category: "tone", analogue: "PS Curves baked to a LUT" },
    Def { name: "posterize", class: "point", category: "tone", analogue: "PS Posterize" },
    Def { name: "threshold", class: "point", category: "binary", analogue: "PS Threshold" },
    Def { name: "solarize", class: "point", category: "tone", analogue: "PS Solarize" },
    Def { name: "equalize", class: "point", category: "tone", analogue: "PS Auto Tone / Equalize" },
    Def { name: "normalize_stretch", class: "point", category: "tone", analogue: "PS Levels, min/max auto" },
    Def { name: "hue_rotate", class: "point", category: "colour", analogue: "PS Hue/Saturation, hue" },
    Def { name: "saturate", class: "point", category: "colour", analogue: "PS Hue/Saturation, saturation" },
    Def { name: "vibrance", class: "point", category: "colour", analogue: "PS Vibrance" },
    Def { name: "color_balance", class: "point", category: "colour", analogue: "PS Color Balance" },
    Def { name: "temperature", class: "point", category: "colour", analogue: "Camera Raw, temperature" },
    Def { name: "tint", class: "point", category: "colour", analogue: "Camera Raw, tint" },
    Def { name: "channel_mixer", class: "point", category: "colour", analogue: "PS Channel Mixer" },
    Def { name: "black_white", class: "point", category: "tone", analogue: "PS Black & White" },
    Def { name: "blend_multiply", class: "blend", category: "blend", analogue: "PS blend mode Multiply" },
    Def { name: "blend_screen", class: "blend", category: "blend", analogue: "PS blend mode Screen" },
    Def { name: "blend_overlay", class: "blend", category: "blend", analogue: "PS blend mode Overlay" },
    Def { name: "blend_darken", class: "blend", category: "blend", analogue: "PS blend mode Darken" },
    Def { name: "blend_lighten", class: "blend", category: "blend", analogue: "PS blend mode Lighten" },
    Def { name: "blend_dodge", class: "blend", category: "blend", analogue: "PS blend mode Color Dodge" },
    Def { name: "blend_burn", class: "blend", category: "blend", analogue: "PS blend mode Color Burn" },
    Def { name: "blend_hardlight", class: "blend", category: "blend", analogue: "PS blend mode Hard Light" },
    Def { name: "blend_softlight", class: "blend", category: "blend", analogue: "PS blend mode Soft Light" },
    Def { name: "blend_difference", class: "blend", category: "blend", analogue: "PS blend mode Difference" },
    Def { name: "blend_exclusion", class: "blend", category: "blend", analogue: "PS blend mode Exclusion" },
    Def { name: "blend_plus_lighter", class: "blend", category: "blend", analogue: "PS blend mode Linear Dodge" },
    Def { name: "blend_pinlight", class: "blend", category: "blend", analogue: "PS blend mode Pin Light" },
    Def { name: "blend_vividlight", class: "blend", category: "blend", analogue: "PS blend mode Vivid Light" },
    Def { name: "blend_hardmix", class: "blend", category: "blend", analogue: "PS blend mode Hard Mix" },
    Def { name: "blend_average", class: "blend", category: "blend", analogue: "PS blend mode Gray Average" },
    Def { name: "blend_linearlight", class: "blend", category: "blend", analogue: "PS blend mode Linear Light" },
    Def { name: "box_blur", class: "area", category: "blur", analogue: "PS Filter > Blur > Box Blur" },
    Def { name: "gaussian_blur", class: "area", category: "blur", analogue: "PS Filter > Blur > Gaussian Blur" },
    Def { name: "blur3x3", class: "area", category: "blur", analogue: "PS Filter > Blur > Blur" },
    Def { name: "sharpen3x3", class: "area", category: "sharpen", analogue: "PS Filter > Sharpen" },
    Def { name: "unsharp_mask", class: "area", category: "sharpen", analogue: "PS Unsharp Mask" },
    Def { name: "high_pass", class: "area", category: "retouch", analogue: "PS High Pass (frequency separation)" },
    Def { name: "emboss", class: "area", category: "stylise", analogue: "PS Filter > Stylize > Emboss" },
    Def { name: "sobel_x", class: "area", category: "edge", analogue: "PS Find Edges (x)" },
    Def { name: "sobel_y", class: "area", category: "edge", analogue: "PS Find Edges (y)" },
    Def { name: "laplacian", class: "area", category: "edge", analogue: "PS Find Edges" },
    Def { name: "median3x3", class: "area", category: "denoise", analogue: "PS Filter > Noise > Median" },
    Def { name: "erode3x3", class: "area", category: "morphology", analogue: "PS Minimum" },
    Def { name: "dilate3x3", class: "area", category: "morphology", analogue: "PS Maximum" },
    Def { name: "motion_blur_h", class: "area", category: "blur", analogue: "PS Motion Blur" },
    Def { name: "pixelate", class: "area", category: "stylise", analogue: "PS Mosaic" },
    Def { name: "vignette", class: "area", category: "stylise", analogue: "PS Lens Correction, vignette" },
    Def { name: "noise_uniform", class: "area", category: "noise", analogue: "PS Add Noise (uniform)" },
    Def { name: "noise_gaussian", class: "area", category: "noise", analogue: "PS Add Noise (gaussian)" },
    Def { name: "dither_bayer4", class: "area", category: "bitdepth", analogue: "PS Indexed, ordered dither" },
    Def { name: "chroma_key_near", class: "point", category: "composite", analogue: "AE Key Light / Colour key" },
    Def { name: "luma_key", class: "point", category: "composite", analogue: "AE Luma Key" },
    Def { name: "premultiply", class: "point", category: "composite", analogue: "AE Interpret Footage, Premultiply" },
    Def { name: "unpremultiply", class: "point", category: "composite", analogue: "AE Unmultiply" },
];

#[no_mangle]
pub extern "C" fn kernel_count() -> i32 {
    KERNELS.len() as i32
}

/// Scratch for the JS side, which cannot grow wasm linear memory itself.
#[no_mangle]
pub extern "C" fn alloc(len: i32) -> *mut u8 {
    if len <= 0 { return core::ptr::null_mut() }
    let mut v: Vec<u8> = Vec::with_capacity(len as usize);
    let ptr = v.as_mut_ptr();
    core::mem::forget(v);
    ptr
}

#[no_mangle]
pub extern "C" fn dealloc(ptr: *mut u8, len: i32) {
    if ptr.is_null() || len <= 0 { return }
    unsafe { drop(Vec::from_raw_parts(ptr, len as usize, len as usize)) }
}

#[no_mangle]
pub unsafe extern "C" fn kernel_names(buf: *mut u8, cap: i32) -> i32 {
    write_joined(buf, cap, |out| {
        for (i, k) in KERNELS.iter().enumerate() {
            if i > 0 { out.push(0) }
            out.extend_from_slice(k.name.as_bytes())
        }
    })
}

#[no_mangle]
pub unsafe extern "C" fn kernel_classes(buf: *mut u8, cap: i32) -> i32 {
    write_joined(buf, cap, |out| {
        for (i, k) in KERNELS.iter().enumerate() {
            if i > 0 { out.push(0) }
            out.extend_from_slice(k.class.as_bytes())
        }
    })
}

unsafe fn write_joined<F: Fn(&mut Vec<u8>)>(buf: *mut u8, cap: i32, build: F) -> i32 {
    if buf.is_null() || cap <= 0 { return -1 }
    let mut v: Vec<u8> = Vec::with_capacity(1024);
    build(&mut v);
    let n = v.len().min(cap as usize);
    core::ptr::copy_nonoverlapping(v.as_ptr(), buf, n);
    v.len() as i32
}

#[no_mangle]
pub unsafe extern "C" fn process(
    id: i32,
    rgba: *mut u8,
    len: i32,
    w: i32,
    h: i32,
    params: *const f32,
    nparams: i32,
) -> i32 {
    if id < 0 || id as usize >= KERNELS.len() { return -1 }
    if rgba.is_null() || len <= 0 || len % 4 != 0 { return -2 }
    let px = (len / 4) as usize;
    let p: &[f32] = if params.is_null() || nparams <= 0 { &[] } else { core::slice::from_raw_parts(params, nparams as usize) };
    let buf = core::slice::from_raw_parts_mut(rgba, len as usize);

    let (wi, hi) = if w <= 0 || h <= 0 { ((px as f32).sqrt() as i32, (px as f32).sqrt() as i32) } else { (w, h) };
    if wi as usize * hi as usize != px { return -3 }
    if wi > MAX_SIDE || hi > MAX_SIDE { return -4 }

    point_kernel(id as usize, buf, p);
    if KERNELS[id as usize].class == "blend" { blend_kernel(id as usize, buf, p); }
    if KERNELS[id as usize].class == "area" { area_kernel(id as usize, buf, px, wi as usize, hi as usize, p); }
    0
}

fn arg(p: &[f32], i: usize, default: f32) -> f32 {
    *p.get(i).unwrap_or(&default)
}

fn point_kernel(id: usize, buf: &mut [u8], p: &[f32]) {
    let name = KERNELS[id].name;
    if name == "identity" { return }

    // Histogram-dependent kernels need a pre-pass.
    if name == "equalize" || name == "normalize_stretch" {
        let mut hist = [0u32; 256];
        for px in buf.chunks_exact(4) {
            if px[3] == 0 { continue }
            hist[px[0] as usize] += 1;
            hist[px[1] as usize] += 1;
            hist[px[2] as usize] += 1;
        }
        let total = (hist[0] + hist[1] + hist[2]) as f32;
        if name == "equalize" {
            let mut cdf = [0u8; 256];
            let mut acc = 0u64;
            for (i, c) in hist.iter().enumerate() {
                acc += *c as u64;
                cdf[i] = clamp255((acc as f32 / total.max(1.0)) * 255.0);
            }
            for px in buf.chunks_exact_mut(4) {
                px[0] = cdf[px[0] as usize];
                px[1] = cdf[px[1] as usize];
                px[2] = cdf[px[2] as usize];
            }
        } else {
            let lo = hist.iter().position(|&c| c > 0).unwrap_or(0) as f32;
            let hi = (0..256).rev().find(|&i| hist[i] > 0).unwrap_or(255) as f32;
            let span = (hi - lo).max(1.0);
            for px in buf.chunks_exact_mut(4) {
                for c in 0..3 {
                    px[c] = clamp255(((px[c] as f32 - lo) / span) * 255.0);
                }
            }
        }
        return;
    }

    let lut_only = name == "lut_rgb";
    for px in buf.chunks_exact_mut(4) {
        let (mut r, mut g, mut b) = (px[0] as f32, px[1] as f32, px[2] as f32);
        match name {
            "invert" => { r = 255.0 - r; g = 255.0 - g; b = 255.0 - b }
            "grayscale_luma" | "grayscale_luminosity" => { let l = luma(r as u8, g as u8, b as u8); r = l; g = l; b = l }
            "sepia" => {
                let (nr, ng, nb) = (
                    0.393 * r + 0.769 * g + 0.189 * b,
                    0.349 * r + 0.686 * g + 0.168 * b,
                    0.272 * r + 0.534 * g + 0.131 * b,
                );
                r = nr; g = ng; b = nb;
            }
            "brightness" | "brightness_contrast" => { let d = arg(p, 0, 0.0) * 255.0; r += d; g += d; b += d }
            "contrast" => {
                let c = arg(p, 0, 0.0) + 1.0;
                r = (r - 128.0) * c + 128.0; g = (g - 128.0) * c + 128.0; b = (b - 128.0) * c + 128.0;
            }
            "exposure" => {
                let k = 2f32.powf(arg(p, 0, 0.0));
                r *= k; g *= k; b *= k;
            }
            "gamma" => {
                let gm = 1.0 / arg(p, 0, 1.0).max(0.01);
                r = 255.0 * (r / 255.0).powf(gm);
                g = 255.0 * (g / 255.0).powf(gm);
                b = 255.0 * (b / 255.0).powf(gm);
            }
            "levels" => {
                let (lo, hi, gm) = (arg(p, 0, 0.0) / 255.0, arg(p, 1, 1.0), arg(p, 2, 1.0).max(0.01));
                for c in [&mut r, &mut g, &mut b] {
                    let v = ((*c / 255.0) - lo).max(0.0) / (hi - lo).max(1e-6);
                    *c = 255.0 * v.powf(1.0 / gm);
                }
            }
            "levels_rgb" => {
                for (i, c) in [&mut r, &mut g, &mut b].iter_mut().enumerate() {
                    let (o, gm, wh) = (arg(p, i * 3, 0.0) / 255.0, arg(p, i * 3 + 1, 1.0).max(0.01), arg(p, i * 3 + 2, 255.0) / 255.0);
                    let v = ((*c / 255.0) - o).max(0.0) / (wh - o).max(1e-6);
                    *c = 255.0 * v.powf(1.0 / gm);
                }
            }
            "posterize" => {
                let levels = arg(p, 0, 4.0).max(2.0).round();
                for c in [&mut r, &mut g, &mut b] {
                    *c = ((*c * (levels - 1.0) / 255.0 + 0.5).floor() * 255.0 / (levels - 1.0)).min(255.0);
                }
            }
            "threshold" => {
                let t = arg(p, 0, 128.0);
                let v = if luma(r as u8, g as u8, b as u8) >= t { 255.0 } else { 0.0 };
                r = v; g = v; b = v;
            }
            "solarize" => {
                let t = arg(p, 0, 128.0);
                for c in [&mut r, &mut g, &mut b] { if *c > t { *c = 255.0 - *c } }
            }
            "hue_rotate" => {
                let (mut hh, s, l) = rgb_to_hsl(r / 255.0, g / 255.0, b / 255.0);
                hh = (hh + arg(p, 0, 0.0) / 360.0) % 1.0;
                if hh < 0.0 { hh += 1.0 }
                let (nr, ng, nb) = hsl_to_rgb(hh, s, l);
                r = nr * 255.0; g = ng * 255.0; b = nb * 255.0;
            }
            "saturate" => {
                let (h, mut s, l) = rgb_to_hsl(r / 255.0, g / 255.0, b / 255.0);
                s = (s * arg(p, 0, 1.0)).clamp(0.0, 1.0);
                let (nr, ng, nb) = hsl_to_rgb(h, s, l);
                r = nr * 255.0; g = ng * 255.0; b = nb * 255.0;
            }
            "vibrance" => {
                let amt = arg(p, 0, 0.5);
                let mx = r.max(g).max(b);
                let mn = r.min(g).min(b);
                let boost = amt * (1.0 - (mx - mn) / 255.0);
                let (h, mut s, l) = rgb_to_hsl(r / 255.0, g / 255.0, b / 255.0);
                s = (s * (1.0 + boost)).clamp(0.0, 1.0);
                let (nr, ng, nb) = hsl_to_rgb(h, s, l);
                r = nr * 255.0; g = ng * 255.0; b = nb * 255.0;
            }
            "color_balance" => {
                r += arg(p, 0, 0.0) * 255.0; g += arg(p, 1, 0.0) * 255.0; b += arg(p, 2, 0.0) * 255.0;
            }
            "temperature" => {
                let t = arg(p, 0, 0.0);
                r += t * 60.0; b -= t * 60.0;
            }
            "tint" => {
                let t = arg(p, 0, 0.0);
                g -= t * 60.0; r += t * 20.0; b += t * 40.0;
            }
            "channel_mixer" => {
                let (a0, a1, a2) = (arg(p, 0, 1.0), arg(p, 1, 0.0), arg(p, 2, 0.0));
                let (b0, b1, b2) = (arg(p, 3, 0.0), arg(p, 4, 1.0), arg(p, 5, 0.0));
                let (c0, c1, c2) = (arg(p, 6, 0.0), arg(p, 7, 0.0), arg(p, 8, 1.0));
                let (nr, ng, nb) = (a0 * r + a1 * g + a2 * b, b0 * r + b1 * g + b2 * b, c0 * r + c1 * g + c2 * b);
                r = nr; g = ng; b = nb;
            }
            "black_white" => {
                let (rr, gg, bb) = (arg(p, 0, 0.4), arg(p, 1, 0.4), arg(p, 2, 0.2));
                let l = rr * r + gg * g + bb * b;
                r = l; g = l; b = l;
            }
            "chroma_key_near" => {
                let (tr, tg, tb) = (arg(p, 0, 0.0), arg(p, 1, 255.0), arg(p, 2, 0.0));
                let tol = arg(p, 3, 40.0);
                let d = ((r - tr) * (r - tr) + (g - tg) * (g - tg) + (b - tb) * (b - tb)).sqrt();
                px[3] = if d <= tol { 0 } else { px[3] };
            }
            "luma_key" => {
                let lo = arg(p, 0, 0.2) * 255.0;
                let hi = arg(p, 1, 0.8) * 255.0;
                let l = luma(r as u8, g as u8, b as u8);
                let a = ((l - lo) / (hi - lo).max(1.0)).clamp(0.0, 1.0);
                px[3] = (a * 255.0 + 0.5) as u8;
            }
            "premultiply" => {
                let a = px[3] as f32 / 255.0;
                r *= a; g *= a; b *= a;
            }
            "unpremultiply" => {
                let a = px[3] as f32 / 255.0;
                if a > 0.001 { r /= a; g /= a; b /= a }
            }
            _ => {}
        }
        if lut_only && p.len() >= 768 {
            let lut = |c: u8, off: usize| -> f32 {
                let i = (c as usize).min(255);
                let v = p[off + i];
                v.clamp(0.0, 255.0)
            };
            r = lut(px[0], 0);
            g = lut(px[1], 256);
            b = lut(px[2], 512);
        }
        if KERNELS[id].class == "point" {
            px[0] = clamp255(r);
            px[1] = clamp255(g);
            px[2] = clamp255(b);
        } else {
            px[0] = r as u8;
            px[1] = g as u8;
            px[2] = b as u8;
        }
    }
}

fn blend_kernel(id: usize, buf: &mut [u8], p: &[f32]) {
    let mode = match KERNELS[id].name {
        "blend_multiply" => 0, "blend_screen" => 1, "blend_overlay" => 2, "blend_darken" => 3,
        "blend_lighten" => 4, "blend_dodge" => 5, "blend_burn" => 6, "blend_hardlight" => 7,
        "blend_softlight" => 8, "blend_difference" => 9, "blend_exclusion" => 10,
        "blend_plus_lighter" => 11, "blend_pinlight" => 12, "blend_vividlight" => 13,
        "blend_hardmix" => 14, "blend_average" => 15, "blend_linearlight" => 16, _ => 0,
    };
    let backdrop = [arg(p, 0, 128.0), arg(p, 1, 128.0), arg(p, 2, 128.0)];
    let opacity = arg(p, 3, 1.0).clamp(0.0, 1.0);
    for px in buf.chunks_exact_mut(4) {
        for c in 0..3 {
            let blended = blend(mode, backdrop[c] / 255.0, px[c] as f32 / 255.0) * 255.0;
            px[c] = clamp255(px[c] as f32 * (1.0 - opacity) + blended * opacity);
        }
    }
}

fn sample(buf: &[u8], w: usize, h: usize, x: i32, y: i32, c: usize) -> f32 {
    let cx = x.clamp(0, w as i32 - 1) as usize;
    let cy = y.clamp(0, h as i32 - 1) as usize;
    buf[(cy * w + cx) * 4 + c] as f32
}

fn area_kernel(id: usize, buf: &mut [u8], px: usize, w: usize, h: usize, p: &[f32]) {
    let name = KERNELS[id].name;

    if name == "box_blur" || name == "gaussian_blur" {
        // Separable moving average. A gaussian is three box passes, which converges
        // on a gaussian without shipping a kernel table into the module.
        let radius = arg(p, 0, 2.0).max(1.0) as usize;
        let passes = if name == "gaussian_blur" { 3 } else { 1 };
        let mut src = vec![0u8; buf.len()];
        src.copy_from_slice(buf);
        let mut acc = vec![0f32; px * 3];
        for _ in 0..passes {
            // horizontal: src -> acc
            for y in 0..h {
                for x in 0..w {
                    for c in 0..3 {
                        let mut sum = 0f32;
                        let mut n = 0f32;
                        for k in -radius..=radius {
                            sum += sample(&src, w, h, x as i32 + k, y as i32, c);
                            n += 1.0;
                        }
                        acc[(y * w + x) * 3 + c] = sum / n;
                    }
                }
            }
            // vertical: acc -> src
            for y in 0..h {
                for x in 0..w {
                    for c in 0..3 {
                        let mut sum = 0f32;
                        let mut n = 0f32;
                        for k in -radius..=radius {
                            let yy = (y as i32 + k).clamp(0, h as i32 - 1) as usize;
                            sum += acc[(yy * w + x) * 3 + c];
                            n += 1.0;
                        }
                        src[(y * w + x) * 4 + c] = clamp255(sum / n);
                    }
                }
            }
        }
        for i in 0..px {
            buf[i * 4] = src[i * 4];
            buf[i * 4 + 1] = src[i * 4 + 1];
            buf[i * 4 + 2] = src[i * 4 + 2];
        }
        return;
    }

    let mut out = vec![0u8; buf.len()];
    for y in 0..h {
        for x in 0..w {
            let i = (y * w + x) * 4;
            match name {
                "blur3x3" | "sharpen3x3" | "emboss" | "sobel_x" | "sobel_y" | "laplacian"
                | "median3x3" | "erode3x3" | "dilate3x3" | "high_pass" | "unsharp_mask" | "motion_blur_h" => {
                    let k: [[f32; 3]; 3] = match name {
                        "blur3x3" => [[1.0; 3]; 3],
                        "sharpen3x3" => [[0.0, -1.0, 0.0], [-1.0, 5.0, -1.0], [0.0, -1.0, 0.0]],
                        "emboss" => [[-2.0, -1.0, 0.0], [-1.0, 1.0, 1.0], [0.0, 1.0, 2.0]],
                        "sobel_x" => [[-1.0, 0.0, 1.0], [-2.0, 0.0, 2.0], [-1.0, 0.0, 1.0]],
                        "sobel_y" => [[-1.0, -2.0, -1.0], [0.0, 0.0, 0.0], [1.0, 2.0, 1.0]],
                        "laplacian" => [[0.0, 1.0, 0.0], [1.0, -4.0, 1.0], [0.0, 1.0, 0.0]],
                        "high_pass" => [[-1.0, -1.0, -1.0], [-1.0, 9.0, -1.0], [-1.0, -1.0, -1.0]],
                        _ => [[0.0; 3]; 3],
                    };
                    if name == "median3x3" || name == "erode3x3" || name == "dilate3x3" || name == "motion_blur_h" {
                        let mut acc = [0f32; 3];
                        for c in 0..3 {
                            let mut vals = [0f32; 9];
                            let mut n = 0;
                            for dy in -1..=1 {
                                for dx in -1..=1 {
                                    vals[n] = sample(buf, w, h, x as i32 + dx, y as i32 + dy, c);
                                    n += 1;
                                }
                            }
                            vals.sort_by(|a, b| a.partial_cmp(b).unwrap());
                            acc[c] = match name {
                                "median3x3" => vals[4],
                                "erode3x3" => vals[0],
                                _ => vals[8],
                            };
                        }
                        if name == "motion_blur_h" {
                            let r = arg(p, 0, 3.0).max(1.0) as i32;
                            for c in 0..3 {
                                let mut acc2 = 0f32;
                                for kx in -r..=r { acc2 += sample(buf, w, h, x as i32 + kx, y as i32, c) }
                                acc[c] = acc2 / (2 * r + 1) as f32;
                            }
                        }
                        out[i] = clamp255(acc[0]);
                        out[i + 1] = clamp255(acc[1]);
                        out[i + 2] = clamp255(acc[2]);
                    } else {
                        let amount = arg(p, 0, 1.0);
                        for c in 0..3 {
                            let mut acc = 0f32;
                            for dy in -1..=1 {
                                for dx in -1..=1 {
                                    acc += k[dy as usize + 1][dx as usize + 1] * sample(buf, w, h, x as i32 + dx, y as i32 + dy, c);
                                }
                            }
                            let base = sample(buf, w, h, x as i32, y as i32, c);
                            let v = match name {
                                "blur3x3" => acc / 9.0,
                                "unsharp_mask" => base + amount * (base - acc / 9.0),
                                "high_pass" => acc + 128.0,
                                _ => acc,
                            };
                            if name == "unsharp_mask" {
                                let mut s = 0f32;
                                for dy in -1..=1 { for dx in -1..=1 { s += sample(buf, w, h, x as i32 + dx, y as i32 + dy, c) } }
                                out[i + c] = clamp255(base + amount * (base - s / 9.0));
                            } else {
                                out[i + c] = clamp255(v);
                            }
                        }
                    }
                }
                "pixelate" => {
                    let cell = arg(p, 0, 8.0).max(1.0) as usize;
                    let bx = (x / cell) * cell + cell / 2;
                    let by = (y / cell) * cell + cell / 2;
                    for c in 0..3 { out[i + c] = sample(buf, w, h, bx as i32, by as i32, c) as u8 }
                    out[i + 3] = buf[i + 3];
                }
                "vignette" => {
                    let strength = arg(p, 0, 0.6);
                    let nx = (x as f32 - w as f32 / 2.0) / (w as f32 / 2.0);
                    let ny = (y as f32 - h as f32 / 2.0) / (h as f32 / 2.0);
                    let d = (nx * nx + ny * ny).sqrt() / 1.4142;
                    let f = 1.0 - strength * (d * d);
                    for c in 0..3 { out[i + c] = clamp255(buf[i + c] as f32 * f) }
                    out[i + 3] = buf[i + 3];
                }
                "noise_uniform" | "noise_gaussian" => {
                    let amount = arg(p, 0, 20.0);
                    let seed = ((y * w + x) as u32).wrapping_mul(2654435761);
                    let u = (seed as f32 / u32::MAX as f32) - 0.5;
                    let n = if name == "noise_uniform" { u * 2.0 * amount } else { u * amount * 1.7 };
                    for c in 0..3 { out[i + c] = clamp255(buf[i + c] as f32 + n) }
                    out[i + 3] = buf[i + 3];
                }
                "dither_bayer4" => {
                    let bayer = [0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0];
                    let levels = arg(p, 0, 4.0).max(2.0);
                    let t = bayer[(y % 4) * 4 + x % 4] / 16.0 - 0.5;
                    for c in 0..3 {
                        let scaled = buf[i + c] as f32 / 255.0 * (levels - 1.0) + t;
                        out[i + c] = clamp255(scaled.round() * 255.0 / (levels - 1.0));
                    }
                    out[i + 3] = buf[i + 3];
                }
                _ => { out[i] = buf[i]; out[i + 1] = buf[i + 1]; out[i + 2] = buf[i + 2]; out[i + 3] = buf[i + 3] }
            }
        }
    }
    buf.copy_from_slice(&out);
}
