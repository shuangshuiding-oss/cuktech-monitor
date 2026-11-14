'use strict';

/**
 * Electron 外壳：给界面一个「真透明 + 无边框 + 大圆角」的窗口。
 *
 * 为什么值得单独做一层：
 *   浏览器（哪怕 --app 模式）永远有一个不透明的窗口背景，CSS 的 backdrop-filter
 *   只能模糊「页面自己画的东西」，**没法把窗口后面的其他程序糊出来**（Electron 官方
 *   文档明说：CSS blur 只作用于窗口内内容）。要做到「看见窗口后面」，唯一的路是
 *   让窗口本身变成透明画布（transparent: true），再叠 vibrancy / backgroundMaterial
 *   这类 DWM 材质。这正是 macOS 上那种玻璃观感的来源。
 *
 * 三个已知硬约束（都踩过或从官方文档核过，别当 bug 查）：
 *   1. transparent 窗口**不能点击穿透**（透明区域仍然收鼠标事件）——
 *      所以本窗口不是"悬浮 HUD"，是一块正常的应用窗口，只是背景透明。
 *   2. transparent + resizable:true 在 Windows 上会让透明失效 —— 所以
 *      （⚠️ 2026-10-08 起本窗口是 transparent:false，故 resizable 改回 true：
 *        resizable:false 会去掉 WS_THICKFRAME，DWM 就不再画圆角、也不合成磨砂。）
 *      resizable:false，缩放交给界面里的「小 / 中 / 大」三档按钮（改窗口尺寸）。
 *   3. 打开 DevTools 会破坏透明（调试时窗口会变黑底，属正常）。
 *
 * ---------------------------------------------------------------- 圆角这件事
 *
 * 「窗口边缘要大圆角」在 Windows 11 上有个坑：**系统会给无边框窗口自己画一圈
 * 圆角 + 阴影 + 细边框**（roundedCorners 默认 true；electron/electron#46468
 * 确认这是 Win11 独有的，Win10 没有）。这圈系统画的框落在我们 CSS 圆角外面，
 * 看起来就是"r 角外面还残留一圈白色边缘"。
 *
 * 所以这里必须显式：
 *   roundedCorners: false   → 系统别画自己的圆角
 *   thickFrame: false       → 顺带去掉系统阴影（代价是不能拖边缩放，本来也不支持）
 * 之后窗口对系统来说就是个无边无影的矩形，**圆角完全由页面 CSS 的 --win-r 决定**，
 * 四角干净。
 *
 * setShape 的取舍（重要）：
 *   setShape 能把窗口形状真正裁成圆角矩形（"圆角外一个像素都不渲染"），但它
 *   在 Windows 上会让 DWM 变得不听话：拖动期间 setBounds 会被拒（用户报的
 *   "按住拖不动"），所以本项目的做法是 —— **只在静止时开、拖动时关**（见
 *   clearShape / drag-end）。有了 roundedCorners:false 之后，setShape 属于
 *   "锦上添花"，即使某些环境不支持也只是四角略钝，不影响使用。
 *
 * 生命周期：
 *   主进程只负责「开窗口 / 拖动 / 换尺寸 / 退出」，数据照旧走 127.0.0.1 的 HTTP + SSE，
 *   渲染进程就是现有那套 web/ 静态页 —— 一行都没改数据逻辑。
 */

const { app, BrowserWindow, ipcMain, shell, screen, desktopCapturer } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');

// ⚠️ 自检：如果进程带着 ELECTRON_RUN_AS_NODE 起来，require('electron') 会退化成
//   普通 Node 的模块（拿不到 app/BrowserWindow），窗口"看似创建了"但渲染器不会
//   正常挂 additionalArguments —— 表现就是页面里"我在壳里"判假、圆角/玻璃/拖动
//   全失效。server.js 那边已经会清掉这个变量，这里再兜一道，防止有人手工启动时踩坑。
if (process.env.ELECTRON_RUN_AS_NODE) {
  console.error('[cuk] 检测到 ELECTRON_RUN_AS_NODE=1 —— Electron 正在以纯 Node 模式运行，'
    + '窗口壳不会生效。已自动清除该变量，但更稳妥的做法是在启动处删掉它。');
  delete process.env.ELECTRON_RUN_AS_NODE;
}

// ---------------------------------------------------------------- 启动参数
// 端口由 server.js 通过 --port 传进来（它是唯一知道实际端口的人）。
function argOf(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  const hit = process.argv.find((a) => a.startsWith('--' + name + '='));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
}

// koffi（纯 JS FFI）：调 dwmapi 去掉 Win11 无边框窗口的 1px 白色边框
// （DWMWA_BORDER_COLOR 默认白色、按矩形走 —— 圆角外露出白色小直角，用户实机反馈）
//
// ⚠️ 2026-10-12：加一条 `vendor/koffi` 回落。便携包里**没有 node_modules**
//    （verify_package.js 的隐私红线），Electron 主进程按 `<shell>/node_modules` →
//    `<APP>/node_modules` 找 `koffi` 必然找不到 —— 结果就是"打包版圆角外有一圈白边"。
//    那份 koffi 是随包走的（package.ps1 会把整个 vendor 目录带走），实测可用。
//    两份都没有时 `_koffi` 保持 null，只是白边去不掉，不影响功能。
let _koffi = null;
for (const _c of [ 'koffi', path.join(__dirname, '..', 'vendor', 'koffi') ]) {
  try { _koffi = require(_c); break; } catch (_) { /* 试下一个 */ }
}

const PORT = Number(argOf('port', 8799));
const BASE = `http://127.0.0.1:${PORT}`;
const APP_DIR = path.join(__dirname, '..');
const SHOT_DIR = argOf('shotdir', path.join(process.env.TEMP || APP_DIR, 'cuk_shots'));
const USER_DIR = path.join(process.env.LOCALAPPDATA || APP_DIR, 'CuktechMonitor', 'electron');
// 用独立 userData，别去动用户 Edge/Chrome 的 profile
app.setPath('userData', USER_DIR);

// 「透明外壳」是可选玩法：没装 Electron（或用不了 GPU 合成）时，
// server.js 会回退到 Edge --app 窗口，功能一点不少。
//
// ⚠️ 2026-10-05：**不再使用 DWM 背景材质（acrylic/mica/tabbed）**。
//   材质是 DWM 按**窗口矩形**合成的，win.setShape 的圆角裁切对它无效、
//   roundedCorners:false 又让系统不画圆角 —— 结果就是四个方角被材质填满，
//   用户看到的"圆角外还有直角"（连报四轮）的真正元凶就是它。
//   现在「玻璃」只是一层 CSS 半透明染色（--glass-tint），窗口本体
//   transparent + setShape 真圆角 —— 窗外仍是实时桌面。
//   ★ 2026-10-05 实测修正：**acrylic 材质与 setShape 圆角蒙版其实能完美配合**
//   （hasShadow:false 前提下）—— 四角干净、大圆角保持、窗外被磨砂模糊。
//   之前“材质填满方角”的误判是 hasShadow:true 的矩形阴影。
//   所以"磨砂玻璃（苹果质感）"现在**固定为 acrylic**：窗外被磨砂模糊、系统圆角裁掉方角。
//   ★ 2026-10-06：顶栏那个「磨砂·开/关」开关已删除 —— 关掉档要铺主题实色底（不透明），
//     用户明确不要那种状态，留着只会让人点错。

