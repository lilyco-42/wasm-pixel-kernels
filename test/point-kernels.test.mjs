// Numeric references for the point and blend kernels. Each expectation is written
// from the operation's definition (W3C compositing for blends, standard tone maths
// for the rest), not copied from src/lib.rs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { apply, gradient, checkPoint, clamp, luma } from './helpers.mjs';

const n = (v) => v / 255;

test('tone point kernels match their definitions', () => {
  checkPoint('identity', (v) => v);
  checkPoint('invert', (v) => 255 - v);
  checkPoint('brightness', (v, p) => clamp(v + p[0] * 255), [0.1]);
  checkPoint('contrast', (v, p) => clamp((v - 128) * (1 + p[0]) + 128), [0.2]);
  checkPoint('brightness_contrast', (v, p) => clamp((v + p[0] * 255 - 128) * (1 + p[1]) + 128), [0.1, 0.2]);
  checkPoint('exposure', (v, p) => clamp(v * 2 ** p[0]), [1]);
  checkPoint('gamma', (v, p) => clamp(255 * n(v) ** (1 / p[0])), [2.2]);
  checkPoint('levels', (v, p) => clamp(((n(v) - p[0]) / (p[1] - p[0])) * 255), [0.25, 0.75, 1]);
  checkPoint('posterize', (v, p) => clamp(Math.floor((v * (p[0] - 1)) / 255 + 0.5) * (255 / (p[0] - 1))), [4]);
  checkPoint('solarize', (v, p) => (v > p[0] ? 255 - v : v), [128]);
  checkPoint('threshold', (v) => (v >= 128 ? 255 : 0), [128]);
  checkPoint('grayscale_luma', (v) => clamp(luma(v, v, v)));
});

test('sepia applies the standard 3x3 matrix per channel', () => {
  const src = gradient();
  const out = apply('sepia', src, 16, 16);
  for (let i = 0; i < src.length; i += 4) {
    const [r, g, b] = [src[i], src[i + 1], src[i + 2]];
    assert.ok(Math.abs(out[i] - clamp(0.393 * r + 0.769 * g + 0.189 * b)) <= 1);
    assert.ok(Math.abs(out[i + 1] - clamp(0.349 * r + 0.686 * g + 0.168 * b)) <= 1);
    assert.ok(Math.abs(out[i + 2] - clamp(0.272 * r + 0.534 * g + 0.131 * b)) <= 1);
  }
});

test('levels_rgb applies per-channel black/white/gamma', () => {
  const src = gradient();
  const params = [0.1, 1.0, 0.9, 0.2, 1.0, 0.8, 0.3, 1.0, 0.7];
  const out = apply('levels_rgb', src, 16, 16, params);
  for (let i = 0; i < src.length; i += 4) {
    for (let c = 0; c < 3; c += 1) {
      const black = params[c * 3];
      const gamma = params[c * 3 + 1];
      const white = params[c * 3 + 2];
      const v = Math.max(0, n(src[i + c]) - black) / (white - black);
      assert.ok(Math.abs(out[i + c] - clamp(255 * v ** (1 / gamma))) <= 2, `channel ${c}`);
    }
  }
});

test('lut_rgb remaps through the supplied 768-entry table', () => {
  const src = gradient();
  const params = new Array(768).fill(0).map((_, i) => {
    const table = Math.floor(i / 256);
    const v = i % 256;
    return table === 0 ? 255 - v : table === 1 ? v : v / 2;
  });
  const out = apply('lut_rgb', src, 16, 16, params);
  for (let i = 0; i < src.length; i += 4) {
    assert.equal(out[i], 255 - src[i]);
    assert.equal(out[i + 1], src[i + 1]);
    assert.equal(out[i + 2], Math.round(src[i + 2] / 2));
  }
});

test('channel_mixer and black_white apply their matrices', () => {
  const src = gradient();
  const matrix = [0.8, 0.1, 0.05, 0.05, 0.9, 0.1, 0.1, 0.0, 0.7];
  const mixed = apply('channel_mixer', src, 16, 16, matrix);
  const bw = apply('black_white', src, 16, 16, [0.5, 0.3, 0.2]);
  for (let i = 0; i < src.length; i += 4) {
    const [r, g, b] = [src[i], src[i + 1], src[i + 2]];
    assert.ok(Math.abs(mixed[i] - clamp(0.8 * r + 0.1 * g + 0.05 * b)) <= 1);
    assert.ok(Math.abs(mixed[i + 1] - clamp(0.05 * r + 0.9 * g + 0.1 * b)) <= 1);
    assert.ok(Math.abs(mixed[i + 2] - clamp(0.1 * r + 0.0 * g + 0.7 * b)) <= 1);
    assert.ok(Math.abs(bw[i] - clamp(0.5 * r + 0.3 * g + 0.2 * b)) <= 1);
  }
});

