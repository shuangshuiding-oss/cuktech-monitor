'use strict';
/**
 * 「窗口相对」区域对比：两张 /screen 截图尺寸/裁剪不同也能比。
 *
 * 为什么需要它（png_diff.js 不够用的地方）：/screen 的裁剪框是**跟着窗口 bounds 走的**，
 * 一旦窗口位置变了（用户拖动 / 贴边被裁），两张图的尺寸就不一样，png_diff 直接报"尺寸不同"退出。
 * 而做「聚焦 vs 失焦」这类 A/B 时真正要比的是**窗口内同一相对位置**的像素 —— 所以这里
 * 显式传入两张图各自窗口左上角的图内坐标，只比窗口内部那块。
 *
 * 用法:
 *   node tools/dev/region_diff.js <a.png> <ax> <ay> <b.png> <bx> <by> <w> <h>
 *   例：node tools/dev/region_diff.js a.png 80 80 b.png 80 80 1100 1213
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// 复用 zoom_region.js 的 decodePNG（避免两份实现漂移）
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

const a = process.argv.slice(2);
if (a.length < 8) {
  console.error('用法: node tools/dev/region_diff.js <a.png> <ax> <ay> <b.png> <bx> <by> <w> <h>');
  process.exit(2);
}
const [fa, axs, ays, fb, bxs, bys, ws, hs] = a;
const A = decodePNG(fs.readFileSync(fa));
const B = decodePNG(fs.readFileSync(fb));
const ax0 = Number(axs) | 0, ay0 = Number(ays) | 0;
const bx0 = Number(bxs) | 0, by0 = Number(bys) | 0;
const w = Math.min(Number(ws) | 0, A.w - ax0, B.w - bx0);
const h = Math.min(Number(hs) | 0, A.h - ay0, B.h - by0);
if (w <= 0 || h <= 0) { console.error('区域越界'); process.exit(3); }

const px = (img, x, y) => {
  const o = y * img.stride + x * img.ch;
  return [img.data[o], img.data[o + 1], img.data[o + 2]];
};

let sum = 0, n = 0, big = 0, maxD = 0, maxAt = null;
const blocks = [];
for (let by = 0; by + 16 <= h; by += 16) {
  for (let bx = 0; bx + 16 <= w; bx += 16) {
    let s = 0, m = 0, ar = 0, ag = 0, ab = 0, br = 0, bg = 0, bb = 0;
    for (let y = by; y < by + 16; y++) {
      for (let x = bx; x < bx + 16; x++) {
        const p = px(A, ax0 + x, ay0 + y); const q = px(B, bx0 + x, by0 + y);
        const d = (Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) + Math.abs(p[2] - q[2])) / 3;
        s += d; m++; sum += d; n++;
        if (d > 12) big++;
        if (d > maxD) { maxD = d; maxAt = [x, y, p, q]; }
        ar += p[0]; ag += p[1]; ab += p[2]; br += q[0]; bg += q[1]; bb += q[2];
      }
    }
    blocks.push({ bx, by, d: s / m, a: [ar / m | 0, ag / m | 0, ab / m | 0], b: [br / m | 0, bg / m | 0, bb / m | 0] });
  }
}
const avg = (arr, i) => Math.round(arr.reduce((s2, v) => s2 + v[i], 0) / arr.length);
const meanA = [avg(blocks.map((k) => k.a), 0), avg(blocks.map((k) => k.a), 1), avg(blocks.map((k) => k.a), 2)];
const meanB = [avg(blocks.map((k) => k.b), 0), avg(blocks.map((k) => k.b), 1), avg(blocks.map((k) => k.b), 2)];

console.log('窗口相对区域 ' + w + 'x' + h + '（A 图内起点 ' + ax0 + ',' + ay0 + '，B 图内起点 ' + bx0 + ',' + by0 + '）');
console.log('平均差 ' + (sum / n).toFixed(2) + ' / 255     差异>12 的占 ' + (big / n * 100).toFixed(1) + '%');
console.log('平均色 A=' + meanA.join(',') + '  B=' + meanB.join(','));
console.log('最大差 ' + maxD.toFixed(1) + ' 在窗口相对 (' + maxAt[0] + ',' + maxAt[1] + ')  A=' + maxAt[2] + '  B=' + maxAt[3]);
blocks.sort((p, q) => q.d - p.d);
console.log('\n差异最大的 5 个 16x16 块（坐标是窗口相对的）：');
for (const k of blocks.slice(0, 5)) {
  console.log('  (' + k.bx + ',' + k.by + ')  差 ' + k.d.toFixed(1)
    + '   A(rgb)=' + k.a.join(',') + '   B(rgb)=' + k.b.join(','));
}