function readPref() {
  try {
    return JSON.parse(fs.readFileSync(path.join(USER_DIR, 'pref.json'), 'utf8')) || {};
  } catch (_) { return {}; }
}
function writePref(p) {
  try { fs.mkdirSync(USER_DIR, { recursive: true }); fs.writeFileSync(path.join(USER_DIR, 'pref.json'), JSON.stringify(p, null, 2)); } catch (_) {}
}

// opacityBlur：「失焦」档（0~100，null = 跟随聚焦那条）。默认 70。
// ⚠️ 2026-10-08 从 80 调到 70，并做一次迁移：v1.8.17 那版因为 blur 的时序 bug（见下面
//    winBlurred 的注释）失焦时根本没生效，用户看到的还是 100%，反馈「调节没用」。
//    修好之后默认调得更透一点，让他一重开就看得出区别；**只在 pref 里正好是老默认 80 时**
//    才改（用户自己拖过的值不动）。
const pref = Object.assign({ size: 'medium', opacity: 56, opacityBlur: 70, theme: 'dark' }, readPref());
if (pref.opacityBlur === 80) { pref.opacityBlur = 70; writePref(pref); }
// 磨砂档位已废除：把旧 pref.json 里遗留的 frost 键删掉，免得以后看到它以为还有开关。
if ('frost' in pref) { delete pref.frost; writePref(pref); }

// 三档尺寸：transparent 窗口不能拖边缩放，改尺寸只能靠这几个预设 + 全屏
const SIZES = {
  small: { w: 1100, h: 780 },
  medium: { w: 1360, h: 940 },
  large: { w: 1760, h: 1100 },
};

let win = null;

// 「圆角外白边」的两个直接开关。写死成常量并报给自检探针，理由见文件头。
// 想改行为只改这里，别散落在 createWindow 里 —— 否则自检探针报的就不是实际值了。
const ROUNDED_CORNERS = true;    // 系统圆角（约 8px）：磨砂材质被 DWM 裁到圆角内
                                 // → 无方角。配合 transparent:false + 透明背景色。
// ⚠️⚠️ 2026-10-08：这一项**必须是 true**（用户报「窗口外面还有直角」的根因就是它）。
//   Win11 的 DWM 只给**有边框样式**（WS_THICKFRAME / WS_CAPTION）的顶层窗口画圆角；
//   本项目 frame:false（没有 WS_CAPTION）+ Electron 的 resizable:false 会去掉
//   WS_THICKFRAME —— 两个都没有，窗口对 DWM 来说就是个「无边框工具窗口」，**不给圆角**，
//   roundedCorners:true 也就成了空话；又因为 transparent:false，CSS 圆角也管不到
//   窗口边界，于是四角就是直的。
//   代价：窗口恢复「可拖边缩放」（配套 resizable:true，见 createWindow）；
//   系统阴影仍由 hasShadow:false 关掉，白色 1px 边框由 removeDwmBorder() 去掉。
const THICK_FRAME = true;        // 保留 WS_THICKFRAME：DWM 才肯画圆角 + 合成磨砂

// 页面量出来的实际圆角（px）。窗口的原生蒙版要用同一个数 ——
// 见 web/shell.js 里那一段：CSS 的 --win-r 是 rem，页面算成 px 再发过来。
let winRadius = 42;
// 原生圆角蒙版当前是不是开着（拖动期间会临时关掉，见 clearShape）
let shapeOn = false;

/**
 * 【已停用 2026-10-05】setShape 圆角蒙版。
 *
 * 历史：transparent 窗口的圆角外区域曾是窗口的一部分，DWM 阴影/材质照矩形合成，
 * 曾用 win.setShape 逐行切出圆角。后来发现真正元凶是 hasShadow:true（矩形阴影）
 * 和 roundedCorners:false（材质无系统圆角可跟）—— 两者修掉后改用**系统圆角**
 * （roundedCorners:true，约 8px）：DWM 自己把窗口和磨砂材质一起裁成圆角，
 * 方角彻底消失，还免去了 setShape 与拖动/DWM 的各种兼容问题。
 *
 * 函数保留为 no-op：拖动、/move、全屏切换等处的调用不动，避免连锁改动；
 * shapeOn 恒为 false，drag-move 里的"setBounds 被拒"兜底自然永不触发。
 */
function applyShape() {
  // ★ 2026-10-05 深夜定案：transparent:false 后系统圆角（roundedCorners:true）
  //   全权负责圆角。setShape 的 SetWindowRgn 会让 DWM 走特殊合成路径，
  //   **破坏系统圆角**（实测：region 活跃时四角变直角）—— 必须保持 no-op。
  return;
}
// 系统圆角下不再需要逐行蒙版，页面回传的半径值弃用（保留通道避免渲染侧报错）
ipcMain.on('cuk:radius', () => {});

/**
 * 磨砂玻璃（2026-10-05 起是"苹果玻璃"，2026-10-06 起**固定开**）：
 * 材质 acrylic 把窗外糊成柔和底色，"程度"细调交给透明度滑块。
 * 曾经的 off 档（关材质 + 铺主题实色底 = 不透明窗口）连同顶栏按钮一起删除。
 */
// ⚠️ 平台限制（实测多轮）：transparent:true 时 DWM 不画系统圆角（材质填满直角）。
// transparent:false 后系统圆角生效（磨砂被裁进圆角），但 DWM 还会画一圈 1px
// 白色矩形边框（DWMWA_BORDER_COLOR 默认白）—— 圆角外露白色小直角，用
// removeDwmBorder() 去掉。
/**
 * 去掉 Win11 无边框窗口的 1px 白色边框（DWMWA_BORDER_COLOR）。
 * 这圈边框按**矩形**走 —— 磨砂开的圆角窗口四角直角处会露白（用户实机反馈）。
 * DWMWA_BORDER_COLOR=34，DWMWA_COLOR_NONE=0xFFFFFFFE。Win11 22000+ 支持。
 */
