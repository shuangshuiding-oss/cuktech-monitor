// 「打包路径」一致性回归（2026-10-12 用户报「打包的不是透明的」）。
//
// 这次的真凶不是"忘了带 Electron"，而是**两个文件的约定对不上**：
//   · tools/package.ps1  -WithElectron 把 Electron 放在  <APP>/electron/
//   · server.js  findElectron() 只找              <APP>/node_modules/electron/dist/
//   ⇒ 就算打包时带上了 Electron，运行时也永远找不到 → 回退 Edge --window → 没有透明玻璃。
//     （而且这 87MB 的白带，从外表一点看不出来，只有"窗口不透明"这一个症状。）
//
// 所以这里钉的不是"某个路径写对了"，而是**打包方与查找方必须指向同一个地方**。
// 外加 shell/main.js 的 koffi 回落（便携包没有 node_modules，不然圆角外会有一圈白边）。
//
// 用法: node tools/test_pack_paths.js
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const serverJs = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const shellJs = fs.readFileSync(path.join(root, 'shell', 'main.js'), 'utf8');
const pkgPs = fs.readFileSync(path.join(root, 'tools', 'package.ps1'), 'utf8');

const out = [];
let bad = 0;
const check = (name, cond, extra) => {
  if (!cond) bad++;
  out.push((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '   — ' + extra : ''));
};

// ---- 1. 从 package.ps1 里抠出"它把 electron 放哪" ----
//     形如：$elDst = Join-Path $Stage 'electron'
const m = /elDst\s*=\s*Join-Path\s+\$Stage\s+'([^']+)'/.exec(pkgPs);
const packDir = m ? m[1] : null;
check('能从 package.ps1 里解析出 Electron 的打包目录', !!packDir, packDir || '(没找到 $elDst)');

// ---- 2. 从 server.js 里抠出 findElectron 的所有候选路径 ----
const fn = (() => {
  const s = serverJs.indexOf('function findElectron(');
  if (s < 0) return '';
  let i = serverJs.indexOf('{', s), d = 0;
  for (; i < serverJs.length; i++) {
    if (serverJs[i] === '{') d++;
    else if (serverJs[i] === '}') { d--; if (!d) return serverJs.slice(s, i + 1); }
  }
  return '';
})();
check('能切出 findElectron 函数体', fn.length > 0);
const cands = [...fn.matchAll(/path\.join\(APP,\s*([^)]*)\)/g)].map((x) => x[1]);
check('findElectron 是多路查找（不是只认一个路径）', cands.length >= 2,
  cands.length + ' 条：' + cands.join(' | '));

// ---- 3. ★核心：打包目录必须在 findElectron 的候选里 ----
if (packDir) {
  const hit = cands.some((c) => c.indexOf("'" + packDir + "'") >= 0);
  check('★打包放 Electron 的目录 <APP>/' + packDir + ' 在 findElectron 的候选里（否则白带 87MB）',
    hit, hit ? '' : ('候选只有：' + cands.join(' | ')));
}
// 开发目录那条不能丢（不然本机 npm install 出来的 Electron 找不到了）
check('开发目录 node_modules/electron/dist 仍在候选里（本机调试靠它）',
  cands.some((c) => c.indexOf("'node_modules'") >= 0 && c.indexOf("'electron'") >= 0));

// ---- 4. -WithElectron 真的会把 electron.exe 复制过去 ----
check('package.ps1 确实以 $elSrc 的 electron.exe 为源做 robocopy',
  /robocopy\s+\$elSrc\s+\$elDst/.test(pkgPs)
  && /Join-Path\s+\$App\s+'node_modules\\electron\\dist'/.test(pkgPs));
check('裁剪 locales（只留 zh-CN/en-US）与 LICENSES.chromium.html 仍在（省约 69MB）',
  /zh-CN\.pak/.test(pkgPs) && /en-US\.pak/.test(pkgPs) && /LICENSES\.chromium\.html/.test(pkgPs));

// ---- 5. shell/main.js 的 koffi 回落（便携包没有 node_modules）----
check('shell/main.js 的 koffi 有 vendor 回落（否则打包版圆角外一圈白边）',
  /vendor',\s*'koffi'/.test(shellJs) && /for \(const _c of/.test(shellJs));
check('shell/main.js 找不到 koffi 时只是降级、不抛（_koffi 为 null 就早退）',
  /let _koffi = null;/.test(shellJs) && /!win \|\| win\.isDestroyed\(\) \|\| !_koffi\) return;/.test(shellJs));
check('server.js 的 hideOwnConsole 也有 vendor 回落（同一个 vendor/koffi）',
  /for \(const cand of \['koffi', path\.join\(APP, 'vendor', 'koffi'\)\]\)/.test(serverJs));

// ---- 6. vendor/koffi 本体在（否则两份回落都是空的）----
check('vendor/koffi 在项目里且带预编译二进制',
  fs.existsSync(path.join(root, 'vendor', 'koffi', 'index.cjs'))
  && fs.existsSync(path.join(root, 'vendor', 'koffi', 'build', 'koffi', 'win32_x64', 'koffi.node')));

// ---- 7. 默认带 Electron（用户要的就是"包也是透明的"）----
check('package.ps1 默认带 Electron（-NoElectron 才不带）',
  /\$WithElectron = \$WithElectron -or \(-not \$NoElectron\)/.test(pkgPs)
  && /\[switch\]\$NoElectron/.test(pkgPs));
check('不带 Electron 时明确提示"没有透明玻璃"（别让用户以为界面坏了）',
  /未打包（-NoElectron）/.test(pkgPs) && /没有透明玻璃/.test(pkgPs));
check('复制完 electron 会**验证落地**（以前只报 robocopy exit，出问题没人知道）',
  /electron\.exe 没复制成功/.test(pkgPs) && /electron 已就位/.test(pkgPs));

// ---- 8. 便携运行时只带"本应用的依赖"（v1.9.3）----
// 2026-11-08 打出来的包突然 173MB（staging 717MB）：package.ps1 把打包机 base Python 的
// Lib\site-packages 整包复制了，而那里因为别的活装了 numpy/scipy/imageio_ffmpeg/PIL…
// 顺带还让隐私检查报假警报（numpy 的测试数据在 `…\tests\data\` 下，撞了 `\data\` 规则）。
check('复制 base Python 时排除它自带的 site-packages（应用依赖只走 venv）',
  /\/XD include libs Scripts __pycache__ site-packages/.test(pkgPs));
check('隐私检查只认应用自己的 data\\ 目录（别被第三方包的 data\\ 目录误触发）',
  /\$dataDir = Join-Path \$Stage 'data'/.test(pkgPs) && /StartsWith\(\$dataDir/.test(pkgPs));

console.log(out.join('\n'));
console.log('RESULT ' + (out.length - bad) + ' PASS / ' + bad + ' FAIL');
process.exit(bad ? 1 : 0);
