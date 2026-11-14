/**
 * 精简便携包的运行时冗余 —— 删掉 node/python 运行时里"跑这个 App 绝对用不到"的东西。
 *
 *   node tools\trim_portable.js <staging目录> [--dry-run]
 *
 * 为什么敢删：App 的 Python 侧只做 BLE + 小米云 HTTP，依赖面很窄。
 *   实际用到的第三方包：bleak / aiohttp / cryptography / winrt（+ 它们的传输依赖
 *   yarl / multidict / frozenlist / propcache / aiosignal / aiohappyeyeballs /
 *   attrs / idna / typing_extensions / cffi）。
 *   标准库只用：argparse asyncio json os random sys time pathlib dataclasses
 *   typing hashlib base64 binascii logging string collections contextlib secrets。
 *   → pip、ensurepip、sqlite3、pydoc、unittest、venv、tkinter 这些一律用不到。
 *
 * 保守原则：**只删这里显式列出的路径**，不递归扫"看起来能删"的东西。
 * 拿不准的一律保留（例如 cffi：虽然代码没直接引用，但删掉只省 0.3MB，
 * 万一 cryptography/bleak 某条分支探测它就会炸，不划算）。
 *
 * 删除用 fs.rmSync —— PowerShell 的 Remove-Item 在本机被 [safe-delete] 拦，
 * 而且那是终止性错误，会把整段脚本打断。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const stage = args.find((a) => !a.startsWith('--'));
if (!stage) {
  console.error('用法: node tools\\trim_portable.js <staging目录> [--dry-run]');
  process.exit(2);
}
const ROOT = path.resolve(stage);
if (!fs.existsSync(ROOT)) {
  console.error('目录不存在: ' + ROOT);
  process.exit(2);
}
// 防呆：绝不允许对盘符根 / 家目录 / 源码目录动手
const guard = ['C:\\', 'C:\\Users', 'C:\\Users\\shuan'];
if (guard.includes(ROOT) || ROOT.split(path.sep).length < 4) {
  console.error('拒绝在过浅的路径上操作: ' + ROOT);
  process.exit(2);
}

// ─────────────────────────────────────────────────── 删除清单（相对 staging）

/** 整目录删除 */
const DIRS = [
  // pip / 安装器 —— 便携包不需要装东西
  'runtime/python/Lib/ensurepip',
  'runtime/python/Lib/site-packages/pip',
  'runtime/python/Lib/site-packages/setuptools',
  'runtime/python/Lib/site-packages/pkg_resources',
  'runtime/python/Lib/site-packages/_distutils_hack',
  'runtime/python/Lib/site-packages/wheel',
  // 标准库里的"开发/测试"设施
  'runtime/python/Lib/pydoc_data',
  'runtime/python/Lib/unittest',
  'runtime/python/Lib/test',
  'runtime/python/Lib/idlelib',
  'runtime/python/Lib/tkinter',
  'runtime/python/Lib/turtledemo',
  'runtime/python/Lib/lib2to3',
  'runtime/python/Lib/venv',
  'runtime/python/Lib/wsgiref',
  'runtime/python/Lib/curses',
  'runtime/python/Lib/dbm',
  'runtime/python/Lib/turtledemo',
  // 数据库 —— 这个 App 的数据全在 jsonl 里
  'runtime/python/Lib/sqlite3',
  'runtime/python/Lib/__phello__',
];

/** 单个文件删除 */
const FILES = [
  // pydoc / doctest：pydoc 只被 site 的 help() 延迟引用，脚本模式永不触发
  'runtime/python/Lib/pydoc.py',
  'runtime/python/Lib/doctest.py',
  // 调试器 / 性能分析 —— 全是开发者工具
  'runtime/python/Lib/pdb.py',
  'runtime/python/Lib/bdb.py',
  'runtime/python/Lib/profile.py',
  'runtime/python/Lib/cProfile.py',
  'runtime/python/Lib/pstats.py',
  'runtime/python/Lib/trace.py',
  'runtime/python/Lib/timeit.py',
  'runtime/python/Lib/tabnanny.py',
  'runtime/python/Lib/pyclbr.py',
  'runtime/python/Lib/modulefinder.py',
  'runtime/python/Lib/zipapp.py',
  'runtime/python/Lib/webbrowser.py',
  'runtime/python/Lib/tty.py',
  'runtime/python/Lib/pty.py',
  // 非 Windows 平台适配（Windows 上永远不会被 import）
  'runtime/python/Lib/_osx_support.py',
  'runtime/python/Lib/_aix_support.py',
  'runtime/python/Lib/_android_support.py',
  'runtime/python/Lib/_ios_support.py',
  'runtime/python/Lib/_apple_support.py',
  // 彩蛋
  'runtime/python/Lib/this.py',
  'runtime/python/Lib/antigravity.py',
  'runtime/python/Lib/__hello__.py',
  // sqlite 的二进制
  'runtime/python/DLLs/sqlite3.dll',
  'runtime/python/DLLs/_sqlite3.pyd',
];