function removeDwmBorder() {
  if (!win || win.isDestroyed() || !_koffi) return;
  try {
    const lib = _koffi.load('dwmapi.dll');
    const set = lib.func('DwmSetWindowAttribute', 'int32', ['void *', 'int32', 'void *', 'int32']);
    const hwnd = win.getNativeWindowHandle();          // Buffer（HWND 指针字节）
    const none = Buffer.alloc(4);
    none.writeUInt32LE(0xfffffffe, 0);
    const rc = set(hwnd, 34, none, 4);
    if (rc !== 0) console.error('DWMWA_BORDER_COLOR 返回', rc);
  } catch (e) { console.error('去除窗口边框失败：', e && e.message); }
}


/**
 * 显式要求 DWM 给窗口画系统圆角（DWMWA_WINDOW_CORNER_PREFERENCE=33 / DWMWCP_ROUND=2）。
 *
 * 为什么还要这一手：Win11 只在窗口**有边框样式**时才应用圆角，无边框工具窗口默认不圆。
 * thickFrame:true 已经补上了 WS_THICKFRAME，这里再把偏好显式设成 ROUND 做双保险
 * （某些主题 / 系统设置下默认偏好可能是 DONOTROUND）。Win11 22000+ 才有这个属性。
 * 2026-10-08 用户报「窗口外面还有直角」时加的。
 */
function forceRoundCorners() {
  if (!win || win.isDestroyed() || !_koffi) return;
  try {
    const lib = _koffi.load('dwmapi.dll');
    const set = lib.func('DwmSetWindowAttribute', 'int32', ['void *', 'int32', 'void *', 'int32']);
    const hwnd = win.getNativeWindowHandle();          // Buffer（HWND 指针字节）
    const v = Buffer.alloc(4);
    v.writeUInt32LE(2, 0);                             // DWMWCP_ROUND
    const rc = set(hwnd, 33, v, 4);                    // DWMWA_WINDOW_CORNER_PREFERENCE
    if (rc !== 0) console.error('DWMWA_WINDOW_CORNER_PREFERENCE 返回', rc);
  } catch (e) { console.error('设置窗口圆角失败：', e && e.message); }
}
/**
 * 材质：**聚焦与失焦都用 acrylic**（2026-10-08 深夜定案，用户报「失焦磨砂就没了」）。
 *
 * 这段走过的三步（别再走回去）：
 *   ① 起初只有聚焦 acrylic。Windows 会把「临时窗口」（DWMSBT_TRANSIENTWINDOW）的磨砂
 *      在失焦时降级成实色（第三方库 electron-acrylic-window 把这条做成开关
 *      disableOnBlur，默认 true）⇒ 试过「聚焦 acrylic / 失焦 mica」（mica 不降级）。
 *   ② 但 mica 只给一层**不透明的「壁纸色调」**、不模糊 ⇒ 失焦时整窗再调也几乎没变化
 *      （用户报「失焦之后透明度没变」）。于是当时给失焦单独加了**整窗 alpha**。
 *   ③ 真机对照实测（tools/dev/win_backdrop.js 直接设 DWMWA_SYSTEMBACKDROP_TYPE）确认：
 *      **本机失焦 + acrylic 依然是"模糊的窗外"**（就是用户要的磨砂），并不降级；
 *      失焦 + mica 才是那块深色实板。⇒ 两端统一 acrylic（v1.8.20）。
 *
 * ⚠️ 2026-10-08 深夜（v1.8.21）**再改一处，这次是语义**：失焦**不再动整窗 alpha**，
 *   「失焦」那条滑块只调**页面染色**（--glass-tint / --panel / --panel2），
 *   与聚焦那条**同口径**（0 = 全透，100 = 不透明）。
 *   为什么把 ② 那个补丁撤掉：
 *     · 整窗 alpha 是 mica 时代的补丁 —— 那时背板不透明，只调染色看不到窗外；
 *       现在背板是 acrylic（半透明 + 真模糊），染色本身已能从「全透」到「不透明」全覆盖。
 *     · 两个机制同时作用于失焦会互相打架：染色变浓 = 更"雾"，整窗 alpha 下降 = 整窗变淡，
 *       合起来既不雾也不透。而**拖动滑块时的预览**只改染色（那条 alpha 的 IPC 当时压根
 *       没接上，见 web/shell.js 的 invoke 白名单），于是「预览」和「实际」必然长得不一样
 *       —— 用户原话「失焦预览和实际雾化不一样，把实际改成预览一样的」。
 *   ⇒ 失焦 = **只染色**。预览（拖滑块）与实际（真失焦）走的是页面里同一个函数
 *      （effNow() → applyOpa()），同源同值，不可能再对不上。
 *      整窗 alpha（win.setOpacity / WS_EX_LAYERED）这条链路连同探针口的 /alpha 一并删掉。
 */
const MATERIAL_FOCUSED = 'acrylic';   // 有焦点：窗外**真模糊**
const MATERIAL_BLURRED = 'acrylic';   // 失焦：同样 acrylic（实测不降级）

/**
 * 窗口现在是不是「失焦」—— 由 focus/blur 事件自己维护。
 *
 * ⚠️ 2026-10-08 的坑（当时用来算整窗 alpha；现在只用于材质切换与 /probe 诊断，
 *   但结论照旧有效）：**不能**在这里调 win.isFocused() —— blur 回调触发的那一刻窗口
 *   其实已经不算前台了，但 isFocused() 仍返回 true（时序），据此判断会算错。
 *   实测证据（tools/dev/win_getalpha.js 从外面读窗口的 layered alpha）：失焦时为 true。
 */
let winBlurred = false;

function applyGlass(material) {
  if (!win || win.isDestroyed()) return;
  try {
    if (typeof win.setBackgroundMaterial !== 'function') return;
    // 背景全透明让 DWM 材质透出窗外；系统圆角（roundedCorners）把材质裁进圆角
    win.setBackgroundColor('#00000000');
    win.setBackgroundMaterial(material || MATERIAL_FOCUSED);
    removeDwmBorder();   // 白色 1px 边框在圆角外露白直角，必须去
    forceRoundCorners(); // 明确要 ROUND 偏好：无边框工具窗口 DWM 默认不画圆角
  } catch (e) {
    console.error('设置磨砂玻璃失败：', e && e.message);
  }
}

