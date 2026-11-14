'use strict';
/**
 * 四角放大拼图：把截图里窗口的四个角各取 60x60，最近邻放大 5 倍，
 * 拼成一张 600x600 PNG 供人工检查「直角 vs 圆角」。
 *
 * 用法: node tools/dev/zoom_corners.js <截图.png> <winX> <winY> <winW> <winH> [out.png]
 *   winX/Y/W/H = 窗口在**截图内**的坐标（= bounds - crop.xy）
 */
const fs = require('fs');
const zlib = require('zlib');

function decodePNG(buf) {
  let pos = 8, w = 0, h = 0, ct = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const t = buf.toString('ascii', pos + 4, pos + 8);
    const d = buf.slice(pos + 8, pos + 8 + len);
    if (t === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); ct = d[9]; }
    else if (t === 'IDAT') idat.push(d);
    else if (t === 'IEND') break;
    pos += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const ch = ct === 6 ? 4 : ct === 2 ? 3 : 1;
  const stride = w * ch;
  const out = Buffer.alloc(h * stride);
  let rp = 0;
  for (let y = 0; y < h; y++) {
    const ft = raw[rp++];
    const line = raw.slice(rp, rp + stride); rp += stride;
    const prev = y > 0 ? out.slice((y - 1) * stride, y * stride) : Buffer.alloc(stride);
    const cur = out.slice(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? cur[x - ch] : 0;
      const b = prev[x];
      const c = x >= ch ? prev[x - ch] : 0;
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
  return { w, h, ch, stride, data: out };
}

// ---- 极简 PNG 编码（8bit RGB，filter 0） ----
function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePNG(w, h, rgb) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8bit RGB
  const stride = w * 3;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0; // filter none
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const [file, wxS, wyS, wwS, whS, outArg] = process.argv.slice(2);
const img = decodePNG(fs.readFileSync(file));
const wx = parseInt(wxS, 10), wy = parseInt(wyS, 10);
const ww = parseInt(wwS, 10), wh = parseInt(whS, 10);
const S = 60, Z = 5; // 每角 60px，放大 5 倍
const CW = S * 2 * Z, CH = S * 2 * Z;
const canvas = Buffer.alloc(CW * CH * 3, 20); // 深灰底
const corners = [
  { n: 'TL', x: wx, y: wy },
  { n: 'TR', x: wx + ww - S, y: wy },
  { n: 'BL', x: wx, y: wy + wh - S },
  { n: 'BR', x: wx + ww - S, y: wy + wh - S },
];
corners.forEach((c, idx) => {
  const dx = (idx % 2) * S * Z;
  const dy = Math.floor(idx / 2) * S * Z;
  for (let y = 0; y < S * Z; y++) {
    const sy = c.y + Math.floor(y / Z);
    for (let x = 0; x < S * Z; x++) {
      const sx = c.x + Math.floor(x / Z);
      const si = sy * img.stride + sx * img.ch;
      const di = (dy + y) * CW * 3 + (dx + x) * 3;
      canvas[di] = img.data[si];
      canvas[di + 1] = img.data[si + 1];
      canvas[di + 2] = img.data[si + 2];
    }
  }
});
const out = outArg || file.replace(/\.png$/i, '') + '_corners.png';
fs.writeFileSync(out, encodePNG(CW, CH, canvas));
console.log('saved:', out, CW + 'x' + CH, '（左上/右上/左下/右下，5x 放大）');
