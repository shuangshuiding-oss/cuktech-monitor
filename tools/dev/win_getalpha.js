// 只读探针：读窗口的 **layered alpha** —— 也就是 Electron `win.setOpacity()` 到底写进去了什么。
//
// 为什么需要它（2026-10-08 用户报「失焦透明度调节没用」）：
//   `win.setOpacity()` 在 Windows 上就是「加 WS_EX_LAYERED + SetLayeredWindowAttributes」。
//   但**没有公开的读回 API**，所以只能从外面读：
//     - EX 样式里有没有 WS_EX_LAYERED
//     - GetLayeredWindowAttributes() 里的 alpha 是多少（0~255）
//   这样就能区分三种情况：① 根本没设（layered=false）② 设了但被别处覆盖成 255
//   ③ 设对了（例如 204 = 80%）。
//
// 用法: node tools/dev/win_getalpha.js <标题关键字> [--list]
'use strict';
const koffi = require('koffi');
const user32 = koffi.load('user32.dll');

const EnumProc = koffi.proto('bool EnumWindowsProc(void *hwnd, intptr_t lParam)');
const EnumWindows = user32.func('EnumWindows', 'bool', [ koffi.pointer(EnumProc), 'intptr_t' ]);
const IsWindowVisible = user32.func('IsWindowVisible', 'bool', [ 'void *' ]);
const GetWindowTextW = user32.func('GetWindowTextW', 'int', [ 'void *', 'void *', 'int' ]);
const GetClassNameW = user32.func('GetClassNameW', 'int', [ 'void *', 'void *', 'int' ]);
const GetWindowLongPtrW = user32.func('GetWindowLongPtrW', 'intptr_t', [ 'void *', 'int' ]);
const GetLayeredWindowAttributes =
  user32.func('GetLayeredWindowAttributes', 'bool', [ 'void *', 'void *', 'void *', 'void *' ]);
const GetForegroundWindow = user32.func('GetForegroundWindow', 'void *', []);

const GWL_EXSTYLE = -20;
const WS_EX_LAYERED = 0x00080000;
const LWA_ALPHA = 0x2;
const LWA_COLORKEY = 0x1;

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
if (!arg) {
  console.error('用法: node tools/dev/win_getalpha.js <标题关键字>   |   --list');
  process.exit(2);
}
if (arg === '--list') {
  for (const w of wins) console.log(w.title + '   [' + w.cls + ']');
  process.exit(0);
}
const hit = wins.find((w) => w.title.includes(arg));
if (!hit) {
  console.error('没找到标题含 “' + arg + '” 的可见窗口。现有窗口：');
  for (const w of wins) console.error('  ' + w.title + '   [' + w.cls + ']');
  process.exit(3);
}

const ex = Number(GetWindowLongPtrW(hit.hwnd, GWL_EXSTYLE));
const layered = (ex & WS_EX_LAYERED) !== 0;
const key = Buffer.alloc(4);
const alpha = Buffer.alloc(1);
const flags = Buffer.alloc(4);
const okAttr = GetLayeredWindowAttributes(hit.hwnd, key, alpha, flags);
const fg = GetForegroundWindow();
const isFg = String(fg) === String(hit.hwnd);

const pct = Math.round(alpha[0] * 100 / 255);
console.log('窗口        : ' + hit.title + '   [' + hit.cls + ']');
console.log('EX 样式     : 0x' + (ex >>> 0).toString(16) + '   WS_EX_LAYERED = ' + layered);
console.log('当前前台    : ' + (isFg ? '是（聚焦）' : '不是（失焦）'));
if (!layered) {
  console.log('layered alpha: ——（没加 WS_EX_LAYERED ⇒ setOpacity 没生效/被清掉了）');
} else if (!okAttr) {
  console.log('layered alpha: 读失败（layered 开着但没设 alpha？）');
} else {
  console.log('layered alpha: ' + alpha[0] + '/255 = ' + pct + '%'
    + '   flags=' + flags.readUInt32LE(0)
    + '（LWA_ALPHA=' + ((flags.readUInt32LE(0) & LWA_ALPHA) !== 0) + '）'
    + '   colorkey=0x' + key.readUInt32LE(0).toString(16));
}
