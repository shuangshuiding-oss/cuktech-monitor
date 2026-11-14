'use strict';
// 检查窗口截图的四角与边缘有没有"白色残留"。
// 用法: node tools/dev/corner_check.js <png> [box]
// 判据：四角 40x40 与最外 3px 里，接近纯白（RGB 全 >200 且互相接近）的像素数。
const fs = require('fs');
const zlib = require('zlib');

function decodePNG(buf) {
  let pos = 8, w = 0, h = 0, ct = 0, bd = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.slice(pos + 8, pos + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); bd = data[8]; ct = data[9]; }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const ch = ct === 6 ? 4 : ct === 2 ? 3 : ct === 0 ? 1 : 4;
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

const file = process.argv[2];
const BOX = Number(process.argv[3] || 40);
const img = decodePNG(fs.readFileSync(file));
const px = (x, y) => {
  const i = y * img.w * img.ch + x * img.ch;
  return [img.data[i], img.data[i + 1], img.data[i + 2]];
};
// 偏白：三通道都 > 200
const isWhitish = ([r, g, b]) => r > 200 && g > 200 && b > 200;

const rep = [];
rep.push(`图像 ${img.w}x${img.h} 通道=${img.ch}  判定框=${BOX}px`);
const corners = {
  '左上': [0, 0], '右上': [img.w - BOX, 0],
  '左下': [0, img.h - BOX], '右下': [img.w - BOX, img.h - BOX],
};
let total = 0;
for (const [name, [x0, y0]] of Object.entries(corners)) {
  let n = 0, sample = null;
  for (let y = y0; y < y0 + BOX; y++) {
    for (let x = x0; x < x0 + BOX; x++) {
      if (isWhitish(px(x, y))) { n++; if (!sample) sample = px(x, y); }
    }
  }
  total += n;
  rep.push(`  ${name}角 偏白像素 = ${n}` + (sample ? `  样例 rgb(${sample.join(',')})` : ''));
}
// 最外 3 像素的一圈：真有"白边"会集中在这里
let ring = 0, ringTot = 0;
for (let x = 0; x < img.w; x++) {
  for (const y of [0, 1, 2, img.h - 3, img.h - 2, img.h - 1]) { ringTot++; if (isWhitish(px(x, y))) ring++; }
}
for (let y = 0; y < img.h; y++) {
  for (const x of [0, 1, 2, img.w - 3, img.w - 2, img.w - 1]) { ringTot++; if (isWhitish(px(x, y))) ring++; }
}
rep.push(`  最外 3px 边框区域 偏白 = ${ring} / ${ringTot}`);
rep.push(`  四角合计偏白 = ${total}`);
rep.push(total === 0 && ring === 0
  ? 'RESULT: PASS —— 四角与边缘没有白色残留'
  : `RESULT: 注意 —— 仍有偏白像素（四角 ${total} + 边缘 ${ring}），需人工看图`);
console.log(rep.join('\n'));
