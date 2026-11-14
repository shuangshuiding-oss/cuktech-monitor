// 解析最近一份界面自测报告（由 tools\uitest.ps1 触发页面回传，落在 data\selftest.log）。
//
//   node tools\uitest.js
//
// 结果写 %TEMP%\cuk_uitest.txt。为什么需要它：脚本运行时抛错会让页面「冻在初始态」，
// `node --check` 看不出这类问题（2026-09-22 连踩两次：一次是未定义函数、一次是
// 未声明变量，症状都是"界面停在初始态 / 点了没反应"）。
const fs = require('fs');
const path = require('path');

const APP = path.resolve(__dirname, '..');
const LOG = path.join(APP, 'data', 'selftest.log');
const OUT = path.join(process.env.TEMP, 'cuk_uitest.txt');

const out = [];
const say = (m) => out.push(String(m));

if (!fs.existsSync(LOG)) {
  say('没有 data\\selftest.log —— 还没跑过界面自测（先执行 tools\\uitest.ps1）。');
  finish(1);
}

const txt = fs.readFileSync(LOG, 'utf8');
const blocks = txt.split(/^===== /m).filter((b) => b.trim());
const last = blocks[blocks.length - 1] || '';
const lines = last.split('\n').map((l) => l.trim()).filter(Boolean);
say('报告份数=' + blocks.length + '，下面是最后一份：');
say('');
for (const l of lines) say('  ' + l);
const fails = lines.filter((l) => l.startsWith('FAIL')).length;
const passes = lines.filter((l) => l.startsWith('PASS')).length;
say('');
say('PASS=' + passes + '  FAIL=' + fails);
say(fails ? '界面自测有失败项' : '界面自测全部通过');
finish(fails ? 1 : 0);

function finish(code) {
  const s = out.join('\n');
  fs.writeFileSync(OUT, s, 'utf8');
  console.log(s);
  process.exitCode = code;
}
