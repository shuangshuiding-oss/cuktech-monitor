/**
 * 便携包产物验收 —— 每次打完包跑一遍，确认"发出去的东西真能解、内容真对"。
 *
 *   node tools\verify_package.js [--out 报告路径] [--keep]
 *
 * 只验体积是不够的。这个脚本做的是"端到端还原比对"：
 *   1. 用 7z t 对每个产物做完整性自校验（CRC/结构）；
 *   2. 真解压到临时目录 —— zip / 7z / 自解压 exe 三种都解，
 *      这样连"SFX 拼接得对不对"也一起验了；
 *   3. 解压结果 vs dist 里的绿色目录**逐文件 sha1 比对**，必须 100% 一致；
 *      再跟源码目录比对关键文件，确认打进去的是当前版本；
 *   4. 隐私红线：绝不能出现 data/、cuktech.token、历史、日志；
 *   5. 文本编码：.bat / .txt 必须是 GBK + CRLF + 无 BOM（中文 Windows 的 ANSI）。
 *
 * --keep 保留解压目录（排查用）；默认验完就删。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const APP = path.resolve(__dirname, '..');
const DIST = path.join(APP, 'dist');
const TMP = process.env.TEMP || '.';

const args = process.argv.slice(2);
const keep = args.includes('--keep');
const outPath = args.includes('--out') ? args[args.indexOf('--out') + 1] : path.join(TMP, 'cuk_pkg_verify.txt');

const L = [];
function say(s) { L.push(s === undefined ? '' : String(s)); }

// 找 7-Zip
const SEVENZ = [
  'C:\\Program Files\\7-Zip\\7z.exe',
  'C:\\Program Files (x86)\\7-Zip\\7z.exe',
].find((p) => fs.existsSync(p));

const sha = (p) => {
  try { return crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex').slice(0, 12); }
  catch (e) { return 'MISSING'; }
};
const rel = (base, p) => p.slice(base.length + 1).replace(/\\/g, '/');

function sizeOf(p) {
  let st;
  try { st = fs.statSync(p); } catch (e) { return 0; }
  if (st.isFile()) return st.size;
  let t = 0;
  for (const e of fs.readdirSync(p, { withFileTypes: true })) t += sizeOf(path.join(p, e.name));
  return t;
}

function listFiles(dir, base = dir) {
  const out = [];
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
  for (const e of ents) {
    const q = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(q, base));
    else out.push(rel(base, q));
  }
  return out;
}

// ─────────────────────────────────────────────────────────── 产物清单
const STAGE = path.join(DIST, '酷态科10号Ultra');
const PRIVACY = /\bdata[\\/]|cuktech\.token|history.*\.jsonl|energy\.json|app\.log|qr\.png|qr-state\.json|^config\.json$|node_modules|\.venv/i;

say('='.repeat(72));
say('便携包产物验收   ' + new Date().toLocaleString('zh-CN'));
say('='.repeat(72));
say('7-Zip: ' + (SEVENZ || '(未找到 —— 只能验 zip 的结构，跳过 t/x)'));
say('');

if (!SEVENZ) {
  say('没有 7-Zip，无法做完整性自校验，退出。');
  fs.writeFileSync(outPath, L.join('\n'), 'utf8');
  console.log(L.join('\n'));
  process.exit(2);
}

// 可选过滤：node tools\verify_package.js v1.8.3
// ⚠️ dist\ 里常年堆着历次旧包（它们和当前 staging 必然对不上：文件被改过、或当年带了
//    Electron 而这次没带），不筛的话报告会被"旧包缺文件"的 FAIL 淹掉，真问题反而看不见。
//    要发哪一版就校验哪一版；想全查一遍就不带参数。
const only = process.argv[2] || '';
const products = fs.readdirSync(DIST)
  .filter((f) => /酷态科10号Ultra-便携版.*\.(zip|7z|exe)$/.test(f))
  .filter((f) => !only || f.includes(only))
  .map((f) => path.join(DIST, f));
if (!products.length) {
  console.log('没有匹配的产物' + (only ? '（过滤词：' + only + '）' : ''));
  process.exit(2);
}

const stageFiles = listFiles(STAGE);
const stageSize = sizeOf(STAGE);
say('staging (绿色目录): ' + stageFiles.length + ' 个文件 / ' + (stageSize / 1048576).toFixed(1) + ' MB');
say('');
say('产物:' + (only ? '（过滤 "' + only + '"，共 ' + products.length + ' 个；不带参数会连同历次旧包一起校验）' : ''));
for (const p of products) {
  say('  ' + (fs.statSync(p).size / 1048576).toFixed(1).padStart(6) + ' MB   ' + path.basename(p));
}
say('');

let fails = [];

// ─────────────────────────────────────────────────────────── 逐产物验证
for (const p of products) {
  const name = path.basename(p);
  say('─'.repeat(72));
  say('【' + name + '】');

  // 1. 完整性自校验
  const t = spawnSync(SEVENZ, ['t', '-y', p], { encoding: 'utf8', timeout: 300000 });
  const tOk = t.status === 0;
  say('  完整性 7z t  : ' + (tOk ? 'PASS' : 'FAIL (exit=' + t.status + ')'));
  if (!tOk) {
    fails.push(name + ' 完整性校验失败');
    const tail = ((t.stdout || '') + (t.stderr || '')).split('\n').slice(-6).join('\n');
    say('    ' + tail.replace(/\n/g, '\n    '));
  }

  // 2. 解压
  const ex = path.join(TMP, '_pkgverify_' + name.replace(/[^\w.]/g, '_'));
  if (fs.existsSync(ex)) fs.rmSync(ex, { recursive: true, force: true });
  fs.mkdirSync(ex, { recursive: true });
  const x = spawnSync(SEVENZ, ['x', '-y', '-o' + ex, p], { encoding: 'utf8', timeout: 300000 });
  if (x.status !== 0) {
    say('  解压        : FAIL (exit=' + x.status + ')');
    fails.push(name + ' 解压失败');
    continue;
  }

  // 顶层结构：应当正好是单个 酷态科10号Ultra 目录
  const top = fs.readdirSync(ex);
  say('  解压后顶层  : ' + JSON.stringify(top));
  const inner = top.length === 1 ? path.join(ex, top[0]) : ex;
  if (top.length !== 1 || top[0] !== '酷态科10号Ultra') {
    fails.push(name + ' 顶层结构不对（期望单个「酷态科10号Ultra」目录）');
  }

  // 3. 与绿色目录逐文件比对
  const innerFiles = listFiles(inner);
  const setA = new Set(stageFiles);
  const setB = new Set(innerFiles);
  const missing = stageFiles.filter((f) => !setB.has(f));
  const extra = innerFiles.filter((f) => !setA.has(f));
  let diff = 0;
  const diffList = [];
  for (const f of stageFiles) {
    if (!setB.has(f)) continue;
    if (sha(path.join(STAGE, f)) !== sha(path.join(inner, f))) {
      diff++;
      if (diffList.length < 5) diffList.push(f);
    }
  }
  say('  文件数      : 包内 ' + innerFiles.length + ' / 绿色目录 ' + stageFiles.length);
  say('  逐文件 sha1 : ' + (missing.length === 0 && extra.length === 0 && diff === 0
    ? 'PASS  (' + stageFiles.length + '/' + stageFiles.length + ' 完全一致)'
    : 'FAIL  缺' + missing.length + ' 多' + extra.length + ' 内容差' + diff));
  if (missing.length) { fails.push(name + ' 缺文件: ' + missing.slice(0, 5).join(', ')); say('    缺: ' + missing.slice(0, 5).join(', ')); }
  if (extra.length) { fails.push(name + ' 多文件: ' + extra.slice(0, 5).join(', ')); say('    多: ' + extra.slice(0, 5).join(', ')); }
  if (diff) { fails.push(name + ' 内容不一致: ' + diffList.join(', ')); say('    差异: ' + diffList.join(', ')); }

  // 中文名还原
  const cn = innerFiles.filter((f) => /[\u4e00-\u9fa5]/.test(f));
  say('  中文文件名  : ' + cn.length + ' 个，例如 ' + (cn.slice(0, 3).join(' , ') || '(无)'));

  // 4. 隐私红线
  const leak = innerFiles.filter((f) => PRIVACY.test(f));
  say('  隐私检查    : ' + (leak.length ? 'FAIL 命中 ' + leak.slice(0, 5).join(', ') : 'PASS 无 data/ 无 token 无历史 无日志'));
  if (leak.length) fails.push(name + ' 隐私泄漏: ' + leak.slice(0, 5).join(', '));

  // 5. 关键文件 vs 源码
  const keyFiles = ['server.js', 'collector.py', 'launcher.js', 'tray.ps1', 'login.py', 'netfix.py',
    'version.json', 'web/app.js', 'web/index.html', 'web/style.css',
    '使用说明.txt', '首次使用.txt', '启动酷态科10号Ultra.bat', '调试启动.bat'];
  let sameSrc = 0;
  const srcDiff = [];
  for (const f of keyFiles) {
    const a = sha(path.join(APP, f));
    const b = sha(path.join(inner, f));
    if (a === b) sameSrc++; else srcDiff.push(f + '(' + a + '≠' + b + ')');
  }
  say('  对源码      : ' + (srcDiff.length === 0 ? 'PASS  ' + sameSrc + '/' + keyFiles.length + ' 与源码一致' : 'FAIL  ' + srcDiff.join(', ')));
  if (srcDiff.length) fails.push(name + ' 与源码不一致: ' + srcDiff.join(', '));

  // 6. 精简是否真的生效（那些文件不该在）
  const mustGone = ['runtime/python/Lib/site-packages/pip', 'runtime/python/Lib/ensurepip',
    'runtime/python/DLLs/sqlite3.dll', 'runtime/python/Lib/pydoc_data'];
  const stillThere = mustGone.filter((m) => innerFiles.some((f) => f.startsWith(m)));
  say('  精简生效    : ' + (stillThere.length ? 'FAIL 仍在: ' + stillThere.join(', ') : 'PASS  pip/ensurepip/sqlite3/pydoc 已剔除'));
  if (stillThere.length) fails.push(name + ' 精简未生效');

  // 7. 文本编码
  const txtFiles = ['启动酷态科10号Ultra.bat', '调试启动.bat', '使用说明.txt', '首次使用.txt'];
  const encBad = [];
  for (const f of txtFiles) {
    const fp = path.join(inner, f);
    if (!fs.existsSync(fp)) { encBad.push(f + ':缺'); continue; }
    const b = fs.readFileSync(fp);
    const bom = b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF;
    let lf = 0, crlf = 0;
    for (let i = 0; i < b.length; i++) if (b[i] === 0x0A) { lf++; if (i > 0 && b[i - 1] === 0x0D) crlf++; }
    let gbkOk = true;
    try { new (require('util').TextDecoder)('gbk', { fatal: true }).decode(b); } catch (e) { gbkOk = false; }
    if (bom || !gbkOk || lf !== crlf) encBad.push(f + '(BOM=' + bom + ' GBK=' + gbkOk + ' CRLF=' + crlf + '/' + lf + ')');
  }
  say('  文本编码    : ' + (encBad.length ? 'FAIL ' + encBad.join(', ') : 'PASS  GBK + CRLF + 无 BOM'));
  if (encBad.length) fails.push(name + ' 编码问题: ' + encBad.join(', '));

  // 8. 便携运行时可跑
  const pyExe = path.join(inner, 'runtime/python/python.exe');
  const nodeExe = path.join(inner, 'runtime/node.exe');
  if (fs.existsSync(nodeExe)) {
    const r = spawnSync(nodeExe, ['-e', 'console.log(process.version)'], { encoding: 'utf8', timeout: 60000 });
    say('  便携 node   : ' + (r.status === 0 ? 'PASS ' + (r.stdout || '').trim() : 'FAIL'));
    if (r.status !== 0) fails.push(name + ' 便携 node 跑不起来');
  } else { say('  便携 node   : FAIL 缺 runtime/node.exe'); fails.push(name + ' 缺 node.exe'); }
  if (fs.existsSync(pyExe)) {
    const r = spawnSync(pyExe, ['-c', 'import sys,bleak,aiohttp,cryptography;print(sys.version.split()[0])'],
      { encoding: 'utf8', timeout: 120000 });
    say('  便携 python : ' + (r.status === 0 ? 'PASS ' + (r.stdout || '').trim() : 'FAIL ' + ((r.stderr || '').split('\n').slice(-2).join(' '))));
    if (r.status !== 0) fails.push(name + ' 便携 python 依赖导入失败');
  } else { say('  便携 python : FAIL 缺 runtime/python/python.exe'); fails.push(name + ' 缺 python.exe'); }

  if (!keep) { try { fs.rmSync(ex, { recursive: true, force: true }); } catch (e) {} }
  else say('  （解压目录保留在 ' + ex + '）');
}

// ─────────────────────────────────────────────────────────── 总结
say('');
say('='.repeat(72));
const best = products.map((p) => ({ n: path.basename(p), s: fs.statSync(p).size })).sort((a, b) => a.s - b.s)[0];
if (best) say('最小产物: ' + best.n + '  ' + (best.s / 1048576).toFixed(1) + ' MB');
if (fails.length) {
  say('结果: 失败 ' + fails.length + ' 项');
  for (const f of fails) say('  - ' + f);
} else {
  say('结果: 全部通过');
}
say('='.repeat(72));

fs.writeFileSync(outPath, L.join('\n') + '\n', 'utf8');
console.log(L.join('\n'));
console.log('\n报告已写入 ' + outPath);
process.exit(fails.length ? 1 : 0);
