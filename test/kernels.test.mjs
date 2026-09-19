// Registry-level checks plus a smoke pass over every kernel. The numeric references
// live in point-kernels.test.mjs and area-kernels.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { apply, kernelList } from './helpers.mjs';

test('registry exposes every advertised kernel', () => {
  for (const name of ['identity', 'invert', 'grayscale_luma', 'levels', 'box_blur', 'blend_multiply']) {
    assert.ok(kernelList.includes(name), `${name} missing from the registry`);
  }
});

test('every registered kernel runs over a real image without error', () => {
  const src = new Uint8Array(24 * 24 * 4);
  for (let i = 0; i < 24 * 24; i += 1) {
    src[i * 4] = (i * 5) % 256;
    src[i * 4 + 1] = (i * 11) % 256;
    src[i * 4 + 2] = (i * 17) % 256;
    src[i * 4 + 3] = 255;
  }
  for (const name of kernelList) {
    const out = apply(name, Uint8Array.from(src), 24, 24);
    assert.equal(out.length, src.length, `${name} changed the buffer size`);
    assert.ok(out.every((v) => Number.isInteger(v)), `${name} produced a non-integer byte`);
  }
});

test('a too-large image is rejected rather than corrupting memory', () => {
  assert.throws(() => apply('identity', new Uint8Array(4), 5000, 5000));
});
