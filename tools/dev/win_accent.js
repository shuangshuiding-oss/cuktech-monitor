// 实验（诊断用）：给窗口上**老式磨砂** —— SetWindowCompositionAttribute +
// ACCENT_ENABLE_ACRYLICBLURBEHIND。
//
// 要回答的问题：官方的 setBackgroundMaterial('acrylic') 一走失焦就被系统降级成实色
// （见 shell/main.js 的 MATERIAL_* 注释），而**老式这条路不降级**。那它在 Win11（尤其这台
// 机器上）到底能不能用：观感是不是真磨砂、系统圆角还在不在、有没有拖影……
// 用户 2026-10-08 问「能不能失焦加个磨砂效果」，所以先拿它做实验，再决定落不落地。
//
// ⚠️ 它改的是窗口合成属性（不是只读），会**覆盖** DWM 材质。做完请关窗重开（页面/壳都会
//    重新加载），或先用 `off` 清掉试试。
//
// 用法:
//   node tools/dev/win_accent.js <标题关键字>                 # 只读：打印窗口信息
//   node tools/dev/win_accent.js <标题关键字> on [0-255]      # 开老式磨砂（第 3 参 = 色调不透明度，默认 96）
//   node tools/dev/win_accent.js <标题关键字> off             # 清掉（ACCENT_DISABLED）
'use strict';
const koffi = require('koffi');
const user32 = koffi.load('user32.dll');

const EnumProc = koffi.proto('bool EnumWindowsProc(void *hwnd, intptr_t lParam)');
const EnumWindows = user32.func('EnumWindows', 'bool', [ koffi.pointer(EnumProc), 'intptr_t' ]);
const IsWindowVisible = user32.func('IsWindowVisible', 'bool', [ 'void *' ]);
const GetWindowTextW = user32.func('GetWindowTextW', 'int', [ 'void *', 'void *', 'int' ]);
const GetClassNameW = user32.func('GetClassNameW', 'int', [ 'void *', 'void *', 'int' ]);
const IsWindowEnabled = user32.func('IsWindowEnabled', 'bool', [ 'void *' ]);

// 老式合成：SetWindowCompositionAttribute(hwnd, &data)  —— user32 未公开导出，用 GetProcAddress 等价物
const SetWindowCompositionAttribute = user32.func('SetWindowCompositionAttribute', 'bool',
  [ 'void *', 'void *' ]);

const ACCENT_POLICY = koffi.struct('ACCENT_POLICY', {
  AccentState: 'uint32',
  AccentFlags: 'uint32',
  GradientColor: 'uint32',      // AABBGGRR
  AnimationId: 'uint32',
});

const WCA_ACCENT_POLICY = 19;
const ACCENT_DISABLED = 0;
const ACCENT_ENABLE_ACRYLICBLURBEHIND = 4;     // 老式"磨砂"（不随焦点降级）
const ACCENT_ENABLE_BLURBEHIND = 3;            // 更老的模糊（无色调噪点）

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
const mode = process.argv[3];
if (!arg) {
  console.error('用法: node tools/dev/win_accent.js <标题关键字> [on [0-255] | off]');
  process.exit(2);
}
const hit = wins.find((w) => w.title.includes(arg));
if (!hit) {
  console.error('没找到标题含 “' + arg + '” 的可见窗口。现有窗口：');
  for (const w of wins) console.error('  ' + w.title + '   [' + w.cls + ']');
  process.exit(3);
}

console.log('窗口   : ' + hit.title + '   [' + hit.cls + ']');

/** 设一次 accent。state = ACCENT_*；alphaByte = 色调不透明度（0~255）。 */
function setAccent(state, alphaByte) {
  const a = Math.max(0, Math.min(255, alphaByte));
  const color = ((a << 24) | 0x00FFFFFF) >>> 0;      // AABBGGRR，白色调
  // 结构体放进 Buffer，手工构造 WINDOWCOMPOSITIONATTRIBDATA，避开 koffi 结构体取址的版本差异
  const pol = Buffer.alloc(16);
  pol.writeUInt32LE(state, 0);
  pol.writeUInt32LE(2, 4);                            // AccentFlags：2 是常见值（画边框/噪点）
  pol.writeUInt32LE(color, 8);
  pol.writeUInt32LE(0, 12);
  const data = Buffer.alloc(32);
  data.writeUInt32LE(WCA_ACCENT_POLICY, 0);           // Attrib
  data.writeBigUInt64LE(BigInt(koffi.address(pol)), 8);  // pvData
  data.writeBigUInt64LE(16n, 16);                     // cbData
  return SetWindowCompositionAttribute(hit.hwnd, data);
}

if (mode === undefined) {
  console.log('（只读模式：没动它。加 on / off 才能真正改）');
  process.exit(0);
}

if (mode === 'off') {
  const r = setAccent(ACCENT_DISABLED, 0);
  console.log('已清掉老式 accent（ACCENT_DISABLED）  返回=' + r);
  console.log('注：它不会把 DWM 材质"变回来" —— 关窗重开最干净。');
  process.exit(0);
}

const alphaByte = process.argv[4] === undefined ? 96 : Number(process.argv[4]);
const state = (mode === 'blur' || mode === '3') ? ACCENT_ENABLE_BLURBEHIND : ACCENT_ENABLE_ACRYLICBLURBEHIND;
const ok = setAccent(state, alphaByte);
console.log('老式磨砂已设：AccentState=' + state + '（' + (state === 4 ? 'ACRYLIC' : 'BLUR') + '）'
  + '  色调 alpha=' + alphaByte + '/255  返回=' + ok);
console.log('接着用它自己的截图口拍一张看看（外壳 /screen），再切走焦点看看失焦时是否还在磨砂。');
