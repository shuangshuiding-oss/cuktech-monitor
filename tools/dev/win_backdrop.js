// 读 / 设窗口的 DWM 背景材质（DWMWA_SYSTEMBACKDROP_TYPE = 38）。
//
// 为什么要它（2026-10-08 用户报「失焦之后透明度没变」）：
//   失焦时我们的壳会把材质从 acrylic 换成 mica —— 而 **mica 是不透明的"壁纸色调"**。
//   于是即便把整窗 alpha 降下来，看起来也还是"一块实色板"（窗外看不到）。
//   这个脚本用来在**不重开窗口**的前提下，直接换材质做对照实验：
//     3 = Acrylic（真模糊窗外）   2 = Mica（壁纸色调）   1 = None（不画材质）
//   值：0=Auto 1=None 2=Mica 3=Acrylic 4=Tabbed
//
// ⚠️ 它改的是窗口属性，和 Electron 内部记录的状态会不一致 —— 测完请设回原值（或关窗重开）。
//
// 用法:
//   node tools/dev/win_backdrop.js <标题关键字>          # 只读
//   node tools/dev/win_backdrop.js <标题关键字> 3        # 设成 Acrylic
'use strict';
const koffi = require('koffi');
const user32 = koffi.load('user32.dll');
const dwmapi = koffi.load('dwmapi.dll');

const EnumProc = koffi.proto('bool EnumWindowsProc(void *hwnd, intptr_t lParam)');
const EnumWindows = user32.func('EnumWindows', 'bool', [ koffi.pointer(EnumProc), 'intptr_t' ]);
const IsWindowVisible = user32.func('IsWindowVisible', 'bool', [ 'void *' ]);
const GetWindowTextW = user32.func('GetWindowTextW', 'int', [ 'void *', 'void *', 'int' ]);
const GetClassNameW = user32.func('GetClassNameW', 'int', [ 'void *', 'void *', 'int' ]);
const DwmGetWindowAttribute =
  dwmapi.func('DwmGetWindowAttribute', 'int32', [ 'void *', 'uint32', 'void *', 'uint32' ]);
const DwmSetWindowAttribute =
  dwmapi.func('DwmSetWindowAttribute', 'int32', [ 'void *', 'uint32', 'void *', 'uint32' ]);

const DWMWA_SYSTEMBACKDROP_TYPE = 38;
const DWMWA_WINDOW_CORNER_PREFERENCE = 33;
const NAMES = { 0: 'Auto', 1: 'None', 2: 'Mica', 3: 'Acrylic', 4: 'Tabbed' };

const txt = (hwnd, fn) => {
  const b = Buffer.alloc(512);
  const n = fn(hwnd, b, 256);
  return n > 0 ? b.toString('utf16le', 0, n * 2).replace(/\0/g, '') : '';
};

const wins = [];
const cb = koffi.register((hwnd) => {
  try {
    if (!IsWindowVisible(hwnd)) return true;
    const t = txt(hwnd, GetWindowTextW);
    if (!t) return true;
    wins.push({ hwnd, title: t, cls: txt(hwnd, GetClassNameW) });
  } catch (_) {}
  return true;
}, koffi.pointer(EnumProc));
EnumWindows(cb, 0);
koffi.unregister(cb);

const arg = process.argv[2];
const raw = process.argv[3];
if (!arg) {
  console.error('用法: node tools/dev/win_backdrop.js <标题关键字> [0-4]');
  process.exit(2);
}
const hit = wins.find((w) => w.title.includes(arg));
if (!hit) {
  console.error('没找到标题含 “' + arg + '” 的可见窗口。现有窗口：');
  for (const w of wins) console.error('  ' + w.title + '   [' + w.cls + ']');
  process.exit(3);
}

const readInt = (attr) => {
  const b = Buffer.alloc(4);
  const rc = DwmGetWindowAttribute(hit.hwnd, attr, b, 4);
  return { rc, v: b.readUInt32LE(0) };
};
const writeInt = (attr, v) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(v >>> 0, 0);
  return DwmSetWindowAttribute(hit.hwnd, attr, b, 4);
};

const before = readInt(DWMWA_SYSTEMBACKDROP_TYPE);
const corner = readInt(DWMWA_WINDOW_CORNER_PREFERENCE);
console.log('窗口      : ' + hit.title);
console.log('当前材质  : ' + before.v + ' (' + (NAMES[before.v] || '?') + ')   rc=' + before.rc);
console.log('圆角偏好  : ' + corner.v + '（2=Round）');

if (raw === undefined) {
  console.log('（只读模式：没动它）');
  process.exit(0);
}
const v = Math.max(0, Math.min(4, Number(raw)));
const rc = writeInt(DWMWA_SYSTEMBACKDROP_TYPE, v);
console.log('已设成    : ' + v + ' (' + (NAMES[v] || '?') + ')   rc=' + rc);
const after = readInt(DWMWA_SYSTEMBACKDROP_TYPE);
console.log('读回      : ' + after.v + ' (' + (NAMES[after.v] || '?') + ')');
console.log('（测完记得设回原值 ' + before.v + '，或关窗重开）');
