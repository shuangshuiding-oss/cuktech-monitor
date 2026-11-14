'use strict';
/**
 * 扫描截图的边缘剖面，找出**窗口真实边界**，用来校正 pad/裁剪假设。
 *
 * 思路：沿图片的中间行/中间列做亮度剖面，窗口（深色玻璃）与窗外（桌面）之间
 * 会有明显的亮度台阶。打印若干候选边界，方便和 crop 参数对账。
 *
 * 用法: node tools/dev/edge_profile.js <png>
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

const img = decodePNG(fs.readFileSync(process.argv[2]));
const lum = (x, y) => {
  const i = y * img.w * img.ch + x * img.ch;
  return (img.data[i] * 299 + img.data[i + 1] * 587 + img.data[i + 2] * 114) / 1000;
};
const rgb = (x, y) => {
  const i = y * img.w * img.ch + x * img.ch;
  return [img.data[i], img.data[i + 1], img.data[i + 2]];
};

console.log(`图片 ${img.w}x${img.h}`);

// 中间行：从左往右打印前 140 px，找窗口左边界
const midY = Math.round(img.h / 2);
console.log(`\n--- 中间行 y=${midY} 左侧剖面（每 2px） ---`);
let prev = null;
for (let x = 0; x < 160; x += 2) {
  const c = rgb(x, midY), l = lum(x, midY);
  const d = prev === null ? 0 : Math.abs(l - prev);
  if (d > 18 || x < 8) console.log(`  x=${String(x).padStart(4)}  rgb(${c.join(',')})  lum=${l.toFixed(0)}` + (d > 18 ? `   <== 台阶 Δ${d.toFixed(0)}` : ''));
  prev = l;
}

// 中间列：从上往下找窗口上边界
const midX = Math.round(img.w / 2);
console.log(`\n--- 中间列 x=${midX} 上侧剖面（每 2px） ---`);
prev = null;
for (let y = 0; y < 160; y += 2) {
  const c = rgb(midX, y), l = lum(midX, y);
  const d = prev === null ? 0 : Math.abs(l - prev);
  if (d > 18 || y < 8) console.log(`  y=${String(y).padStart(4)}  rgb(${c.join(',')})  lum=${l.toFixed(0)}` + (d > 18 ? `   <== 台阶 Δ${d.toFixed(0)}` : ''));
  prev = l;
}

// 右侧/下侧
console.log(`\n--- 中间行 y=${midY} 右侧剖面（每 2px） ---`);
prev = null;
for (let x = img.w - 1; x > img.w - 160; x -= 2) {
  const c = rgb(x, midY), l = lum(x, midY);
  const d = prev === null ? 0 : Math.abs(l - prev);
  if (d > 18 || x > img.w - 9) console.log(`  x=${String(x).padStart(4)}  rgb(${c.join(',')})  lum=${l.toFixed(0)}` + (d > 18 ? `   <== 台阶 Δ${d.toFixed(0)}` : ''));
  prev = l;
}
console.log(`\n--- 中间列 x=${midX} 下侧剖面（每 2px） ---`);
prev = null;
for (let y = img.h - 1; y > img.h - 160; y -= 2) {
  const c = rgb(midX, y), l = lum(midX, y);
  const d = prev === null ? 0 : Math.abs(l - prev);
  if (d > 18 || y > img.h - 9) console.log(`  y=${String(y).padStart(4)}  rgb(${c.join(',')})  lum=${l.toFixed(0)}` + (d > 18 ? `   <== 台阶 Δ${d.toFixed(0)}` : ''));
  prev = l;
}