function createWindow() {
  const size = SIZES[pref.size] || SIZES.medium;
  const area = screen.getPrimaryDisplay().workAreaSize;
  const w = Math.min(size.w, area.width - 40);
  const h = Math.min(size.h, area.height - 40);

  win = new BrowserWindow({
    width: w,
    height: h,
    minWidth: 860,
    minHeight: 620,
    x: Math.round((area.width - w) / 2),
    y: Math.round((area.height - h) / 2),
    frame: false,            // 无标题栏、无系统边框 —— 圆角由页面自己画
    transparent: false,      // ★ 重测：透明窗口下 DWM 不画系统圆角（方角）。改 false
                             // 换取系统圆角，磨砂靠 backgroundColor 透明透出（见下）。
                             // 配合用户"圆角可以小点"—— 用系统 8px 圆角。
    // ⚠️ 2026-10-08：必须 true。Electron 的 resizable:false 会去掉 WS_THICKFRAME，
    //    而 Win11 的 DWM 只给有边框样式的窗口画圆角 —— 去掉之后四角就是直角。
    //    文件头「约束 2」（transparent + resizable 冲突）针对的是 transparent:true；
    //    本窗口是 transparent:false，不冲突。
    //    副作用：窗口现在能拖边缩放了；界面里那三档尺寸按钮照旧可用。
    resizable: true,
    maximizable: false,
    fullscreenable: true,
    backgroundColor: '#00000000',   // 全透明（不是 #070b14，否则就不透了）

    // ⚠️ 2026-09-23：修「圆角外残留白色边缘」的关键两项（官方文档有明说）。
    //
    // 1) roundedCorners 默认是 **true**。在 Windows 11（Build 22000+）上，
    //    系统会给无边框窗口**自己画一圈圆角 + 阴影 + 细边框**（这条在
    //    electron/electron#46468 里被确认是 Windows 11 独有的行为，Win10 没有）。
    //    这圈系统画的框正好落在我们 CSS 圆角**外面** —— 用户看到的就是
    //    "r 角外面还有一圈白色边缘"。设成 false 让系统别画，圆角完全交给我们。
    // 2) thickFrame 走的是 WS_THICKFRAME 风格；关掉它会同时**去掉窗口阴影**。
    //    （代价：失去"拖窗口边缘缩放"。本项目本来 resizable:false + 三档按钮，
    //    这笔交易划算。）
    // 两项合起来之后，窗口对系统来说就是一个无边无影的矩阵，圆角由 CSS 决定，
    // 四角不会再被系统那圈框"顶"出一层白边。
    roundedCorners: ROUNDED_CORNERS,
    thickFrame: THICK_FRAME,

    // ⚠️ 2026-10-05：这里必须 false。上一次只关了 roundedCorners + thickFrame，
    //    却把 hasShadow 留成 true —— DWM 的窗口阴影是绕着**矩形**画的（四个直角），
    //    正好落在 CSS 圆角外面，于是"圆角外还残留一圈浅色直角"。阴影就是那个直角。
    //    hasShadow:false 把阴影彻底关掉，四角才能真正交给 setShape 切成圆角。
    hasShadow: false,
    show: false,
    title: '酷态科10号Ultra',
    icon: path.join(APP_DIR, 'app.ico'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      // ⚠️ 必须挂 preload：contextIsolation 开着时渲染进程里**没有 require**，
      //    页面拿 IPC 只有这一条路（见 shell/preload.js 的说明）。
      preload: path.join(__dirname, 'preload.js'),
      // 页面靠它区分"在 Electron 壳里"还是"在浏览器里"（浏览器里就没有拖动/换尺寸）。
      // 注意这只是**辅助**判据：preload 暴露的 window.__CUK_SHELL__ 才是主判据
      // （additionalArguments 曾经因为 ELECTRON_RUN_AS_NODE 而整条失效过）。
      additionalArguments: ['--cuk-shell=electron'],
    },
  });

  applyGlass(MATERIAL_FOCUSED);

  // 焦点一变就换材质（见上面 MATERIAL_* 注释：现在是**两端同为 acrylic**，所以这两次调用
  // 事实上是等价的；留着是为了"哪天真要再分材质"时只用改那两个常量）。
  // 这里只重设材质本身 —— removeDwmBorder / forceRoundCorners 与材质无关，不必跟着重来。
  // ⚠️ 用自己维护的 winBlurred，**不要**在这里调 win.isFocused()（时序陷阱，见其注释）。
  // ⚠️ 失焦**不再动整窗 alpha**（v1.8.21）：失焦的观感只由页面染色决定，
  //    而页面那条染色在预览与实际两条路上走的是同一个函数 ⇒ 两者天然一致。
  win.on('focus', () => {
    winBlurred = false;
    try { win.setBackgroundMaterial(MATERIAL_FOCUSED); } catch (_) {}
  });
  win.on('blur', () => {
    winBlurred = true;
    try { win.setBackgroundMaterial(MATERIAL_BLURRED); } catch (_) {}
    // 这里**没有**任何"降整窗 alpha"的动作了：失焦的观感 100% 由页面染色决定
    // （页面听 window 的 blur → effNow() 切到「失焦」档 → applyOpa()）。见 v1.8.21 说明。
  });

  // 窗口背景必须是全透明，否则 DWM 材质会被一层不透明底盖掉
  win.setBackgroundColor('#00000000');

  win.loadURL(BASE + '/');

  win.once('ready-to-show', () => {
    win.show();
    // 玻璃模式下不抢焦点也能看见内容；但正常使用还是前置更合理
    try { win.focus(); } catch (_) {}
    // 页面这会儿才量得出 --win-r 的实际像素值，但先按默认值切一次蒙版，
    // 免得开窗瞬间露出方角；页面随后会用 cuk:radius 把准确值发过来。
    applyShape(winRadius);
    forceRoundCorners();   // 上屏后再设一次：DWM 圆角偏好对已显示的窗口才可靠生效
  });

  // 尺寸/全屏变了就重切蒙版：全屏时圆角应当归零（铺满屏幕不该有圆角缺口）
  const refit = () => {
    if (!win || win.isDestroyed()) return;
    if (dragState) return;                       // 拖动中不打扰（圆角蒙版全程保持）
    const full = win.isFullScreen();
    applyShape(full ? 0 : winRadius);
  };
  win.on('resize', refit);
  win.on('enter-full-screen', refit);
  win.on('leave-full-screen', refit);

  // 页面里点 http 链接走系统浏览器，别在应用窗口里跑
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url) && !url.startsWith(BASE)) {
      try { shell.openExternal(url); } catch (_) {}
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  win.on('closed', () => { win = null; });
}

