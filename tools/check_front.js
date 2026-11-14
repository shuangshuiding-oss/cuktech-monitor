// 校验 CuktechMonitor 前端脚本（不执行，只 parse）+ 元素引用完整性。
//
// 2026-09-22 起前端拆成 web/index.html + style.css + app.js，
// 所以这里同时支持两种形态：外链 app.js，或（老备份里的）内联 <script>。
//
// 用法: node tools/check_front.js
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const htmlFile = path.join(root, 'web', 'index.html');
const html = fs.readFileSync(htmlFile, 'utf8');

const out = [];
let bad = 0;

// ---- 1. 脚本来源：外链 app.js 优先，没有再退回内联块 ------------------------
const sources = [];
const appJs = path.join(root, 'web', 'app.js');
if (/<script[^>]*\bsrc=/.test(html)) {
  const links = [...html.matchAll(/<script[^>]*\bsrc="([^"]+)"/gi)].map((m) => m[1]);
  out.push('external <script src>: ' + links.join(', '));
  for (const rel of links) {
    const p = path.join(root, 'web', rel);
    if (!fs.existsSync(p)) {
      bad++;
      out.push('  MISSING FILE: web/' + rel);
      continue;
    }
    sources.push({ label: 'web/' + rel, code: fs.readFileSync(p, 'utf8') });
  }
} else {
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) sources.push({ label: 'inline #' + (sources.length + 1), code: m[1] });
  out.push('inline <script> blocks: ' + sources.length);
}

// ---- 2. 语法（只解析，不调用）---------------------------------------------
out.push('');
out.push('语法检查:');
for (const s of sources) {
  try {
    new Function(s.code);
    out.push(`  ${s.label}: OK, ${s.code.split('\n').length} lines`);
  } catch (e) {
    bad++;
    out.push(`  ${s.label}: SYNTAX ERROR: ${e.message}`);
  }
}

// ---- 3. 样式表也要在 ------------------------------------------------------
out.push('');
out.push('样式:');
for (const m of html.matchAll(/<link[^>]*\bhref="([^"]+\.css)"/gi)) {
  const p = path.join(root, 'web', m[1]);
  const ok = fs.existsSync(p);
  if (!ok) bad++;
  out.push(`  web/${m[1]}: ${ok ? 'OK' : 'MISSING'}${ok ? ' (' + fs.statSync(p).size + ' B)' : ''}`);
}
if (!/<link[^>]*\.css/.test(html)) out.push('  (no external css link)');

// ---- 4. $("#id") 引用是否都有对应元素 -------------------------------------
const ids = new Set();
for (const m of html.matchAll(/id="([^"]+)"/g)) ids.add(m[1]);

const all = sources.map((s) => s.code).join('\n');
const refs = new Set();
for (const m of all.matchAll(/\$\('#([A-Za-z0-9_-]+)'\)/g)) refs.add(m[1]);
const missing = [...refs].filter((x) => !ids.has(x));

out.push('');
out.push(`$('#id') 引用数: ${refs.size}, 缺少对应元素: ${missing.length ? missing.join(', ') : '无'}`);
if (missing.length) bad++;

// ---- 5. 关键常量必须定义（历史踩过 PROTO_LAYOUT 未定义 -> ReferenceError）---
const constants = ['PROTO_LAYOUT', 'SW_KEY', 'PORT_LABEL', 'SCENE_OPTS', 'SCREEN_OPTS', 'LANG_OPTS', 'RANGES'];
out.push('');
out.push('常量定义检查:');
for (const c of constants) {
  const defined = new RegExp('\\b(?:const|let|var)\\s+' + c + '\\b').test(all);
  if (!defined) bad++;
  out.push(`  ${c}: ${defined ? 'defined' : 'MISSING'}`);
}

// ---- 6. 用电量「度 / 毫安」显示要成套 -------------------------------------
// 度数 = Wh / 1000，毫安 = Wh / 3.7 * 1000（3.7 V 电芯口径）。每格的副行 + 换算函数
// 必须同时在位，少一个界面上就少一个换算。离线数值回归另见 tools/test_kwh.js。
// （风扇那三格电量 fan-e-* 2026-10-11 已随"功率/电量"功能整体删除，所以这里不再钉它。）
const kwhIds = ['e-today-kwh', 'e-total-kwh', 'e-sess-kwh',
                'e-today-mah', 'e-total-mah', 'e-sess-mah'];
out.push('');
out.push('用电量换算（度 / 毫安）:');
for (const id of kwhIds) {
  const inHtml = ids.has(id);
  const inJs = new RegExp(`\\$\\('#${id}'\\)`).test(all);
  if (!inHtml || !inJs) bad++;
  out.push(`  #${id}: html=${inHtml ? 'OK' : 'MISSING'} js=${inJs ? 'OK' : 'MISSING'}`);
}
for (const fn of ['scaleFix', 'fmtKwh', 'mahFix', 'grp', 'fmtMah', 'CELL_V']) {
  const defined = new RegExp(`\\bconst\\s+${fn}\\b`).test(all);
  if (!defined) bad++;
  out.push(`  ${fn}: ${defined ? 'defined' : 'MISSING'}`);
}

// ---- 7. 「看温度 · 屏幕常亮」要成套 ---------------------------------------
// 温度读不到（蓝牙侧没有该属性），这个按钮只做「息屏时间=常亮 + 关空闲熄屏」。
// 少一样都会退化成「按了没用」：没有常量就写不进常亮档、没有 19 就可能被空闲熄屏黑掉。
out.push('');
out.push('看温度 · 屏幕常亮:');
const twNeed = [
  ['按钮 #btn-temp-watch 在 HTML 里', ids.has('btn-temp-watch')],
  ['按钮点击已接线', /\$\('#btn-temp-watch'\)\.onclick/.test(all)],
  ['SCREEN_ALWAYS_ON 常量', /\bconst\s+SCREEN_ALWAYS_ON\s*=\s*4\b/.test(all)],
  ['写息屏时间 piid 6', /action:\s*'set',\s*piid:\s*6/.test(all)],
  ['关空闲熄屏 piid 19', /action:\s*'set',\s*piid:\s*19/.test(all)],
  ['有还原用的原值变量', /\btempWatchPrev\b/.test(all)],
  ['界面写清温度在哪看', /核心温度/.test(html)],
];
for (const [label, ok] of twNeed) {
  if (!ok) bad++;
  out.push(`  ${label}: ${ok ? 'OK' : 'MISSING'}`);
}

const txt = out.join('\n') + (bad ? `\n\nRESULT: FAIL (${bad} problem(s))` : '\n\nRESULT: PASS');
fs.writeFileSync(path.join(root, 'tools', 'check_front.out.txt'), txt, 'utf8');
console.log(txt);
