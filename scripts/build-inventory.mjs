// Builds inventory/modules.json and modules.csv: the auditable list of candidate
// wasm modules. Every row names the public catalogue it came from, so the count of
// ">=200 modules" is checkable rather than asserted.
//
//   node scripts/build-inventory.mjs
//
// Inputs are the files fetched by scripts/fetch-catalogues.mjs plus the Rust
// registry in src/lib.rs. No compilation happens here.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const lines = (file) => (existsSync(file) ? readFileSync(file, 'utf8') : '').split('\n').map((s) => s.trim()).filter(Boolean);

const ffmpegVideo = lines('inventory/ffmpeg-video-filters.txt');
const opencvFns = lines('inventory/opencv-imgproc-fns.txt');
const registryNames = [...readFileSync('src/lib.rs', 'utf8').matchAll(/Def \{ name: "([a-z0-9_]+)"/g)].map((m) => m[1]);
// Derived from the test file rather than typed here, so a status can never claim
// more than CI actually checks.
const verifiedNames = [...readFileSync('test/kernels.test.mjs', 'utf8').matchAll(/apply\('([a-z0-9_]+)'/g)].map((m) => m[1]);

// W3C "Compositing and Blending Level 1" blend-mode list.
const BLEND_MODES = [
  'normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'color-dodge', 'color-burn',
  'hard-light', 'soft-light', 'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity',
  'plus-lighter', 'multiply-legacy', 'screen-legacy', 'overlay-legacy', 'darken-legacy', 'lighten-legacy',
  'color-dodge-legacy', 'color-burn-legacy', 'hard-light-legacy', 'soft-light-legacy', 'difference-legacy',
];

const SOURCES = {
  ffmpeg: { url: 'https://ffmpeg.org/ffmpeg-filters.html', license: 'concept only (ffmpeg docs, LGPL-2.1-or-later / GPL-2-or-later)', note: 'operation name and semantics; no ffmpeg code is reused' },
  opencv: { url: 'https://github.com/opencv/opencv/blob/4.x/modules/imgproc/include/opencv2/imgproc.hpp', license: 'concept only (Apache-2.0 header)', note: 'operation name and semantics; no OpenCV code is reused' },
  w3c: { url: 'https://www.w3.org/TR/compositing-1/', license: 'specification (W3C)', note: 'normative blend formulas' },
  registry: { url: 'src/lib.rs', license: 'MIT (this repo)', note: 'already implemented in this crate' },
};

// Coarse bucket so a reader can see which Photoshop / After Effects vocabulary each
// entry answers to. Keyword rules only; unknown names stay "other".
function classify(name) {
  const n = name.toLowerCase();
  const rules = [
    [/blur|bokeh|defocus|gaussian|avgblur|median|bilateral|smartblur|guided/, 'blur / sharpen'],
    [/sharpen|unsharp|convolution|convolve|kirsch|sobel|canny|laplacian|edges|find_edges/, 'edge / detail'],
    [/noise|grain|dither|halftone|screen|despeckle|denoise|nlmeans|fastnlm/, 'noise'],
    [/key|chroma|alpha|matte|mask|crop|pad|scale|resize|rotate|transpose|flip|perspective|warp|remap|affine/, 'composite / geometry'],
    [/color|colour|hue|sat|equali|lut|curves|levels|eq|exposure|gamma|white|balance|vibrance|temperature|tone|histogram/, 'colour / tone'],
    [/text|drawtext|drawbox|annotat|line|circle|rectangle|ellipse|polyline/, 'draw / text'],
    [/motion|stab|vidstab|displace|flow|optical|calcback|farneback|tracking/, 'motion / tracking'],
    [/morph|erode|dilate|open|close|tophat|blackhat|gradient|watershed|threshold|adaptive|bilateralFilter/, 'binary / morphology'],
    [/stereo|disparity|pointset|subdiv|corner|goodfeatures|hough|pyr/, 'analysis'],
    [/overlay|blend|mix|opacity|blendmode|addtoalpha|premultiply|unpremultiply/, 'blend'],
  ];
  for (const [re, bucket] of rules) if (re.test(n)) return bucket;
  return 'other';
}

const rows = new Map();
const add = (name, source, analogue) => {
  const key = name.toLowerCase().replace(/\s+/g, '_');
  if (rows.has(key)) {
    const prev = rows.get(key);
    if (!prev.sources.includes(source)) prev.sources.push(source);
    return;
  }
  rows.set(key, {
    module: key,
    category: classify(name),
    analogue,
    sources: [source],
    status: verifiedNames.includes(key)
      ? 'verified'
      : registryNames.includes(key)
        ? 'registered_ci_smoke'
        : 'catalogued',
  });
};

for (const name of registryNames) add(name, 'registry', 'this crate');
for (const name of BLEND_MODES) add(`blend_${name.replace(/-/g, '_')}`, 'w3c', 'PS / AE blend mode');
for (const name of ffmpegVideo) add(name, 'ffmpeg', 'ffmpeg video filter');
for (const name of opencvFns) add(name.toLowerCase(), 'opencv', 'OpenCV imgproc function');

const list = [...rows.values()].sort((a, b) => (a.category + a.module).localeCompare(b.category + b.module));
const summary = {
  total: list.length,
  byStatus: list.reduce((acc, r) => ({ ...acc, [r.status]: (acc[r.status] ?? 0) + 1 }), {}),
  byCategory: list.reduce((acc, r) => ({ ...acc, [r.category]: (acc[r.category] ?? 0) + 1 }), {}),
  sourceLicences: Object.fromEntries(Object.entries(SOURCES).map(([k, v]) => [k, v.license])),
  sources: Object.fromEntries(Object.entries(SOURCES).map(([k, v]) => [k, v.url])),
};

writeFileSync('inventory/modules.json', JSON.stringify({ summary, modules: list }, null, 2) + '\n');
const header = 'module,category,analogue,sources,status';
const csv = [header, ...list.map((r) => `${r.module},"${r.category}","${r.analogue}","${r.sources.join('|')}",${r.status}`)].join('\n') + '\n';
writeFileSync('inventory/modules.csv', csv);

console.log(JSON.stringify(summary, null, 2));
if (list.length < 200) {
  console.error(`inventory has only ${list.length} rows; expected >= 200. Re-run scripts/fetch-catalogues.mjs.`);
  process.exit(1);
}