// ---------------------------------------------------------------- 拖动
// 无边框窗口必须自己实现（-webkit-app-region:drag 也能用，但那个在
// 透明窗口上会和部分合成器打架，用 IPC + setPosition 更稳）。
//
// ⚠️ 三个踩过的坑（否则表现就是"按住拖不动"）：
//   1. **全屏时不能拖**：窗口铺满屏幕时 setPosition 会被 Windows 忽略。
//      所以拖的那一刻如果处于全屏，先退全屏、再从鼠标当前位置继续 —— 这点
//      最容易忽略，因为界面上「大」档和「全屏」长得很像。
//   2. **mousemove 必须挂在 window 上**，且用 screenX/screenY（绝对屏幕坐标）。
//      用 clientX 会在窗口跟着动之后产生"自己追自己"的抖动。
//   3. **渲染进程要先 preventDefault**，否则拖动会变成文本选择，mousemove 断流。
let dragState = null;
ipcMain.on('cuk:drag-start', (e, pt) => {
  if (!win || win.isDestroyed()) return;
  // ⚠️ 2026-10-05：**不再在拖动时撤圆角蒙版**。用户实测：撤了之后拖动全程四个
  //    直角露出来（“拖动窗口还会出现四个小角”）。当时撤蒙版是因为 DWM 材质
  //    时代 setShape 会让 setBounds 被拒 —— 现在材质/阴影全关了，这个坑
  //    不再触发；万一某种驱动仍会拒，drag-move 里有自适应兑底（见下）。
  // 全屏状态下没有“窗口位置”可言，先退出全屏，并把参考点重新取一次
  if (win.isFullScreen()) {
    try { win.setFullScreen(false); } catch (_) {}
    // 退全屏是异步的，等一帧再取 bounds，否则拿到的还是全屏尺寸
    setTimeout(() => {
      if (!win || win.isDestroyed()) return;
      const [x, y] = win.getPosition();
      dragState = { mx: Math.round(pt.x), my: Math.round(pt.y), wx: x, wy: y, lastAt: Date.now() };
      startDragWatch();
    }, 120);
    return;
  }
  const [x, y] = win.getPosition();
  dragState = { mx: Math.round(pt.x), my: Math.round(pt.y), wx: x, wy: y, lastAt: Date.now() };
  startDragWatch();
});
ipcMain.on('cuk:drag-move', (e, pt) => {
  if (!win || win.isDestroyed() || !dragState) return;
  const dx = Math.round(pt.x) - dragState.mx;
  const dy = Math.round(pt.y) - dragState.my;
  dragState.lastAt = Date.now();
  // setPosition 在 Windows 上偶发“被 DWM 吃掉”，用 setBounds 更可靠
  // （x/y 变了但 w/h 不变，透明窗口不允许改尺寸，这里传的是原尺寸）。
  const b = win.getBounds();
  win.setBounds({ x: dragState.wx + dx, y: dragState.wy + dy, width: b.width, height: b.height });
  // （系统圆角 + setShape 废弃后，"setBounds 被拒"的历史问题已不存在，
  //   原来的蒙版兜底随之移除 —— clearShape/shapeOn 已一并删除。）
});
ipcMain.on('cuk:drag-end', () => {
  const wasDragging = !!dragState;
  dragState = null;
  stopDragWatch();
  // 蒙版全程开着；只有上面兑底真的撤过（shapeOn=false）时才需要切回来。
  // applyShape 对已开状态是幂等的，无条件调一次最稳。
  if (wasDragging) setTimeout(() => { if (!win.isFullScreen()) applyShape(winRadius); }, 80);
});

// 主进程侧的兜底拖动：渲染进程因为任何原因没能持续发 cuk:drag-move 时
// （例如某次 GC 卡住、或事件被别的层吃掉），主进程自己按光标位置继续跟手。
// 只在渲染进程最后一次移动后 250ms 内还收不到新消息时才接管，避免两套打架。
let dragWatch = null;
function startDragWatch() {
  stopDragWatch();
  dragWatch = setInterval(() => {
    if (!dragState || !win || win.isDestroyed()) { stopDragWatch(); return; }
    if (Date.now() - (dragState.lastAt || 0) < 250) return;
    const p = require('electron').screen.getCursorScreenPoint();
    const dx = Math.round(p.x) - dragState.mx;
    const dy = Math.round(p.y) - dragState.my;
    const b = win.getBounds();
    win.setBounds({ x: dragState.wx + dx, y: dragState.wy + dy, width: b.width, height: b.height });
  }, 60);
}
function stopDragWatch() { if (dragWatch) { clearInterval(dragWatch); dragWatch = null; } }

ipcMain.handle('cuk:minimize', () => { if (win && !win.isDestroyed()) win.minimize(); });
ipcMain.handle('cuk:toggle-max', () => {
  if (!win || win.isDestroyed()) return false;
  // transparent 窗口不能走系统最大化（官方限制），用"铺满工作区"代替
  if (win.isFullScreen()) { win.setFullScreen(false); return false; }
  win.setFullScreen(true);
  return true;
});
ipcMain.handle('cuk:close', () => { if (win && !win.isDestroyed()) win.close(); });

// 磨砂开关已删除（2026-10-06）：玻璃固定 acrylic，页面也不再有任何切磨砂的通道。

// 透明度滑块（2026-10-05）：0 = 全透，100 = 不透明。
// 染色由页面实时改 CSS 变量（立即跟手），这里只负责把数值持久化。
ipcMain.handle('cuk:set-opacity', (e, v) => {
  const o = Math.max(0, Math.min(100, Math.round(Number(v) || 0)));
  pref.opacity = o;
  writePref(pref);
  return { ok: true, opacity: o };
});

// 主题切换（2026-10-05）：dark / light。页面加 html.light 类驱动整套配色。
// 「失焦」透明度（2026-10-08）：0~100，null = 跟随聚焦那条（默认）。
//   ⚠️ v1.8.21：这条**只存值**，不再驱动整窗 alpha（那条链路已删，见 MATERIAL_* 注释）。
//   预览与实际都发生在页面里（effNow() → applyOpa() 改 CSS 变量），主进程不参与渲染，
//   所以不需要什么 preview 分支；`opts.preview` 只剩一个作用：**拖动过程中不写盘**。
//   ⚠️ 页面那条 IPC 曾经因为 web/shell.js 的 invoke 白名单里漏了这个 case 而**完全没接上**
//      （invoke 静默返回 unknown channel）—— 表现就是"值拖过了但重启就回去、预览也和实际
//      两回事"。往 invoke 白名单里加通道时记得两边一起加。
ipcMain.handle('cuk:set-opacity-blur', (e, v, opts) => {
  const empty = (v === null || v === undefined || v === '');
  pref.opacityBlur = empty ? null : Math.max(0, Math.min(100, Math.round(Number(v) || 0)));
  if (!(opts && opts.preview)) writePref(pref);   // 拖动过程不写文件（与聚焦那条一致）
  return { ok: true, opacityBlur: pref.opacityBlur };
});

ipcMain.handle('cuk:set-theme', (e, t) => {
  const theme = t === 'light' ? 'light' : 'dark';
  pref.theme = theme;
  writePref(pref);
  return { ok: true, theme };
});

