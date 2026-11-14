/* Electron 外壳的桥接层。
 *
 * 只在「被 Electron 壳加载」时做事。用浏览器直接打开这个页面时，本文件一行
 * 代码都不会生效 —— 界面照旧，不会多出标题栏，也不会有任何报错。
 *
 * 为什么需要它：
 *   frame:false 之后系统标题栏没了，拖动 / 最小化 / 关窗 / 换尺寸 / 换玻璃材质
 *   全得自己接。这些能力只能由主进程出（渲染进程没有窗口句柄）。
 *
 * ⚠️ 本文件在壳里拿 IPC 的唯一途径是 preload 暴露的 window.cukShell
 *   （主窗口是 contextIsolation:true + nodeIntegration:false，渲染进程里
 *    **没有 require**）。见 shell/preload.js。
 */

'use strict';

(function () {
  // 判定"我在 Electron 壳里"。
  //
  // ⚠️ 2026-09-23 修：原来只看 process.argv 里的 --cuk-shell=electron。
  //   这个开关是主进程用 webPreferences.additionalArguments 塞进来的，**只要它
  //   没生效，整个壳层就静默失效**（圆角/玻璃/标题栏/拖动全都不做），而外观上
  //   只是"窗口是方的、多一圈白边"，很难联想到是这里。所以改成多路判定：
  //     1) preload 注入的 window.__CUK_SHELL__（主判据，最可靠）
  //     2) 主进程给的 argv 开关（正常路径，但依赖 additionalArguments 生效）
  //     3) 有 window.cukShell 这个桥（等价于 1，双保险）
  //   任一条成立就认为在壳里。误判的代价只是多一层样式，可接受。
  const bridge = (typeof window !== 'undefined' && window.cukShell) ? window.cukShell : null;
  const envFlag = !!window.__CUK_SHELL__;
  const argvFlag = (typeof process !== 'undefined' && process.argv
    && process.argv.indexOf('--cuk-shell=electron') >= 0);
  const hasElectron = (typeof process !== 'undefined' && process.versions
    && !!process.versions.electron);
  const inShell = envFlag || !!bridge || argvFlag || hasElectron;
  if (!inShell) return;

  // 自检用：把判定依据记下来（出问题时一眼看出是哪条路生效的）
  window.__cukShellWhy = { envFlag, bridge: !!bridge, argvFlag, hasElectron };

  // 没有桥就什么都做不了 —— 说明 preload 没挂上，明确报到 console 而不是静默失败
  if (!bridge) {
    console.warn('[cuk] 检测到 Electron 环境但没有 cukShell 桥：'
      + 'preload 可能没加载。窗口标题栏/拖动/圆角玻璃将不可用。');
    return;
  }

  // 统一走桥（不再 require('electron')：contextIsolation 下没有 require）
  const ipc = {
    send: (ch, payload) => {
      // 只允许拖动这三个通道从页面直接发（bridge 上就这三个 send）
      if (ch === 'cuk:drag-start') return bridge.dragStart(payload);
      if (ch === 'cuk:drag-move') return bridge.dragMove(payload);
      if (ch === 'cuk:drag-end') return bridge.dragEnd();
    },
    invoke: (ch, ...a) => {
      switch (ch) {
        case 'cuk:minimize': return bridge.minimize(...a);
        case 'cuk:toggle-max': return bridge.toggleMax(...a);
        case 'cuk:close': return bridge.close(...a);
        case 'cuk:set-size': return bridge.setSize(...a);
        case 'cuk:info': return bridge.info(...a);
        case 'cuk:shot': return bridge.shot(...a);
        case 'cuk:trans-check': return bridge.transCheck(...a);
        case 'cuk:set-opacity': return bridge.setOpacity(...a);
        // ⚠️⚠️ 2026-10-08 深夜补上：**这条以前漏了**，而它的后果极其隐蔽 ——
        //   invoke 静默走 default 分支返回 {ok:false,'unknown channel ...'}（不抛错、
        //   不带 reject），于是「失焦」那条滑块：
        //     · 拖动时的"预览"那次 IPC 根本没到主进程（当时整窗 alpha 靠它）；
        //     · 松手时的落盘也没发生 ⇒ pref.opacityBlur 永远停在旧值，
        //       而页面自己那份 opaBlurCur 只活在内存里 ⇒ **同一件事两个副本互相打架**，
        //       表现出来就是用户报的「失焦预览和实际雾化不一样」（预览用页面的值、
        //       实际失焦用主进程的值）。
        //   往 invoke 白名单里加通道时，**preload.js / 这里 / 主进程 handler 三处都要加**。
        case 'cuk:set-opacity-blur': return bridge.setOpacityBlur(...a);
        case 'cuk:set-theme': return bridge.setTheme(...a);
        default: return Promise.resolve({ ok: false, error: 'unknown channel ' + ch });
      }
    },
  };

  document.documentElement.classList.add('shell-electron');

  // ---------------------------------------------------------------- 玻璃板
  //
  // ⚠️ 2026-09-23 修的坑：`.win-glass` 的样式写在 style.css 里（整窗染色 + 上缘高光
  //   + 内阴影），但**从来没有谁把它插进 DOM** —— 于是壳里其实少了一整层，
  //   界面看着"没有玻璃"。这层必须在这里建，因为只有壳里才需要它
  //   （浏览器模式下不需要，也不该多一块盖住整页的东西）。
  //   插在 body 最前面、z-index:0，页面内容（.app / .winbar）都在它之上。
  (function () {
    const layer = document.createElement('div');
    layer.className = 'win-glass';
    layer.setAttribute('aria-hidden', 'true');
    document.body.insertBefore(layer, document.body.firstChild);
  })();

  // 把 --win-r 的实际像素值写回给主进程 —— 它开着真正的原生圆角
  // （setShape / DWM），必须和 CSS 用同一个数，否则会出现"CSS 圆角 41px、
  // 原生蒙版 27px"的双层圆角错位（四角一圈毛边）。
  try {
    const rv = getComputedStyle(document.documentElement).getPropertyValue('--win-r').trim();
    const px = rv.endsWith('rem')
      ? parseFloat(rv) * (parseFloat(getComputedStyle(document.documentElement).fontSize) || 16)
      : parseFloat(rv);
    if (px > 0) bridge.radius(Math.round(px));
  } catch (_) {}

  const bar = document.getElementById('winbar');
  if (bar) bar.setAttribute('aria-hidden', 'false');

  // ---------------------------------------------------------------- 拖动
  // 用 IPC + setPosition 而不是 CSS 的 -webkit-app-region:drag：
  // 后者在透明窗口上偶尔会和合成器打架（表现为拖起来一顿一顿或窗口闪烁）。
  //
  // ⚠️ 2026-09-23 重写。之前"按住拖不动"的三个真实原因：
  //   1. **pointerdown 才是可靠的起点**：mousedown 在窗口刚获得焦点的那一次
  //      可能被吞掉（第一次点击只用来激活窗口），于是第一次拖必然失败 ——
  //      用户看到的就是"按下去没反应"。pointerdown 不受这个影响。
  //   2. **不能用 setPointerCapture**：一旦捕获，pointermove 全都派给拖动条，
  //      而窗口已经在移动，后续坐标越来越离谱；同时 pointerup 也可能收不到，
  //      拖动状态就永久卡住（松手了窗口还跟着鼠标跑）。所以只在 pointerdown 时
  //      短暂捕获一下、立刻释放，纯粹为了"吃掉"这次手势，之后纯监听 window。
  //   3. **每帧只发一次、按 rAF 节流**：pointermove 在 1000Hz 鼠标上能到每秒上千次，
  //      每次一个 IPC 会把主进程和 DWM 压垮 → 窗口"跟不上手"甚至僵住。
  //      这里把最新坐标存起来，一个动画帧最多发一次。
  //
  // 坐标一律用 screenX/screenY（绝对屏幕坐标）：窗口一动 clientX 就自相矛盾，
  // 会造成"窗口追着自己的鼠标跑"的抖动。
  const dragBar = document.getElementById('winbar');       // 整条标题栏都可拖（按钮自己 exempt）
  const dragHit = () => document.getElementById('winbar-drag') || dragBar;

  let dragging = false;
  let rafId = 0;
  let pending = null;      // 最近一个还没发出去的屏幕坐标

  function flushMove() {
    rafId = 0;
    if (!dragging || !pending) return;
    ipc.send('cuk:drag-move', pending);
    pending = null;
  }

  function onDown(e) {
    // 只认左键 / 单指；工具按钮自己处理点击，别抢
    if (e.button !== undefined && e.button !== 0) return;
    if (e.target && e.target.closest && e.target.closest('button, .wseg, a, input, select, textarea')) return;
    dragging = true;
    pending = null;
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'grabbing';
    // 短暂捕获 + 立刻释放：既吃掉这次手势，又不会把后续 pointermove 据为己有
    try {
      if (e.pointerId !== undefined && dragHit().setPointerCapture) {
        dragHit().setPointerCapture(e.pointerId);
        setTimeout(() => {
          try { if (dragHit().releasePointerCapture) dragHit().releasePointerCapture(e.pointerId); } catch (_) {}
        }, 0);
      }
    } catch (_) {}
    ipc.send('cuk:drag-start', { x: e.screenX, y: e.screenY });
    e.preventDefault();
  }

  function onMove(e) {
    if (!dragging) return;
    pending = { x: e.screenX, y: e.screenY };
    if (!rafId) rafId = requestAnimationFrame(flushMove);
    e.preventDefault();
  }

  function onUp() {
    if (!dragging) return;
    dragging = false;
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    pending = null;
    document.body.style.userSelect = '';
    document.body.style.cursor = '';
    ipc.send('cuk:drag-end');
  }

  if (dragBar) {
    // 整个标题栏都能按（含标题文字与小圆点区），工具按钮在 onDown 里被排除
    dragBar.addEventListener('pointerdown', onDown);
    // mousedown 兜底：极少数环境（老 Chromium 布局 / 无 PointerEvent）只给 mouse 事件
    if (!window.PointerEvent) dragBar.addEventListener('mousedown', onDown);
    window.addEventListener('pointermove', onMove, { passive: false });
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    if (!window.PointerEvent) {
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    }
    // 窗口失焦（Alt+Tab 切走）时一定要收尾，否则回来时窗口还"粘"在鼠标上
    window.addEventListener('blur', onUp);
    // 自检标志：证明拖动监听真的挂上了（界面能起 ≠ 能拖，这个从外面看不见）
    window.__cukDragWired = true;
    window.__cukDragInfo = {
      pointerEvents: !!window.PointerEvent,
      barFound: true,
      dragFound: !!document.getElementById('winbar-drag'),
    };
    // 拖动条双击 = 全屏 / 还原（和系统标题栏的习惯一致）
    dragBar.addEventListener('dblclick', (e) => {
      if (e.target && e.target.closest && e.target.closest('button, .wseg')) return;
      toggleMax();
    });
  }

  function toggleMax() { ipc.invoke('cuk:toggle-max'); }

  const on = (id, fn) => { const el = document.getElementById(id); if (el) el.addEventListener('click', fn); };

  on('w-min', () => ipc.invoke('cuk:minimize'));
  on('w-max', () => toggleMax());
  on('w-close', () => ipc.invoke('cuk:close'));

  // ---------------------------------------------------------------- 透明度滑块
  // 2026-10-05：固定的三档改成了**连续滑块**（用户要求"加一个透明度调节"）。
  // 2026-10-08：用户要求「失焦的透明度也加一个调节开关」—— 于是分成两档：
  //   左滑块 = **聚焦**时的透明度；右滑块（新加的「失焦」）= **失焦**时的透明度。
  //   两档**同一口径**（0 = 全透，100 = 不透明），都只改**页面这层染色**
  //   （--glass-tint / --panel / --panel2）—— 窗外本来就被 acrylic 磨砂着，
  //   染色浓一档 = 更"雾"，染色淡一档 = 更看得清窗外。
  //   右滑块显示「跟随」时两档一致（默认，行为与以前完全一样）；拖过它才分叉，
  //   双击它可回到跟随。拖动右滑块时会**即时预览**，3.5 秒后自动回到聚焦观感。
  //   ⚠️ 预览与"真失焦"必须是**同一条渲染路径**（见下面的 effNow 与 applyOpa）——
  //      2026-10-08 曾经存在第二条旁路（主进程的整窗 alpha）导致两者漂移，已删掉。
  // 拖动时实时改 CSS 变量（立即跟手），松手才 invoke 持久化 —— 调节过程不写盘。
  let opaCur = 56;
  let opaBlurCur = null;      // null = 跟随聚焦
  let opaSlider = null;
  let opaBlurSlider = null;
  let previewTimer = null;
  let winFocused = true;
  let previewing = false;
  let themeCur = 'dark';

  // 注：「失焦」档的**权威副本在主进程**（pref.json，IPC: cuk:set-opacity-blur）——
  //     这样关窗重开、换壳（Edge/Electron）之后值还在；页面这份只是当前渲染用的缓存，
  //     启动时由 cuk:info 同步回来。null = 跟随聚焦。
  //     ⚠️ 两份副本能对上的前提是那条 IPC **真的通**（白名单里要有 case，见上面 invoke）。

  /** 失焦该用的值（没单独设过就跟随聚焦）。 */
  const effBlur = () => (opaBlurCur == null ? opaCur : opaBlurCur);
  /** 此刻**实际**该渲染的值：失焦（或正在预览）用失焦值，否则用聚焦值。
   *  ★ 预览与真失焦都落在这个表达式里 —— 前者靠 previewing，后者靠 !winFocused，
   *    两条路算出的都是 effBlur()，最终又都由 applyOpa() 落到同几个 CSS 变量上。 */
  const effNow = () => ((!winFocused || previewing) ? effBlur() : opaCur);

  function applyOpa(o) {
    if (o !== undefined) opaCur = Math.max(0, Math.min(100, Math.round(Number(o) || 0)));
    const a = effNow() / 100;
    const d = document.documentElement;
    const light = d.classList.contains('light');
    // 整窗染色直接用滑块值；卡片比整窗略实一点，保证任何档位下文字都可读
    // 深色/浅色主题用不同的染色基色（文字色由 html.light 那套变量切换）。
    if (light) {
      d.style.setProperty('--glass-tint', 'rgba(246,249,255,' + a.toFixed(3) + ')');
      d.style.setProperty('--panel', 'rgba(255,255,255,' + (0.4 + 0.5 * a).toFixed(3) + ')');
      d.style.setProperty('--panel2', 'rgba(255,255,255,' + (0.62 + 0.38 * a).toFixed(3) + ')');
    } else {
      d.style.setProperty('--glass-tint', 'rgba(9,14,26,' + a.toFixed(3) + ')');
      d.style.setProperty('--panel', 'rgba(14,20,36,' + (0.16 + 0.5 * a).toFixed(3) + ')');
      d.style.setProperty('--panel2', 'rgba(10,16,29,' + (0.35 + 0.65 * a).toFixed(3) + ')');
    }
    // ★ 排查用：把这三个输入与最终算出的染色摊在 window 上，外壳 /probe 会把它读出去。
    //   为什么需要：调「失焦」那条链路的 bug（预览和实际对不上）从界面上看不出来 ——
    //   页面自己以为的焦点、失焦档值、算出多少透明度，只有摊开才能和主进程那边的
    //   winBlurred / 整窗 alpha 逐项对照。**只读快照，不参与渲染。**
    window.__cukOpaState = {
      focusOpa: opaCur, blurOpa: opaBlurCur, winFocused, previewing,
      effBlur: effBlur(), effNow: effNow(),
    };
    const v = document.getElementById('w-opa-v');
    if (v) v.textContent = opaCur + '%';
    if (opaSlider && opaSlider.value !== String(opaCur)) opaSlider.value = String(opaCur);
    // 右滑块自己显示自己的值：「跟随」时写字，不跟着左滑块跳（免得看不明白在调哪个）
    const v2 = document.getElementById('w-opa-blur-v');
    // 预览时数值后面加个「·预览」，让人一眼看出滑块在响应（否则聚焦状态下容易以为它坏了）
    if (v2) {
      if (opaBlurCur == null) v2.textContent = '跟随';
      else v2.textContent = opaBlurCur + '%' + (previewing ? '·预览' : '');
    }
    if (opaBlurSlider) {
      const want = String(effBlur());
      if (opaBlurSlider.value !== want) opaBlurSlider.value = want;
    }
  }

  function applyTheme(t) {
    themeCur = t === 'light' ? 'light' : 'dark';
    document.documentElement.classList.toggle('light', themeCur === 'light');
    const b = document.getElementById('w-theme');
    if (b) b.textContent = themeCur === 'light' ? '深色' : '浅色';
    applyOpa();   // 染色基色随主题变，重刷一次
  }

  // -------------------------------------------------------------- 磨砂
  // 磨砂开关已删除（2026-10-06）：玻璃**一律** acrylic（窗外磨砂 + 系统圆角）。
  // 原来那个「磨砂·开 / 磨砂·关」按钮，关掉之后窗口会变成不透明实色（DWM 的
  // 材质一关就只剩实底），用户明确不要这种状态 —— 索性把开关去掉，省得点错了
  // 还以为窗口坏了。观感强弱仍由透明度滑块调。

  async function initShell() {
    let info = null;
    try { info = await ipc.invoke('cuk:info'); } catch (_) {}
    opaSlider = document.getElementById('w-opa');
    if (opaSlider) {
      opaSlider.addEventListener('input', () => applyOpa(opaSlider.value));
      opaSlider.addEventListener('change', () => {
        ipc.invoke('cuk:set-opacity', opaCur).catch(() => {});
      });
    }
    // 「失焦」透明度滑块（2026-10-08 用户要求）：拖它 = 给失焦单独设一个值（拖动即时预览），
    // 双击 = 回到「跟随聚焦」（默认行为）。
    // ⚠️ 预览必须**自动结束**：窗口明明有焦点、却停在"只有失焦才该有"的渲染上，会让人
    //    以为坏了。所以松手后约 2 秒回到聚焦观感，想再看就再拖一下。
    opaBlurSlider = document.getElementById('w-opa-blur');
    if (opaBlurSlider) {
      opaBlurSlider.addEventListener('input', () => {
        opaBlurCur = Math.max(0, Math.min(100, Math.round(Number(opaBlurSlider.value) || 0)));
        // 预览：让页面**按失焦档渲染**（previewing 一置位，effNow() 就取 effBlur()）。
        // 真实失焦时页面做的事**一模一样**（只是触发源换成 window 的 blur 事件），
        // 所以"预览所见"与"实际失焦"必然一致 —— 这也是 v1.8.21 把"整窗 alpha"那条
        // 旁路删掉的原因：只要有第二条旁路，两条路就会漂移。
        // 主进程那边只需要**收值**（拖动中不写盘），不参与渲染。
        previewing = true;
        applyOpa();
        clearTimeout(previewTimer);
        // 3.5 秒后自动收手 —— 窗口明明有焦点却停在失焦观感上，会让人以为坏了
        previewTimer = setTimeout(() => { previewing = false; applyOpa(); }, 3500);
        ipc.invoke('cuk:set-opacity-blur', opaBlurCur, { preview: true }).catch(() => {});
      });
      // 松手才落盘（拖动过程不写文件 —— 与主透明度滑块一致）
      opaBlurSlider.addEventListener('change', () => {
        ipc.invoke('cuk:set-opacity-blur', opaBlurCur).catch(() => {});
      });
      opaBlurSlider.addEventListener('dblclick', () => {
        opaBlurCur = null;                                   // 回到「跟随聚焦」
        previewing = false;
        clearTimeout(previewTimer);
        applyOpa();
        ipc.invoke('cuk:set-opacity-blur', null).catch(() => {});
      });
    }
    // 窗口焦点一变就换档：失焦时用「失焦」那档染色渲染（主进程那边同时把材质切一次，
    // 现在两端都是 acrylic，见 shell/main.js 的 MATERIAL_* 注释）。
    // ⚠️ 听 window 的 focus/blur —— 元素级的 blur 不冒泡，收不到（也不用收）。
    winFocused = document.hasFocus();
    window.addEventListener('focus', () => { winFocused = true; previewing = false; applyOpa(); });
    window.addEventListener('blur', () => { winFocused = false; applyOpa(); });
    const themeBtn = document.getElementById('w-theme');
    if (themeBtn) {
      themeBtn.addEventListener('click', async () => {
        applyTheme(themeCur === 'light' ? 'dark' : 'light');
        try { await ipc.invoke('cuk:set-theme', themeCur); } catch (_) {}
      });
    }
    if (info) {
      applyOpa(typeof info.opacity === 'number' ? info.opacity : 56);
      // 「失焦」档由主进程管（它要动整窗 alpha）：null = 跟随聚焦
      opaBlurCur = (typeof info.opacityBlur === 'number') ? info.opacityBlur : null;
      applyOpa();
      applyTheme(info.theme === 'light' ? 'light' : 'dark');
      paintSize(info.size || 'medium');
      if (info.shotDir) {
        window.__cukShotDir = info.shotDir;
      }
    }
  }

  function paintSize(name) {
    const box = document.getElementById('w-size');
    if (!box) return;
    for (const b of box.querySelectorAll('button')) b.classList.toggle('on', b.dataset.size === name);
  }

  const sizeBox = document.getElementById('w-size');
  if (sizeBox) {
    sizeBox.addEventListener('click', async (e) => {
      const b = e.target.closest('button[data-size]');
      if (!b) return;
      const r = await ipc.invoke('cuk:set-size', b.dataset.size);
      if (r && r.ok) paintSize(r.size);
    });
  }

  // ---------------------------------------------------------------- 截图
  // 供自检用：window.__cukShot('名字') 存一张 PNG 到 shell 的截图目录。
  window.__cukShot = async (name) => {
    try { return await ipc.invoke('cuk:shot', name || 'shot'); }
    catch (e) { return { ok: false, error: String(e && e.message) }; }
  };
  // ⚠️ 别再往 window.__cukShell 上写东西 —— 那是 preload 注入的**布尔标志**
  //    （壳环境判据）。之前这里写了个同名对象把它覆盖掉，导致 envFlag 判定失效。
  //    要给外部用的能力挂在 window.__cukShellApi 上。
  window.__cukShellApi = { electron: true, invoke: ipc.invoke };

  // ---------------------------------------------------------------- 壁纸退路
  //
  // ★ 2026-09-23 重写：「透明要实时的」——
  //
  // 原来这段是**无条件**铺一张桌面壁纸当背景，结果把真正透出去的窗口盖住了：
  // 用户看到的"窗外"是一张静止的图片，别的窗口从后面经过、桌面图标变了他都看不见。
  // 那是假透明。
  //
  // 现在改成：**能用真透明就绝不铺壁纸**。只有当"窗外"确实是死的（原生材质
  // 不可用、窗口没透出去）时才铺，而且铺之前要先用像素说话 —— 见
  // probeRealTransparency()：让主进程拍一张窗口所在的屏幕，比较"窗口中心区域"
  // 与"紧贴窗口外的桌面"是否不同。真的透了就什么都不做。
  //
  // 顺序：先等原生材质生效 → 拍照判断 → 只有判定"没透"才铺壁纸。
  async function probeRealTransparency() {
    try {
      const r = await ipc.invoke('cuk:trans-check');
      window.__cukTrans = r;
      return r;
    } catch (e) {
      return { ok: false, error: String(e && e.message) };
    }
  }

  async function initWallpaperFallback() {
    // 先给原生材质几帧时间落地（acrylic/mica 是异步生效的）
    await new Promise((r) => setTimeout(r, 900));
    const t = await probeRealTransparency();
    // 判定"真的透出去了"：窗口内部区域的像素与窗口外的桌面像素明显不同，
    // 说明我们确实是在把背后的画面模糊/透出来，而不是显示一块死背景。
    if (t && t.ok && t.transparent) return;      // 真透明 —— 什么都不要盖
    // 走到这里说明窗外是死的（材质没生效），此时才铺壁纸兜底
    let w = null;
    try {
      const r = await fetch('/api/wallpaper');
      w = await r.json();
    } catch (_) { return; }
    if (!w || !w.ok) return;
    const layer = document.createElement('div');
    layer.className = 'win-wallpaper';
    layer.setAttribute('aria-hidden', 'true');
    // 时间戳防缓存：换了壁纸刷新就能看到新的
    layer.style.backgroundImage = `url("/api/wallpaper/img?t=${Date.now()}")`;
    document.body.insertBefore(layer, document.body.firstChild);
    // 兜底层是"假透"，明确标出来，界面据此可以提示用户"当前是壁纸兜底"
    document.documentElement.classList.add('win-wallpaper-fallback');
  }

  initWallpaperFallback();

  // 快捷键：F11 全屏、Ctrl+W 关窗 —— 无边框窗口没有系统菜单，给两个常见入口
  window.addEventListener('keydown', (e) => {
    if (e.key === 'F11') { e.preventDefault(); toggleMax(); }
    else if (e.ctrlKey && (e.key === 'w' || e.key === 'W')) { e.preventDefault(); ipc.invoke('cuk:close'); }
  });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initShell);
  else initShell();
})();
