# wasm-pixel-kernels

Goal: a catalogue of **≥200 everyday Photoshop-retouch / After-Effects-compositing operations**
available as WebAssembly, behind one uniform ABI.

## The boundary this project will not pretend away

Adobe's Photoshop and After Effects cores are closed-source proprietary C++. They cannot be
"compiled to wasm" by anyone outside Adobe. What *is* achievable, and what this repo does, is
take the **operation vocabulary** those apps made famous — curves, levels, blend modes, unsharp
mask, frequency separation, luma key, premultiply, motion blur — and implement or bind each one
from a public, citable catalogue.

So "200 modules" here means 200 named operations with a documented reference, not 200 Adobe
binaries. `inventory/modules.json` lists every row with its source.

## Catalogue sources (machine-fetched, not typed by hand)

| Source | What is taken | Count |
|---|---|---|
| [ffmpeg filter manual](https://ffmpeg.org/ffmpeg-filters.html) | chapter 11 video filter names | 289 |
| [OpenCV imgproc.hpp](https://github.com/opencv/opencv/blob/4.x/modules/imgproc/include/opencv2/imgproc.hpp) | exported function names | 125 |
| [W3C Compositing and Blending 1](https://www.w3.org/TR/compositing-1/) | blend modes | 27 |
| `src/lib.rs` | this crate's own registry | 68 |

After de-duplication that yields **486 catalogued modules** (`node scripts/build-inventory.mjs`
asserts the ≥200 floor, and CI re-runs it so the number cannot rot).

Only operation *names and semantics* are taken from ffmpeg/OpenCV; no upstream code is copied.
That keeps the LGPL/Apache questions out of the current scope, and it is flagged because the
answer changes the moment someone starts porting code instead of algorithms.

## Status vocabulary (deliberately unforgiving)

* `catalogued` — named, sourced, not implemented.
* `registered_unverified` — present in the Rust registry, **never proven to compile or to be
  numerically correct**. That is the current state of all 68 local kernels.
* `verified` — assigned only by `test/kernels.test.mjs` passing in CI against independent JS
  references.

Nothing in this repo is `verified` yet.

## ABI

One module, one linear memory, a registry indexed by id:

```
kernel_count() -> i32
kernel_names(buf, cap) -> i32      // '\0'-joined, registry order
kernel_classes(buf, cap) -> i32    // "point" | "area" | "blend"
alloc(len) -> ptr ; dealloc(ptr, len)
process(id, rgba, len, w, h, params, n) -> i32
```

A single wasm module rather than 200 files on purpose: measurements in
[android-wasm-lab](https://lilyco-42.github.io/android-wasm-lab/) showed an 11.2 MB wasm module
already costs ~3.7 s per image on an Android emulator browser, so per-operation modules would be
unusable on phones.

## Build and test

Nothing is built on the author's machine (host too weak). CI does it:

```bash
cargo build --release --target wasm32-unknown-unknown
node --test test/kernels.test.mjs
```

## Roadmap

1. Get the current registry green in CI, then promote each kernel to `verified` one at a time.
2. Grow toward the catalogue in priority order: colour/tone (50), blend (35), geometry/composite
   (43), blur/sharpen (25), edge/detail (12), morphology (10).
3. AE-side temporal operations (keyframe interpolation, time remap, motion blur over frames) need
   a second ABI with frame state; they are catalogued but not started.