ipcMain.handle('cuk:set-size', (e, name) => {
  if (!SIZES[name] || !win || win.isDestroyed()) return { ok: false };
  pref.size = name;
  writePref(pref);
  const s = SIZES[name];
  const area = screen.getPrimaryDisplay().workAreaSize;
  const w = Math.min(s.w, area.width - 40);
  const h = Math.min(s.h, area.height - 40);
  try { win.setFullScreen(false); } catch (_) {}
  const [cx, cy] = win.getPosition();
  win.setBounds({ x: cx, y: cy, width: w, height: h });
  // 尺寸变了，圆角蒙版要按新高度重算（蒙版是按像素行生成的）
  setTimeout(() => applyShape(winRadius), 60);
  return { ok: true, size: name, w, h };
});

// 「截一张图存盘」：Electron 的 capturePage 是走合成器的，
// 这台机器上无头 Edge 截不出活页面的老问题在这里不存在。
ipcMain.handle('cuk:shot', async (e, name) => {
  if (!win || win.isDestroyed()) return { ok: false, error: 'no window' };
  try {
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    const safe = String(name || 'shot').replace(/[^\w.-]/g, '_').slice(0, 60);
    const image = await win.webContents.capturePage();
    const file = path.join(SHOT_DIR, safe.endsWith('.png') ? safe : safe + '.png');
    fs.writeFileSync(file, image.toPNG());
    return { ok: true, file, bytes: fs.statSync(file).size };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

ipcMain.handle('cuk:info', () => ({
  ok: true,
  shell: 'electron',
  electron: process.versions.electron,
  chrome: process.versions.chrome,
  opacity: typeof pref.opacity === 'number' ? pref.opacity : 56,
  // 失焦档：null = 跟随聚焦（页面据此显示「跟随」）
  opacityBlur: (typeof pref.opacityBlur === 'number') ? pref.opacityBlur : null,
  theme: pref.theme === 'light' ? 'light' : 'dark',
  size: pref.size,
  port: PORT,
  shotDir: SHOT_DIR,
}));

/**
 * 「窗外是不是活的」——用像素判定，不靠猜。
 *
 * 为什么要这么麻烦：用户要的是**实时透明**（背后是真正的桌面/别的窗口在动），
 * 而"原生材质有没有生效"这件事在 Electron 里没有任何 API 能直接问。
 * 唯一可靠的办法是拍一张屏幕：
 *   · 取窗口**内部**一块区域（中心偏下，避开标题栏）
 *   · 取窗口**外面**紧贴着的桌面一块
 *   · 如果两者不同 → 说明窗口里显示的确实来自窗外（真透明/真模糊）
 *   · 如果两者相同 → 说明窗口里是块死背景（材质没生效），需要铺壁纸兜底
 *
 * 注意：这个方法会被"窗口恰好压在纯色桌面上"之类的巧合骗到，所以它只用来决定
 * "要不要铺兜底壁纸" —— 铺错了最多是观感差一点，不会影响功能。
 */
ipcMain.handle('cuk:trans-check', async () => {
  if (!win || win.isDestroyed()) return { ok: false, error: 'no window' };
  try {
    const b = win.getBounds();
    const disp = screen.getDisplayMatching(b);
    const sf = disp.scaleFactor || 1;
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: Math.round(disp.size.width * sf), height: Math.round(disp.size.height * sf) },
    });
    const src = sources.find((s) => String(s.display_id) === String(disp.id)) || sources[0];
    if (!src) return { ok: false, error: 'no screen source' };
    const full = src.thumbnail;
    const size = full.getSize();
    // 缩到 1/4 再采样，省内存也够判断
    const small = full.resize({ width: Math.max(2, Math.round(size.width / 4)) });
    const bmp = small.toBitmap();                 // BGRA
    const sw = small.getSize().width, sh = small.getSize().height;
    const at = (x, y) => {
      const cx = Math.max(0, Math.min(sw - 1, Math.round(x / 4)));
      const cy = Math.max(0, Math.min(sh - 1, Math.round(y / 4)));
      const i = (cy * sw + cx) * 4;
      return [bmp[i + 2], bmp[i + 1], bmp[i]];    // RGB
    };
    const ox = Math.round((b.x - disp.bounds.x) * sf);
    const oy = Math.round((b.y - disp.bounds.y) * sf);
    const w = Math.round(b.width * sf), h = Math.round(b.height * sf);
    // 窗口内：中心偏下（避开标题栏与卡片高光），取 5 个采样点
    const inside = [
      at(ox + w * 0.5, oy + h * 0.62), at(ox + w * 0.3, oy + h * 0.7),
      at(ox + w * 0.7, oy + h * 0.55), at(ox + w * 0.45, oy + h * 0.85),
      at(ox + w * 0.6, oy + h * 0.75),
    ];
    // 窗口外：左右各取一条竖线（窗口与屏幕边留 6px 余量）
    const outX = [
      Math.max(0, ox - 20 * sf), Math.min(Math.round(disp.size.width * sf) - 6, ox + w + 20 * sf),
    ];
    const outside = [];
    for (const x of outX) for (const f of [0.3, 0.5, 0.7]) outside.push(at(x, oy + h * f));
    const avg = (arr) => arr.reduce((a, c) => [a[0] + c[0], a[1] + c[1], a[2] + c[2]], [0, 0, 0])
      .map((v) => Math.round(v / arr.length));
    const ai = avg(inside), ao = avg(outside);
    const dist = Math.max(Math.abs(ai[0] - ao[0]), Math.abs(ai[1] - ao[1]), Math.abs(ai[2] - ao[2]));
    // 窗口内明显异于窗外 → 里头显示的不是窗外画面（有玻璃染色/模糊也是"不同"，
    // 但那不算"没透"）。这里判"没透"的口径是：窗口内**基本等于**窗外 → 死背景。
    // 阈值放宽到 8：玻璃染色必然拉开更大差距，只有真的糊了一整块才判没透。
    return { ok: true, transparent: dist > 8, dist, inside: ai, outside: ao,
             display: disp.id };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});

// ---------------------------------------------------------------- 自检控制通道
//
// 为什么需要它：外壳和 server.js 是两个进程，中间只有 127.0.0.1 的 HTTP。
// 「窗口到底有没有圆角、拖动监听有没有挂上、界面是不是真的透」这些事只有主进程
// 知道，而会话里的自检脚本（PowerShell/Node）够不到 Electron 的 IPC。
// 所以外壳自己开一个**只绑回环、只读**的小 HTTP 口，供自检与本机自动化调用。
//
// ⚠️ 只绑 127.0.0.1，且只暴露三个只读/低风险动作（probe / shot / 窗口几何）。
//    不接受任何文件路径、不接受任意代码 —— 不要往这里加"能执行命令"的口子。
// ⚠️ 端口不能想当然地用 PORT+1：本机上 8800 被系统进程（PID 4）占着，
//    listen 静默失败（error 事件没接住就成了"探针口没响应"）。
//    这里从 PORT+11 开始往上找一个真能绑上的口，绑上了才用它。
const PROBE_PORT_BASE = Number(argOf('probeport', PORT + 11));
let probeSrv = null;
let probePort = 0;

function probeOnce() {
  return new Promise((resolve) => {
    if (!win || win.isDestroyed()) return resolve({ ok: false, error: 'no window' });
    const b = win.getBounds();
    win.webContents.executeJavaScript(`(() => {
      const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
                 display: cs.display, z: cs.zIndex, cursor: cs.cursor, pe: cs.pointerEvents }; };
      const at = (x, y) => { const el = document.elementFromPoint(x, y);
        return el ? (el.id || (typeof el.className === 'string' ? el.className : '') || el.tagName) : null; };
      return {
        shellClass: document.documentElement.classList.contains('shell-electron'),
        winR: getComputedStyle(document.documentElement).getPropertyValue('--win-r').trim(),
        bodyRadius: getComputedStyle(document.body).borderRadius,
        htmlRadius: getComputedStyle(document.documentElement).borderRadius,
        bodyOverflow: getComputedStyle(document.body).overflow,
        appOverflowY: getComputedStyle(document.querySelector('.app') || document.body).overflowY,
        winGlassInDom: !!document.querySelector('.win-glass'),
        winGlassRect: rect(document.querySelector('.win-glass')),
        wallpaperInDom: !!document.querySelector('.win-wallpaper'),
        bar: rect(document.getElementById('winbar')),
        dragZone: rect(document.getElementById('winbar-drag')),
        dragWired: !!window.__cukDragWired,
        dragInfo: window.__cukDragInfo || null,
        // 标题栏正上方那几个点实际命中的元素 —— 被别的层盖住就拖不动
        hitTopLeft:   at(40, 14),
        hitTopMid:    at(Math.round(innerWidth * 0.5), 14),
        hitTopRight:  at(innerWidth - 40, 14),
        innerW: innerWidth, innerH: innerHeight,
        // ★ 透明度这条链路的现场（排查「失焦预览和实际对不上」用）：
        //   页面把它的三个输入（聚焦档 / 失焦档 / 焦点 / 预览中）与**最终算出来的染色**都摊在这里，
        //   外面拿 /probe 一问就知道"页面以为现在是什么状态"，不必靠截图猜。
        //   pageFocus = 页面自己看到的焦点（document.hasFocus()），
        //   winFocus  = 主进程看到的焦点（winBlurred 取反）—— 两者不一致就是 bug 所在。
        opa: window.__cukOpaState || null,
        pageFocus: document.hasFocus(),
        tint: {
          glass: getComputedStyle(document.documentElement).getPropertyValue('--glass-tint').trim(),
          panel: getComputedStyle(document.documentElement).getPropertyValue('--panel').trim(),
          panel2: getComputedStyle(document.documentElement).getPropertyValue('--panel2').trim(),
        },
      };
    })()`).then((dom) => {
      resolve({ ok: true, bounds: b, fullScreen: win.isFullScreen(), radius: winRadius,
                shapeApi: typeof win.setShape === 'function',
                shapeNow: !!shapeOn,
                // 这两项是"圆角外白边"的直接开关（见文件头「圆角这件事」）
                winOpts: { roundedCorners: ROUNDED_CORNERS, thickFrame: THICK_FRAME },
                hasShadow: win.hasShadow(),
                // 主进程这边的同一份现场（与 dom.opa / dom.tint 逐项对照用）：
                //   blurred/focused 是主进程看到的焦点，opacityBlur 是「失焦」档的持久值。
                //   ⚠️ v1.8.21 起失焦不再动整窗 alpha，所以这里**不该**有 alpha 一项 ——
                //      若哪天真需要它，先看 MATERIAL_* 那段说明。
                blurState: { blurred: winBlurred, focused: win.isFocused(),
                             opacityBlur: pref.opacityBlur, opacity: pref.opacity,
                             materials: MATERIAL_FOCUSED + '/' + MATERIAL_BLURRED },
                dom });
    }).catch((e) => resolve({ ok: true, bounds: b, radius: winRadius,
                shapeApi: typeof win.setShape === 'function', shapeNow: !!shapeOn,
                winOpts: { roundedCorners: ROUNDED_CORNERS, thickFrame: THICK_FRAME },
                domErr: String(e.message) }));
  });
}

function startProbeServer(port) {
  try {
    const srv = http.createServer(async (req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1');
      const send = (o) => {
        const body = JSON.stringify(o);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8',
                             'Cache-Control': 'no-store' });
        res.end(body);
      };
      if (u.pathname === '/probe') return send(await probeOnce());
      // 显示器布局（多屏诊断：主屏/副屏 bounds、scaleFactor、窗口在哪块屏）
      if (u.pathname === '/displays') {
        if (!win || win.isDestroyed()) return send({ ok: false, error: 'no window' });
        const b = win.getBounds();
        const cur = screen.getDisplayMatching(b);
        return send({
          ok: true,
          primary: screen.getPrimaryDisplay().bounds,
          displays: screen.getAllDisplays().map((d) => ({
            id: d.id, bounds: d.bounds, workArea: d.workArea, scaleFactor: d.scaleFactor,
          })),
          windowBounds: b,
          windowOnDisplay: { id: cur.id, bounds: cur.bounds, scaleFactor: cur.scaleFactor },
        });
      }
      // ★ 页面重载：改完 web/ 下的 CSS/JS 想立刻看效果用。
      //   为什么需要它：外壳是**启动时**把页面加载进来的，改完样式不重载就一直看旧样子；
      //   而这个窗口只有 Electron 里才有（浏览器里 .winbar 根本不显示），截图也得靠壳。
      //   配上 /shot 就是"改样式 → reload → 截图 → 自己看"的闭环，不用每次让用户重启。
      //   风险：和已有的 /move /quit 同级（都只绑 127.0.0.1），只是让页面重新拉一次状态。
      // 注：`/alpha?v=`（临时改整窗 alpha）已随 v1.8.21 一并删除 —— 失焦不再动整窗 alpha。
      //     要看"失焦这条链路到底怎么了"用 **/probe**：它把页面侧（focusOpa/blurOpa/
      //     winFocused/previewing/effNow + 最终染色）和主进程侧（blurred/focused/
      //     opacityBlur/materials）**一次摊平**，逐项对照即可。
      if (u.pathname === '/reload') {
        if (!win || win.isDestroyed()) return send({ ok: false, error: 'no window' });
        try {
          win.webContents.reloadIgnoringCache();     // 带上 CSS 缓存也别拦着
          return send({ ok: true, reloaded: true });
        } catch (e) { return send({ ok: false, error: String(e.message) }); }
      }
      if (u.pathname === '/shot') {
        if (!win || win.isDestroyed()) return send({ ok: false, error: 'no window' });
        try {
          const name = (u.searchParams.get('name') || 'shot').replace(/[^\w.-]/g, '_').slice(0, 60);
          fs.mkdirSync(SHOT_DIR, { recursive: true });
          const img = await win.webContents.capturePage();
          const file = path.join(SHOT_DIR, name.endsWith('.png') ? name : name + '.png');
          fs.writeFileSync(file, img.toPNG());
          return send({ ok: true, file, bytes: fs.statSync(file).size });
        } catch (e) { return send({ ok: false, error: String(e.message) }); }
      }
      // ★ 桌面截图：把窗口所在的那块**屏幕**拍下来，连窗口阴影/系统圆角一起进画面。
      //   capturePage 只拍页面内容，看不到"圆角外那圈白边"（那是系统合成的），
      //   所以验证"白边有没有修掉"必须用这条。
      if (u.pathname === '/screen') {
        if (!win || win.isDestroyed()) return send({ ok: false, error: 'no window' });
        try {
          const name = (u.searchParams.get('name') || 'screen').replace(/[^\w.-]/g, '_').slice(0, 60);
          fs.mkdirSync(SHOT_DIR, { recursive: true });
          const b = win.getBounds();
          const disp = screen.getDisplayMatching(b);
          const sf = disp.scaleFactor || 1;
          const sources = await desktopCapturer.getSources({
            types: ['screen'],
            thumbnailSize: { width: Math.round(disp.size.width * sf), height: Math.round(disp.size.height * sf) },
          });
          const src = sources.find((s) => String(s.display_id) === String(disp.id))
            // ⚠️ display_id 在部分驱动上为空（Electron 已知问题），此时上面的 find
            //    会落空 → 曾一路 fallback 到 sources[0]，把**主屏**截了下来，
            //    而窗口在副屏 —— "四角干净"的验证全是拍错屏的假阳性。
            //    改用 thumbnail 尺寸匹配目标显示器分辨率兜底。
            || sources.find((s) => {
              const sz2 = s.thumbnail.getSize();
              return Math.abs(sz2.width - Math.round(disp.size.width * sf)) <= 2
                  && Math.abs(sz2.height - Math.round(disp.size.height * sf)) <= 2;
            })
            || sources[0];
          if (!src) return send({ ok: false, error: 'no screen source' });
          const full = src.thumbnail;
          // 自检期间用户可能开着全屏游戏 —— 置顶截完立刻取消，保证拍到窗口
          const needTop = u.searchParams.get('top') === '1';
          if (needTop) {
            try { win.setAlwaysOnTop(true, 'screen-saver'); } catch (_) {}
            await new Promise((r2) => setTimeout(r2, 350));
          }
          // 裁到"窗口 + 四周各留 80px"，这样四角的系统残留一眼可见
          const pad = Math.round(80 * sf);
          const crop = {
            x: Math.max(0, Math.round((b.x - disp.bounds.x) * sf) - pad),
            y: Math.max(0, Math.round((b.y - disp.bounds.y) * sf) - pad),
            width: Math.round(b.width * sf) + pad * 2,
            height: Math.round(b.height * sf) + pad * 2,
          };
          const sz = full.getSize();
          crop.width = Math.min(crop.width, sz.width - crop.x);
          crop.height = Math.min(crop.height, sz.height - crop.y);
          const out = full.crop(crop);
          const file = path.join(SHOT_DIR, name.endsWith('.png') ? name : name + '.png');
          fs.writeFileSync(file, out.toPNG());
          if (needTop) { try { win.setAlwaysOnTop(false); } catch (_) {} }
          return send({ ok: true, file, bytes: fs.statSync(file).size, crop, scaleFactor: sf });
        } catch (e) { return send({ ok: false, error: String(e.message) }); }
      }
      if (u.pathname === '/quit') { send({ ok: true }); setTimeout(() => app.quit(), 120); return; }
      // 自检用：把窗口挪到指定位置（默认"靠右下角"，那里通常是干净的桌面，
      // 便于用截图判断窗口四角有没有系统残留的白边，不会被别的窗口干扰）
      if (u.pathname === '/move') {
        if (!win || win.isDestroyed()) return send({ ok: false, error: 'no window' });
        try {
          // 最小化/隐藏状态下 setBounds 不上屏 —— 先恢复显示再挪
          if (win.isMinimized()) win.restore();
          win.show();
          win.focus();
          const d = screen.getPrimaryDisplay();
          const b = win.getBounds();
          const hasXY = u.searchParams.get('x') && u.searchParams.get('y');
          const corner = hasXY ? null : (u.searchParams.get('to') || 'br');
          let x = b.x, y = b.y;
          const M = 40;
          if (hasXY) {
            x = parseInt(u.searchParams.get('x'), 10);
            y = parseInt(u.searchParams.get('y'), 10);
          } else if (corner === 'br') { x = d.bounds.width - b.width - M; y = d.bounds.height - b.height - M; }
          else if (corner === 'bl') { x = d.bounds.x + M; y = d.bounds.height - b.height - M; }
          else if (corner === 'tr') { x = d.bounds.width - b.width - M; y = d.bounds.y + M; }
          else if (corner === 'tl') { x = d.bounds.x + M; y = d.bounds.y + M; }
          win.setBounds({ x, y, width: b.width, height: b.height });
          return send({ ok: true, bounds: win.getBounds(), corner: corner || 'xy' });
        } catch (e) { return send({ ok: false, error: String(e.message) }); }
      }
      send({ ok: false, error: 'not found',
             paths: ['/probe', '/shot?name=', '/screen?name=', '/displays', '/reload',
                     '/move?to=br|bl|tr|tl', '/quit'] });
    });
    // 试着绑；绑不上就换下一个口（最多试 20 个）
    let tries = 0;
    const tryListen = (p) => {
      srv.once('error', () => {
        if (++tries > 20) return;
        tryListen(p + 1);
      });
      srv.listen(p, '127.0.0.1', () => { probePort = p; });
    };
    srv.on('error', () => {});
    probeSrv = srv;
    tryListen(port);
  } catch (_) {}
}

/** 探针端口（0 表示还没绑上）—— 供 /api/state 报给自检脚本。 */
function probePortNow() { return probePort; }

// 单实例：第二次启动就把已有窗口拉到前面，别开两个
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win && !win.isDestroyed()) { if (win.isMinimized()) win.restore(); win.focus(); }
  });

  app.whenReady().then(() => {
    createWindow();
    startProbeServer(PROBE_PORT_BASE);
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });

  app.on('window-all-closed', () => { app.quit(); });

  // 透明窗口 + 硬件加速缺失时会整片发黑，这里给一条明确的提示路径
  app.on('gpu-process-crashed', () => {
    console.error('GPU 进程崩溃：透明效果可能失效，建议改用 --glass=solid 启动');
  });
}