test('temperature and tint bias channels in opposite directions', () => {
  const src = new Uint8Array(4 * 4 * 4);
  for (let i = 0; i < 16; i += 1) src.set([128, 128, 128, 255], i * 4);
  const warm = apply('temperature', src, 4, 4, [0.5]);
  assert.ok(warm[0] > 128, `warming must raise red, got ${warm[0]}`);
  assert.ok(warm[2] < 128, `warming must lower blue, got ${warm[2]}`);
  const green = apply('tint', Uint8Array.from(src), 4, 4, [0.5]);
  assert.ok(green[5] < 128, `positive tint must pull green down, got ${green[5]}`);
});

test('saturate at zero desaturates and at two saturates', () => {
  const src = gradient();
  const grey = apply('saturate', src, 16, 16, [0]);
  for (let i = 0; i < src.length; i += 4) {
    assert.ok(Math.abs(grey[i] - grey[i + 1]) <= 1 && Math.abs(grey[i + 1] - grey[i + 2]) <= 1, 'sat 0 must be grey');
  }
  const vivid = apply('saturate', src, 16, 16, [2]);
  const spread = (buf, i) => Math.max(buf[i], buf[i + 1], buf[i + 2]) - Math.min(buf[i], buf[i + 1], buf[i + 2]);
  let before = 0;
  let after = 0;
  for (let i = 0; i < src.length; i += 4) {
    before += spread(src, i);
    after += spread(vivid, i);
  }
  assert.ok(after > before, 'saturate 2 must widen the channel spread');
});

test('hue_rotate by 180 degrees swaps the dominant channel', () => {
  const px = new Uint8Array([220, 40, 40, 255]);
  const out = apply('hue_rotate', px, 1, 1, [180]);
  assert.ok(out[0] < 120 && out[1] > 120 && out[2] > 120, `expected a cyan-ish result, got ${[...out]}`);
});

test('blend modes follow the W3C formulas', () => {
  const src = gradient();
  const backdrop = [200, 100, 50];
  const params = [...backdrop, 1.0];
  const cases = {
    blend_multiply: (b, s) => b * s,
    blend_screen: (b, s) => b + s - b * s,
    blend_difference: (b, s) => Math.abs(b - s),
    blend_exclusion: (b, s) => b + s - 2 * b * s,
    blend_overlay: (b, s) => (s <= 0.5 ? 2 * b * s : 1 - 2 * (1 - b) * (1 - s)),
    blend_hardlight: (b, s) => (s <= 0.5 ? 2 * b * s : 1 - 2 * (1 - b) * (1 - s)),
    blend_darken: (b, s) => Math.min(b, s),
    blend_lighten: (b, s) => Math.max(b, s),
    blend_plus_lighter: (b, s) => Math.min(1, b + s),
    blend_softlight: (b, s) => {
      const dd = (t) => (t <= 0.25 ? ((16 * t - 12) * t + 4) * t : Math.sqrt(t));
      return s <= 0.5 ? b - (1 - 2 * s) * b * (1 - b) : b + (2 * s - 1) * (dd(b) - b);
    },
    blend_dodge: (b, s) => (s >= 1 ? 1 : Math.min(1, b / (1 - s))),
    blend_burn: (b, s) => (s <= 0 ? 0 : 1 - Math.min(1, (1 - b) / s)),
    blend_pinlight: (b, s) => (s <= 0.5 ? Math.min(b, 2 * s) : Math.max(b, 2 * s - 1)),
    blend_vividlight: (b, s) => (s < 0.5
      ? (2 * s <= 0 ? 0 : 1 - Math.min(1, (1 - b) / (2 * s)))
      : (2 * s - 1 >= 1 ? 1 : Math.min(1, b / (1 - (2 * s - 1))))),
    blend_linearlight: (b, s) => (s < 0.5
      ? (2 * s <= 0 ? 0 : 1 - Math.min(1, (1 - b) / (2 * s)))
      : (2 * s - 1 >= 1 ? 1 : Math.min(1, b / (1 - (2 * s - 1))))),
    blend_average: (b, s) => (b + s) / 2,
  };
  for (const [kernel, fn] of Object.entries(cases)) {
    const out = apply(kernel, src, 16, 16, params);
    for (let i = 0; i < src.length; i += 4) {
      for (let c = 0; c < 3; c += 1) {
        const wanted = clamp(fn(n(backdrop[c]), n(src[i + c])) * 255);
        assert.ok(Math.abs(out[i + c] - wanted) <= 2, `${kernel} channel ${c} pixel ${i / 4}: ${out[i + c]} vs ${wanted}`);
      }
    }
  }
});

test('hard-mix outputs only black or white per channel', () => {
  const src = gradient();
  const out = apply('blend_hardmix', src, 16, 16, [200, 100, 50, 1.0]);
  for (let i = 0; i < src.length; i += 4) {
    for (let c = 0; c < 3; c += 1) {
      assert.ok(out[i + c] === 0 || out[i + c] === 255, `hard-mix must be binary, got ${out[i + c]}`);
    }
  }
});

test('blend opacity interpolates between source and blended result', () => {
  const src = gradient();
  const full = apply('blend_multiply', src, 16, 16, [200, 100, 50, 1.0]);
  const half = apply('blend_multiply', src, 16, 16, [200, 100, 50, 0.5]);
  for (let i = 0; i < src.length; i += 4) {
    assert.ok(Math.abs(half[i] - (src[i] + full[i]) / 2) <= 2, 'opacity 0.5 must sit halfway');
  }
});

