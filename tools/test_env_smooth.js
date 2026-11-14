'use strict';
// 温湿度曲线「平滑开关」的离线回归 —— 不需要蓝牙、不需要起服务，只读 data/（不写）。
//
// 背景（2026-10-08 用户报「只平滑了湿度，温度没效果」）：
//   平滑只对**连续段**做（smoothValues 在段长 < 3 时原样返回）。而温度线原本会跳过
//   「小时带」那些行（本意是避免和带子重复画），短窗口里几乎每一行都是设备小时记录 →
//   全被置成 null → 一段都不够长 → 平滑等于没做。湿度不跳，所以只有湿度看起来变顺了。
//
// 这里把 app.js 里的三个纯函数抠出来独立求值，钉住：
//   ① 空档（null）处不跨着抹 —— 真断档不能被平滑连成假趋势；
//   ② 段长不足 3 点时不改动（这就是"平滑无效"的机理，写清楚免得再踩）；
//   ③ 真实数据下：跳过带子行几乎没有可平滑的连续段，不跳则平滑确实生效（总变差下降）；
//   ④ 源码接线：温度线在平滑开着时必须**不跳过**带子行，湿度线始终不跳。
//
// 用法: node tools/test_env_smooth.js
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'web', 'app.js'), 'utf8');

const out = [];
let bad = 0;
const check = (name, cond, extra) => {
  if (!cond) bad++;
  out.push((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '   — ' + extra : ''));
};

