// hideOwnConsole 的离线回归（2026-10-11 用户报「这个窗口隐藏」）。
//
// 为什么这样测：会话沙箱里**根本没有控制台**（实测 GetConsoleWindow() 恒为 NULL，
// 连 wscript 都被当 LOLBin 拦掉），所以没法"真起一个黑窗口再把它藏掉"。
// 改成用**替身 koffi** 把逻辑喂进去：三种真实世界的返回（没有 koffi / 没有控制台 /
// 有控制台）都必须走对分支，并且**任何异常都不许往外冒**（藏窗口失败绝不能影响服务）。
//
// 用法: node tools/dev/console_hide_test.js
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'server.js'), 'utf8');

const out = [];
let bad = 0;
const check = (name, cond, extra) => {
  if (!cond) bad++;
  out.push((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '   — ' + extra : ''));
};

function extractFn(text, name) {
  let start = text.indexOf('function ' + name + '(');
  if (start < 0) return null;
  if (text.slice(Math.max(0, start - 6), start) === 'async ') start -= 6;
  let i = text.indexOf('{', start);
  if (i < 0) return null;
  let depth = 0;
  for (; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return text.slice(start, i + 1); }
  }
  return null;
}

const fn = extractFn(src, 'hideOwnConsole');
check('hideOwnConsole 能从 server.js 里切出来', !!fn);

/** 造一个替身 koffi：kernel32/user32 两个 dll，返回可控的句柄与记录调用。 */
function makeFake(koffiOpts) {
  const calls = { show: [], isVisible: 0, loads: [] };
  const fake = {
    load(name) {
      calls.loads.push(name);
      if (koffiOpts.loadThrows) throw new Error('dll 加载失败（模拟）');
      if (name === 'kernel32.dll') {
        return { func: (n) => (n === 'GetConsoleWindow' ? () => koffiOpts.hwnd : null) };
      }
      return {
        func: (n) => {
          if (n === 'ShowWindow') return (h, cmd) => { calls.show.push([h, cmd]); return true; };
          if (n === 'IsWindowVisible') return () => { calls.isVisible++; return !!koffiOpts.visibleAfter; };
          return null;
        },
      };
    },
  };
  return { fake, calls };
}

/** 把函数体放到给定环境里求值。 */
function run(fakeKoffi, opts) {
  opts = opts || {};
  const APP = 'C:\\fake\\app';
  const req = (m) => {
    // 函数会按 ['koffi', <APP>\vendor\koffi] 两个候选依次 require。
    // · noKoffi  → 两个都失败（模拟"两份都没有"）
    // · vendorOnly → 只有 vendor 那份在（模拟便携包：包里没 node_modules）
    if (m === 'koffi') {
      if (opts.noKoffi || opts.vendorOnly) {
        const e = new Error("Cannot find module 'koffi'"); e.code = 'MODULE_NOT_FOUND'; throw e;
      }
      return fakeKoffi;
    }
    if (String(m).indexOf('vendor') >= 0) {
      if (!opts.vendorOnly) {
        const e = new Error("Cannot find module '" + m + "'"); e.code = 'MODULE_NOT_FOUND'; throw e;
      }
      return fakeKoffi;
    }
    const e = new Error("Cannot find module '" + m + "'");
    e.code = 'MODULE_NOT_FOUND';
    throw e;
  };
  const platform = opts.platform || 'win32';
  const f = new Function('require', 'process', 'path', 'APP',
    fn + '\nreturn hideOwnConsole;')(req, { platform }, path, APP);
  return f();
}

// ---- 1) 拿不到 koffi：不许抛，返回可读的原因 ----
let r;
try { r = run(null, { noKoffi: true }); } catch (e) { r = { threw: e.message }; }
check('没有 koffi 时不抛异常，返回 why=no-koffi', r && r.ok === false && r.why === 'no-koffi',
  JSON.stringify(r));

// ---- 2) 非 Windows：直接跳过 ----
try { r = run(null, { platform: 'linux' }); } catch (e) { r = { threw: e.message }; }
check('非 Windows 直接返回 why=not-windows', r && r.ok === false && r.why === 'not-windows',
  JSON.stringify(r));

// ---- 3) 没有控制台（沙箱/被当库 require）：什么都不做，也不报错 ----
const f3 = makeFake({ hwnd: null });
try { r = run(f3.fake, {}); } catch (e) { r = { threw: e.message }; }
check('GetConsoleWindow 返回 0 时返回 why=no-console，且不调 ShowWindow',
  r && r.ok === false && r.why === 'no-console' && f3.calls.show.length === 0, JSON.stringify(r));