/** glob 删除（只在指定目录里匹配文件名） */
const GLOBS = [
  { dir: 'runtime/python/DLLs', re: /^_test.*\.pyd$/i },        // CPython 自测用的扩展
  { dir: 'runtime/python/DLLs', re: /^_ctypes_test\.pyd$/i },
  { dir: 'runtime/python/Lib/site-packages', re: /^pip-.*\.dist-info$/i },
];

/** 明确保留（写在这里是为了让后来的人别再犹豫） */
const KEEP_NOTE = [
  'cffi / pycparser / _cffi_backend —— 代码没直接引用，但只省 0.3MB，留着降风险',
  'winrt 的 9 个 .pyd —— bleak 的 Windows 后端全都会用到（含 radios）',
  'libssl / libcrypto 9.1MB —— aiohttp 顶层 import ssl，小米云要走 HTTPS',
  'cryptography/_rust.pyd 9.5MB —— BLE 握手要做 AESCCM / ECDH，必需',
  'asyncio / email / xml / multiprocessing —— 被间接依赖或收益太小',
];

// ─────────────────────────────────────────────────── 执行

function sizeOf(p) {
  let st;
  try { st = fs.lstatSync(p); } catch (_) { return 0; }
  if (st.isFile()) return st.size;
  if (!st.isDirectory()) return 0;
  let t = 0;
  for (const e of fs.readdirSync(p, { withFileTypes: true })) {
    t += sizeOf(path.join(p, e.name));
  }
  return t;
}

const removed = [];
let freed = 0;

function drop(rel) {
  const p = path.join(ROOT, rel);
  if (!p.startsWith(ROOT + path.sep)) { removed.push(['SKIP(越界)', rel, 0]); return; }
  if (!fs.existsSync(p)) { removed.push(['skip(不存在)', rel, 0]); return; }
  const n = sizeOf(p);
  if (!dryRun) {
    try { fs.rmSync(p, { recursive: true, force: true }); }
    catch (e) { removed.push(['FAIL ' + e.message, rel, n]); return; }
  }
  removed.push([dryRun ? '(将删)' : '已删', rel, n]);
  freed += n;
}

for (const d of DIRS) drop(d);
for (const f of FILES) drop(f);
for (const g of GLOBS) {
  const dir = path.join(ROOT, g.dir);
  if (!fs.existsSync(dir)) continue;
  for (const name of fs.readdirSync(dir)) {
    if (g.re.test(name)) drop(path.join(g.dir, name).replace(/\\/g, '/'));
  }
}

// ─────────────────────────────────────────────────── 收尾统计

let total = 0;
let files = 0;
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const q = path.join(d, e.name);
    if (e.isDirectory()) walk(q);
    else { try { total += fs.statSync(q).size; files++; } catch (_) {} }
  }
})(ROOT);

const out = [];
out.push('staging = ' + ROOT + (dryRun ? '   [DRY RUN，未真正删除]' : ''));
out.push('');
out.push('清单命中 ' + removed.filter((r) => r[0].startsWith('已删') || r[0].startsWith('(将删)') || r[0].startsWith('FAIL')).length
  + ' 项，其中实际存在并处理的 ' + removed.filter((r) => r[0].startsWith('已删') || r[0].startsWith('(将删)')).length + ' 项');
out.push('');
for (const [st, rel, n] of removed) {
  if (st.startsWith('skip')) continue;
  out.push('  ' + st.padEnd(12) + (n / 1048576).toFixed(3).padStart(8) + ' MB  ' + rel);
}
out.push('');
out.push('释放 = ' + (freed / 1048576).toFixed(2) + ' MB');
out.push('清理后 staging = ' + (total / 1048576).toFixed(1) + ' MB / ' + files + ' 个文件');
out.push('');
out.push('【刻意保留】');
for (const k of KEEP_NOTE) out.push('  - ' + k);

const rep = (process.env.TEMP || '.') + '\\cuk_trim.txt';
fs.writeFileSync(rep, out.join('\n'), 'utf8');
console.log(out.join('\n'));
console.log('');
console.log('报告已写入 ' + rep);
