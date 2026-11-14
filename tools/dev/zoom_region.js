'use strict';
/**
 * 任意区域裁剪 + 最近邻放大：给"看外观"用。
 *
 * 窗口截图（外壳自带 /shot，见 shell/main.js）拿回来是全窗大小，顶栏、圆角、贴边这些细节
 * 在缩略图上根本看不出来。这个工具把某一块裁出来放大 N 倍，另存 PNG 给 Read 工具看。
 *
 * 用法: node tools/dev/zoom_region.js <in.png> <x> <y> <w> <h> <scale> [out.png]
 *   例（顶栏左半）：node tools/dev/zoom_region.js shot.png 0 0 560 72 3 top.png
 */
const fs = require('fs');
const path = require('path');
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
// ---- 主流程 ---------------------------------------------------------------
const [inP, xs, ys, ws, hs, ss, outP] = process.argv.slice(2);
if (!inP || !ss) {
  console.error('用法: node tools/dev/zoom_region.js <in.png> <x> <y> <w> <h> <scale> [out.png]');
  process.exit(2);
}
const ox = Number(xs), oy = Number(ys), cw = Number(ws), chh = Number(hs);
const s = Math.max(1, Number(ss));
const img = decodePNG(fs.readFileSync(inP));
const vw = Math.min(cw, img.w - ox), vh = Math.min(chh, img.h - oy);
if (vw <= 0 || vh <= 0) { console.error('裁剪区域超出图片范围（图 ' + img.w + 'x' + img.h + '）'); process.exit(2); }
const ow = vw * s, oh = vh * s;
const out = Buffer.alloc(ow * oh * 3);
for (let yy = 0; yy < oh; yy++) {
  const sy = oy + Math.floor(yy / s);
  for (let xx = 0; xx < ow; xx++) {
    const sx = ox + Math.floor(xx / s);
    const si = sy * img.stride + sx * img.ch;
    const di = yy * ow * 3 + xx * 3;
    out[di] = img.data[si];
    out[di + 1] = img.data[img.ch >= 3 ? si + 1 : si];
    out[di + 2] = img.data[img.ch >= 3 ? si + 2 : si];
  }
}
const dst = outP || path.join(path.dirname(inP), path.basename(inP, '.png') + '_zoom.png');
fs.writeFileSync(dst, encodePNG(ow, oh, out));
console.log('ok ' + dst + '  ' + ow + 'x' + oh + '（原图 ' + img.w + 'x' + img.h + '）');