// ---- 4) 有控制台：必须调 ShowWindow(hwnd, 0) —— 0 就是 SW_HIDE ----
const f4 = makeFake({ hwnd: '[fake-hwnd]', visibleAfter: false });
try { r = run(f4.fake, {}); } catch (e) { r = { threw: e.message }; }
check('有控制台时调 ShowWindow(hwnd, SW_HIDE=0)', r && r.ok === true
  && f4.calls.show.length === 1 && f4.calls.show[0][0] === '[fake-hwnd]' && f4.calls.show[0][1] === 0,
  JSON.stringify(r) + ' calls=' + JSON.stringify(f4.calls.show));
check('顺带回读 IsWindowVisible 作为凭据（日志里能看出藏没藏住）',
  f4.calls.isVisible === 1 && r.stillVisible === false, 'stillVisible=' + (r && r.stillVisible));

// ---- 5) 即使"藏完仍可见"也不改变 ok（只是凭据，用于日志）----
const f5 = makeFake({ hwnd: '[fake-hwnd]', visibleAfter: true });
try { r = run(f5.fake, {}); } catch (e) { r = { threw: e.message }; }
check('回读仍可见时 ok 依旧为 true，但把 stillVisible 记进结果',
  r && r.ok === true && r.stillVisible === true, JSON.stringify(r));

// ---- 6) koffi 在但 DLL 调用炸了：吞掉，返回 error:...，绝不让服务挂 ----
//    注意区分两种失败：require('koffi') 本身抛 → no-koffi（上面第 1 条）；
//    koffi 拿到了、但 load/func 抛 → error:*（本条）。
const f6 = makeFake({ hwnd: '[fake-hwnd]', loadThrows: true });
try {
  r = run(f6.fake, {});
} catch (e) { r = { threw: e.message }; }
check('koffi 内部异常被吞掉（返回 why=error:*，不抛出）',
  r && r.ok === false && /^error:/.test(r.why), JSON.stringify(r));

// ---- 8) 便携包：没有 node_modules，靠 vendor/koffi 那份也要能藏 ----
const f8 = makeFake({ hwnd: '[fake-hwnd]', visibleAfter: false });
try { r = run(f8.fake, { vendorOnly: true }); } catch (e) { r = { threw: e.message }; }
check('没有 node_modules 时回落到 vendor/koffi（便携包场景）',
  r && r.ok === true && r.from && String(r.from).indexOf('vendor') >= 0, JSON.stringify(r));
check('vendor/koffi 真的在项目里（打包时会连 vendor 一起带走）',
  fs.existsSync(path.join(root, 'vendor', 'koffi', 'index.cjs'))
  && fs.existsSync(path.join(root, 'vendor', 'koffi', 'build', 'koffi', 'win32_x64', 'koffi.node')));

// ---- 9) 起点位置：必须在 main() 的**第一步**，别让黑窗口多待几百毫秒 ----
const mainIdx = src.indexOf('(async function main()');
const callIdx = src.indexOf('const hid = hideOwnConsole();', mainIdx);
const loadIdx = src.indexOf('loadEnergy();', mainIdx);
check('hideOwnConsole() 是 main() 里第一条语句（排在 loadEnergy 之前）',
  mainIdx > 0 && callIdx > 0 && loadIdx > 0 && callIdx < loadIdx,
  'main@' + mainIdx + ' hide@' + callIdx + ' load@' + loadIdx);

// ---- 8) 开机自启动直连 node.exe（不再经过 cmd），且后台档带 --no-window ----
check('开机自启动的 .lnk 直接指向 node.exe（不再经 .bat，开机不起 cmd 窗口）',
  /const node = findNodeExe\(\);/ .test(src)
  && /\$s\.TargetPath = '" \+ q\(node\) \+ "'/ .test(src)
  && /m === 'tray' \? ' --no-window' : ''/ .test(src));
check('findNodeExe 优先便携包自带的 runtime\\node.exe，兜底当前进程的 node',
  /path\.join\(APP, 'runtime', 'node\.exe'\)/.test(src) && /process\.execPath/.test(src));

console.log(out.join('\n'));
console.log('RESULT ' + (out.length - bad) + ' PASS / ' + bad + ' FAIL');
process.exit(bad ? 1 : 0);