/** 从源码里按花括号配对切出一个 function 的完整定义（能处理嵌套）。 */
function extractFn(text, name) {
  const start = text.indexOf('function ' + name + '(');
  if (start < 0) return null;
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

const parts = ['smoothValues', 'envSeries', 'smoothSegments'].map((n) => extractFn(src, n));
check('三个函数都切出来了（smoothValues / envSeries / smoothSegments）',
  parts.every(Boolean), parts.map((p) => (p ? 'ok' : 'missing')).join('/'));
if (parts.some((p) => !p)) {
  const txt0 = out.join('\n') + '\n\nRESULT: FAIL (函数抠不出来，后面无从校验)\n';
  process.stdout.write(txt0);
  process.exit(1);
}
const F = new Function(parts.join('\n') + '\nreturn { smoothValues, envSeries, smoothSegments };')();

const tvOf = (a) => a.reduce((s, v, i) => (i && v != null && a[i - 1] != null ? s + Math.abs(v - a[i - 1]) : s), 0);
const longestRun = (vals) => {
  let best = 0, cur = 0;
  for (const v of vals) { if (v == null) cur = 0; else { cur += 1; if (cur > best) best = cur; } }
  return best;
};
const round2 = (a) => JSON.stringify(a.map((v) => (v == null ? null : +v.toFixed(2))));
const diffCount = (a, b) => {
  let n = 0;
  for (let i = 0; i < a.length; i++) if (Math.abs((a[i] || 0) - (b[i] || 0)) > 1e-6) n += 1;
  return n;
};

// ---- 1. 合成用例：平滑的基本性质 ------------------------------------------
const spiky = [10, 10, 30, 10, 10, 10];
const smSpiky = F.smoothSegments(spiky, 0.35);
check('孤立尖刺被压下去（3 点中值直接把它抹成邻居的高度）',
  smSpiky[2] < 30, '30 → ' + smSpiky[2].toFixed(2));
check('平滑后总变差下降（这才是"看起来更顺"的量化说法）',
  tvOf(smSpiky) < tvOf(spiky), tvOf(spiky).toFixed(1) + ' → ' + tvOf(smSpiky).toFixed(1));
check('不改动原数组（返回新数组）', JSON.stringify(spiky) === JSON.stringify([10, 10, 30, 10, 10, 10]));

const tiny = [20, null, null, 21, null, 22, null];
check('段长不足 3 点时不改动 —— 这次"温度平滑没效果"的机理就是这个',
  JSON.stringify(F.smoothSegments(tiny, 0.35)) === JSON.stringify(tiny), round2(F.smoothSegments(tiny, 0.35)));

const two = [10, 12, 14, null, 40, 42, 44];
const smTwo = F.smoothSegments(two, 0.35);
check('空档两侧各自平滑、不跨着抹（null 仍在原位、后段首点保持 40）',
  smTwo[3] === null && smTwo[4] === 40 && Math.abs(smTwo[2] - 14) > 1e-9,
  round2(smTwo));

// ---- 2. 取值规则：跳过带子行 ⇒ 值为 null ----------------------------------
const rowsSyn = [
  { at: 1000, t: 20, sp: 3600000 },
  { at: 2000, t: 21, sp: 3600000 },
  { at: 3000, t: 22, sp: 3600000 },
  { at: 4000, t: 23 },
];
const isRib = (r) => Number(r.sp) > 0;
check('envSeries(skipRibbon=true)：带子行取 null、其余取原值',
  JSON.stringify(F.envSeries(rowsSyn, (r) => r.t, true, isRib)) === JSON.stringify([null, null, null, 23]));
check('envSeries(skipRibbon=false)：全部取原值',
  JSON.stringify(F.envSeries(rowsSyn, (r) => r.t, false, isRib)) === JSON.stringify([20, 21, 22, 23]));
check('envSeries：坏值（null/NaN/缺字段）一律取 null，不会被当成 0℃',
  JSON.stringify(F.envSeries([{ t: null }, { t: NaN }, {}, { t: 25 }], (r) => r.t, false, isRib))
  === JSON.stringify([null, null, null, 25]));

// ---- 3. 真实数据：跳 / 不跳的差别 -----------------------------------------
// ⚠️ 2026-10-11 修：原来写死「取最近 26 小时」。设备小时记录（带 sp 的行）只在
// **读过设备历史**的那段时间才有；本机 90 秒采样一直在写，于是随着时间推移，
// 最近 26 小时里可能**一条 sp 都没有** → 那条"确实有设备小时记录"的断言就红了
// （而代码一点没坏）。这正是"断言别按当时的数据形态写死"的又一例。
// 改成：**以数据里最新一条 sp 行为锚**，取它前后各 13 小时当观察窗；窗口里没有 sp
// 就明确报 SKIP（而不是 FAIL）—— 测不了的事不该判成失败，但也不能悄悄放过。
let rows = [], anchorNote = '（没找到带 sp 的设备小时记录）';
try {
  const read = (p) => fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const dayDir = path.join(root, 'data', 'env-history');
  const all = [];
  if (fs.existsSync(dayDir)) {
    for (const f of fs.readdirSync(dayDir).sort().slice(-3)) {
      try { all.push(...read(path.join(dayDir, f))); } catch (_) {}
    }
  }
  const minFile = path.join(root, 'data', 'env-history-min.jsonl');
  if (fs.existsSync(minFile)) all.push(...read(minFile));
  const uniq = new Map();
  for (const r of all) if (r && Number.isFinite(r.at)) uniq.set(r.at, r);
  const list = [...uniq.values()].sort((a, b) => a.at - b.at);
  const spRows = list.filter((r) => Number(r.sp) > 0);
  if (spRows.length) {
    const anchor = spRows[spRows.length - 1].at;
    anchorNote = '（锚点 = 最新设备小时记录 ' + new Date(anchor).toLocaleString('zh-CN', { hour12: false }) + '）';
    const lo = anchor - 13 * 3600 * 1000, hi = anchor + 13 * 3600 * 1000;
    rows = list.filter((r) => r.at >= lo && r.at <= hi);
  } else {
    // 一条 sp 都没有：退化成"最早/最晚各取一段"，让其余断言仍能在真实数据上跑
    rows = list.slice(-400);
  }
} catch (_) { rows = []; }

if (rows.length >= 8) {
  const devCount = rows.filter((r) => Number(r.sp) > 0).length;
  const withSkip = F.envSeries(rows, (r) => r.t, true, isRib);
  const noSkip = F.envSeries(rows, (r) => r.t, false, isRib);
  if (devCount > 0) {
    check('真实数据：观察窗里确实有设备小时记录 ' + anchorNote, true,
      devCount + ' 条 / 共 ' + rows.length + ' 行');
  } else {
    // 窗口里一条 sp 都没有：这条**测不了**，明确报 SKIP。
    // 别改成 FAIL —— 「最近 26 小时内没有设备小时记录」是数据形态问题，不是代码坏了；
    // 也别删掉这条断言 —— 数据里一旦又有 sp，它就该继续把关。
    out.push('SKIP  真实数据里没有设备小时记录（' + anchorNote + '）→ 跳过带子行相关的断言');
  }
  // ⚠️ 判据要**确定性**：别写"被跳过的比例 > 30%" —— 本机采样（90 秒一条）比设备小时记录
  //    密得多，电脑连开几天后 sp 行只占一成，比例判据会误报（2026-10-08 踩过）。
  //    规则本身是确定的：跳过带子行 ⇒ 被跳过的行数 = 数据里带 sp 的行数。
  const spRows = rows.filter((r) => Number(r.sp) > 0).length;
  const skipped = withSkip.filter((v) => v == null).length;
  if (spRows > 0) {
    check('真实数据：跳过的行数 = 数据里带 sp 的行数（规则生效、不多不少）',
      skipped === spRows,
      skipped + ' 行被跳过 / sp 行 ' + spRows + ' / 共 ' + rows.length + ' 行');
  }
  check('真实数据：不跳时连续段够长（平滑才动得起来）',
    longestRun(noSkip) >= Math.max(3, rows.length - 2), '最长 ' + longestRun(noSkip) + ' / 共 ' + rows.length);

  const smT = F.smoothSegments(noSkip, 0.35);
  check('真实数据：温度平滑后确实有值被改动（开关对温度有效）',
    diffCount(smT, noSkip) > 0, diffCount(smT, noSkip) + ' / ' + rows.length + ' 个点变了');
  check('真实数据：温度平滑后总变差下降', tvOf(smT) < tvOf(noSkip),
    tvOf(noSkip).toFixed(2) + ' → ' + tvOf(smT).toFixed(2));

  const hVals = F.envSeries(rows, (r) => r.h, false, isRib);
  const smH = F.smoothSegments(hVals, 0.35);
  check('真实数据：湿度平滑后也有值被改动（两条线都动）',
    diffCount(smH, hVals) > 0, diffCount(smH, hVals) + ' 个点变了');
} else {
  out.push('SKIP  真实数据用例（data/ 里没有可用的温湿度记录）');
}

// ---- 4. 源码接线：参数传对了才有用 -----------------------------------------
check('app.js：温度线在平滑开着时不跳过带子行（skipRibbon: !envSmooth）',
  /if \(showT\) \{[\s\S]{0,240}skipRibbon: !envSmooth/.test(src));
check('app.js：湿度线始终不跳过带子行（它没有带子逻辑，那些点就是它唯一的点源）',
  /stroke\(YH[\s\S]{0,240}skipRibbon: false/.test(src));
check('app.js：温湿度两条线都用设备间隔阈值（gapMs: devGap）',
  (src.match(/gapMs: devGap/g) || []).length >= 3);

const txt = out.join('\n') + '\n\n' + (bad ? `RESULT: FAIL (${bad} 项失败)` : `RESULT: PASS (${out.length} 项)`) + '\n';
fs.writeFileSync(path.join(root, 'tools', 'test_env_smooth.out.txt'), txt, 'utf8');
process.stdout.write(txt);
process.exit(bad ? 1 : 0);
