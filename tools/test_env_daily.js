// 「按天看温湿度」的离线回归 —— 不需要蓝牙，也不需要起服务。
//
// server.js 里的 aggregateEnvDaily() 是纯函数（读 → 按本地自然日聚合），但那个文件
// 顶层 require 了一堆东西、还会起 HTTP 服务，Node 里不能直接 require。
// 所以这里按**花括号配对**把函数体抠出来单独求值（手法同 test_plug.js）。
//
// 为什么要单测它：
//   ① 分组必须按**本地日期**，不能按 UTC —— 否则北京时间 0~8 点的读数会掉到前一天；
//   ② 「今天」是没过完的一天，点数 n 必须如实反映它只有半天数据；
//   ③ 均值、当天最高/最低、点数三者必须自洽（均温一定落在最低~最高之间），
//      否则界面上的"阴影带"和"均值线"会互相打架；
//   ④ 缺湿度或坏行不能把整天的统计带崩。
//
// 用法: node tools/test_env_daily.js
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const appJs = fs.readFileSync(path.join(root, 'web', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'web', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'web', 'style.css'), 'utf8');

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
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

// ---- 1. 抠出 dayKey + aggregateEnvDaily ------------------------------------
const dayKeySrc = extractFn(src, 'dayKey');
const aggSrc = extractFn(src, 'aggregateEnvDaily');
check('能切出 dayKey 的函数体', !!dayKeySrc);
check('能切出 aggregateEnvDaily 的函数体', !!aggSrc, aggSrc ? aggSrc.split('\n').length + ' 行' : '未找到');

let F = null;
if (dayKeySrc && aggSrc) {
  try {
    // ⚠️ aggregateEnvDaily 现在用模块级的 envNum 判空（Number(null)===0 的坑），
    //    抠出来单独求值时必须把它一起带上，否则 ReferenceError。
    const numSrc = extractFn(src, 'envNum');
    check('能切出 envNum（aggregateEnvDaily 的判空依赖它）', !!numSrc);
    F = new Function(numSrc + '\n' + dayKeySrc + '\n' + aggSrc + '\nreturn { dayKey, aggregateEnvDaily };')();
    check('两个函数都能被求值', true);
  } catch (e) {
    check('两个函数都能被求值', false, e.message);
  }
}

const noonOf = (ms) => new Date(ms).setHours(12, 0, 0, 0);
const midnight = (y, m, d, hh, mm) => new Date(y, m - 1, d, hh, mm).getTime();

if (F) {
  // ---- 2. 单日聚合：均值 / 最高 / 最低 / 点数
  const A = F.aggregateEnvDaily([
    { at: midnight(2026, 10, 5, 1, 0), t: 10, h: 40 },
    { at: midnight(2026, 10, 5, 13, 0), t: 30, h: 60 },
    { at: midnight(2026, 10, 5, 20, 0), t: 20, h: 50 },
  ]);
  check('一天只出一条', A.length === 1, 'len=' + A.length);
  if (A.length === 1) {
    const d = A[0];
    check('日均温 = 20', d.t === 20, String(d.t));
    check('当日最低 / 最高 = 10 / 30', d.tmin === 10 && d.tmax === 30, d.tmin + '~' + d.tmax);
    check('日均湿 = 50、湿度区间 40~60', d.h === 50 && d.hmin === 40 && d.hmax === 60);
    check('点数 = 3', d.n === 3, String(d.n));
    check('day 是本地日期 2026-10-05', d.day === '2026-10-05', d.day);
    check('at 落在当天正午（画图时点在日子中段）', d.at === noonOf(d.at), new Date(d.at).toString());
  }

  // ---- 3. 跨日必须分开：本地日期分组（北京时间早上的读数不能掉到前一天）
  const B = F.aggregateEnvDaily([
    { at: midnight(2026, 10, 5, 23, 30), t: 18, h: 55 },
    { at: midnight(2026, 10, 6, 0, 30), t: 19, h: 56 },
    { at: midnight(2026, 10, 6, 8, 0), t: 25, h: 50 },
  ]);
  check('跨零点分成两天', B.length === 2, 'len=' + B.length);
  check('日期升序且无重复', B.every((r, i) => i === 0 || r.at > B[i - 1].at)
    && new Set(B.map((r) => r.day)).size === B.length);
  if (B.length === 2) {
    check('前一天只有 18℃ 那一条', B[0].t === 18 && B[0].n === 1, B[0].t + '/' + B[0].n);
    check('后一天 19 与 25 的均值 = 22', B[1].t === 22, String(B[1].t));
  }

  // ---- 4. 坏行 / 缺字段不能把整天的统计带崩
  const C = F.aggregateEnvDaily([
    { at: midnight(2026, 10, 5, 9, 0), t: 20, h: 50 },
    { at: midnight(2026, 10, 5, 10, 0), t: null, h: 52 },     // 只有湿度
    { at: midnight(2026, 10, 5, 11, 0), h: null },            // 只有时间
    { at: 'x', t: 99 },                                       // 坏行（at 不是数字）
    null,
  ]);
  check('坏行被丢掉，仍聚成一天', C.length === 1, 'len=' + C.length);
  if (C.length === 1) {
    check('缺温度的读数不参与温度统计', C[0].t === 20 && C[0].tmin === 20 && C[0].tmax === 20,
      C[0].t + ' / ' + C[0].tmin + '~' + C[0].tmax);
    check('湿度用的是有值的两条（50 / 52）', C[0].h === 51 && C[0].hmin === 50 && C[0].hmax === 52,
      C[0].h + ' / ' + C[0].hmin + '~' + C[0].hmax);
    check('点数如实 = 3（含只有时间的那条）', C[0].n === 3, String(C[0].n));
  }
  check('空输入返回空数组', F.aggregateEnvDaily([]).length === 0);

  // ---- 5. 拿真实数据跑：data/env-history-min.jsonl（设备历史回填的那份）
  let real = [];
  try {
    real = fs.readFileSync(path.join(root, 'data', 'env-history-min.jsonl'), 'utf8')
      .split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch (_) { return null; } })
      .filter((r) => r && typeof r.at === 'number');
  } catch (_) { real = []; }
  if (!real.length) {
    out.push('SKIP  真实数据用例（data/env-history-min.jsonl 不存在或为空）');
  } else {
    const D = F.aggregateEnvDaily(real);
    const distinct = new Set(real.map((r) => F.dayKey(r.at))).size;
    check('真实数据：天数 = 去重后的本地日期数', D.length === distinct, D.length + ' vs ' + distinct);
    check('真实数据：点数合计 = 输入行数', D.reduce((s, r) => s + r.n, 0) === real.length,
      D.reduce((s, r) => s + r.n, 0) + ' vs ' + real.length);
    check('真实数据：均温始终落在当天最低~最高之间',
      D.every((r) => r.t == null || (r.t >= r.tmin - 1e-9 && r.t <= r.tmax + 1e-9)));
    check('真实数据：均湿始终落在当天最低~最高之间',
      D.every((r) => r.h == null || (r.h >= r.hmin - 1e-9 && r.h <= r.hmax + 1e-9)));
    check('真实数据：at 都在当天正午', D.every((r) => r.at === noonOf(r.at)));
    check('真实数据：日期与 at 对得上', D.every((r) => F.dayKey(r.at) === r.day));
    check('真实数据：输出按时间升序', D.every((r, i) => i === 0 || r.at > D[i - 1].at));
    check('真实数据：不抽稀（按天本来就不超 400 点，抽稀会抹平最高/最低）',
      /daily \? aggregateEnvDaily\(inWin\) : downsampleEnv\(inWin, ENV_MAX_POINTS\)/.test(src));
    const span = D.length > 1 ? Math.round((D[D.length - 1].at - D[0].at) / 86400000) : 0;
    out.push('INFO  真实数据：' + D.length + ' 天（跨度 ' + span + ' 天），'
      + real.length + ' 条原始读数 → 一天一个点');
  }
}

