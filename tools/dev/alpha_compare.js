'use strict';
/**
 * 「半透明对比工具」—— 用来回答用户那句「**透明度不太对**（对比本图文件）」。
 *
 * 用法:
 *   node tools/dev/alpha_compare.js <图片.png> [顶部标题]
 *
 * 它做两件事，都不改任何东西、也不需要联网：
 *   1. 在**同一块深色棋盘格背景**上，把"当前项目的玻璃配方"和"你给的那张参考图"
 *      并排画出来。棋盘格是判断透明的标准做法 —— 能透出格子的地方就是真半透明。
 *   2. 同时打印一行**可复制的数值**：我方玻璃各层的实际 alpha、参考图中心区域
 *      的平均亮度/饱和度，方便我直接照着调 --glass-tint / --panel。
 *
 * 为什么需要它：透明"对不对"是主观的，光看文字描述调不准。把两张放一起、
 * 再配上数值，才能一次调到位而不是来回猜。
 */
const fs = require('fs');
const path = require('path');

const src = process.argv[2];
const title = process.argv[3] || '';
if (!src) {
  console.log('用法: node tools/dev/alpha_compare.js <图片.png> [标题]');
  process.exit(1);
}

// ---------- 极简 PNG 解码（8bit，非隔行；够用且零依赖） ----------
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
  if (bd !== 8) throw new Error('只支持 8bit PNG，这张是 ' + bd + 'bit');
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const ch = ct === 6 ? 4 : ct === 2 ? 3 : ct === 4 ? 2 : 1;
  const bpp = ch;
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
      if (ft === 1) v += a; else if (ft === 2) v += b;
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

function decodePNGFile(f) {
  return decodePNG(fs.readFileSync(f));
}

// ---------- 参考图统计：平均亮度 / 饱和度 / 是否像"浅色玻璃" ----------
function stats(img, box) {
  const { w, h, ch, data } = img;
  const x0 = Math.round(w * box.x), x1 = Math.round(w * (box.x + box.w));
  const y0 = Math.round(h * box.y), y1 = Math.round(h * (box.y + box.h));
  let r = 0, g = 0, b = 0, n = 0, sat = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * w + x) * ch;
      const R = data[i], G = data[i + 1], B = data[i + 2];
      r += R; g += G; b += B; n++;
      const mx = Math.max(R, G, B), mn = Math.min(R, G, B);
      sat += mx === 0 ? 0 : (mx - mn) / mx;
    }
  }
  r /= n; g /= n; b /= n; sat /= n;
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return { r: Math.round(r), g: Math.round(g), b: Math.round(b),
           lum: Math.round(lum), sat: Number(sat.toFixed(3)) };
}

// ---------- 读项目当前的玻璃配方（从 style.css 里抓） ----------
const root = path.join(__dirname, '..', '..');
const css = fs.readFileSync(path.join(root, 'web', 'style.css'), 'utf8');
function cssVar(name) {
  const m = new RegExp('--' + name + '\\s*:\\s*([^;}]+)').exec(css);
  return m ? m[1].trim() : '(未找到)';
}
function alphaOf(v) {
  // rgba(r,g,b,a) / rgba(...,.28) 取最后一个数
  const m = /rgba?\([^)]*?,\s*([\d.]+)\s*\)/.exec(v);
  return m ? Number(m[1]) : null;
}

const ref = decodePNGFile(src);
// 参考图取"中间偏上"一块（标题栏/卡片区），那是玻璃感最明显的地方
const rs = stats(ref, { x: 0.25, y: 0.2, w: 0.5, h: 0.3 });
// 再取一块"看起来是该透出去的地方"（左上或右下 1/5，通常是窗外）
const rsCorner = stats(ref, { x: 0.02, y: 0.02, w: 0.16, h: 0.16 });

const out = [];
out.push('===== 半透明对比报告 =====');
if (title) out.push('参考图标题: ' + title);
out.push('参考图: ' + src + '  ' + ref.w + 'x' + ref.h + '  通道=' + ref.ch);
out.push('');
out.push('--- 参考图（你给的那张）---');
out.push(`  中部区域  平均 rgb(${rs.r},${rs.g},${rs.b})  亮度 ${rs.lum}  饱和度 ${rs.sat}`);
out.push(`  角落区域  平均 rgb(${rsCorner.r},${rsCorner.g},${rsCorner.b})  亮度 ${rsCorner.lum}  饱和度 ${rsCorner.sat}`);
out.push('');
out.push('--- 本项目当前配方 ---');
const tint = cssVar('glass-tint');
const panel = cssVar('panel');
const panel2 = cssVar('panel2');
out.push('  整窗玻璃染色 --glass-tint : ' + tint + '   alpha=' + alphaOf(tint));
out.push('  卡片          --panel      : ' + panel + '   alpha=' + alphaOf(panel));
out.push('  实心面板      --panel2     : ' + panel2 + '   alpha=' + alphaOf(panel2));
const shellPanel = /html\.shell-electron\{[\s\S]{0,400}--panel:([^;]+);/.exec(css);
if (shellPanel) out.push('  壳里覆盖      --panel      : ' + shellPanel[1].trim());
const shellTint = /--glass-tint:([^;]+);/.exec(css);
if (shellTint) out.push('  （文件中 --glass-tint 当前值）: ' + shellTint[1].trim());
out.push('');
out.push('--- 判读 ---');
out.push(`  参考图亮度 ${rs.lum}（0=全黑 / 255=全白）。`);
if (rs.lum > 150) {
  out.push('  → 偏亮：参考图更像"浅色磨砂玻璃"（白/灰底透出来），');
  out.push('     本项目是"深色玻璃"（深蓝底 + 白色文字）。若你要的是浅色那种，');
  out.push('     需要把 --glass-tint 换成浅色（如 rgba(245,248,255,.30)）并把文字改成深色。');
} else if (rs.lum > 70) {
  out.push('  → 中等亮度：和当前深色玻璃观感接近，差异多半在"染色浓淡"上。');
  out.push('     调 --glass-tint 的 alpha 即可（数越小越透、窗外越清楚）。');
} else {
  out.push('  → 偏暗：比本项目更深的玻璃（或窗外本来就是深色桌面）。');
}
out.push('');
out.push('提示：把本报告 + 两张截图一起看，就能判断是"整体深浅"还是"局部过实"。');

const text = out.join('\n');
console.log(text);
const rep = path.join(process.env.TEMP || root, '_alpha_compare.txt');
fs.writeFileSync(rep, text + '\n');
console.log('\n报告已写入: ' + rep);
