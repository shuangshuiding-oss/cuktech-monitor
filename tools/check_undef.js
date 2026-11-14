/* 揪「调用了不存在的函数 / 用了没声明的变量」这类错误。
 *
 * 为什么需要它：`node --check` 只做语法解析，`foo()` 里 foo 根本不存在照样通过；
 * 等到运行时才抛 ReferenceError。在 async HTTP 处理器里表现为「连接吊死不返回」，
 * 在页面脚本里表现为「渲染一次就冻住」—— 2026-09-22 两种都踩过。
 *
 * 手法是粗糙的词法启发式（不建 AST）：收集文件里声明过的名字，再扫所有 `名字(` 的
 * 调用点，减去 JS/DOM 内建与显式白名单，剩下的就是嫌疑。宁可有少量误报，也不要漏。
 *
 * 用法：node tools/check_undef.js [文件...]   不给参数就查默认三个文件。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_FILES = ['server.js', 'web/app.js', 'launcher.js'];

// JS + Node + 浏览器内建：被调用但不需要在本文件声明。
const GLOBALS = new Set([
  // 语句关键字/结构（会被上面的正则误当成调用）
  'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'function', 'new',
  'do', 'else', 'case', 'delete', 'void', 'in', 'of', 'instanceof', 'yield', 'await',
  'async', 'static', 'get', 'set', 'constructor', 'super', 'this',
  // 通用
  'require', 'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent',
  'decodeURIComponent', 'encodeURI', 'decodeURI', 'setTimeout', 'clearTimeout',
  'setInterval', 'clearInterval', 'setImmediate', 'structuredClone', 'queueMicrotask',
  'String', 'Number', 'Boolean', 'Array', 'Object', 'Map', 'Set', 'Date', 'Math', 'JSON',
  'Promise', 'RegExp', 'Error', 'TypeError', 'RangeError', 'Buffer', 'BigInt', 'Symbol',
  'WeakMap', 'WeakSet', 'Proxy', 'Reflect', 'Intl', 'URL', 'URLSearchParams', 'TextDecoder',
  'TextEncoder', 'AbortController', 'fetch', 'process', 'console',
  // 浏览器/DOM
  'window', 'document', 'performance', 'requestAnimationFrame', 'cancelAnimationFrame',
  'EventSource', 'XMLHttpRequest', 'WebSocket', 'localStorage', 'sessionStorage',
  'getComputedStyle', 'matchMedia', 'alert', 'prompt', 'confirm', 'btoa', 'atob',
  'addEventListener', 'removeEventListener', 'dispatchEvent', 'CustomEvent', 'Event',
  'Image', 'Audio', 'Worker', 'Blob', 'FileReader', 'FormData', 'Headers', 'Request',
  'Response', 'ResizeObserver', 'IntersectionObserver', 'MutationObserver', 'Notification',
  'svgEl', 'postMessage', 'scrollTo', 'open', 'close', 'focus', 'print', 'matchAll',
  // 本项目里从其它地方注入/约定的
  'onmessage', 'onerror', 'onload', 'onclick',
]);

/** 这个 `/` 是正则开头吗？看它前面最后一个有意义的记号。 */
const KEYWORDS_BEFORE_REGEX = ['return', 'typeof', 'case', 'in', 'of', 'do', 'else',
  'yield', 'await', 'new', 'delete', 'void', 'instanceof', 'throw'];
function looksLikeRegex(src, i) {
  let j = i - 1;
  while (j >= 0 && /\s/.test(src[j])) j--;
  if (j < 0) return true;                                     // 文件开头
  const ch = src[j];
  if ('(,=:[!&|?{};+-*%~^<>'.includes(ch)) return true;
  // `return /re/` 这种：前面的记号是个词，看它是不是关键字。
  // （漏了这条就会把 /["\\n]/ 里的引号当成字符串开头，一路抹掉几十行代码。）
  if (/[A-Za-z_$]/.test(ch)) {
    let k = j, word = '';
    while (k >= 0 && /[A-Za-z_$0-9]/.test(src[k])) { word = src[k] + word; k--; }
    if (KEYWORDS_BEFORE_REGEX.includes(word)) return true;
  }
  return false;
}

/** 从 `${` 的 `{` 位置出发，返回配对 `}` 的下标（跳过字符串/注释/嵌套）。 */
function matchBrace(src, i) {
  let depth = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i], c2 = src[i + 1];
    if (c === '/' && c2 === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && c2 === '*') { i += 2; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }
    if (c === '"' || c === "'" || c === '`') {
      const q = c; i++;
      while (i < n) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === q) { i++; break; }
        i++;
      }
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return i; }
    i++;
  }
  return n - 1;
}

