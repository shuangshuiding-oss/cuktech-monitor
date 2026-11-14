'use strict';

/**
 * 桌面壁纸探测（只读）。
 *
 * 用途：透明窗口方案里，"窗口后面是什么"这件事有两种做法：
 *   1. 让 DWM 把窗口后面的真实像素糊出来（Electron 的 backgroundMaterial）——
 *      最真，但要 GPU 合成支持，某些驱动/远程桌面下会失效；
 *   2. 自己拿桌面壁纸当底图，按窗口在屏幕上的位置对齐铺上去 —— 退路，
 *      不依赖任何系统材质，看着也像"透出去的"。
 *
 * 这个模块只做第 2 条需要的那一步：找到系统正在用的壁纸文件。
 *
 * 三个来源，按可靠性排序：
 *   · HKCU\Control Panel\Desktop\TranscodedWallpaper  —— 系统把任意格式（webp/jpg/…）
 *     转码后的 JPG，**永远存在且可直接解码**，是首选。
 *   · HKCU\Control Panel\Desktop\Wallpaper —— 用户原始文件路径（可能是 webp，
 *     Chromium 能解码，但文件可能已被用户删掉）。
 *   · 聚焦的幻灯片目录（Slideshow）—— 拿目录里第一张图，够用。
 *
 * 全程只读，不修改任何系统设置。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const APPDATA = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const TRANSCODED = path.join(APPDATA, 'Microsoft', 'Windows', 'Themes', 'TranscodedWallpaper');
const CACHED_FILES_DIR = path.join(APPDATA, 'Microsoft', 'Windows', 'Themes', 'CachedFiles');

const MIME = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.bmp': 'image/bmp', '.webp': 'image/webp', '.gif': 'image/gif',
};

/** 用 reg query 读一个 HKCU 值，读不到就返回 null。 */
function regQuery(key, value) {
  try {
    const out = execFileSync('reg.exe', ['query', key, '/v', value], {
      encoding: 'utf8', windowsHide: true, timeout: 4000,
    });
    // 形如：    Wallpaper    REG_SZ    C:\Users\x\a.jpg
    const line = out.split(/\r?\n/).find((l) => l.includes('REG_'));
    if (!line) return null;
    const m = line.match(/REG_(?:SZ|EXPAND_SZ|MULTI_SZ)\s+(.+)$/);
    return m ? m[1].trim() : null;
  } catch (_) { return null; }
}

function regQueryValues(key) {
  const out = {};
  try {
    const txt = execFileSync('reg.exe', ['query', key], { encoding: 'utf8', windowsHide: true, timeout: 4000 });
    for (const line of txt.split(/\r?\n/)) {
      const m = line.match(/^\s+(\S+)\s+REG_\w+\s+(.*)$/);
      if (m) out[m[1]] = m[2].trim();
    }
  } catch (_) {}
  return out;
}

function isFile(p) {
  try { return !!p && fs.statSync(p).isFile() && fs.statSync(p).size > 0; } catch (_) { return false; }
}

/** 探测当前壁纸。返回 {ok, file, mime, kind, source} 或 {ok:false, error}。 */
function findWallpaper() {
  // 1) 转码后的 JPG：最可靠，任何原格式都在这
  if (isFile(TRANSCODED)) {
    return { ok: true, file: TRANSCODED, mime: 'image/jpeg', kind: 'file', source: 'TranscodedWallpaper' };
  }

  // 2) 原始文件路径
  const raw = regQuery('HKCU\\Control Panel\\Desktop', 'Wallpaper');
  if (isFile(raw)) {
    return { ok: true, file: raw, mime: MIME[path.extname(raw).toLowerCase()] || 'image/jpeg',
      kind: 'file', source: 'Desktop\\Wallpaper' };
  }

  // 3) 幻灯片：从 Slideshow 目录里挑第一张能用的
  const ss = regQueryValues('HKCU\\Control Panel\\Personalization\\Slideshow');
  let dir = ss.Interval ? ss.RootPath : null;
  if (dir) dir = String(dir).replace(/^"|"$/g, '');
  if (dir && fs.existsSync(dir)) {
    const exts = new Set(['.jpg', '.jpeg', '.png', '.bmp', '.webp']);
    const files = fs.readdirSync(dir).filter((f) => exts.has(path.extname(f).toLowerCase())).sort();
    if (files.length) {
      const f = path.join(dir, files[0]);
      return { ok: true, file: f, mime: MIME[path.extname(f).toLowerCase()] || 'image/jpeg',
        kind: 'file', source: 'Slideshow' };
    }
  }

  // 4) 主题缓存目录（Windows 会在这存一份）
  try {
    if (fs.existsSync(CACHED_FILES_DIR)) {
      const f = fs.readdirSync(CACHED_FILES_DIR)
        .filter((x) => /\.(jpe?g|png|bmp)$/i.test(x)).sort()[0];
      if (f) {
        const p = path.join(CACHED_FILES_DIR, f);
        return { ok: true, file: p, mime: MIME[path.extname(p).toLowerCase()] || 'image/jpeg',
          kind: 'file', source: 'CachedFiles' };
      }
    }
  } catch (_) {}

  return { ok: false, error: '没能找到桌面壁纸（可能是纯色背景或主题壁纸），可退回界面自带的氛围光背景。' };
}

module.exports = { findWallpaper, MIME };
