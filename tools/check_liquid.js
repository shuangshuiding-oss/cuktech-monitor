/* 版式自检：不截图，直接从 CSS / HTML 里核对「液态玻璃」改版的硬约束。
 *
 * 为什么不用截图：这台机器上无头 Edge 打开这个页面会吊死在 --virtual-time-budget 上
 * （页面有常驻 SSE + rAF 动画，virtual time 永远走不完），9 分钟都不出 PNG。
 * 所以外观类改动一律走**规则层断言** —— 把「必须成立的样子」写成可判定的条件。
 *
 * 用法: node tools/check_liquid.js
 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const css = fs.readFileSync(path.join(root, 'web', 'style.css'), 'utf8');
const html = fs.readFileSync(path.join(root, 'web', 'index.html'), 'utf8');

const out = [];
let bad = 0;
const ok = (label, cond, extra) => {
  if (!cond) bad++;
  out.push(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '   [' + extra + ']' : ''}`);
};

out.push('=== 1. 边框：卡片/端口卡/弹窗一律不许有可见描边 ===');
// 玻璃配方里 border 必须是"透明占位"，否则又回到有框的老样子。
const glassBlock = css.slice(css.indexOf('.card,.port,.modal'), css.indexOf('/* ---------- cards'));
ok('玻璃基类存在', glassBlock.length > 0);
ok('基类描边是透明的（只为 box-shadow 定位）', /border\s*:\s*1px solid var\(--edge\)/.test(glassBlock));
ok('--edge 是全透明色', /--edge\s*:\s*rgba\([^)]*,\s*0\s*\)/.test(css));
const visibleBorder = [...css.matchAll(/border\s*:\s*1px solid\s+(?!var\(--edge\))[^;]+/g)]
  .map((m) => m[0].trim())
  .filter((s) => !/var\(--edge\)/.test(s));
ok('没有其它可见 1px 实线描边（表格分隔线除外）',
  visibleBorder.every((s) => /rgba\(255,\s*255,\s*255,\s*0?\.0\d+\)/.test(s)),
  visibleBorder.join(' | ') || 'none');
ok('HTML 里没有内联 border', !/style="[^"]*border/i.test(html));
ok('HTML 里没有内联的实线分隔（border-top）', !/border-top:1px solid/.test(html));

out.push('');
out.push('=== 2. 玻璃质感：内高光 + 斜向光泽 + 分层投影 ===');
// —— 2026-10-05 「去掉模仿玻璃的光晕」：下列光效全部停用，断言反过来钉住“不得回归”——
ok('斜向高光已停用（--glass-sheen:none）', /--glass-sheen\s*:\s*none/.test(css));
ok('上缘高光已停用（--edge-top 全透明）', /--edge-top\s*:\s*rgba\(255,\s*255,\s*255,\s*0\)/.test(css));
ok('左右缘反射（侧向内高光）', /inset -0\.7px 0 0 var\(--edge-side\)/.test(css));
ok('两层投影（近景 + 远景）', /--lift-1\s*:[\s\S]{0,160}--lift-2\s*:/.test(css));
ok('卡片用玻璃基类', /\.card,\.port,\.modal/.test(css));
ok('文字亮晕已停用（--glow:none）', /--glow\s*:\s*none/.test(css));
ok('大数字用了 glow', /\.gauge-val\{[\s\S]{0,300}drop-shadow/.test(css));
ok('端口大数字按口色发光', /\.port \.big\{[\s\S]{0,300}text-shadow[\s\S]{0,200}var\(--pc/.test(css));

out.push('');
out.push('=== 3. 模糊预算：只留少量 backdrop-filter（同屏几十块会掉帧）===');
// 只在**声明**位置数（行首缩进的 backdrop-filter:），@supports 的特性查询、
// 同行带 -webkit- 前缀的重复写法、以及注释都不算 —— 否则计数会比真实规则数虚高一倍多。
const bfDecl = (css.match(/^\s*(?<!-webkit-)backdrop-filter\s*:\s*blur/gm) || []).length;
ok('真正生效的模糊规则 = 3 处（顶栏 / 提示 / 遮罩）', bfDecl <= 3, 'count=' + bfDecl);
const bfRules = (css.match(/^\s*backdrop-filter\s*:\s*blur/gm) || []).length;
ok('用到模糊的规则 ≤ 3 处', bfRules <= 3, 'rules=' + bfRules);
ok('顶栏是真模糊', /header\{[\s\S]{0,400}backdrop-filter/.test(css));
ok('卡片没有 backdrop-filter（靠半透明+高光，不靠模糊）',
  !/\.card\{[^}]*backdrop-filter/.test(css) && !/\.port\{[^}]*backdrop-filter/.test(css));
ok('顶栏是 sticky 的（滚动时玻璃下面有内容经过）', /header\{[\s\S]{0,200}position:sticky/.test(css));

out.push('');
out.push('=== 4. 背景：要有东西可"透" ===');
ok('氛围底图已停用（body::before display:none）', /body::before\{display:none\}/.test(css));
ok('有缓慢飘动的背景光斑已停用（.bg-orbs display:none）',
  /\.bg-orbs\{display:none\}/.test(css));
ok('HTML 里装饰层仍在（只是不显示，DOM 不动）', /class="bg-orbs"/.test(html));
ok('装饰层不吃事件（win-glass）', /\.win-glass\{[\s\S]{0,200}pointer-events:none/.test(css));
ok('尊重 prefers-reduced-motion', /prefers-reduced-motion/.test(css));

out.push('');
out.push('=== 5. 卡内分隔：实线换成渐隐高光 ===');
ok('.sec 用渐隐高光线', /\.sec\{[\s\S]{0,500}linear-gradient\(90deg,transparent/.test(css));
ok('.sec-h 小标题存在', /\.sec-h\{/.test(css));
const secCount = (html.match(/class="sec"/g) || []).length;
ok('HTML 里用到 .sec 分隔块', secCount >= 5, 'n=' + secCount);
ok('HTML 里用到 .sec-h 小标题', (html.match(/class="sec-h"/g) || []).length >= 5);

out.push('');
out.push('=== 6. 控件：玻璃片而不是方框 ===');
ok('按钮无描边 + 内高光', /button\{[\s\S]{0,400}border:0;[\s\S]{0,300}inset/.test(css));
ok('按钮有 hover 辉光', /button:hover\{[\s\S]{0,400}rgba\(56,189,248,\.2/.test(css));
ok('输入框/下拉也是玻璃片', /input\[type=number\][\s\S]{0,200}var\(--glass-bg\)/.test(css));
ok('聚焦有青色光晕（不是描边）', /:focus\{[\s\S]{0,200}box-shadow:[\s\S]{0,120}rgba\(56,189,248,\.2\)/.test(css));
ok('开关是玻璃槽 + 玻璃珠', /\.switch::after\{[\s\S]{0,300}linear-gradient/.test(css));
ok('分段控件选中段被点亮', /\.seg button\.on\{[\s\S]{0,200}box-shadow/.test(css));
ok('危险按钮用红色玻璃而非红框', /button\.danger\{[\s\S]{0,200}rgba\(248,113,113,\.14\)/.test(css));

out.push('');
out.push('=== 7. 降级：老引擎不能糊成一片看不见字 ===');
ok('无 backdrop-filter 时有实色兜底', /@supports not \(\(backdrop-filter/.test(css));
ok('无 color-mix 时有 text-shadow 兜底', /@supports not \(color:color-mix/.test(css));

out.push('');
out.push('=== 8. 透明窗口外壳（Electron）：真透明 + 大圆角 + 壁纸退路 ===');
const shellJs = fs.readFileSync(path.join(root, 'web', 'shell.js'), 'utf8');
const mainJs = fs.readFileSync(path.join(root, 'shell', 'main.js'), 'utf8');
const preloadJs = fs.readFileSync(path.join(root, 'shell', 'preload.js'), 'utf8');
// serverJs 在本文件更靠下的第 9 段才声明；第 8c 段要用，所以这里先单独读一份
const serverJsEarly = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
// 透明窗口的前提是"整页真的透明"。只要 html/body 里还留着不透明底色，
// 窗口再透明也会被一层不透明 body 挡死 —— 这是最容易翻车的一步，必须断言。
ok('壳模式下 html 背景透明', /html\.shell-electron\{[^}]*background:transparent/.test(css));
ok('壳模式下 body 背景透明', /html\.shell-electron body\{[\s\S]{0,200}background:transparent/.test(css));
ok('圆角与系统圆角同值（--win-r:8px，双圆角不错位）', /--win-r\s*:\s*8px/.test(css));
ok('body 圆角 + 裁切（圆角外不许漏方角）',
  /html\.shell-electron body\{[\s\S]{0,400}border-radius:var\(--win-r\)[\s\S]{0,120}overflow:hidden/.test(css));
// html 也裁一层：body 的裁剪框在滚动容器下会失效，只靠 body 会漏方角（踩过）
ok('html 也套圆角 + 裁切（双重保险）',
  /html\.shell-electron\{[\s\S]{0,400}border-radius:var\(--win-r\)[\s\S]{0,160}overflow:hidden/.test(css));

ok('玻璃板层存在（.win-glass）', /\.win-glass\{/.test(css));
ok('玻璃板有整窗尺寸的圆角', /\.win-glass\{[\s\S]{0,200}border-radius:var\(--win-r\)/.test(css));
ok('玻璃板边缘白线已停用（纯染色，无 inset 高光）',
  !/\.win-glass\{[\s\S]{0,600}inset 0 1\.5px 0 rgba\(255,255,255/.test(css));
ok('壁纸退路层存在（.win-wallpaper）', /\.win-wallpaper\{/.test(css));
ok('壁纸层不吃事件', /\.win-wallpaper\{[^}]*pointer-events:none/.test(css));

// Electron 主进程侧：真透明的三个开关必须都在
ok('Electron 主进程存在', mainJs.length > 500);
ok('窗口是 frame:false（无系统边框）', /frame:\s*false/.test(mainJs));
ok('窗口是 transparent:true（真透明的前提）', /transparent:\s*true/.test(mainJs));
ok('窗口背景色是全透明（不是深色）', /backgroundColor:\s*'#00000000'/.test(mainJs));
ok('没有"不透明档"（关材质 + 主题实色底那套已随开关一起删掉）',
  !/setBackgroundMaterial\('none'\)/.test(mainJs)
  && !/setBackgroundColor\(pref\.theme === 'light'/.test(mainJs));
ok('用 DWMWA_BORDER_COLOR 去掉 1px 白色矩形边框（圆角外露白直角）',
  /removeDwmBorder/.test(mainJs) && /0xfffffffe/i.test(mainJs) && /_koffi/.test(mainJs));
// transparent + resizable:true 在 Windows 上会让透明失效 —— 官方文档明说过
// ⚠️ 2026-10-08 反转：resizable 必须 **true**。Electron 的 resizable:false 会去掉
//    WS_THICKFRAME，而 Win11 的 DWM 只给**有边框样式**的窗口画圆角 —— 去掉之后
//    窗口四角就是直角（用户报「窗口外面还有直角」）。原注释说的 transparent +
//    resizable 冲突针对的是 transparent:true，本窗口是 transparent:false，不冲突。
ok('resizable:true（resizable:false 会去掉 WS_THICKFRAME，DWM 就不画圆角了）',
  /resizable:\s*true/.test(mainJs));
ok('有原生背景材质兜底（acrylic/mica）', /setBackgroundMaterial\(/.test(mainJs));
// 2026-10-08：**两端都用 acrylic**（失焦不再换 mica）—— 见下面那条的实测说明。
ok('背景材质用 DWM 原生 acrylic（聚焦 / 失焦同一材质）',
  /MATERIAL_FOCUSED = 'acrylic'/.test(mainJs) && /MATERIAL_BLURRED = 'acrylic'/.test(mainJs));
ok('有截图能力（供自检用）', /capturePage\(/.test(mainJs));
// 渲染侧：只有壳里才启用自绘窗口控件，浏览器打开不能变样
ok('shell.js 判定壳环境（--cuk-shell=electron）', /--cuk-shell=electron/.test(shellJs));
ok('shell.js 会加 shell-electron 类', /classList\.add\('shell-electron'\)/.test(shellJs));
ok('标题栏在浏览器里默认不显示', /\.winbar\{[\s\S]{0,200}display:none/.test(css));
ok('标题栏在壳里才显示', /html\.shell-electron \.winbar\{display:flex\}/.test(css));
// 2026-10-08：顶栏整条改成"圆角条"（原来上圆下直、向下淡出到透明，下沿那条直边很扎眼）。
// ⚠️ 光给 border-radius 没用 —— 条身必须**覆盖整条高度**的填充，圆角才看得出来。
ok('顶栏是圆角条（下两角也是圆的）',
  /\.winbar\{[\s\S]{0,1200}border-radius:calc\(var\(--win-r\) - 0\.3rem\) calc\(var\(--win-r\) - 0\.3rem\) 1\.1rem 1\.1rem/.test(css));
ok('顶栏填充不再"淡出到 transparent"（否则下沿直边挡着，圆角看不出来）',
  /\.winbar\{[\s\S]{0,1200}background:linear-gradient\(180deg, rgba\(255,255,255,\.075\), rgba\(255,255,255,\.028\)\)/.test(css)
  && !/\.winbar\{[\s\S]{0,1200}62%, transparent\)/.test(css));
// 2026-10-08 晚：用户圈出"显示登录和蓝牙信号的那栏"（= header 底衬）—— 说它还是方的。
// 它左右贴窗口边、下沿一条直边；壳里上两角被 .winbar 压住，看到的正是下面两个圆角。
ok('页头（登录 / 蓝牙信号那栏）的底衬也是圆角条',
  /header::before\{[\s\S]{0,700}border-radius:1\.1rem/.test(css));
ok('外壳调试口带 /reload（改完样式可自己刷新+截图，不必重启应用）',
  /u\.pathname === '\/reload'/.test(mainJs) && /reloadIgnoringCache/.test(mainJs));
ok('拖动区有抓取光标', /\.winbar-drag\{[\s\S]{0,200}cursor:grab/.test(css));
// ★ 2026-10-05 终场定案（像素级验证）：transparent:false + roundedCorners:true
//    → 磨砂被 DWM 裁进系统圆角，四角干净（四角 5x 放大拼图 + 角落亮度图确认）。
ok('用系统圆角（roundedCorners:true，磨砂跟随圆角）',
  /roundedCorners\s*:\s*ROUNDED_CORNERS/.test(mainJs) && /ROUNDED_CORNERS\s*=\s*true/.test(mainJs));

// ============================================================
// 8b. 「圆角外白色边缘」+「实时透明」—— 2026-09-23 实机修掉的两个真问题
// ============================================================
//
// 背景（别删这些断言，删了以后很容易又改回错的样子）：
//  · 白边：Win11 会给无边框窗口**自己画一圈圆角+阴影+细边框**（roundedCorners
//    默认 true，见 electron/electron#46468）。那圈系统框落在 CSS 圆角外面，
//    就是用户看到的"r 角外面残留白色边缘"。
//  · 假透明：原来是拿桌面壁纸当背景"假装透出去"，窗外是死的（别的窗口经过看不见）。
//
// 这两条都没法靠截图断言（无头浏览器截不了活页面），所以全部写成规则断言。

out.push('');
out.push('=== 8b. 圆角无白边 + 实时透明（实机修复项）===');
// —— 磨砂玻璃（2026-10-05 定案；2026-10-06 开关删除，固定 acrylic）——
//    hasShadow:false 修掉矩形阴影后实测：**acrylic 材质跟随系统圆角裁切**，
//    之前的"方角"是 hasShadow:true 的锅。磨砂（苹果玻璃）+ 无方角可以兼得，
//    前提是 roundedCorners:true（系统圆角）。
//    开关删除的原因：关掉档要铺主题实色底，得到一层**不透明窗口**，用户明确不要。
// 2026-10-08 深夜改：材质现在由代码决定两态（**聚焦 / 失焦都是 acrylic**），
// 仍然**不是**用户可切的档位（FROST_MODES 那套已删）。
ok('材质由代码定两态（聚焦/失焦），仍无用户档位',
  /MATERIAL_FOCUSED = 'acrylic'/.test(mainJs) && /MATERIAL_BLURRED = 'acrylic'/.test(mainJs)
  && !/FROST_MODES/.test(mainJs));
ok('磨砂开关删干净了（按钮 / IPC / preload / 页面逻辑四处都不留）',
  !/w-frost/.test(html) && !/cuk:set-frost/.test(mainJs) && !/setFrost/.test(preloadJs)
  && !/FROST_CYCLE/.test(shellJs) && !/frost/i.test(shellJs));
ok('不会再有"不透明档"（none 材质 + 主题实色底那套已移除）',
  !/setBackgroundMaterial\('none'\)/.test(mainJs) && !/applyFrost\(/.test(mainJs));
ok('启动时走 applyGlass(材质)（唯一入口，主题切换不再碰玻璃）',
  /applyGlass\(MATERIAL_FOCUSED\)/.test(mainJs) && !/applyGlass\(\)/.test(mainJs));
ok('旧 pref.json 里的 frost 键会被清掉（免得以后以为还有开关）',
  /delete pref\.frost/.test(mainJs));
// ⚠️ 2026-10-08 反转：thickFrame 必须**开着**。关掉它 = 没有 WS_THICKFRAME =
//    Win11 的 DWM 把窗口当「无边框工具窗口」，**不给圆角**（roundedCorners:true 也白搭）。
//    系统阴影由 hasShadow:false 单独关，不用靠 thickFrame。
ok('主进程保留 thickFrame（WS_THICKFRAME 是 DWM 肯画圆角的前提）',
  /thickFrame\s*:\s*THICK_FRAME/.test(mainJs) && /THICK_FRAME\s*=\s*true/.test(mainJs));
// 2026-10-08 深夜：官方 acrylic 会被 Windows 在失焦时降级成实色（UWP 行为，第三方库把它
// 做成 disableOnBlur 且默认 true）—— 但那是**旧窗口形态**下的结论。
// 2026-10-08 真机对照实测（tools/dev/win_backdrop.js 直接设 DWMWA_SYSTEMBACKDROP_TYPE）：
//   失焦 + acrylic ⇒ 窗口里是**模糊的窗外**（磨砂）；失焦 + mica ⇒ 深色壁纸色调，像块实色板。
//   用户反馈「失焦后透明度没变」「预览和实际对不上」正是 mica 造成的 ⇒ 两端都用 acrylic。
ok('聚焦与失焦都用 acrylic（mica 会让失焦像一块实色板）',
  /MATERIAL_FOCUSED = 'acrylic'/.test(mainJs) && /MATERIAL_BLURRED = 'acrylic'/.test(mainJs)
  && /win\.on\('blur'/.test(mainJs) && /setBackgroundMaterial\(MATERIAL_BLURRED\)/.test(mainJs));
ok('显式要 DWM 画圆角（DWMWA_WINDOW_CORNER_PREFERENCE=33 / DWMWCP_ROUND=2）',
  /function forceRoundCorners\(\)/.test(mainJs) && /set\(hwnd, 33, v, 4\)/.test(mainJs)
  && /forceRoundCorners\(\);/.test(mainJs));
ok('两个开关写成常量（自检报的才是实际值，不是散落的字面量）',
  /const ROUNDED_CORNERS/.test(mainJs) && /const THICK_FRAME/.test(mainJs));
// ⚠️ 2026-10-05 踩过：只关 roundedCorners+thickFrame 却把 hasShadow 留 true，
//    窗口阴影绕矩形画，圆角外还是一圈浅色直角。必须显式 hasShadow:false。
ok('显式关掉窗口阴影（hasShadow:false，阴影=矩形直角）',
  /hasShadow:\s*false/.test(mainJs));
ok('自检探针会报出这两个值', /winOpts:\s*\{\s*roundedCorners/.test(mainJs));
ok('探针也报实际阴影状态（判断 false 是否真生效）', /hasShadow:\s*win\.hasShadow\(\)/.test(mainJs));
ok('滚动的只有 .app（不让滚动条轨道跑到窗口圆角上画方块）',
  /html\.shell-electron \.app\{[\s\S]{0,300}overflow-y:auto/.test(css));
ok('html/body 在壳里都不滚（消除第二个方角来源）',
  /html\.shell-electron\{overflow:hidden!important\}/.test(css)
  && /html\.shell-electron body\{overflow:hidden!important\}/.test(css));
ok('滚动条轨道全站透明（默认那条灰方块就是"白框"的一半）',
  /\*::-webkit-scrollbar-track\{background:transparent\}/.test(css)
  && /\*::-webkit-scrollbar-corner\{background:transparent\}/.test(css));

// —— 实时透明 ——
// 染色三档（glass-deep/light/solid）：deep 默认档 alpha=.5；light=.16。
// 这里钉住"至少有一档是透的，且默认档不是实心"。
ok('存在浅透档位（glass-light tint < 0.35）', (() => {
  const m = /html\.glass-light\{[^}]*--glass-tint:rgba\([^)]*?,\s*([\d.]+)\s*\)/.exec(css);
  return !!m && Number(m[1]) < 0.35;
})());
ok('三档染色类齐全（deep/light/solid）',
  /html\.glass-deep\{/.test(css) && /html\.glass-light\{/.test(css) && /html\.glass-solid\{/.test(css));
ok('顶栏底衬在壳里调薄（原来 .8 太实）', /html\.shell-electron header::before\{/.test(css));
ok('氛围光整体停用（壳里不再有 opacity 折中段）',
  !/html\.shell-electron body::before\{opacity/.test(css));
// —— 透明度滑块（2026-10-05，用户要求"加一个透明度调节"）——
const indexHtml = html;
ok('顶栏有透明度滑块（w-opa，0~100）',
  /id="w-opa"/.test(indexHtml) && /type="range"/.test(indexHtml));
ok('滑块拖动实时改 CSS 变量（input 事件，不等松手）',
  /addEventListener\('input', \(\) => applyOpa\(opaSlider\.value\)\)/.test(shellJs));
ok('松手才持久化（change 事件 → cuk:set-opacity）',
  /addEventListener\('change'[\s\S]{0,200}cuk:set-opacity/.test(shellJs));
ok('滑块同时调三处（tint/panel/panel2，卡片比整窗略实）',
  /--glass-tint/.test(shellJs) && /--panel2/.test(shellJs));
ok('主进程持久化 opacity（cuk:set-opacity handler）',
  /cuk:set-opacity/.test(mainJs) && /pref\.opacity = o/.test(mainJs));
ok('info 返回当前透明度', /opacity:\s*typeof pref\.opacity/.test(mainJs));
ok('preload 暴露 setOpacity', /setOpacity:/.test(preloadJs));
// —— 浅色主题（2026-10-05，用户要"浅色切换"）——
ok('顶栏有主题切换按钮（w-theme）', /id="w-theme"/.test(indexHtml));
// 2026-10-08：顶栏原来还有个落单的「中」按钮（id=w-size-m，没有任何 JS 绑定），
// 和右边「小 中 大」分段控件功能重复 —— 用户说「没用就删了」。钉住别再加回来。
ok('顶栏只有一个尺寸控件（没有落单的重复按钮）',
  !/id="w-size-m"/.test(indexHtml) && /id="w-size"/.test(indexHtml)
  && /data-size="small"/.test(indexHtml) && /data-size="large"/.test(indexHtml));
ok('浅色主题用 html.light 类覆盖配色', /html\.light\{[\s\S]{0,600}--txt:#1c2436/.test(css));
ok('浅色下文字是深色（--txt 换成深蓝灰）', /html\.light\{[\s\S]{0,800}--txt-2:#4a5a78/.test(css));
ok('滑块感知主题（light 用浅色基色）', /classList\.contains\('light'\)/.test(shellJs)
  && /rgba\(246,249,255,'\s*\+\s*a\.toFixed/.test(shellJs));
ok('主题切换持久化（cuk:set-theme）', /cuk:set-theme/.test(mainJs) && /pref\.theme = theme/.test(mainJs));
ok('info 返回主题', /theme:\s*pref\.theme === 'light'/.test(mainJs));
ok('preload 暴露 setTheme', /setTheme:/.test(preloadJs));
// 壁纸兜底：必须是**条件**铺，不是无条件铺（无条件铺 = 假透明）
ok('壁纸层只作兜底（先探真透明，透了就不铺）',
  /probeRealTransparency/.test(shellJs) && /if \(t && t\.ok && t\.transparent\) return/.test(shellJs)
  && /win-wallpaper-fallback/.test(shellJs));
ok('主进程有"窗外是不是活的"像素判定（cuk:trans-check）',
  /cuk:trans-check/.test(mainJs) && /desktopCapturer/.test(mainJs));
ok('探针桥暴露了 transCheck', /transCheck:/.test(preloadJs));
// capturePage 只拍页面内容，看不到系统合成的那圈框 —— 验证白边必须拍屏幕
ok('有整屏截图能力（验证"圆角外"用）', /'\/screen'/.test(mainJs) && /desktopCapturer\.getSources/.test(mainJs));
ok('有把窗口挪到指定角的接口（避开别的窗口干扰做截图判定）', /'\/move'/.test(mainJs));
// —— 白边判定方法论：用"最长连续白线"而不是"白色像素计数" ——
// 教训：早期 corner_check2.js 用"四角 50x50 区里数近纯白像素"，结果把**窗外的
// 白底文档窗口**和**大圆角切角区外的内容**全算成了白边（假阳性，报 2500）。在
// 干净桌面上实测（窗口挪到右下角）四条边外 1px + 圆角弧外侧 184 点全是 0 白像素。
// 所以断言必须钉住：判据是"连续段长度"，且要跳过圆角切角区。
const cornerChk = fs.readFileSync(path.join(root, 'tools', 'dev', 'corner_check2.js'), 'utf8');
ok('白边检测用"最长连续白线"判据（计数式会假阳性）',
  /runMax/.test(cornerChk) && /RUN_LIMIT/.test(cornerChk) && /最长连续/.test(cornerChk));
ok('白边检测跳过圆角切角区（切角外是窗外内容，不是描边）',
  /nearCorner/.test(cornerChk) && /WX \+ R/.test(cornerChk));
ok('白边检测只扫"窗口外缘/内缘 1px 带"（不整图统计）',
  /外1px/.test(cornerChk) && /内1px/.test(cornerChk));

// ============================================================
// 8c. 壳环境判定 + 拖动 —— 两个曾经让整个壳层静默失效的坑
// ============================================================
//
//  · ELECTRON_RUN_AS_NODE=1 会让 Electron 退化成纯 Node：窗口"看着开出来了"，
//    但渲染器的 additionalArguments 不生效 → shell.js 判定"不在壳里" →
//    圆角/玻璃/标题栏/拖动全都不做。外观上只是"窗口是方的、多一圈白边"。
//  · contextIsolation:true 时渲染进程**没有 require**，原来 shell.js 直接
//    require('electron') 会抛错 → 同样整层失效。必须走 preload 桥。
out.push('');
out.push('=== 8c. 壳环境判定与拖动（静默失效防护）===');
// ⚠️ 这里必须用 serverJsEarly：本节在 out 的第 8c 段，位置在 `const serverJs`
//    （第 253 行）**之前**，直接用 serverJs 会因为 TDZ 抛
//    "Cannot access 'serverJs' before initialization"，整个 check_liquid 挂掉。
ok('server 启动外壳时清掉 ELECTRON_RUN_AS_NODE',
  /delete shellEnv\.ELECTRON_RUN_AS_NODE/.test(serverJsEarly));
ok('外壳自己也会检测并清掉该变量（手工启动也不踩）',
  /if \(process\.env\.ELECTRON_RUN_AS_NODE\)/.test(mainJs));
ok('窗口挂了 preload（contextIsolation 下拿 IPC 的唯一途径）',
  /preload:\s*path\.join\(__dirname,\s*'preload\.js'\)/.test(mainJs));
ok('preload 通过 contextBridge 暴露最小桥',
  /contextBridge\.exposeInMainWorld\('cukShell'/.test(preloadJs)
  && /__CUK_SHELL__/.test(preloadJs));
ok('preload 不暴露任意通道（安全）',
  !/exposeInMainWorld\([^)]*ipcRenderer\s*\)/.test(preloadJs));
// 只看代码行（注释里提到 require 是解释原因，不算违规）
ok('shell.js 不再 require(electron)（contextIsolation 下会抛错）',
  !/^\s*(?:const|let|var)?[^/\n]*require\('electron'\)/m.test(shellJs.replace(/^\s*\/\/.*$/gm, '')));
ok('壳环境多路判定（桥 / argv / versions / env 任一成立）',
  /const inShell = envFlag \|\| !!bridge \|\| argvFlag \|\| hasElectron/.test(shellJs));
ok('没有桥时明确告警而不是静默失败', /没有 cukShell 桥/.test(shellJs));
ok('壳里会插入 .win-glass 玻璃板（原来只写了样式没进 DOM）',
  /className = 'win-glass'/.test(shellJs) && /insertBefore\(layer, document\.body\.firstChild\)/.test(shellJs));
ok('拖动用 pointerdown（首次点击不会被"激活窗口"吞掉）',
  /addEventListener\('pointerdown', onDown\)/.test(shellJs));
ok('拖动按 rAF 节流（1000Hz 鼠标不会把主进程压垮）',
  /requestAnimationFrame\(flushMove\)/.test(shellJs));
ok('指针捕获只用一瞬间，不长期占用（否则松手还粘着鼠标）',
  /setPointerCapture\(e\.pointerId\)/.test(shellJs)
  && /releasePointerCapture\(e\.pointerId\)/.test(shellJs));
ok('窗口失焦一定收尾拖动（Alt+Tab 回来不粘鼠标）',
  /addEventListener\('blur', onUp\)/.test(shellJs));
// ⚠️ 只判代码，注释里的历史说明不算（main.js 注释保留演化记录）。
const mainJsCode = mainJs.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
ok('拖动开始不再撤蒙版（用户实测撤了露直角）',
  !/cuk:drag-start'[\s\S]{0,300}clearShape\(\)/.test(mainJsCode));
ok('全屏时蒙版归零（铺满不留缺口）',
  /isFullScreen\(\)[\s\S]{0,200}applyShape\(full \? 0/.test(mainJsCode));
ok('标题栏一眼可辨可拖（有底衬 + 抓取光标）',
  /\.winbar\{[\s\S]{0,900}cursor:grab/.test(css));
ok('拖动区声明 touch-action:none（指针事件不被当滚动）',
  /\.winbar-drag\{[\s\S]{0,500}touch-action:none/.test(css));
ok('被别的层盖住会拖不动 —— 装饰层都不吃事件',
  /\.win-glass\{[\s\S]{0,200}pointer-events:none/.test(css)
  && /\.bg-orbs\{display:none\}/.test(css));

out.push('');
out.push('=== 9. 环境温度计卡片 ===');
const appJs = fs.readFileSync(path.join(root, 'web', 'app.js'), 'utf8');
ok('HTML 有温度卡片', /id="env-card"/.test(html));
ok('HTML 有温度大数字', /id="env-temp"/.test(html));
ok('HTML 有湿度', /id="env-hum"/.test(html));
ok('HTML 有"是外挂传感器"的声明', /外挂传感器/.test(html));
ok('HTML 明确"不是充电头内部温度"', /不是充电头内部温度/.test(html));
ok('CSS 有温度卡片样式', /\.env-card\{/.test(css));
ok('CSS 有大数字渐变', /\.env-val span\{[\s\S]{0,300}background:linear-gradient/.test(css));
ok('CSS 有陈旧态样式（.stale）', /\.env-card\.stale/.test(css));
ok('前端有 renderEnv 渲染函数', /function renderEnv\(/.test(appJs));
ok('前端会标注"数据陈旧"', /数据陈旧/.test(appJs));
ok('前端区分广播直读 / 连接读取', /广播直读/.test(appJs));
const serverJs = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
// 云登录的 TLS 口径在 netfix.py + login.py 里（v1.8.1：Python 3.13 严格模式误杀小米证书链）
const netfixPy = fs.readFileSync(path.join(root, 'netfix.py'), 'utf8');
const loginPy = fs.readFileSync(path.join(root, 'login.py'), 'utf8');
ok('服务端有独立温度计进程管理', /function startEnvSensor\(/.test(serverJs));
// 温度比功率值得留得更久（一天才 960 行）。设备内置历史读回来之后能追到半年前，
// 所以日文件的实际保留期由 ENV_KEEP_DAYS_DEVICE(200) 决定，不能再只判 30。
ok('温湿度历史保留 30 天以上',
  /ENV_KEEP_DAYS\s*=\s*30/.test(serverJs) && /ENV_KEEP_DAYS_DEVICE\s*=\s*(\d+)/.test(serverJs)
  && Number(/ENV_KEEP_DAYS_DEVICE\s*=\s*(\d+)/.exec(serverJs)[1]) >= 160);
ok('日文件清理用设备保留期（否则读回半年前的数据会被当过期删掉）',
  /for \(let i = 0; i < ENV_KEEP_DAYS_DEVICE; i\+\+\) keep\.add/.test(serverJs));
ok('有 /api/env/history 路由', /'\/api\/env\/history'/.test(serverJs));
ok('温湿度查询函数存在', /function queryEnvHistory\(/.test(serverJs));
// 设备内置历史 = 每小时一条、可跨半年 ⇒ 必须有 90天/全部 两档，否则看不到全貌
ok('区间含 90 天 / 半年 / 1 年 / 全部四档',
  ['90d', '180d', '1y', 'all'].every((k) => serverJs.includes("'" + k + "'") && appJs.includes("'" + k + "'")));
ok('半年档的秒数别写错（180 天 = 15552000）', /'180d':\s*15552000/.test(serverJs));
ok('1 年档的时间轴换成年-月（跨年窗口不能只画"月-日"）',
  /tickFmt === 'ym'/.test(appJs) && /300 \* 86400000 \? 'ym'/.test(appJs));
ok('温度按天文件保留 400 天（否则「1 年」档会被清理机制截短）',
  /ENV_KEEP_DAYS_DEVICE\s*=\s*400/.test(serverJs));
ok('长窗（90 天/半年/1 年/全部）统一走 LONG_RANGES，读过历史才显示',
  /const LONG_RANGES = new Set\(\['90d', '180d', '1y', 'all'\]\)/.test(appJs)
  && /RANGES\.filter\(\(\[k\]\) => !LONG_RANGES\.has\(k\) \|\| envHistLoaded\)/.test(appJs));
ok('半年级档位默认隐藏、读过历史才放出', /envHistLoaded/.test(appJs) && /renderEnvRanges/.test(appJs));
ok('时间轴刻度按跨度换格式（长窗口不能一律打印 HH:MM:SS）', /tickFmt/.test(appJs));
ok('曲线空档判据跟着真实采样间隔走（小时级历史不会被当空档切断）',
  /medIv/.test(appJs) && /3 \* medIv/.test(appJs));
ok('历史进度不拿设备上限当分母（曾显示成 3105/152 条）',
  /已超过设备保留上限/.test(appJs) && !/got\}\/\$\{d\.total\}/.test(appJs));
// 长区间必须同时读「按天文件」和「分钟文件」—— 历史只保证进了分钟文件，
// 按天文件可能因为旧 bug 缺了整段（曾经「90天/全部」只画到最近 30 天）。
ok('长区间同时读按天文件与分钟文件', /src\.push\(\.\.\.readEnvMinRows\(\)\)/.test(serverJs));
// mergeEnvHistory 绝不能在逐行循环里调 prune —— 那会把刚写的历史日文件自己删掉
// （判据要剥掉注释再测，注释里正写着这条教训本身）
const serverJsCode = serverJs.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
// ⚠️ 只查 mergeEnvHistory 这一段。appendEnvRow 里的 "换天就清理" 是**正常**的
//    （实时写入一天才跨一次天，触发一次）；会被误伤的只有"逐行搬历史"那个循环 ——
//    那里 envHistDay 会被历史日期一路往回带，清理窗口跟着后退，刚写进去的日文件
//    在同一轮里被自己删掉。曾经把整文件范围内禁止这个写法，结果把正常路径也判成错。
const mergeCode = (() => {
  const i = serverJsCode.indexOf('function mergeEnvHistory');
  if (i < 0) return '';
  const j = serverJsCode.indexOf('\nfunction ', i + 10);
  return serverJsCode.slice(i, j < 0 ? serverJsCode.length : j);
})();
ok('能找到 mergeEnvHistory（这条断言的判据所在）', mergeCode.length > 0);
ok('历史落盘写完之后才统一清理（循环里清理会删掉刚写的日文件）',
  /const byDay = new Map\(\)/.test(mergeCode) && /pruneEnvHistDays\(\);/.test(mergeCode)
  && !/envHistDay = k; pruneEnvHistDays\(\);/.test(mergeCode));
// v1.8.2 起语义从"合并"改成"覆盖"：设备历史是权威数据，同期本机采样一律丢掉，
// 否则两种粒度混着画，"当日最低~最高"会忽宽忽窄（看着像数据坏了）
ok('设备历史是覆盖写（按天重建文件，不是 append 追加）',
  /const dev = \[\]/.test(mergeCode) && /fs\.writeFileSync\(path\.join\(ENV_HIST_DIR/.test(mergeCode)
  && !/fs\.appendFileSync\(path\.join\(ENV_HIST_DIR/.test(mergeCode));
// ⚠️ 2026-10-08 反转：**不能**"一条都不留"。设备历史只到它最后一条（每小时 :38），
//    之后到现在这段时间只有本机采样 —— 删掉曲线右端就出现断点（用户报"一小时温度有断点"）。
ok('覆盖只吃「设备历史盖住的那一段」，比它更新的本机采样保留（否则右端有断点）',
  /r\.at > lastDevAt \|\| r\.at < firstDevAt/.test(mergeCode)
  && /const out = dev\.concat\(keep\)/.test(mergeCode));
ok('范围外的旧按天文件也删掉（否则「全部」档拖出一截来源不同的旧数据）',
  /fs\.unlinkSync\(p\); removed \+= 1;/.test(mergeCode));
ok('按天文件全部重做成设备那套（读目录 + 逐文件重写/删除）',
  /for \(const f of fs\.readdirSync\(ENV_HIST_DIR\)\)/.test(mergeCode)
  && /const k = f\.slice\(4, 14\);/.test(mergeCode));
ok('实时写入路径换天时照旧清理（一天只触发一次，别一并删掉）',
  /if \(k !== envHistDay\) \{ envHistDay = k; pruneEnvHistDays\(\); \}/.test(serverJsCode));
ok('启动时补齐缺失的按天文件（历史读完那次丢掉的要能补回来）',
  /function backfillEnvDays\(/.test(serverJs) && /backfillEnvDays\(rows\)/.test(serverJs));
// 2026-10-06 踩到：退出时正在读设备历史，子进程没被杀 → 孤儿 python 独占温湿度计链路，
// 下次"读取设备历史"一直连不上（单连接设备）。跨了十分钟的读取也就白读了。
ok('退出时杀掉"读历史"子进程（stopEnvSensor 管不到它）',
  /if \(envHistProc\) \{/.test(serverJs) && /envHistProc\.kill\(\)/.test(serverJs));

out.push('');
out.push('=== 10. 温湿度曲线（与功率共用时间轴）===');
ok('HTML 有温度曲线画布', /id="env-chart"/.test(html));
ok('HTML 有温湿度图例', /id="env-legend"/.test(html));
ok('HTML 有温湿度区间按钮容器', /id="env-ranges"/.test(html));
ok('CSS 有温湿度曲线盒子', /\.env-chart-box\{/.test(css));
ok('前端有 drawEnvChart', /function drawEnvChart\(/.test(appJs));
ok('前端有 renderEnvRanges（复用同一套 RANGES）', /function renderEnvRanges\(/.test(appJs));
ok('温度与湿度分两条线', /ENV_T_HEX/.test(appJs) && /ENV_H_HEX/.test(appJs));
ok('双轴：左轴温度 / 右轴湿度', /yTMin/.test(appJs) && /YH\(/.test(appJs));
// 关键语义：温度不做"断档补 0"（功率才补 0）
ok('温湿度曲线不补 0（空档断开）', /不补 0/.test(appJs) && !/fillEnvGaps/.test(appJs));
ok('SSE env 事件会增量追加到曲线', /envRows\.push\(\{ at: e\.at/.test(appJs));
ok('切区间同时刷新两条曲线', /Promise\.all\(\[resyncHistory\(\), pullEnvHistory\(\)\]\)/.test(appJs));
ok('悬停提示显示温湿度', /env-tip/.test(html) && /bindEnvTip/.test(appJs));

out.push('');
out.push('=== 11. 温度计历史在重启后可回填 ===');
ok('启动时预热温度曲线', /function seedEnvHistory\(/.test(serverJs));
ok('main() 里调用了 seedEnvHistory', /seedEnvHistory\(\)/.test(serverJs.split('(async function main')[1] || ''));
ok('state.env 有 history 环形缓冲', /history: \[\],\s*\/\/ 最近的温湿度读数/.test(serverJs));


out.push('');
out.push('=== 12. 按天看温湿度（v1.8.1）===');
ok('后端能按本地自然日聚合', /function aggregateEnvDaily\(/.test(serverJs));
// Number(null) === 0：缺字段的坏行会被当成 0℃，混进"当天最低"里就是一条从 0℃ 起的假带子
ok('坏行不会被当成 0℃（判空统一走 envNum，不再各处手写 Number()）',
  /function envNum\(v\)/.test(serverJs) && /const num = envNum;/.test(serverJs)
  && /const nnum = envNum;/.test(serverJs));
ok('/api/env/history 支持 daily=1',
  /searchParams\.get\('daily'\) === '1'/.test(serverJs) && /queryEnvHistory\(sec, \{ daily \}\)/.test(serverJs));
ok('按天不抽稀（抽稀会把当天最高/最低抹平）',
  /daily \? aggregateEnvDaily\(inWin\) : downsampleEnv/.test(serverJs));
ok('前端有「按天」开关与明细表容器',
  /id="btn-env-daily"/.test(html) && /id="env-daily"/.test(html) && /btn-env-daily'\)\.onclick/.test(appJs));
ok('按天时画「当天最高 ~ 最低」阴影带', /rgba\(255,178,122,\.15\)/.test(appJs));
ok('按天时不往聚合行里插原始读数（会造出假尖点）',
  /if \(envDaily\) \{[\s\S]{0,400}pullEnvHistory\(\)\.then\(drawEnvChart\)/.test(appJs));
ok('温度窗口用自己的口径（不再借功率曲线的 WINDOW_SEC）',
  /function envWinSec\(\)/.test(appJs) && /const winSec = envWinSec\(\)/.test(appJs));
ok('「全部」档的"无限窗口"有兜底（否则点全挤在最右边）',
  /sec <= 400 \* 86400/.test(appJs));
ok('明细表限长（长区间不撑爆页面）', /MAX_DAILY_ROWS/.test(appJs));
ok('明细表/悬停也不把缺数据显示成 0（Number(null) 的坑前端同样有）',
  (appJs.match(/const has = \(v\) => v !== null && v !== undefined/g) || []).length >= 2);
ok('明细表样式右对齐 + 等宽数字', /\.env-daily th,\.env-daily td\{text-align:right/.test(css));
ok('按天有离线回归测试', fs.existsSync(path.join(root, 'tools', 'test_env_daily.js')));

out.push('');
out.push('=== 12b. 设备小时记录铺满一小时（v1.8.3）===');
// 设备每小时只记一条（覆盖刚过去的那一小时），只画成孤点的话，30 分钟窗口里就是
// "一个点 + 一大片空白" —— 用户 2026-10-06 报的就是这个。
ok('落盘时给设备行带 sp / 区间', /rec = \{ at, sp: DEV_HIST_SPAN_MS \}/.test(serverJs));
ok('老数据启动自愈补 sp（幂等）', /function healEnvSpans\(/.test(serverJs) && /healEnvSpans\(\);/.test(serverJs));
// ⚠️ 2026-10-08：原来每小时还铺一块「最低~最高」的橙色阴影带；用户说「温度多出来的
//    橙色边去掉」（那条带子的上下沿看着就像多出来的一圈橙色描边）—— 已去掉填充、只留均值线。
//    最高/最低没丢，悬停提示里照样写着"该小时 22.3 ~ 23.6 ℃"。
ok('设备小时记录画成"该小时一段"的均值线（不再铺橙色阴影带）',
  /const isRibbon = /.test(appJs)
  && /g\.moveTo\(x0, YT\(mid\)\); g\.lineTo\(x1, YT\(mid\)\)/.test(appJs)
  && !/g\.fillRect\(x0, y1, x1 - x0/.test(appJs));
// ⚠️ 2026-10-08 两次修正（同一条规则踩了两次，过程写这里备查）：
//   ① 那句「跳过已铺带子的行」原本只照顾**温度**（带子已经画过一遍），湿度跟着跳 →
//      长区间里整条湿度线被跳空（用户报「7 天也没有湿度曲线」）；
//   ② 温度**自己**跳得太狠：短窗口里几乎每一行都是设备小时记录，全被置 null →
//      连续段不足 3 点，smoothValues 原样返回，平滑开关对温度完全无效
//      （用户报「只平滑了湿度，温度没效果」）。
//   现在：取值规则抽到 envSeries()；温度在**平滑开着时不跳**（连上设备小时记录才平滑得动），
//   湿度始终不跳（它没有带子逻辑，那些点就是它唯一的点源）。
ok('取值规则抽成 envSeries()，跳过带子行由 skipRibbon 控制（温度平滑时不跳 / 湿度不跳）',
  /function envSeries\(rowsIn, pick, skipRibbon, isRibbonFn\)/.test(appJs)
  && /if \(skipRibbon && isRibbonFn\(r\)\) return null;/.test(appJs)
  && /skipRibbon: !envSmooth/.test(appJs) && /skipRibbon: false/.test(appJs));
ok('平滑抽成 smoothSegments()，只对连续段做（空档处不跨着抹）',
  /function smoothSegments\(vals, alpha\)/.test(appJs) && /smoothSegments\(vals, 0\.35\)/.test(appJs));
ok('设备小时记录的固有间隔不算断档（温湿度共用 ENV_DEV_GAP_MS）',
  /ENV_DEV_GAP_MS = 2 \* 3600 \* 1000/.test(appJs) && /gapMs: devGap/.test(appJs)
  && !/ENV_H_GAP_MS/.test(appJs));
// 失焦透明度滑块（2026-10-08 用户要求「失焦的透明度能不能加一个调节开关」）。
// 失焦时材质与聚焦一致（acrylic，见 shell/main.js），"多透"主要靠**整窗 alpha** + 页面染色
// —— 所以它是页面侧的独立档：默认「跟随」，拖过才分叉，双击回跟随。
ok('顶栏有「失焦」透明度滑块（有样式、有焦点状态、有预览逻辑）',
  /id="w-opa-blur"/.test(indexHtml) && /id="w-opa-blur-v"/.test(indexHtml)
  && /\.wslider-blur input\[type=range\]\{width:64px\}/.test(css)
  && /const effNow = /.test(shellJs)
  && /addEventListener\('blur'/.test(shellJs) && /addEventListener\('focus'/.test(shellJs));
// ⚠️ v1.8.21 语义修正（用户报「失焦预览和实际雾化不一样，把实际改成预览一样的」）：
//    失焦**只调页面染色**（0 = 全透，100 = 不透明，与聚焦那档同口径），
//    **不再动整窗 alpha**。原因：拖滑块时的"预览"只走页面染色（那条整窗 alpha 的 IPC
//    当年压根没接上），而"实际"失焦是染色 + 整窗 alpha 两件事同时生效
//    ⇒ 两者必然长得不一样。删掉整窗 alpha 这条链路后，预览与实际在页面里走**同一个函数**。
ok('「失焦」档只调染色：整窗 alpha 那条链路（alphaOfBlur / setWinAlpha / previewingAlpha）已删净',
  !/function alphaOfBlur\(/.test(mainJs) && !/win\.setOpacity\(/.test(mainJs)
  && !/setWinAlpha\(/.test(mainJs) && !/previewingAlpha/.test(mainJs)
  && /on\('blur',[\s\S]{0,400}setBackgroundMaterial\(MATERIAL_BLURRED\)/.test(mainJs));
ok('「失焦」档走主进程（pref 默认值 + IPC + preload 通道 + **页面 invoke 白名单**）',
  /opacityBlur: 70/.test(mainJs) && /cuk:set-opacity-blur/.test(mainJs)
  && /setOpacityBlur/.test(preloadJs)
  // ★ 这条是 2026-10-08 的**真凶**：web/shell.js 的 invoke 白名单漏了这个 case，
  //   页面里所有 ipc.invoke('cuk:set-opacity-blur') 静默返回 unknown channel
  //   ⇒ 失焦档永远没写进 pref、预览的那次整窗 alpha 也从没生效过。
  && /case 'cuk:set-opacity-blur': return bridge\.setOpacityBlur\(\.\.\.a\);/.test(shellJs)
  && /preview: true/.test(shellJs));
ok('预览与实际同源：预览走的也是"失焦那档染色"（effNow 同时吃 winFocused 与 previewing）',
  /const effNow = \(\) => \(\(!winFocused \|\| previewing\) \? effBlur\(\) : opaCur\)/.test(shellJs));
// ⚠️ 2026-10-08 的坑（用户报「失焦透明度调节没用」）：blur 回调里 win.isFocused() 仍可能
//    返回 true → 焦点判断会算错。改成自己维护 winBlurred（材质切换与 /probe 诊断都靠它）。
ok('blur/focus 焦点判断用自己维护的 winBlurred，不猜 win.isFocused()',
  /let winBlurred = false;/.test(mainJs) && /winBlurred = true;/.test(mainJs)
  && !/isFocused\(\)\.*alphaOfBlur/.test(mainJs));
// 这条 bug 是靠 /probe 把两侧状态摊平才定位到的（页面以为的焦点/失焦档值 vs 主进程的），
// 所以把这份诊断能力也钉住 —— 下次再对不上，一条 /probe 就能分辨是谁的错。
ok('/probe 摊平「失焦」链路两侧状态（页面染色/焦点 + 主进程焦点/档值）',
  /opa: window\.__cukOpaState \|\| null/.test(mainJs)
  && /pageFocus: document\.hasFocus\(\)/.test(mainJs)
  && /blurState: \{ blurred: winBlurred/.test(mainJs)
  && /window\.__cukOpaState = \{/.test(shellJs));
// 温度计卡片可折叠（2026-10-08 用户要求：「加个折叠开关，有的人用不上」）。
// 收起只藏内容（曲线/设置都还在），标题行留读数摘要，状态记 localStorage。
ok('温度计卡片可折叠（按钮 + 折叠样式 + 状态记住）',
  /id="env-fold"/.test(indexHtml) && /id="env-fold-body"/.test(indexHtml)
  && /#env-card\.folded > #env-fold-body\{display:none\}/.test(css)
  && /cuk_env_folded/.test(appJs) && /function applyEnvFold\(/.test(appJs));
ok('按天聚合优先用行内极值（当日最低~最高 = 设备实测）',
  /Number\.isFinite\(tlo\) && tlo < d\.tMin/.test(serverJs));
ok('小时带也有离线回归测试', fs.existsSync(path.join(root, 'tools', 'test_env_span.js')));
ok('「双击快捷方式打不开」也有离线回归（单实例接管）',
  fs.existsSync(path.join(root, 'tools', 'test_singleton.js')));
// 2026-10-08：判据只有 /api/ping（1.2s）时，实例一忙就判"没人在跑"→ 另起一个 → 撞端口 →
// 顺延到系统保留端口 8800 → EACCES → 退出；bat 等不到 ready.json → 报"启动失败"。
ok('接管判据含 pid 存活（不能只看 HTTP 探活）',
  /function pidAlive\(pid\)/.test(serverJs) && /async function resolveRunningInstance\(lk\)/.test(serverJs));
ok('启动了要先把 ready.json 写回给 bat（否则它 15 秒后报"启动失败"）',
  /reused: true/.test(serverJs) && /ready\.upgrade = hit\.version/.test(serverJs));

out.push('');
out.push('=== 13. 小米云登录的证书口径（v1.8.1）===');
ok('netfix.py 在，且写明 Strict 模式这回事',
  /VERIFY_X509_STRICT/.test(netfixPy) && /Basic Constraints/.test(netfixPy));
ok('只摘严格模式，CA 与主机名校验照旧', /verify_flags &= ~_STRICT/.test(netfixPy));
ok('证书错误会被单独识别（不能当瞬时错误重试到超时）',
  /def is_cert_error/.test(netfixPy) && /netfix\.is_cert_error\(exc\) or any\(m in msg/.test(loginPy));
ok('登录会话统一走 netfix 的 TLS 口径',
  (loginPy.match(/netfix\.connector_kwargs\(\)/g) || []).length >= 2);
ok('证书错误换成人话再回给界面',
  /def friendly_error/.test(netfixPy) && /def _err_text/.test(loginPy));
ok('有 /api/diag/tls 自检接口', /'\/api\/diag\/tls'/.test(serverJs));
ok('登录失败自动附上自检结论', /async function tlsVerdict/.test(serverJs) && /await tlsVerdict\(\)/.test(serverJs));
ok('登录弹层有「网络自检」按钮与结果面板',
  /id="btn-login-diag"/.test(html) && /id="login-diag"/.test(html) && /btn-login-diag'\)\.onclick/.test(appJs));
ok('自检能认出中间人解密（信任库里找解密软件的根证书）',
  /MITM_HINTS/.test(netfixPy) && /enum_certificates/.test(netfixPy));

// ---- v1.9.2：unable to get local issuer 单独一类（本机缺根 vs 被中间人）----
ok('体检会「偷看」对方出示的证书链（否则校验失败时手里什么都没有）',
  /def _attempt\([\s\S]{0,120}peek/.test(netfixPy)
  && /_attempt\(h, port, True, peek=True/.test(netfixPy));
// 取 ssl_context 的函数体（到下一个顶格 def 为止），在体内找危险写法 ——
// 用"附近 N 个字符"那种正则太脆：函数一变长，断言就悄悄失效了。
const sslCtxBody = (netfixPy.split('def ssl_context(', 2)[1] || '').split('\ndef ', 1)[0];
ok('peek 只用于诊断，业务上下文仍然完整校验',
  /CERT_NONE/.test(netfixPy)                 // peek 那张上下文确实是关校验的
  && !/CERT_NONE|verify_mode\s*=|check_hostname\s*=\s*False/.test(sslCtxBody));
ok('能区分「本机缺根」和「被中间人重签」',
  /cls="missing-root"/.test(netfixPy) && /cls="mitm"/.test(netfixPy)
  && /PUBLIC_CA_HINTS/.test(netfixPy));
ok('「缺根」时不误导成网络被拦', /不是网络被拦/.test(netfixPy));
ok('随包带了小米链的根证书',
  /vendor['"],\s*['"]ca['"],\s*['"]xiaomi-roots\.pem/.test(netfixPy.replace(/\\/g, '/'))
  || /BUNDLE = HERE \/ "vendor" \/ "ca"/.test(netfixPy));
ok('unable to get local issuer 也算证书错（否则不会自动跑体检）',
  /unable to get local issuer/.test(serverJs) && /function isCertText/.test(serverJs));
ok('界面对 missing-root / mitm / expired / unreachable 都有对应说法',
  /missing-root/.test(appJs) && /mitm/.test(appJs)
  && /unreachable/.test(appJs) && /expired/.test(appJs));

out.push('');
out.push('=== 13b. 蓝牙连不上时，原因必须看得见（v1.9.3）===');
// 2026-11-08 有人在别人电脑上一直只看到「连接中 · 已发现，正在建立 BLE 连接」：
// 采集器的循环里，"失败原因"只在 reconnecting 那一两秒出现，其余时间界面显示
// "等待第一帧数据" —— 等于把真因藏起来了。现在 server 留住 lastError，界面常驻显示。
ok('server 把上一次失败原因留住（reconnecting/error 时写、connected 时清）',
  /lastError/.test(serverJs)
  && /obj\.state === 'reconnecting' \|\| obj\.state === 'error'/.test(serverJs)
  && /obj\.state === 'connected' \? null/.test(serverJs));
ok('server 链接状态里带上 lastError 一起回给界面',
  /lastError,\s*\n?\s*\};/.test(serverJs) || /rssi: obj\.rssi != null[^\n]*\n[^\n]*lastError/.test(serverJs));
ok('界面在「连接中」也显示上一次的失败原因（不是只在重连瞬间）',
  /s === 'scanning' \|\| s === 'connecting'/.test(appJs)
  && /last\.link\.lastError/.test(appJs));
ok('界面按 RSSI 分开判断：扫得到却连不上 ≠ 没扫到',
  /扫得到/.test(appJs) && /一直没扫到设备/.test(appJs));
ok('界面点名两种最可能原因（被别的中心端占用 / 适配器不支持 BLE 连接）',
  /这条蓝牙已被别的设备占用/.test(appJs) && /适配器不支持 BLE 连接/.test(appJs));
// v1.9.4：把"到底是哪颗蓝牙芯片"也显示出来 —— 2026-11-08 那台是 MS-B550M WIFI ICE，
// 板载 RTL8821CE（Wi-Fi+BT4.2 组合卡，1x1 天线分时共用），这类"扫得到、连不上"
// 光看界面永远猜不到是硬件。
ok('server 会探测蓝牙适配器型号（只读、失败就算了）',
  /function probeBtAdapter/.test(serverJs)
  && /Get-PnpDevice -Class Bluetooth/.test(serverJs)
  && /probeBtAdapter\(\);/.test(serverJs));
ok('适配器型号进了 /api/state 的 payload',
  /bt: btAdapter/.test(serverJs));
ok('界面把适配器型号写进失败提示',
  /last\.bt && last\.bt\.name/.test(appJs) && /蓝牙适配器：/.test(appJs));
ok('对组合卡（8821/8822）给出"关 Wi-Fi / 切 5GHz"的具体建议',
  /8821\|8822\|rtl88/.test(appJs) && /2\.4G Wi-Fi 共用同一副天线/.test(appJs));
ok('对廉价棒（CSR8510/Generic）建议换 BT5.0',
  /csr8510/.test(appJs) && /BT5\.0/.test(appJs));

out.push('');
out.push('=== 14. 服务自己的控制台窗口必须藏起来（v1.8.23）===');
// 2026-10-11 用户报「开机自启动窗口打不开 … 这个窗口隐藏」：截图里那个黑窗口
// （客户区 #0C0C0C）就是 node 自己的控制台 —— `start /min` 只是最小化它，
// 它会一直挂到 node 退出（几小时），而且**关掉它 = 立刻杀掉服务**
// （CTRL_CLOSE_EVENT，无退出日志、lock/alive 全部残留）。
// 解法：server.js 一起来就 hideOwnConsole() 调 user32.ShowWindow SW_HIDE。
ok('server.js 有 hideOwnConsole()，且走 koffi 调 ShowWindow 传 SW_HIDE(0)',
  /function hideOwnConsole\(\)/.test(serverJs)
  && /kernel32\.func\('GetConsoleWindow', 'void \*', \[\]\)/.test(serverJs)
  && /user32\.func\('ShowWindow', 'bool', \['void \*', 'int'\]\)/.test(serverJs)
  && /ShowWindow\(hwnd, 0\)/.test(serverJs));
ok('隐藏是 main() 的**第一步**（排在 loadEnergy 等同步大活之前）',
  /\(async function main\(\) \{\n(?:.*\n){0,6}?\s*const hid = hideOwnConsole\(\);/.test(serverJs));
ok('取不到控制台 / 没有 koffi / DLL 报错都不许影响服务（返回原因而不是抛）',
  /why: 'no-console'/.test(serverJs) && /why: 'no-koffi'/.test(serverJs)
  && /why: 'error:'/.test(serverJs));
ok('藏完回读一次 IsWindowVisible 当凭据（日志里能看出藏没藏住）',
  /IsWindowVisible/.test(serverJs) && /stillVisible/.test(serverJs)
  && /已隐藏服务自身的控制台窗口/.test(serverJs));
ok('开机自启动的 .lnk 直接指向 node.exe（经 bat 的话开机必然起一个 cmd 窗口）',
  /const node = findNodeExe\(\);/.test(serverJs) && /\$s\.TargetPath = '" \+ q\(node\) \+ "'/ .test(serverJs));
ok('开机自启动的后台档带 --no-window（不起应用窗口，托盘照旧）',
  /m === 'tray' \? ' --no-window' : ''/.test(serverJs));
ok('启动 bat 里**没有裸 CR**（曾被 `\\r` 转义写坏，把 findstr 那行拦腰截断）',
  (() => {
    try {
      const b = fs.readFileSync(path.join(root, '启动酷态科10号Ultra.bat'));
      return b.filter((v) => v === 13).length === b.filter((v) => v === 10).length;
    } catch (_) { return false; }
  })());
ok('控制台隐藏有离线回归测试', fs.existsSync(path.join(root, 'tools', 'test_console_hide.js')));

out.push('');
out.push('=== 15. 小米电风扇卡片（第三条链路：Wi-Fi / miIO）===');
// 风扇是**局域网 Wi-Fi**（miIO）设备，不碰蓝牙 —— 所以它和充电头/温湿度计那两张卡
// 共用一个界面、一个托盘、一次启动，但底层完全是另一条链路（独立进程、独立 token 文件）。
// 这条链路上最容易出的事：① 没登录时露一堆灰开关；② 把"我发过命令了"当成"设备真变了"。
// ⚠️ v1.9.0 曾按档位**推算**过功率与电量（还画了一条推算功率曲线），2026-10-11 按用户
//    要求整体删除 —— 这台设备一个电参量属性都没有，推算出来的数看着像实测，反而误导。
//    所以下面既有"必须在"的断言，也有"必须已经不在了"的反向断言（防它长回来）。
const fanPy = fs.readFileSync(path.join(root, 'fan_collector.py'), 'utf8');
const miioPy = fs.readFileSync(path.join(root, 'vendor', 'miio_lan.py'), 'utf8');
ok('HTML 有风扇卡片', /id="fan-card"/.test(html));
ok('HTML 说清了不显示功率/电量（设备没有电参量属性）',
  /没有功率传感器/.test(html) && /不做功率/.test(html) && /不画曲线/.test(html));
ok('HTML 说清了风扇不占用蓝牙（能和手机米家同时用）',
  /不经过米家云/.test(html) && /同时用/.test(html));
ok('HTML 有没登录时的提示条与登录按钮', /id="fan-login-hint"/.test(html) && /id="btn-fan-login"/.test(html));
ok('CSS 有风扇卡片样式（整行 + 折叠 + 登录态）',
  /\.rowfan\{grid-template-columns:minmax\(0,1fr\)\}/.test(css)
  && /#fan-card\.folded > #fan-fold-body\{display:none\}/.test(css)
  && /#fan-card\.no-login #fan-ctl-wrap/.test(css));
ok('CSS 有电源大开关与无级调速滑条', /\.switch\.big\{/.test(css) && /\.fan-slider input\[type=range\]/.test(css));
ok('CSS 有自检输出框（等宽可滚动）', /\.fan-probe-out\{/.test(css));
ok('前端有 renderFan / syncFanControl，大数字位放的是状态',
  /function renderFan\(/.test(appJs) && /function syncFanControl\(/.test(appJs)
  && /\.fan-state-big\{/.test(css));
// ---- 反向断言：功率 / 电量 / 曲线这一套必须已经删干净 ----
ok('前端的功率/电量/曲线代码已整体删除（fanWinSec / drawFanChart / renderFanRanges …）',
  !/fanWinSec|drawFanChart|renderFanRanges|fanChartPad|bindFanTip/.test(appJs)
  && !/let fanRows|let fanCache|fanWindowSec|pullFanHistory/.test(appJs));
ok('HTML 里功率大数字 / 三格电量 / 区间按钮 / 曲线画布都已移除',
  !/id="fan-w"|fan-e-today|fan-e-total|fan-e-sess|id="fan-ranges"|id="fan-chart"|id="fan-tip"|id="fan-rated"|fan-chart-hint/
    .test(html));
ok('服务端已删掉 /api/fan/history、用电量账本与分钟行历史',
  !/'\/api\/fan\/history'/.test(serverJs) && !/FAN_ENERGY|FAN_HIST_MIN|FAN_KEEP_DAYS/.test(serverJs)
  && !/integrateFanEnergy|fanEnergyPayload|queryFanHistory|pushFanHistory|fanRatedW/.test(serverJs));
ok('采集器不再推算功率（没有 estimate_power_w / rated_w / power_w）',
  !/estimate_power_w|rated_w|power_w|power_kind/.test(fanPy));
ok('给界面的风扇 payload 不再带 energy / ratedW',
  /function fanPayload\(\)/.test(serverJs) && !/energy: e,|ratedW:/.test(serverJs));
ok('服务端有独立风扇进程管理与控制接口',
  /function startFanCollector\(/.test(serverJs) && /function stopFanCollector\(/.test(serverJs)
  && /'\/api\/fan\/control'/.test(serverJs));
ok('token 只写文件、不进命令行（任务管理器里人人可见）',
  /token: t\.token, interval: fanInterval\(\)/.test(serverJs)
  && /'--config', FAN_CFG/.test(serverJs)
  && !/['"]--token['"]/.test(serverJs));
ok('写入后一定回读确认（界面状态来自设备回读值）',
  /const same = String\(j\.readback\) === String\(value\)/.test(appJs)
  && /dev\.get_properties\(\[\(siid, piid\)\]\)/.test(fanPy));
ok('采集器的 read 真的读一次并回 ack（曾经是空操作 → 刷新永远假失败）',
  /kind in \("ping", "read"\)[\s\S]{0,1400}emit\(snapshot\(\)\)/.test(fanPy)
  && /"cmd": "read"/.test(fanPy));
ok('miIO 协议常量齐（端口 / magic / 密钥派生）',
  /\bPORT = 54321\b/.test(miioPy) && /\bMAGIC = 0x2131\b/.test(miioPy)
  && /self\.key = _md5\(self\.token\)/.test(miioPy)
  && /self\.iv = _md5\(self\.key \+ self\.token\)/.test(miioPy));
ok('风扇链路有离线回归测试', fs.existsSync(path.join(root, 'tools', 'test_fan_front.js')));
ok('风扇链路有真起服务的冒烟测试', fs.existsSync(path.join(root, 'tools', 'dev', 'smoke_fan.js')));

const txt = out.join('\n') + (bad ? `\n\nRESULT: FAIL (${bad} problem(s))` : '\n\nRESULT: PASS');
fs.writeFileSync(path.join(root, 'tools', 'check_liquid.out.txt'), txt, 'utf8');
console.log(txt);
process.exitCode = bad ? 1 : 0;