function stripCommentsAndStrings(src) {
  // 把注释和字符串内容抹掉，避免里面的词被当成代码（保留换行以维持行号）。
  let out = '';
  let i = 0;
  const n = src.length;
  const keep = (ch) => { out += ch === '\n' ? '\n' : ' '; };
  while (i < n) {
    const c = src[i], c2 = src[i + 1];
    if (c === '/' && c2 === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && c2 === '*') { i += 2; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { keep(src[i]); i++; } i += 2; continue; }
    // 正则字面量：/["']/g 这类里面的引号会把「字符串剥离」带偏，导致它后面的代码
    // 整段被当成字符串抹掉（于是函数"看起来没声明"）—— 必须先识别并跳过。
    if (c === '/' && looksLikeRegex(src, i)) {
      keep(c); i++;
      let inClass = false;
      while (i < n) {
        const d = src[i];
        if (d === '\\') { keep(d); keep(src[i + 1]); i += 2; continue; }
        if (d === '[') inClass = true;
        else if (d === ']') inClass = false;
        else if (d === '/' && !inClass) { keep(d); i++; break; }
        else if (d === '\n') break;   // 换行说明不是正则，兜底退出
        keep(d); i++;
      }
      while (i < n && /[a-z]/.test(src[i])) { keep(src[i]); i++; }   // 跳过 g/i/m 等标志
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const q = c; out += ' '; i++;
      while (i < n) {
        if (src[i] === '\\') { keep(src[i]); keep(src[i + 1]); i += 2; continue; }
        if (src[i] === q) break;
        // 模板串里的 ${...} 是真的代码，要留下 —— 但**必须递归剥离**：
        // 直接原样复制的话，里面的 '字符串' 会被当成代码（`class="mute"` 曾因此
        // 被误判成"给未声明的 class 赋值"）。
        if (q === '`' && src[i] === '$' && src[i + 1] === '{') {
          const close = matchBrace(src, i + 1);
          out += '${' + stripCommentsAndStrings(src.slice(i + 2, close)) + '}';
          i = close + 1; continue;
        }
        keep(src[i]); i++;
      }
      i++; out += ' '; continue;
    }
    out += c; i++;
  }
  return out;
}

