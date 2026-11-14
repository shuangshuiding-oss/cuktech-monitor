// 把某个窗口前置并聚焦（**只用于诊断**：比如对比"聚焦/失焦"两种状态的外观）。
//
// 为什么需要 AttachThreadInput：Windows 有"前台锁"——非活动进程直接调
// SetForegroundWindow 往往只闪任务栏不切窗口。把当前前台线程和目标窗口线程
// 临时 Attach 到一起，就能绕过这条限制（经典做法）。
//
// 用法: node tools/dev/win_focus.js <窗口标题关键字> [--list]
//   node tools/dev/win_focus.js 酷态科        # 前置并聚焦标题含"酷态科"的窗口
//   node tools/dev/win_focus.js --list        # 只列出可见顶层窗口（找关键字用）
'use strict';
const koffi = require('koffi');
const user32 = koffi.load('user32.dll');
const kernel32 = koffi.load('kernel32.dll');

const EnumProc = koffi.proto('bool EnumWindowsProc(void *hwnd, intptr_t lParam)');
const EnumWindows = user32.func('EnumWindows', 'bool', [ koffi.pointer(EnumProc), 'intptr_t' ]);
const IsWindowVisible = user32.func('IsWindowVisible', 'bool', [ 'void *' ]);
const GetWindowTextW = user32.func('GetWindowTextW', 'int', [ 'void *', 'void *', 'int' ]);
const GetClassNameW = user32.func('GetClassNameW', 'int', [ 'void *', 'void *', 'int' ]);
const GetForegroundWindow = user32.func('GetForegroundWindow', 'void *', []);
const GetWindowThreadProcessId = user32.func('GetWindowThreadProcessId', 'uint32', [ 'void *', 'void *' ]);
const AttachThreadInput = user32.func('AttachThreadInput', 'bool', [ 'uint32', 'uint32', 'bool' ]);
const SetForegroundWindow = user32.func('SetForegroundWindow', 'bool', [ 'void *' ]);
const BringWindowToTop = user32.func('BringWindowToTop', 'bool', [ 'void *' ]);
const ShowWindow = user32.func('ShowWindow', 'bool', [ 'void *', 'int' ]);
const GetCurrentThreadId = kernel32.func('GetCurrentThreadId', 'uint32', []);

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
  console.error('用法: node tools/dev/win_focus.js <窗口标题关键字>   |   --list');
  process.exit(2);
}
if (arg === '--list') {
  for (const w of wins) console.log(w.title + '   [' + w.cls + ']');
  process.exit(0);
}

const hit = wins.find((w) => w.title.includes(arg));
if (!hit) {
  console.error('没找到标题含 “' + arg + '” 的可见窗口。可用 --list 看看有哪些。');
  process.exit(3);
}

const fg = GetForegroundWindow();
const pb = Buffer.alloc(4);
const fgTid = GetWindowThreadProcessId(fg, pb);
const myTid = GetCurrentThreadId();
const tgtTid = GetWindowThreadProcessId(hit.hwnd, pb);

ShowWindow(hit.hwnd, 9);            // SW_RESTORE
AttachThreadInput(myTid, fgTid, true);
AttachThreadInput(myTid, tgtTid, true);
const ok = SetForegroundWindow(hit.hwnd);
BringWindowToTop(hit.hwnd);
AttachThreadInput(myTid, tgtTid, false);
AttachThreadInput(myTid, fgTid, false);

console.log((ok ? 'ok  ' : '部分成功 ') + '已聚焦：' + hit.title);
