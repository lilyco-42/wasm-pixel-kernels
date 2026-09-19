// Numeric references for the neighbourhood kernels. Expectations come from the
// textbook definition of each operator (3x3 convolution, order statistics, mean over
// a window), not from src/lib.rs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { apply, gradient, clamp } from './helpers.mjs';

const W = 16;
const H = 16;
const at = (buf, x, y, c) => buf[(Math.max(0, Math.min(H - 1, y)) * W + Math.max(0, Math.min(W - 1, x))) * 4 + c];

function convolve3(buf, x, y, c, kernel, divisor = 1, bias = 0) {
  let acc = 0;
  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      acc += kernel[dy + 1][dx + 1] * at(buf, x + dx, y + dy, c);
    }
  }
  return clamp(acc / divisor + bias);
}

const orderStats = (buf, x, y, c, pick) => {
  const vals = [];
  for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) vals.push(at(buf, x + dx, y + dy, c));
  vals.sort((a, b) => a - b);
  return clamp(pick(vals));
};

const boxMean = (buf, x, y, c, r) => {
  let sum = 0;
  let n = 0;
  for (let k = -r; k <= r; k += 1) { sum += at(buf, x + k, y, c); n += 1 }
  return sum / n;
};

function checkChannel(kernel, expected, params = [], tolerance = 1) {
  const src = gradient();
  const out = apply(kernel, src, W, H, params);
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      for (let c = 0; c < 3; c += 1) {
        const i = (y * W + x) * 4 + c;
        const want = expected(src, x, y, c, params);
        assert.ok(Math.abs(out[i] - want) <= tolerance, `${kernel} at ${x},${y} ch${c}: ${out[i]} vs ${want}`);
      }
    }
  }
  return out;
}

test('blur3x3 is the 3x3 mean', () => {
  checkChannel('blur3x3', (b, x, y, c) => convolve3(b, x, y, c, [[1, 1, 1], [1, 1, 1], [1, 1, 1]], 9));
});

test('sharpen3x3, emboss, sobel and laplacian match their kernels', () => {
  checkChannel('sharpen3x3', (b, x, y, c) => convolve3(b, x, y, c, [[0, -1, 0], [-1, 5, -1], [0, -1, 0]]));
  checkChannel('emboss', (b, x, y, c) => convolve3(b, x, y, c, [[-2, -1, 0], [-1, 1, 1], [0, 1, 2]]));
  checkChannel('sobel_x', (b, x, y, c) => convolve3(b, x, y, c, [[-1, 0, 1], [-2, 0, 2], [-1, 0, 1]]));
  checkChannel('sobel_y', (b, x, y, c) => convolve3(b, x, y, c, [[-1, -2, -1], [0, 0, 0], [1, 2, 1]]));
  checkChannel('laplacian', (b, x, y, c) => convolve3(b, x, y, c, [[0, 1, 0], [1, -4, 1], [0, 1, 0]]));
});

test('median, erode and dilate are order statistics over the 3x3 window', () => {
  checkChannel('median3x3', (b, x, y, c) => orderStats(b, x, y, c, (v) => v[4]));
  checkChannel('erode3x3', (b, x, y, c) => orderStats(b, x, y, c, (v) => v[0]));
  checkChannel('dilate3x3', (b, x, y, c) => orderStats(b, x, y, c, (v) => v[8]));
});

test('box_blur is a separable mean over the requested radius', () => {
  const r = 2;
  const horizontal = new Uint8Array(W * H * 4);
  const src = gradient();
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      for (let c = 0; c < 3; c += 1) horizontal[(y * W + x) * 4 + c] = clamp(boxMean(src, x, y, c, r));
    }
  }
  checkChannel('box_blur', (_b, x, y, c) => {
    let sum = 0;
    for (let k = -r; k <= r; k += 1) sum += at(horizontal, x, y + k, c);
    return clamp(sum / (2 * r + 1));
  }, [r]);
});

test('gaussian_blur is three box passes and blurs harder than one', () => {
  const src = gradient();
  const box = apply('box_blur', src, W, H, [2]);
  const gauss = apply('gaussian_blur', src, W, H, [2]);
  const roughness = (buf) => {
    let acc = 0;
    for (let y = 1; y < H - 1; y += 1) for (let x = 1; x < W - 1; x += 1) acc += Math.abs(at(buf, x + 1, y, 0) - at(buf, x - 1, y, 0));
    return acc;
  };
  assert.ok(roughness(gauss) < roughness(box), 'three box passes must smooth more than one');
});

test('motion_blur_h averages along the horizontal only', () => {
  const r = 3;
  checkChannel('motion_blur_h', (b, x, y, c) => clamp(boxMean(b, x, y, c, r)), [r]);
});

test('pixelate samples the centre of each cell', () => {
  const cell = 4;
  checkChannel('pixelate', (b, x, y, c) => {
    const bx = Math.floor(x / cell) * cell + Math.floor(cell / 2);
    const by = Math.floor(y / cell) * cell + Math.floor(cell / 2);
    return at(b, bx, by, c);
  }, [cell]);
});

test('unsharp_mask amplifies the difference from the 3x3 mean', () => {
  const amount = 1.5;
  checkChannel('unsharp_mask', (b, x, y, c) => {
    const mean = boxMean(b, x, y, c, 1);
    return clamp(b[(y * W + x) * 4 + c] + amount * (b[(y * W + x) * 4 + c] - mean));
  }, [amount]);
});

test('high_pass is the 3x3 high-pass kernel offset by mid grey', () => {
  checkChannel('high_pass', (b, x, y, c) => convolve3(b, x, y, c, [[-1, -1, -1], [-1, 9, -1], [-1, -1, -1]], 1, 128));
});

test('vignette darkens corners but not the centre', () => {
  const src = new Uint8Array(W * H * 4).fill(200);
  for (let i = 3; i < src.length; i += 4) src[i] = 255;
  const out = apply('vignette', src, W, H, [0.8]);
  const centre = at(out, W / 2, H / 2, 0);
  const corner = at(out, 0, 0, 0);
  assert.ok(corner < centre, `corner ${corner} should be darker than centre ${centre}`);
  assert.ok(centre <= 200 && centre >= 190, `centre should stay near the input, got ${centre}`);
});

test('dither_bayer4 follows the standard 4x4 matrix', () => {
  const bayer = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]];
  const levels = 4;
  checkChannel('dither_bayer4', (b, x, y, c) => {
    const t = bayer[y % 4][x % 4] / 16 - 0.5;
    const scaled = (b[(y * W + x) * 4 + c] / 255) * (levels - 1) + t;
    return clamp(Math.round(scaled) * (255 / (levels - 1)));
  }, [levels], 2);
});