function declaredNames(src) {
  const names = new Set();
  const add = (s) => { if (s) names.add(s); };
  for (const m of src.matchAll(/\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)/g)) add(m[1]);
  for (const m of src.matchAll(/\bclass\s+([A-Za-z_$][\w$]*)/g)) add(m[1]);
  for (const m of src.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) add(m[1]);
  // 解构：const { a, b } = / const [a, b] =
  for (const m of src.matchAll(/\b(?:const|let|var)\s*[\[{]([^\]}]*)[\]}]/g)) {
    for (const part of m[1].split(',')) {
      const k = part.split(':').pop().trim().replace(/=.*$/, '').trim();
      if (/^[A-Za-z_$][\w$]*$/.test(k)) add(k);
    }
  }
  // 函数参数
  for (const m of src.matchAll(/\bfunction\s*\*?\s*[A-Za-z_$]*\s*\(([^)]*)\)/g)) {
    for (const part of m[1].split(',')) {
      const k = part.split('=')[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(k)) add(k);
    }
  }
  for (const m of src.matchAll(/\(([^()]*)\)\s*=>/g)) {
    for (const part of m[1].split(',')) {
      const k = part.split('=')[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(k)) add(k);
    }
  }
  for (const m of src.matchAll(/(?:^|[,{(])\s*([A-Za-z_$][\w$]*)\s*=>/g)) add(m[1]);

  // 一行多声明：`const a = 1, b = 2;` —— 上面只抓到了第一个名字，这里补全。
  // 逐条声明语句取出「到分号为止」的片段（括号/花括号里深度 > 0 时不停），
  // 再按顶层逗号切开。不这么做的话 b/c/d 会被误报成「未声明就赋值」。
  for (const m of src.matchAll(/\b(?:const|let|var)\b/g)) {
    let j = m.index + m[0].length;
    let depth = 0;
    let end = src.length;
    for (let k = j; k < src.length; k++) {
      const ch = src[k];
      if ('([{'.includes(ch)) depth++;
      else if (')]}'.includes(ch)) depth--;
      else if (ch === ';' && depth <= 0) { end = k; break; }
      else if (ch === '\n' && depth <= 0) {
        // 换行且没有续行符 → 语句结束（JS 的 ASI 大致如此）
        const nxt = src.slice(k, k + 40);
        if (!/^\n\s*(?:[.,=+\-*/?:)]|&&|\|\|)/.test(nxt)) { end = k; break; }
      }
    }
    const decl = src.slice(j, end);
    if (/^[\s]*[\[{]/.test(decl)) continue;   // 解构已经在上面处理过
    for (const part of decl.split(',')) {
      const seg = part.trim().replace(/=.*$/s, '').trim();
      if (/^[A-Za-z_$][\w$]*$/.test(seg)) add(seg);
    }
  }
  // ⚠️ 故意**不**把「裸赋值」(`x = ...`) 当作声明：两个文件都是 'use strict'，
  //    给未声明的名字赋值会当场抛 ReferenceError（2026-09-22 就靠这条抓到
  //    `lastMinute = 0` 让整个区间切换按钮失效）。声明必须真的 let/const/var/参数。
  return names;
}

function calledNames(src) {
  const hits = new Map();
  for (const m of src.matchAll(/(^|[^\w$.])([A-Za-z_$][\w$]*)\s*\(/g)) {
    const name = m[2];
    const line = src.slice(0, m.index).split('\n').length;
    if (!hits.has(name)) hits.set(name, []);
    hits.get(name).push(line);
  }
  return hits;
}

/** 裸赋值的名字：`x = ...`。在 'use strict' 下给未声明名字赋值会抛 ReferenceError。 */
function assignedNames(src) {
  const hits = new Map();
  // 前面不能是 `.`（属性赋值）或标识符字符；后面不能是 `=`（== / ===）或 `>`（=>）
  for (const m of src.matchAll(/(^|[^\w$.])([A-Za-z_$][\w$]*)\s*=(?![=>])/g)) {
    const name = m[2];
    if (['const', 'let', 'var', 'return', 'typeof', 'case', 'default'].includes(name)) continue;
    // `const x =` / `let x =` 里面的名字由 declaredNames 负责，这里不重复报
    const before = src.slice(Math.max(0, m.index - 12), m.index + m[1].length);
    if (/(?:const|let|var)\s+$/.test(before)) continue;
    const line = src.slice(0, m.index).split('\n').length;
    if (!hits.has(name)) hits.set(name, []);
    hits.get(name).push(line);
  }
  return hits;
}

const files = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_FILES;
const out = [];
let problems = 0;

for (const rel of files) {
  const file = path.isAbsolute(rel) ? rel : path.join(ROOT, rel);
  if (!fs.existsSync(file)) { out.push('SKIP (不存在): ' + rel); continue; }
  const raw = fs.readFileSync(file, 'utf8');
  const src = stripCommentsAndStrings(raw);
  const declared = declaredNames(src);
  const called = calledNames(src);
  const bad = [];
  for (const [name, lines] of called) {
    if (declared.has(name) || GLOBALS.has(name)) continue;
    // 只在「明显像标识符调用」时报（长度 >= 3 且不是全大写常量）
    if (name.length < 3) continue;
    bad.push('调用 ' + name + '  (行 ' + lines.slice(0, 6).join(',') + (lines.length > 6 ? ' …' : '') + ')');
  }
  // 裸赋值给未声明的名字：'use strict' 下会抛 ReferenceError，静默炸掉整段逻辑。
  const assigned = assignedNames(src);
  for (const [name, lines] of assigned) {
    if (declared.has(name) || GLOBALS.has(name)) continue;
    if (name.length < 3) continue;
    bad.push('未声明就赋值 ' + name + '  (行 ' + lines.slice(0, 6).join(',') + (lines.length > 6 ? ' …' : '') + ')');
  }
  out.push('=== ' + rel + ' === 声明 ' + declared.size + ' 个 / 调用点 ' + called.size + ' 个');
  if (!bad.length) out.push('  OK 没有未声明的调用');
  else { bad.sort(); out.push('  ⚠ 可能是未定义：'); for (const b of bad) out.push('    ' + b); problems += bad.length; }
}

out.push('');
out.push(problems ? ('发现 ' + problems + ' 处可疑调用') : '全部通过');
const OUT = path.join(process.env.TEMP || '.', 'cuk_undef.txt');
fs.writeFileSync(OUT, out.join('\n'), 'utf8');
console.log(out.join('\n'));
// 有嫌疑就置非零退出码，好让 check_all.ps1 / CI 能判成败。
process.exitCode = problems ? 1 : 0;
