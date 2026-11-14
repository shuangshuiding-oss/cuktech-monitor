'use strict';

/**
 * 自绘应用图标：一个「功率表」——深色圆角底、青紫渐变的仪表弧、中间一道闪电。
 * 不依赖任何图像库：PNG = 签名 + IHDR + IDAT(zlib) + IEND（每块带 CRC32），
 * ICO 直接把 PNG 塞进容器（Vista+ 支持 PNG-in-ICO）。
 * 4x4 超采样做抗锯齿。
 *
 * 产出：app.ico（16/24/32/48/64/128/256）、tools/icon-preview.png（512，人看）
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const APP = path.join(__dirname, '..');

// ------------------------------------------------------------------ PNG

const CRC_T = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_T[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
function encodePng(w, h, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  return Buffer.concat([
    sig, chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ------------------------------------------------------------------ 绘制

const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (x, a, b) => Math.min(Math.max(x, a), b);

// 闪电多边形（归一化坐标，v 向下）
const BOLT = [
  [0.549, 0.283], [0.383, 0.541], [0.471, 0.541],
  [0.421, 0.727], [0.612, 0.462], [0.519, 0.462], [0.583, 0.283],
];
function inPoly(u, v, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if (((yi > v) !== (yj > v)) && (u < ((xj - xi) * (v - yi)) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}

/** 弧上的渐变配色：青 -> 靛 -> 紫 */
function arcColor(t) {
  const stops = [[0x38, 0xBD, 0xF8], [0x81, 0x8C, 0xF8], [0xC0, 0x84, 0xFC]];
  const x = clamp(t, 0, 1) * (stops.length - 1);
  const i = Math.min(Math.floor(x), stops.length - 2);
  const f = x - i;
  return [0, 1, 2].map((k) => Math.round(lerp(stops[i][k], stops[i + 1][k], f)));
}

/** 返回该采样点的 [r,g,b,a] */
function sample(u, v) {
  const R = 0.225;                                   // 圆角半径
  const ex = clamp(u, R, 1 - R), ey = clamp(v, R, 1 - R);
  if (Math.hypot(u - ex, v - ey) > R) return [0, 0, 0, 0];

  // 背景：竖向渐变
  let r = Math.round(lerp(0x0B, 0x18, v));
  let g = Math.round(lerp(0x12, 0x29, v));
  let b = Math.round(lerp(0x22, 0x47, v));

  // 仪表弧：缺口开在正下方
  const gx = 0.5, gy = 0.525, rad = 0.292, th = 0.086;
  const dr = Math.hypot(u - gx, v - gy);
  if (Math.abs(dr - rad) <= th / 2) {
    let deg = (Math.atan2(v - gy, u - gx) * 180) / Math.PI;
    if (deg < 0) deg += 360;                          // 0=右, 90=下, 180=左, 270=上
    const inGap = deg > 60 && deg < 120;
    if (!inGap) {
      const t = ((deg >= 120 ? deg - 120 : deg + 240)) / 300;
      const c = arcColor(t);
      r = c[0]; g = c[1]; b = c[2];
    }
  }

  // 中心闪电
  if (inPoly(u, v, BOLT)) { r = 0xEA; g = 0xF6; b = 0xFF; }

  return [r, g, b, 255];
}

function render(size) {
  const SS = 4;
  const buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let R = 0, G = 0, B = 0, A = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const u = (x + (sx + 0.5) / SS) / size;
          const v = (y + (sy + 0.5) / SS) / size;
          const c = sample(u, v);
          const a = c[3] / 255;
          R += c[0] * a; G += c[1] * a; B += c[2] * a; A += a;
        }
      }
      const n = SS * SS;
      const i = (y * size + x) * 4;
      if (A > 0) { buf[i] = Math.round(R / A); buf[i + 1] = Math.round(G / A); buf[i + 2] = Math.round(B / A); }
      buf[i + 3] = Math.round((A / n) * 255);
    }
  }
  return buf;
}

// ------------------------------------------------------------------ ICO

const SIZES = [16, 24, 32, 48, 64, 128, 256];

function buildIco(entries) {
  const dir = Buffer.alloc(6);
  dir.writeUInt16LE(0, 0); dir.writeUInt16LE(1, 2); dir.writeUInt16LE(entries.length, 4);
  const head = [];
  let offset = 6 + entries.length * 16;
  for (const e of entries) {
    const b = Buffer.alloc(16);
    b[0] = e.size >= 256 ? 0 : e.size;
    b[1] = e.size >= 256 ? 0 : e.size;
    b[2] = 0; b[3] = 0;
    b.writeUInt16LE(1, 4);        // planes
    b.writeUInt16LE(32, 6);       // bpp
    b.writeUInt32LE(e.png.length, 8);
    b.writeUInt32LE(offset, 12);
    offset += e.png.length;
    head.push(b);
  }
  return Buffer.concat([dir, ...head, ...entries.map((e) => e.png)]);
}

const entries = SIZES.map((size) => ({ size, png: encodePng(size, size, render(size)) }));
fs.writeFileSync(path.join(APP, 'app.ico'), buildIco(entries));
fs.writeFileSync(path.join(__dirname, 'icon-preview.png'), encodePng(512, 512, render(512)));

console.log('app.ico            ' + fs.statSync(path.join(APP, 'app.ico')).size + ' bytes  (' + SIZES.join('/') + ')');
console.log('tools/icon-preview.png 512x512 done');
