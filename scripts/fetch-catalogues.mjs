// Downloads the public catalogues the inventory is derived from, so the >=200 claim is
// reproducible instead of typed by hand.
//
//   node scripts/fetch-catalogues.mjs
import { writeFileSync } from 'node:fs';

const get = async (url) => {
  const res = await fetch(url, { headers: { 'user-agent': 'wasm-pixel-kernels inventory fetch' } });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.text();
};

const ffmpegHtml = await get('https://ffmpeg.org/ffmpeg-filters.html');
// Chapter 11 of the manual is the video-filter reference; audio/source/sink and the
// hardware-specific chapters are deliberately excluded.
const videoFilters = [...ffmpegHtml.matchAll(/<h3 class="section">11\.\d+ ([a-z0-9_]{2,28})</g)].map((m) => m[1]);
writeFileSync('inventory/ffmpeg-video-filters.txt', [...new Set(videoFilters)].sort().join('\n') + '\n');

const header = await get('https://raw.githubusercontent.com/opencv/opencv/4.x/modules/imgproc/include/opencv2/imgproc.hpp');
const fns = [...header.matchAll(/^\s*CV_EXPORTS(?:_W)?[^;=]*?\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/gm)]
  .map((m) => m[1])
  .filter((n) => !/^(operator|if|for|while|return|switch|sizeof)$/.test(n));
writeFileSync('inventory/opencv-imgproc-fns.txt', [...new Set(fns)].sort().join('\n') + '\n');

console.log(JSON.stringify({
  ffmpegVideoFilters: new Set(videoFilters).size,
  opencvImgprocFunctions: new Set(fns).size,
}));
