// 逐像素对比两张 PNG（用于"聚焦 / 失焦"这类 A/B 外观实验）。
//
// 复用 tools/dev/zoom_region.js 里的纯 JS PNG 解码（不依赖任何第三方库）。
//
// 用法: node tools/dev/png_diff.js <a.png> <b.png> [x y w h]
//   给了矩形就只比那块（坐标按图内像素）。
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ---- 从 zoom_region.js 抠出 decodePNG（避免复制粘贴导致两份实现漂移）
const zsrc = fs.readFileSync(path.join(__dirname, 'zoom_region.js'), 'utf8');
const s0 = zsrc.indexOf('function decodePNG');
if (s0 < 0) { console.error('zoom_region.js 里找不到 decodePNG'); process.exit(2); }
let i = zsrc.indexOf('{', s0); let depth = 0; let s1 = -1;
for (; i < zsrc.length; i++) {
  const c = zsrc[i];
  if (c === '{') depth++;
  else if (c === '}') { depth--; if (!depth) { s1 = i + 1; break; } }
}
const decodePNG = new Function('zlib', zsrc.slice(s0, s1) + '\nreturn decodePNG;')(zlib);

const [fa, fb, xs, ys, ws, hs] = process.argv.slice(2);
if (!fa || !fb) { console.error('用法: node tools/dev/png_diff.js <a.png> <b.png> [x y w h]'); process.exit(2); }
const A = decodePNG(fs.readFileSync(fa));
const B = decodePNG(fs.readFileSync(fb));
if (A.w !== B.w || A.h !== B.h) {
  console.error('尺寸不同：' + A.w + 'x' + A.h + ' vs ' + B.w + 'x' + B.h);
  process.exit(3);
}
const x0 = xs ? Math.max(0, Number(xs)) : 0;
const y0 = ys ? Math.max(0, Number(ys)) : 0;
const w = ws ? Math.min(Number(ws), A.w - x0) : A.w;
const h = hs ? Math.min(Number(hs), A.h - y0) : A.h;

const px = (img, x, y) => {
  const o = y * img.stride + x * img.ch;
  return [ img.data[o], img.data[img.ch >= 3 ? o + 1 : o], img.data[img.ch >= 3 ? o + 2 : o] ];
};

let sum = 0, n = 0, big = 0, maxD = 0, maxAt = null;
for (let y = y0; y < y0 + h; y++) {
  for (let x = x0; x < x0 + w; x++) {
    const a = px(A, x, y); const b = px(B, x, y);
    const d = (Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2])) / 3;
    sum += d; n++;
    if (d > 12) big++;
    if (d > maxD) { maxD = d; maxAt = [ x, y, a, b ]; }
  }
}
console.log('区域 ' + w + 'x' + h + ' @(' + x0 + ',' + y0 + ')  共 ' + n + ' 像素');
console.log('平均差 ' + (sum / n).toFixed(2) + ' / 255     差异>12 的占 ' + (big / n * 100).toFixed(1) + '%');
console.log('最大差 ' + maxD.toFixed(1) + ' 在 (' + maxAt[0] + ',' + maxAt[1] + ')  A=' + maxAt[2] + '  B=' + maxAt[3]);

// 16x16 分块找差异最大的 5 块（看清"是整块变实还是局部变化"）
const blocks = [];
for (let by = y0; by + 16 <= y0 + h; by += 16) {
  for (let bx = x0; bx + 16 <= x0 + w; bx += 16) {
    let s = 0, m = 0, ar = 0, ag = 0, ab = 0, br = 0, bg = 0, bb = 0;
    for (let y = by; y < by + 16; y++) {
      for (let x = bx; x < bx + 16; x++) {
        const a = px(A, x, y); const b = px(B, x, y);
        s += (Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2])) / 3; m++;
        ar += a[0]; ag += a[1]; ab += a[2]; br += b[0]; bg += b[1]; bb += b[2];
      }
    }
    blocks.push({ bx, by, d: s / m, a: [ ar / m | 0, ag / m | 0, ab / m | 0 ], b: [ br / m | 0, bg / m | 0, bb / m | 0 ] });
  }
}
blocks.sort((p, q) => q.d - p.d);
console.log('\n差异最大的 5 个 16x16 块：');
for (const k of blocks.slice(0, 5)) {
  console.log('  (' + k.bx + ',' + k.by + ')  差 ' + k.d.toFixed(1)
    + '   A(rgb)=' + k.a.join(',') + '   B(rgb)=' + k.b.join(','));
}
