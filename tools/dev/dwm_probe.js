// 读某个进程的窗口用了什么 DWM 材质 / 圆角偏好（**只读**诊断，不改任何东西）。
//
// 用途：判断 QQ / 微信那类"失焦也不消失"的磨砂到底是系统材质还是自绘 ——
//   本项目的磨砂用 Electron 的 backgroundMaterial('acrylic')，它对应
//   Win11 的 DWMSBT_TRANSIENTWINDOW，而**系统会在窗口失去焦点时把它降级成实色**。
//   如果别人用的是 DWMSBT_MAINWINDOW(Mica) 或者压根没设材质（自绘），
//   那就解释了"他们失焦为什么不变"。
//
// 用法: node tools/dev/dwm_probe.js <pid> [pid...]
//   例: node tools/dev/dwm_probe.js 4700
'use strict';
const koffi = require('koffi');

const user32 = koffi.load('user32.dll');
const dwmapi = koffi.load('dwmapi.dll');

const EnumProc = koffi.proto('bool EnumWindowsProc(void *hwnd, intptr_t lParam)');
const EnumWindows = user32.func('EnumWindows', 'bool', [ koffi.pointer(EnumProc), 'intptr_t' ]);
const IsWindowVisible = user32.func('IsWindowVisible', 'bool', [ 'void *' ]);
const GetWindowThreadProcessId = user32.func('GetWindowThreadProcessId', 'uint32', [ 'void *', 'void *' ]);
const GetClassNameW = user32.func('GetClassNameW', 'int', [ 'void *', 'void *', 'int' ]);
const GetWindowTextW = user32.func('GetWindowTextW', 'int', [ 'void *', 'void *', 'int' ]);
const GetWindowLongPtrW = user32.func('GetWindowLongPtrW', 'intptr_t', [ 'void *', 'int' ]);
const DwmGetWindowAttribute = dwmapi.func('DwmGetWindowAttribute', 'int',
  [ 'void *', 'uint32', 'void *', 'uint32' ]);

// dwmapi.h
const DWMWA_WINDOW_CORNER_PREFERENCE = 33;   // 0默认 1不圆 2圆 3小圆
const DWMWA_SYSTEMBACKDROP_TYPE = 38;        // 0自动 1无 2Mica 3Acrylic 4Tabbed
const BACKDROP = { 0: '自动(Auto)', 1: '无(None)', 2: 'Mica', 3: 'Acrylic', 4: 'Tabbed' };
const CORNER = { 0: '默认', 1: '不圆(DoNotRound)', 2: '圆(Round)', 3: '小圆(RoundSmall)' };

// Win32 窗口样式位
const GWL_STYLE = -16;
const WS_CAPTION = 0x00C00000;
const WS_THICKFRAME = 0x00040000;
const WS_POPUP = 0x80000000;
const WS_EX_LAYERED = 0x00080000;

function u32(hwnd, attr) {
  const b = Buffer.alloc(4);
  const rc = DwmGetWindowAttribute(hwnd, attr, b, 4);
  return rc === 0 ? b.readUInt32LE(0) : null;
}
const hex = (v) => (v == null ? 'n/a' : '0x' + (v >>> 0).toString(16));

function text(hwnd, fn) {
  const b = Buffer.alloc(512);
  const n = fn(hwnd, b, 256);
  return n > 0 ? b.toString('utf16le', 0, n * 2).replace(/\0/g, '') : '';
}

const want = new Set(process.argv.slice(2).map((s) => Number(s)).filter(Boolean));
if (!want.size) {
  console.error('用法: node tools/dev/dwm_probe.js <pid> [pid...]');
  process.exit(2);
}

const found = [];
const cb = koffi.register((hwnd) => {
  try {
    const pidBuf = Buffer.alloc(4);
    GetWindowThreadProcessId(hwnd, pidBuf);
    const pid = pidBuf.readUInt32LE(0);
    if (!want.has(pid)) return true;
    const style = Number(GetWindowLongPtrW(hwnd, GWL_STYLE)) | 0;
    const exStyle = Number(GetWindowLongPtrW(hwnd, -20)) | 0;
    found.push({
      pid,
      hwnd: hex(Number(hwnd)),
      visible: IsWindowVisible(hwnd),
      cls: text(hwnd, GetClassNameW),
      title: text(hwnd, GetWindowTextW),
      backdrop: u32(hwnd, DWMWA_SYSTEMBACKDROP_TYPE),
      corner: u32(hwnd, DWMWA_WINDOW_CORNER_PREFERENCE),
      style: hex(style),
      hasCaption: !!(style & WS_CAPTION),
      hasThickFrame: !!(style & WS_THICKFRAME),
      isPopup: !!(style & WS_POPUP),
      layered: !!(exStyle & WS_EX_LAYERED),
    });
  } catch (_) {}
  return true;
}, koffi.pointer(EnumProc));

EnumWindows(cb, 0);
koffi.unregister(cb);

found.sort((a, b) => (b.visible - a.visible) || (b.title ? 1 : -1));
console.log('pid ' + [ ...want ].join(',') + ' 共 ' + found.length + ' 个顶层窗口\n');
for (const w of found) {
  if (!w.visible && !w.title) continue;
  console.log('- ' + w.hwnd + '  ' + w.cls + (w.title ? '  “' + w.title + '”' : ''));
  console.log('    可见=' + w.visible
    + '   材质=' + (w.backdrop == null ? '读不到' : (BACKDROP[w.backdrop] || w.backdrop))
    + '   圆角偏好=' + (w.corner == null ? '读不到' : (CORNER[w.corner] || w.corner)));
  console.log('    样式=' + w.style + '  标题栏=' + w.hasCaption + '  可缩放边框=' + w.hasThickFrame
    + '  弹窗=' + w.isPopup + '  分层窗口=' + w.layered);
}
