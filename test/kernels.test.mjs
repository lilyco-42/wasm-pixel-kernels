// Numeric checks against independent JS references. This is the gate that decides
// whether a kernel is "implemented" rather than "registered": compiling is not proof.
//
//   node --test test/kernels.test.mjs path/to/kernels.wasm
import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

const wasmPath = process.argv[2] ?? 'target/wasm32-unknown-unknown/release/wasm_pixel_kernels.wasm';
const bytes = readFileSync(wasmPath);
const { instance } = await WebAssembly.instantiate(bytes, {});
const { memory, alloc, dealloc, process: run, kernel_count: count, kernel_names: names } = instance.exports;

const kernelList = (() => {
  const cap = 8192;
  const ptr = alloc(cap);
  const written = names(ptr, cap);
  const raw = new Uint8Array(memory.buffer, ptr, Math.min(written, cap));
  const list = new TextDecoder().decode(raw).split('\0');
  dealloc(ptr, cap);
  return list;
})();

assert.equal(kernelList.length, count(), 'registry size and name list must agree');

const clamp = (v) => (v <= 0 ? 0 : v >= 255 ? 255 : Math.round(v));

function apply(kernel, rgba, w, h, params = []) {
  const len = rgba.length;
  const ptr = alloc(len);
  new Uint8Array(memory.buffer, ptr, len).set(rgba);
  let pptr = 0;
  if (params.length) {
    pptr = alloc(params.length * 4);
    new Float32Array(memory.buffer, pptr, params.length).set(params);
  }
  const rc = run(kernelList.indexOf(kernel), ptr, len, w, h, pptr, params.length);
  assert.equal(rc, 0, `${kernel}: process returned ${rc}`);
  const out = new Uint8Array(new Uint8Array(memory.buffer.slice(ptr, ptr + len)));
  dealloc(ptr, len);
  if (pptr) dealloc(pptr, params.length * 4);
  return out;
}

const solid = (px = 16) => {
  const buf = new Uint8Array(px * px * 4);
  for (let i = 0; i < px * px; i += 1) {
    buf[i * 4] = (i * 7) % 256;
    buf[i * 4 + 1] = (i * 13) % 256;
    buf[i * 4 + 2] = (i * 29) % 256;
    buf[i * 4 + 3] = 255;
  }
  return buf;
};

const luma = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

test('registry exposes every advertised kernel', () => {
  for (const name of ['identity', 'invert', 'grayscale_luma', 'levels', 'box_blur', 'blend_multiply']) {
    assert.ok(kernelList.includes(name), `${name} missing from the registry`);
  }
});

test('identity is a no-op', () => {
  const src = solid();
  assert.deepEqual(apply('identity', src, 16, 16), src);
});

test('invert flips every channel and keeps alpha', () => {
  const src = solid();
  const out = apply('invert', src, 16, 16);
  for (let i = 0; i < src.length; i += 4) {
    assert.equal(out[i], 255 - src[i]);
    assert.equal(out[i + 3], src[i + 3]);
  }
});

test('grayscale_luma matches the Rec.709 reference', () => {
  const src = solid();
  const out = apply('grayscale_luma', src, 16, 16);
  for (let i = 0; i < src.length; i += 4) {
    const expected = clamp(luma(src[i], src[i + 1], src[i + 2]));
    assert.ok(Math.abs(out[i] - expected) <= 1, `r ${out[i]} vs ${expected}`);
    assert.equal(out[i], out[i + 1]);
    assert.equal(out[i + 1], out[i + 2]);
  }
});

test('brightness shifts by the requested amount', () => {
  const src = solid();
  const out = apply('brightness', src, 16, 16, [0.1]);
  for (let i = 0; i < src.length; i += 4) {
    assert.ok(Math.abs(out[i] - clamp(src[i] + 0.1 * 255)) <= 1);
  }
});

test('levels maps black point and white point', () => {
  const src = solid();
  const out = apply('levels', src, 16, 16, [64 / 255, 192 / 255, 1.0]);
  for (let i = 0; i < src.length; i += 4) {
    const v = clamp(((src[i] / 255 - 64 / 255) / (128 / 255)) * 255);
    assert.ok(Math.abs(out[i] - v) <= 2, `level ${out[i]} vs ${v}`);
  }
});

test('threshold binarises on luma', () => {
  const src = solid();
  const out = apply('threshold', src, 16, 16, [128]);
  for (let i = 0; i < src.length; i += 4) {
    const expected = luma(src[i], src[i + 1], src[i + 2]) >= 128 ? 255 : 0;
    assert.equal(out[i], expected);
  }
});

test('blend_multiply uses the backdrop colour', () => {
  const src = solid();
  const out = apply('blend_multiply', src, 16, 16, [255, 128, 0, 1.0]);
  for (let i = 0; i < src.length; i += 4) {
    assert.equal(out[i], clamp((src[i] / 255) * (255 / 255) * 255));
    assert.equal(out[i + 2], clamp((src[i + 2] / 255) * 0));
  }
});

test('box_blur reduces variance and preserves size', () => {
  const src = solid();
  const out = apply('box_blur', src, 16, 16, [2]);
  assert.equal(out.length, src.length);
  const variance = (buf) => {
    const mean = buf.reduce((a, b) => a + b, 0) / buf.length;
    return buf.reduce((a, b) => a + (b - mean) ** 2, 0) / buf.length;
  };
  assert.ok(variance(out) < variance(src), 'blurring must reduce variance');
});

test('premultiply scales rgb by alpha', () => {
  const src = solid();
  for (let i = 3; i < src.length; i += 4) src[i] = 128;
  const out = apply('premultiply', src, 16, 16);
  for (let i = 0; i < src.length; i += 4) {
    assert.ok(Math.abs(out[i] - clamp(src[i] * (128 / 255))) <= 2);
    assert.equal(out[i + 3], 128);
  }
});

test('every registered kernel runs without error on a small image', () => {
  const src = new Uint8Array(8 * 8 * 4).fill(90);
  for (const name of kernelList) {
    const copy = Uint8Array.from(src);
    const len = copy.length;
    const ptr = alloc(len);
    new Uint8Array(memory.buffer, ptr, len).set(copy);
    const rc = run(kernelList.indexOf(name), ptr, len, 8, 8, 0, 0);
    dealloc(ptr, len);
    assert.ok(rc >= 0, `${name} failed with ${rc}`);
  }
});
