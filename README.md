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
| `src/lib.rs` | this crate's own registry | 66 |

After de-duplication that yields **486 catalogued modules** (`node scripts/build-inventory.mjs`
asserts the ≥200 floor, and CI re-runs it so the number cannot rot).

Only operation *names and semantics* are taken from ffmpeg/OpenCV; no upstream code is copied.
That keeps the LGPL/Apache questions out of the current scope, and it is flagged because the
answer changes the moment someone starts porting code instead of algorithms.

## Status vocabulary (deliberately unforgiving)

* `catalogued` — named, sourced, not implemented.
* `registered_ci_smoke` — in the Rust registry, builds in CI, and executes over a test image
  without error. **Not** numerically checked.
* `verified` — matched against an independent JS reference in `test/*.test.mjs`, in CI.

The status list is derived from the test files themselves, so it cannot drift ahead of what CI
actually asserts. Current split: 43 `verified`, 23 `registered_ci_smoke`, 420 `catalogued`.

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

1. ~~Get the registry building and green in CI.~~ Done.
2. Add numeric references for the remaining 23 `registered_ci_smoke` kernels, then work down the
   catalogue in priority order: colour/tone (50), composite/geometry (43), blend (35),
   blur/sharpen (25), draw/text (26), edge/detail (12), morphology (10).
3. AE-side temporal operations (keyframe interpolation, time remap, motion blur over frames) need
   a second ABI with frame state; they are catalogued but not started.
4. A browser demo page, once enough kernels are `verified` to be worth showing.