// ---- 6. 前后端接线（静态断言）---------------------------------------------
check('路由支持 daily=1', /searchParams\.get\('daily'\) === '1'/.test(src)
  && /queryEnvHistory\(sec, \{ daily \}\)/.test(src));
check('server 返回体带 daily 标记', /daily,\n\s+rows,/.test(src));
check('前端请求带 daily=1', /envDaily \? '&daily=1' : ''/.test(appJs));
check('前端有「按天」按钮与明细表容器',
  /id="btn-env-daily"/.test(html) && /id="env-daily"/.test(html));
check('按钮点击切视图并落盘偏好', /btn-env-daily'\)\.onclick/.test(appJs)
  && /localStorage\.setItem\('cuk_env_daily'/.test(appJs));
check('曲线画了「当天最高~最低」阴影带', /rgba\(255,178,122,\.15\)/.test(appJs));
check('阴影带也按空档断段（缺几天不能横着连过去）',
  /segs\.push\(seg\)/.test(appJs) && /gapLimit/.test(appJs));
check('按天时不会往聚合行里插原始读数',
  /if \(envDaily\) \{/.test(appJs) && /pullEnvHistory\(\)\.then\(drawEnvChart\)/.test(appJs));
check('明细表只列最近若干天（长区间不至于把页面撑爆）',
  /MAX_DAILY_ROWS/.test(appJs) && /envRows\.slice\(-MAX_DAILY_ROWS\)/.test(appJs));
// 后端把这些天的 t/h 给成 null，前端如果写 Number.isFinite(Number(v)) 就会显示 0.0℃
check('明细表/悬停都不会把缺数据显示成 0（Number(null) 的坑，前端同样有）',
  (appJs.match(/const has = \(v\) => v !== null && v !== undefined/g) || []).length >= 2
  && !/n1 = \(v, d\) => \(Number\.isFinite\(Number\(v\)\)/.test(appJs));
check('表格样式存在（右对齐 + 等宽数字）', /\.env-daily th,\.env-daily td/.test(css));
check('温度窗口按自己的口径（不再借功率曲线的 WINDOW_SEC）',
  /function envWinSec/.test(appJs) && /const winSec = envWinSec\(\)/.test(appJs)
  // 只看 drawEnvChart 那一段（到 SERIES 为止）：后面 drawChart 用的是功率自己的窗口
  && (() => {
    const seg = appJs.slice(appJs.indexOf('function drawEnvChart'), appJs.indexOf('const SERIES'));
    return !/WINDOW_SEC \* 1000/.test(seg);
  })());

const txt = out.join('\n') + '\n\n' + (bad ? `RESULT: FAIL (${bad} 项失败)` : `RESULT: PASS (${out.length} 项)`) + '\n';
fs.writeFileSync(path.join(root, 'tools', 'test_env_daily.out.txt'), txt, 'utf8');
process.stdout.write(txt);
process.exit(bad ? 1 : 0);
