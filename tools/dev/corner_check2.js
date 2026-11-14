'use strict';
/**
 * 窗口"白边 / 圆角残留"检测（严格版）。
 *
 * 历史教训（两个假阳性来源，务必看）：
 *   1) 截图里窗口外面拍进了桌面/别的窗口，那些像素本来就有白色（例如白底文档、
 *      浏览器白页）。早期版本"整张图统计偏白"会把它们全算进来 —— 误报。
 *   2) 大圆角（r=36）切掉四角，切角区里**没有窗口像素**，看到的是窗外内容；
 *      在那里取点同样会命中窗外白色 —— 也是误报。
 *   3) 玻璃边缘的抗锯齿像素会与窗外亮内容混合，产生零星的近白像素 —— 不是描边。
 *
 * 真正的"系统白描边"特征：沿窗口边缘形成一条**连续、颜色恒定**的浅色线。
 * 所以本脚本的判据是"**最长连续段**"，而不是"白色像素计数"：
 *   - 沿四条直边的外 1px 带逐点扫描；
 *   - 跳过四角 r 的切角区；
 *   - 统计近纯白像素的**最长连续长度**，>= 60px 才判为描边。
 * 另外补一条"圆角弧线外侧"扫描，防止描边沿弧线绕过去。
 *
 * 用法: node tools/dev/corner_check2.js <png> [pad=80] [radius=36]
 *   pad 来自 /screen 响应里的 crop 与窗口 bounds 之差（默认 80）。
 */
const fs = require('fs');
const zlib = require('zlib');

function decodePNG(buf) {
  let pos = 8, w = 0, h = 0, ct = 0, bd = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const t = buf.toString('ascii', pos + 4, pos + 8);
    const d = buf.slice(pos + 8, pos + 8 + len);
    if (t === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); bd = d[8]; ct = d[9]; }
    else if (t === 'IDAT') idat.push(d);
    else if (t === 'IEND') break;
    pos += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const ch = ct === 6 ? 4 : ct === 2 ? 3 : 1;
  const bpp = ch * (bd / 8);
  const stride = w * bpp;
  const out = Buffer.alloc(h * stride);
  let rp = 0;
  for (let y = 0; y < h; y++) {
    const ft = raw[rp++];
    const line = raw.slice(rp, rp + stride); rp += stride;
    const prev = y > 0 ? out.slice((y - 1) * stride, y * stride) : Buffer.alloc(stride);
    const cur = out.slice(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      let v = line[x];
      if (ft === 1) v += a;
      else if (ft === 2) v += b;
      else if (ft === 3) v += (a + b) >> 1;
      else if (ft === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      cur[x] = v & 0xff;
    }
  }
  return { w, h, ch, data: out };
}

const PAD = Number(process.argv[3] || 80);
const R = Number(process.argv[4] || 36);
const RUN_LIMIT = Number(process.argv[5] || 60); // 连续多少像素才判为"线"
const img = decodePNG(fs.readFileSync(process.argv[2]));
const px = (x, y) => {
  const i = y * img.w * img.ch + x * img.ch;
  return [img.data[i], img.data[i + 1], img.data[i + 2]];
};
const white = ([r, g, b]) => r > 235 && g > 235 && b > 235;

const WX = PAD, WY = PAD, WW = img.w - PAD * 2, WH = img.h - PAD * 2;
console.log(`图片 ${img.w}x${img.h}  窗口 = (${WX},${WY}) ${WW}x${WH}  r=${R}  连续阈值=${RUN_LIMIT}px`);

const nearCorner = (x, y, m) =>
  (x < WX + R + m || x >= WX + WW - R - m) && (y < WY + R + m || y >= WY + WH - R - m);

function scanEdge(name, getX, getY) {
  let cnt = 0, n = 0, runMax = 0, run = 0;
  for (let d = 0; d < Math.max(WW, WH); d++) {
    const x = getX(d), y = getY(d);
    if (x < 0 || y < 0 || x >= img.w || y >= img.h) continue;
    if (nearCorner(x, y, 2)) { run = 0; continue; }
    n++;
    if (white(px(x, y))) { cnt++; run++; runMax = Math.max(runMax, run); } else run = 0;
  }
  console.log(`  ${name}: 采样 ${n}，近纯白 ${cnt}，最长连续 ${runMax}`);
  return { n, cnt, runMax };
}

const edges = [
  scanEdge('上边外1px', (d) => WX + d, () => WY - 1),
  scanEdge('下边外1px', (d) => WX + d, () => WY + WH),
  scanEdge('左边外1px', () => WX - 1, (d) => WY + d),
  scanEdge('右边外1px', () => WX + WW, (d) => WY + d),
  scanEdge('上边内1px', (d) => WX + d, () => WY + 1),
  scanEdge('左边内1px', () => WX + 1, (d) => WY + d),
];

const totalWhite = edges.reduce((s, e) => s + e.cnt, 0);
const maxRun = Math.max(...edges.map((e) => e.runMax));

// 圆角弧线外侧 —— 防止描边沿弧线绕
let arcWhite = 0, arcN = 0;
for (const [cx, cy, sx, sy] of [
  [WX, WY, 1, 1], [WX + WW - 1, WY, -1, 1],
  [WX, WY + WH - 1, 1, -1], [WX + WW - 1, WY + WH - 1, -1, -1],
]) {
  for (let a = 0; a <= 90; a += 2) {
    const rad = (a * Math.PI) / 180;
    const x = Math.round(cx + sx * (R + 1.5) * Math.cos(rad));
    const y = Math.round(cy + sy * (R + 1.5) * Math.sin(rad));
    if (x < 0 || y < 0 || x >= img.w || y >= img.h) continue;
    arcN++;
    if (white(px(x, y))) arcWhite++;
  }
}

console.log('');
console.log(`边缘近纯白合计 ${totalWhite}，最长连续 ${maxRun}px；圆角弧线外侧 ${arcWhite}/${arcN}`);
const fail = maxRun >= RUN_LIMIT || arcWhite >= 10;
console.log(fail
  ? `RESULT: FAIL —— 外缘存在 ${maxRun}px 连续白线（圆角弧 ${arcWhite}），疑似系统描边`
  : 'RESULT: PASS —— 窗口边缘与圆角均无系统白描边');
process.exit(fail ? 1 : 0);
