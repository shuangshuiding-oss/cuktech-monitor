// 诊断 + 临时实验：给某个窗口加「整窗 alpha」（WS_EX_LAYERED + SetLayeredWindowAttributes），
// 验证**非 transparent 的 Electron 窗口**能不能真的整窗半透明（透出桌面 / 别的窗口）。
//
// 为什么要验它：失焦时窗口材质被换成 mica —— 而 mica 是**不透明的"壁纸色调"背板**，
// 所以只调页面染色永远看不到窗外（用户 2026-10-08 反馈「滑块没用 / 能不能再透点」）。
// 想真正更透，只剩「整窗 alpha」这一条路；这个脚本用来**在真机上确认它是否有效**。
//
// ⚠️ 它改的是窗口样式（不是只读）。用完请用 --restore 还原；不带参数时是纯只读的。
//
// 用法:
//   node tools/dev/win_alpha.js <标题关键字>              # 只读：打印 EX 样式 / 是否已 layered
//   node tools/dev/win_alpha.js <标题关键字> 60           # 整窗 alpha = 60%（0~100，可反复调）
//   node tools/dev/win_alpha.js <标题关键字> --restore    # 去掉 layered，还原成完全不透明
'use strict';
const koffi = require('koffi');
const user32 = koffi.load('user32.dll');

const EnumProc = koffi.proto('bool EnumWindowsProc(void *hwnd, intptr_t lParam)');
const EnumWindows = user32.func('EnumWindows', 'bool', [ koffi.pointer(EnumProc), 'intptr_t' ]);
const IsWindowVisible = user32.func('IsWindowVisible', 'bool', [ 'void *' ]);
const GetWindowTextW = user32.func('GetWindowTextW', 'int', [ 'void *', 'void *', 'int' ]);
const GetClassNameW = user32.func('GetClassNameW', 'int', [ 'void *', 'void *', 'int' ]);
const GetWindowLongPtrW = user32.func('GetWindowLongPtrW', 'intptr_t', [ 'void *', 'int' ]);
const SetWindowLongPtrW = user32.func('SetWindowLongPtrW', 'intptr_t', [ 'void *', 'int', 'intptr_t' ]);
const SetLayeredWindowAttributes =
  user32.func('SetLayeredWindowAttributes', 'bool', [ 'void *', 'uint32', 'uint8', 'uint32' ]);
const SetWindowPos = user32.func('SetWindowPos', 'bool',
  [ 'void *', 'void *', 'int', 'int', 'int', 'int', 'uint32' ]);

const GWL_EXSTYLE = -20;
const WS_EX_LAYERED = 0x00080000;
const LWA_ALPHA = 0x2;
// SWP_NOSIZE|SWP_NOMOVE|SWP_NOZORDER|SWP_NOACTIVATE|SWP_FRAMECHANGED
const SWP = 0x0001 | 0x0002 | 0x0004 | 0x0010 | 0x0020;

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
const val = process.argv[3];
if (!arg) {
  console.error('用法: node tools/dev/win_alpha.js <标题关键字> [0-100 | --restore]');
  process.exit(2);
}
const hit = wins.find((w) => w.title.includes(arg));
if (!hit) {
  console.error('没找到标题含 “' + arg + '” 的可见窗口。现有窗口：');
  for (const w of wins) console.error('  ' + w.title + '   [' + w.cls + ']');
  process.exit(3);
}

const exBefore = GetWindowLongPtrW(hit.hwnd, GWL_EXSTYLE);
const layeredBefore = (Number(exBefore) & WS_EX_LAYERED) !== 0;
console.log('窗口   : ' + hit.title + '   [' + hit.cls + ']');
console.log('EX 样式: 0x' + (Number(exBefore) >>> 0).toString(16) + '   已 layered: ' + layeredBefore);

if (val === undefined) {
  console.log('（只读模式：没动它。加一个 0~100 的数值可以试整窗 alpha）');
  process.exit(0);
}

if (val === '--restore') {
  const cleared = Number(exBefore) & ~WS_EX_LAYERED;
  SetWindowLongPtrW(hit.hwnd, GWL_EXSTYLE, cleared);
  SetWindowPos(hit.hwnd, null, 0, 0, 0, 0, SWP);
  const exAfter = Number(GetWindowLongPtrW(hit.hwnd, GWL_EXSTYLE));
  console.log('已还原：layered = ' + (((exAfter & WS_EX_LAYERED) !== 0) ? '仍开着(异常)' : '已去掉'));
  process.exit(0);
}

const pct = Math.max(0, Math.min(100, Math.round(Number(val))));
const a = Math.round(pct * 255 / 100);
SetWindowLongPtrW(hit.hwnd, GWL_EXSTYLE, Number(exBefore) | WS_EX_LAYERED);
const okSet = SetLayeredWindowAttributes(hit.hwnd, 0, a, LWA_ALPHA);
SetWindowPos(hit.hwnd, null, 0, 0, 0, 0, SWP);
console.log('整窗 alpha 设为 ' + pct + '%（' + a + '/255）  SetLayeredWindowAttributes=' + okSet);
console.log('看看窗口是不是变透了（能看见桌面/别的窗口）；看完用 --restore 还原。');