test('alpha keys write the expected alpha channel', () => {
  const src = gradient();
  const keyed = apply('luma_key', src, 16, 16, [0.25, 0.75]);
  for (let i = 0; i < src.length; i += 4) {
    const wanted = clamp(((luma(src[i], src[i + 1], src[i + 2]) - 0.25 * 255) / (0.5 * 255)) * 255);
    assert.ok(Math.abs(keyed[i + 3] - wanted) <= 2, `alpha ${keyed[i + 3]} vs ${wanted}`);
  }

  const green = new Uint8Array([10, 250, 12, 255, 200, 30, 30, 255]);
  const chroma = apply('chroma_key_near', green, 2, 1, [0, 255, 0, 60]);
  assert.equal(chroma[3], 0, 'the green pixel must be keyed out');
  assert.equal(chroma[7], 255, 'the red pixel must stay opaque');
});

test('premultiply and unpremultiply round-trip', () => {
  const src = gradient();
  for (let i = 3; i < src.length; i += 4) src[i] = 128;
  const back = apply('unpremultiply', apply('premultiply', src, 16, 16), 16, 16);
  for (let i = 0; i < src.length; i += 4) {
    if (src[i] > 4) assert.ok(Math.abs(back[i] - src[i]) <= 2, `${back[i]} vs ${src[i]}`);
  }
});

test('equalise spreads the histogram and keeps the extremes', () => {
  const src = new Uint8Array(64 * 4);
  for (let i = 0; i < 64; i += 1) {
    const v = 100 + (i % 40);
    src[i * 4] = v;
    src[i * 4 + 1] = v;
    src[i * 4 + 2] = v;
    src[i * 4 + 3] = 255;
  }
  const out = apply('equalize', src, 8, 8);
  const min = Math.min(...out.filter((_, i) => i % 4 !== 3));
  const max = Math.max(...out.filter((_, i) => i % 4 !== 3));
  assert.ok(min <= 5, `expected the low end to reach black, got ${min}`);
  assert.ok(max >= 250, `expected the high end to reach white, got ${max}`);
});

test('color_balance shifts each channel by its parameter', () => {
  const src = gradient();
  const out = apply('color_balance', src, 16, 16, [0.1, -0.05, 0.0]);
  for (let i = 0; i < src.length; i += 4) {
    assert.ok(Math.abs(out[i] - clamp(src[i] + 0.1 * 255)) <= 1);
    assert.ok(Math.abs(out[i + 1] - clamp(src[i + 1] - 0.05 * 255)) <= 1);
    assert.equal(out[i + 2], src[i + 2]);
  }
});

test('vibrance leaves grey alone and boosts muted colour more than vivid colour', () => {
  const grey = new Uint8Array([120, 120, 120, 255, 120, 120, 120, 255]);
  assert.deepEqual([...apply('vibrance', grey, 2, 1, [1.0])], [...grey], 'vibrance must not touch neutral grey');

  const muted = new Uint8Array([120, 130, 125, 255]);
  const vivid = new Uint8Array([250, 20, 120, 255]);
  const spread = (buf) => {
    const out = apply('vibrance', buf, 1, 1, [1.0]);
    const ch = [out[0], out[1], out[2]];
    return Math.max(...ch) - Math.min(...ch);
  };
  const before = (buf) => { const ch = [buf[0], buf[1], buf[2]]; return Math.max(...ch) - Math.min(...ch) };
  assert.ok(spread(muted) - before(muted) > spread(vivid) - before(vivid), 'muted pixels should gain more');
});

test('noise is bounded, deterministic and actually perturbs the image', () => {
  for (const kernel of ['noise_uniform', 'noise_gaussian']) {
    const src = new Uint8Array(64 * 4).fill(128);
    for (let i = 3; i < src.length; i += 4) src[i] = 255;
    const first = apply(kernel, Uint8Array.from(src), 8, 8, [30]);
    const second = apply(kernel, Uint8Array.from(src), 8, 8, [30]);
    assert.deepEqual([...first], [...second], `${kernel} must be reproducible for a fixed image`);
    let changed = 0;
    for (let i = 0; i < first.length; i += 4) {
      assert.ok(Math.abs(first[i] - 128) <= 60, `${kernel} exceeded its bound: ${first[i]}`);
      assert.equal(first[i + 3], 255, `${kernel} must not touch alpha`);
      if (first[i] !== 128) changed += 1;
    }
    assert.ok(changed > 32, `${kernel} produced no visible noise`);
  }
});

test('normalize_stretch maps the observed range onto 0..255', () => {
  const src = new Uint8Array(16 * 4);
  for (let i = 0; i < 16; i += 1) {
    const v = 100 + i;
    src[i * 4] = v;
    src[i * 4 + 1] = v;
    src[i * 4 + 2] = v;
    src[i * 4 + 3] = 255;
  }
  const out = apply('normalize_stretch', src, 4, 4);
  assert.equal(out[0], 0);
  assert.equal(out[15 * 4], 255);
});
