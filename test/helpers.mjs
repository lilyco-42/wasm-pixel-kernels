// Shared loader for the wasm module: allocates, runs a kernel, copies the result back.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const wasmPath = process.argv[2] ?? 'target/wasm32-unknown-unknown/release/wasm_pixel_kernels.wasm';

const { instance } = await WebAssembly.instantiate(readFileSync(wasmPath), {});
const { memory, alloc, dealloc, process: runRaw, kernel_count: count, kernel_names: names } = instance.exports;

export const kernelList = (() => {
  const cap = 8192;
  const ptr = alloc(cap);
  const written = names(ptr, cap);
  const list = new TextDecoder().decode(new Uint8Array(memory.buffer, ptr, Math.min(written, cap))).split('\0');
  dealloc(ptr, cap);
  assert.equal(list.length, count(), 'registry size and name list must agree');
  return list;
})();

export const clamp = (v) => (v <= 0 ? 0 : v >= 255 ? 255 : Math.round(v));
export const luma = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

export function apply(kernel, rgba, w, h, params = []) {
  const len = rgba.length;
  const ptr = alloc(len);
  new Uint8Array(memory.buffer, ptr, len).set(rgba);
  let pptr = 0;
  if (params.length) {
    pptr = alloc(params.length * 4);
    new Float32Array(memory.buffer, pptr, params.length).set(params);
  }
  const rc = runRaw(kernelList.indexOf(kernel), ptr, len, w, h, pptr, params.length);
  assert.equal(rc, 0, `${kernel}: process returned ${rc}`);
  const out = new Uint8Array(new Uint8Array(memory.buffer.slice(ptr, ptr + len)));
  dealloc(ptr, len);
  if (pptr) dealloc(pptr, params.length * 4);
  return out;
}

/// A deterministic gradient image; every channel value 0..255 appears across pixels.
export function gradient(px = 16) {
  const buf = new Uint8Array(px * px * 4);
  for (let i = 0; i < px * px; i += 1) {
    buf[i * 4] = (i * 7) % 256;
    buf[i * 4 + 1] = (i * 13) % 256;
    buf[i * 4 + 2] = (i * 29) % 256;
    buf[i * 4 + 3] = 255;
  }
  return buf;
}

/// Runs a point kernel over one pixel per channel value and compares to `expect`.
export function checkPoint(kernel, expect, params = [], tolerance = 1) {
  const src = new Uint8Array(256 * 4);
  for (let v = 0; v < 256; v += 1) {
    src[v * 4] = v;
    src[v * 4 + 1] = v;
    src[v * 4 + 2] = v;
    src[v * 4 + 3] = 255;
  }
  const out = apply(kernel, src, 256, 1, params);
  for (let v = 0; v < 256; v += 1) {
    const wanted = expect(v, params);
    for (let c = 0; c < 3; c += 1) {
      assert.ok(
        Math.abs(out[v * 4 + c] - wanted) <= tolerance,
        `${kernel}: in ${v} -> got ${out[v * 4 + c]} expected ${wanted} (channel ${c})`,
      );
    }
  }
  return out;
}
