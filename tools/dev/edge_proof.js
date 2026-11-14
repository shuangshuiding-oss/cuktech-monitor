'use strict';
/**
 * 决定性验证：窗口外缘是否存在**系统白色描边**。
 *
 * corner_check2.js 的教训：玻璃边缘的抗锯齿像素会与窗外亮内容混合产生近白像素，
 * 那不是描边。本脚本改用更严格的判据 —— 真正的系统描边是一条**连续、不透明、
 * 颜色恒定**的浅色线（通常 rgb 在 200~255 且几乎不透明、alpha=255）。
 *
 * 做法：分别统计"窗口边框外 1px 带"和"窗口边框内 1px 带"的
 *   - 近纯白像素数 (r,g,b > 235)
 *   - 是否成"连续段"（描边的特征是长连续，抗锯齿不会）
 * 并用"窗口外 1px 带" 与 "更外面 3px 带" 的亮度差判断有无突兀描边。
 *
 * 用法: node tools/dev/edge_proof.js <png> [pad=80]
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
const img = decodePNG(fs.readFileSync(process.argv[2]));
const px = (x, y) => {
  const i = y * img.w * img.ch + x * img.ch;
  return [img.data[i], img.data[i + 1], img.data[i + 2]];
};
const lum = ([r, g, b]) => (r * 299 + g * 587 + b * 114) / 1000;
const white = ([r, g, b]) => r > 235 && g > 235 && b > 235;

const WX = PAD, WY = PAD, WW = img.w - PAD * 2, WH = img.h - PAD * 2;
console.log(`图片 ${img.w}x${img.h}  窗口 = (${WX},${WY}) ${WW}x${WH}  r=${R}`);

// 四角切角区（边长 r）—— 那里的窗口边缘是弧线，跳过
const nearCorner = (x, y, m) =>
  (x < WX + R + m || x >= WX + WW - R - m) && (y < WY + R + m || y >= WY + WH - R - m);

// 取"窗口四条直边的外 1px / 内 1px"，避开圆角
function scanEdge(name, getX, getY) {
  let outerWhite = 0, innerWhite = 0, n = 0, runMax = 0, run = 0;
  for (let d = 0; d < Math.max(WW, WH); d++) {
    const x = getX(d), y = getY(d);
    if (x < 0 || y < 0 || x >= img.w || y >= img.h) continue;
    if (nearCorner(x, y, 2)) { run = 0; continue; }
    n++;
    if (white(px(x, y))) { outerWhite++; run++; runMax = Math.max(runMax, run); } else run = 0;
  }
  console.log(`  ${name}: 采样 ${n}，外缘近纯白 ${outerWhite}，最长连续段 ${runMax}`);
  return { n, outerWhite, runMax };
}

const top = scanEdge('上边外1px', (d) => WX + d, () => WY - 1);
const bot = scanEdge('下边外1px', (d) => WX + d, () => WY + WH);
const lef = scanEdge('左边外1px', () => WX - 1, (d) => WY + d);
const rig = scanEdge('右边外1px', () => WX + WW, (d) => WY + d);

// 内缘（窗口内侧 1px）—— 如果系统描边盖住了窗口，这里也会是白
const topI = scanEdge('上边内1px', (d) => WX + d, () => WY + 1);
const lefI = scanEdge('左边内1px', () => WX + 1, (d) => WY + d);

const totalOuterWhite = top.outerWhite + bot.outerWhite + lef.outerWhite + rig.outerWhite;
const maxRun = Math.max(top.runMax, bot.runMax, lef.runMax, rig.runMax);

console.log('');
console.log(`外缘近纯白合计 = ${totalOuterWhite}，最长连续段 = ${maxRun}px`);
console.log(maxRun >= 60
  ? `RESULT: FAIL —— 外缘存在 ${maxRun}px 连续白线（疑似系统描边）`
  : 'RESULT: PASS —— 外缘无连续白线（无系统描边）');

// 附加：圆角弧线上是否有白色
let arcWhite = 0, arcN = 0;
const corners = [[WX, WY, 1, 1], [WX + WW - 1, WY, -1, 1], [WX, WY + WH - 1, 1, -1], [WX + WW - 1, WY + WH - 1, -1, -1]];
for (const [cx, cy, sx, sy] of corners) {
  for (let a = 0; a <= 90; a += 2) {
    const rad = (a * Math.PI) / 180;
    const x = Math.round(cx + sx * (R + 1.5) * Math.cos(rad));
    const y = Math.round(cy + sy * (R + 1.5) * Math.sin(rad));
    if (x < 0 || y < 0 || x >= img.w || y >= img.h) continue;
    arcN++;
    if (white(px(x, y))) arcWhite++;
  }
}
console.log(`圆角弧线外侧(半径${R}+1.5) 采样 ${arcN}，近纯白 ${arcWhite}`);
