// 每口插拔记账的离线回归 —— 不需要蓝牙，也不需要起服务。
//
// server.js 里的 plugStep() 是整套记账的状态机（纯函数），但那个文件顶层就 require
// 了一堆东西、还会起 HTTP 服务，Node 里不能直接 require。所以这里按**花括号配对**
// 把函数体抠出来单独求值，再喂各种采样序列进去。
//
// 为什么要单测它：这套逻辑最容易错的就是"抖动"——接触不良时端口字的在用位会闪断一两帧，
// 如果闪断就结算，一次充电会被切成一堆碎记录，**而且每碎一次都从新的 whAtStart 起算，
// 电量会越切越少**（静默算少，界面上还看不出来）。用例 B 就是钉这条。
//
// 用法: node tools/test_plug.js
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

// ---- 1. 抠出常量与 plugStep ------------------------------------------------
const constNames = ['PLUG_KEEP', 'PLUG_IDLE_MS', 'PLUG_MIN_MS'];
const srcs = [];
for (const n of constNames) {
  const m = src.match(new RegExp('^const\\s+' + n + '\\s*=[^\\n]*;', 'm'));
  if (!m) check(`server.js 里能找到 ${n}`, false);
  else srcs.push(m[0]);
}
check('三个常量都找到了', srcs.length === constNames.length, srcs.length + '/' + constNames.length);

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

const fnSrc = extractFn(src, 'plugStep');
check('能切出 plugStep 的函数体', !!fnSrc, fnSrc ? fnSrc.split('\n').length + ' 行' : '未找到');

let S = null;
if (fnSrc && srcs.length === constNames.length) {
  try {
    S = new Function(srcs.join('\n') + '\n' + fnSrc
      + '\nreturn { PLUG_KEEP, PLUG_IDLE_MS, PLUG_MIN_MS, plugStep };')();
    check('plugStep 能被求值', true);
  } catch (e) {
    check('plugStep 能被求值', false, e.message);
  }
}

// ---- 2. 用例 ---------------------------------------------------------------
/** 模拟 trackPlug 的喂样本动作：维护 open 与已结算列表。 */
function mk() {
  return { open: null, closed: [] };
}
function feed(st, inUse, wh, at, port) {
  const r = S.plugStep(st.open, inUse, wh, at, port || { w: 0 });
  st.open = r.open;
  if (r.closed) st.closed.push(r.closed);
  return r;
}

if (S) {
  const T = 1_800_000_000_000;   // 任意基准时刻（毫秒）

  // A. 一次完整的插拔：插 → 充 → 功率掉 0（还插着）→ 拔 → 结算
  {
    const st = mk();
    feed(st, true, 10, T, { w: 20, proto_text: 'PD', cap: 30 });
    check('A 插入后有了进行中的记录', !!st.open && st.open.since === T);
    check('A 起点电量被记住', st.open && st.open.whAtStart === 10);
    feed(st, true, 12, T + 1000, { w: 25 });
    check('A 峰值跟着涨', st.open && st.open.peak === 25);
    feed(st, true, 15.5, T + 2000, { w: 0 });           // 充饱，功率 0 但还在用
    check('A 充饱不算拔出（在用位仍为 1）', !!st.open && st.closed.length === 0);
    feed(st, false, 15.5, T + 4000);                     // 拔线第一帧
    check('A 第一帧不立刻结算（先去抖）', !!st.open && st.closed.length === 0);
    feed(st, false, 15.5, T + 9000);                     // 过了 5 秒空闲
    check('A 空闲够久后结算出 1 条', st.closed.length === 1, 'closed=' + st.closed.length);
    const c = st.closed[0];
    if (c) {
      check('A 电量 = 拔出时累计 − 插入时累计', c.wh === 5.5, 'wh=' + c.wh);
      check('A 时长 = 空闲起点 − 插入时刻', c.ms === 4000, 'ms=' + c.ms);
      check('A 结束时刻取"第一次看到不在用"', c.end === T + 4000, 'end-T=' + (c.end - T));
      check('A 峰值保留', c.peak === 25, 'peak=' + c.peak);
      check('A 协议与协商功率保留', c.proto === 'PD' && c.cap === 30, c.proto + '/' + c.cap);
    }
    check('A 结算后进行中记录被清掉', st.open === null);
  }

  // B. 抖动不能把一次充电切成好几段（关键回归）
  {
    const st = mk();
    feed(st, true, 0, T, { w: 20 });
    feed(st, true, 1, T + 1000, { w: 20 });
    feed(st, false, 1.2, T + 2000);                      // 闪断一帧
    feed(st, true, 1.3, T + 2500, { w: 18 });            // 马上又回来了 → 取消待结算
    check('B 闪断后没有结算', st.closed.length === 0, 'closed=' + st.closed.length);
    check('B 待结算标记被清掉', st.open && st.open.idleAt === 0, 'idleAt=' + (st.open && st.open.idleAt));
    check('B 起点没被重置（还是最初那次插入）', st.open && st.open.since === T);
    feed(st, true, 4, T + 6000, { w: 20 });
    feed(st, false, 4, T + 6500);
    feed(st, false, 4, T + 12000);
    check('B 整段只结算 1 条', st.closed.length === 1, 'closed=' + st.closed.length);
    const c = st.closed[0];
    if (c) {
      check('B 电量是完整的 4 Wh（没有被切碎算少）', c.wh === 4, 'wh=' + c.wh);
      check('B 时长覆盖整段（含闪断前那 2 秒）', c.ms === 6500, 'ms=' + c.ms);
    }
  }

  // C. 充饱后一直插着（功率 0）不算拔出
  {
    const st = mk();
    feed(st, true, 0, T, { w: 30 });
    for (let k = 1; k <= 60; k++) feed(st, true, 10, T + k * 1000, { w: 0 });
    check('C 插着但 0 功率，一分钟也没结算', st.closed.length === 0 && !!st.open);
    check('C 记录起点仍是插入那一刻', st.open && st.open.since === T);
  }

  // D. 累计值被重置（换天/删文件）时电量不会算成负数
  {
    const st = mk();
    feed(st, true, 100, T, { w: 20 });
    feed(st, false, 98, T + 1000);
    feed(st, false, 98, T + 8000);
    check('D 负增量被夹到 0（不会记成 -2 Wh）', st.closed.length === 1 && st.closed[0].wh === 0,
      st.closed.length ? 'wh=' + st.closed[0].wh : 'no closed');
  }

  // E. 一直空着什么都不产生
  {
    const st = mk();
    for (let k = 0; k < 10; k++) feed(st, false, 0, T + k * 1000);
    check('E 空口不产生任何记录', st.closed.length === 0 && st.open === null);
  }

  // F. 连续两次插拔各自独立
  {
    const st = mk();
    feed(st, true, 0, T, { w: 10 });
    feed(st, false, 2, T + 2000);
    feed(st, false, 2, T + 8000);                       // 第 1 条结算：wh=2
    feed(st, true, 3, T + 9000, { w: 10 });             // 第 2 次插入
    feed(st, true, 9, T + 15000, { w: 12 });
    feed(st, false, 9, T + 16000);
    feed(st, false, 9, T + 22000);                      // 第 2 条结算：wh=6
    check('F 两次插拔各自一条', st.closed.length === 2, 'closed=' + st.closed.length);
    if (st.closed.length === 2) {
      check('F 第一条电量 2 Wh', st.closed[0].wh === 2, 'wh=' + st.closed[0].wh);
      check('F 第二条电量 6 Wh（起点重新取）', st.closed[1].wh === 6, 'wh=' + st.closed[1].wh);
      check('F 两条的起点不同', st.closed[0].start !== st.closed[1].start);
    }
  }

  // G. 协议在插入后升档（PPS 会爬）—— 记录应留下后面的值
  {
    const st = mk();
    feed(st, true, 0, T, { w: 5, proto_text: 'PD', cap: 15 });
    feed(st, true, 1, T + 3000, { w: 45, proto_text: 'PPS', cap: 45 });
    feed(st, false, 1, T + 4000);
    feed(st, false, 1, T + 10000);
    const c = st.closed[0];
    check('G 协议/协商功率取到升档后的值', c && c.proto === 'PPS' && c.cap === 45,
      c ? c.proto + '/' + c.cap : 'no closed');
    check('G 峰值取到最大功率', c && c.peak === 45, c ? 'peak=' + c.peak : '');
  }

  // H. 去抖窗口是常量说了算（改常量就该跟着变）
  {
    check('H PLUG_IDLE_MS 是 5000', S.PLUG_IDLE_MS === 5000, String(S.PLUG_IDLE_MS));
    check('H PLUG_MIN_MS 是 3000', S.PLUG_MIN_MS === 3000, String(S.PLUG_MIN_MS));
    check('H PLUG_KEEP 是 300', S.PLUG_KEEP === 300, String(S.PLUG_KEEP));
    const st = mk();
    feed(st, true, 0, T, { w: 10 });
    feed(st, false, 1, T + 1000);
    feed(st, false, 1, T + 1000 + S.PLUG_IDLE_MS - 1);
    check('H 差 1 毫秒不算拔出', st.closed.length === 0);
    feed(st, false, 1, T + 1000 + S.PLUG_IDLE_MS + 1);
    check('H 到点才算拔出', st.closed.length === 1);
  }
}

// ---- 3. 接线：这几处必须都装上 ------------------------------------------
check('server.js 有 trackPlug', /function\s+trackPlug\s*\(/.test(src));
check('pushHistory 里每帧都喂 trackPlug', /trackPortCharge\(row\);\s*\n\s*trackPlug\(s,\s*row\);/.test(src));
check('只记登记过的口（防脏数据撑大文件）', /if\s*\(!PORT_LABEL\[id\]\)\s*continue;/.test(src));
check('太短的接触被过滤掉', /r\.closed\.ms\s*<\s*PLUG_MIN_MS/.test(src));
check('结算后写进 energy.plugs', /energy\.plugs\.push\(/.test(src));
check('energy.plugs 有上限裁剪', /energy\.plugs\.slice\(-PLUG_KEEP\)/.test(src));
check('emptyEnergy 里有 plugs: []', /sessions:\s*\[\],\s*\n\s*plugs:\s*\[\],/.test(src));
check('loadEnergy 会恢复 plugs', /energy\.plugs\s*=\s*Array\.isArray\(raw\.plugs\)/.test(src));
check('/api/energy 下发 plugs', /plugs:\s*energy\.plugs\.slice\(-40\)\.reverse\(\)/.test(src));
check('/api/energy 下发 plugsLive（正在充的那几次）', /plugsLive:\s*PORTS\.filter/.test(src));
check('拔掉时推一条通知（带度/mAh）', /addNotice\('plug'/.test(src));
check('CSV 支持 what=plugs', /what\s*===\s*'plugs'/.test(src));
check('CSV 里有度数与 mAh 两列', /round3\(g\.wh \/ 1000\), Math\.round\(\(g\.wh \/ CELL_V\) \* 1000\)/.test(src));

check('index.html 有 #e-plugs', html.indexOf('id="e-plugs"') >= 0);
check('app.js 渲染 #e-plugs', appJs.indexOf("$('#e-plugs').innerHTML") >= 0);
check('界面里插拔记录也给三种单位',
  appJs.includes('${fmtKwh(g.wh)} 度') && appJs.includes('${fmtMah(g.wh)} mAh'));
check('界面里保留了 Wh 原值', /\$\{Number\(g\.wh \|\| 0\)\.toFixed\(3\)\} Wh/.test(appJs));
check('界面有「充电中」标签', /class="live"/.test(appJs) && /\.kv b\.live\{/.test(
  fs.readFileSync(path.join(root, 'web', 'style.css'), 'utf8')));
check('导出按钮里有插拔记录', /data-export="plugs"/.test(html));

// 4 个端口卡里的那行「本次充电」（2026-09-22 追加：用户要“下次充电刷新”的那个数）
check('端口卡里有「本次充电」一行', /plugLine\(p\)/.test(appJs) && /本次充电/.test(appJs));
check('端口卡优先显示正在充的那次（实时值）',
  /const lv = \(E\.plugsLive \|\| \[\]\)\.find\(\(g\) => g\.id === p\.id\)/.test(appJs));
check('不在充电就显示最近一次插拔的结算值',
  /const rec = lv \|\| \(E\.plugs \|\| \[\]\)\.find/.test(appJs));
check('端口卡那行也给度与 mAh',
  appJs.includes('${fmtKwh(wh)} 度 · ${fmtMah(wh)} mAh'));
check('端口卡那行保留 Wh 原值', /\$\{whTxt\} Wh/.test(appJs));
check('没有记录时有个干净的占位', /还没有记录/.test(appJs));
check('energy 拉回来时记下 lastEnergy', /lastEnergy = e;/.test(appJs));
check('energy 刷新后重画端口卡', /renderPorts\(last\.latest\.ports\)/.test(appJs));
check('样式里有 .live-dot', /\.port \.cap i\.live-dot\{/.test(css));

// 「本次充电」旁的时长（2026-09-23 追加：用户要“本次充了多久”）。
// fmtDur 是单行 const，和 test_kwh.js 一样按行抠出来求值。
const durM = appJs.match(/^const\s+fmtDur\s*=.*$/m);
check('app.js 里有单行 fmtDur 声明', !!durM);
let dur = null;
try {
  dur = new Function(durM ? durM[0] + '\nreturn fmtDur;' : '')();
} catch (_) { dur = null; }
check('fmtDur 能被求值', typeof dur === 'function');
if (typeof dur === 'function') {
  check('fmtDur(0) = 0 秒', dur(0) === '0 秒', dur(0));
  check('fmtDur(null) = 0 秒', dur(null) === '0 秒', dur(null));
  check('fmtDur(45000) = 45 秒（不足 1 分）', dur(45000) === '45 秒', dur(45000));
  check('fmtDur(60000) = 1 分', dur(60000) === '1 分', dur(60000));
  check('fmtDur(754000) = 12 分（分钟级不带秒，卡片放得下）', dur(754000) === '12 分', dur(754000));
  check('fmtDur(3600000) = 1 小时 0 分', dur(3600000) === '1 小时 0 分', dur(3600000));
  check('fmtDur(5700000) = 1 小时 35 分', dur(5700000) === '1 小时 35 分', dur(5700000));
  check('fmtDur 负值夹到 0', dur(-5) === '0 秒', dur(-5));
}
check('端口卡电量旁边带时长（Wh · 时长）', /\$\{whTxt\} Wh`\s*\n?\s*\+ ` <span class="mute">· \$\{dur\}<\/span>`/.test(appJs));
check('在充的按时长现算（起点到现在，每秒都在跳）',
  /Math\.max\(rec\.ms \|\| 0, Date\.now\(\) - rec\.start\)/.test(appJs));
check('已结算的用记录里的 ms', /: \(rec\.ms \|\| 0\)/.test(appJs));
check('插拔记录/会话/用电标签也用 fmtDur（不再有粗粒度 N 分）',
  (appJs.match(/fmtDur\(/g) || []).length === 4
  && !/Math\.max\(1, Math\.round\([csg]\.ms \/ 60000\)\)/.test(appJs),
  'fmtDur 调用 ' + (appJs.match(/fmtDur\(/g) || []).length + ' 处（端口卡/用电标签/会话/插拔记录）');

// 曲线空档补零（2026-09-23 追加：用户要“没有数据的地方画 0，不是斜线”）。
// fillGaps 是多行 function，按花括号配对抠出来求值。
const fgSrc = extractFn(appJs, 'fillGaps');
check('app.js 里能切出 fillGaps 函数体', !!fgSrc, fgSrc ? fgSrc.split('\n').length + ' 行' : '未找到');
let FG = null;
try { FG = new Function(fgSrc + '\nreturn fillGaps;')(); check('fillGaps 能被求值', typeof FG === 'function'); }
catch (e) { check('fillGaps 能被求值', false, e.message); }
if (typeof FG === 'function') {
  const mkRow = (at, total) => ({ at, total: total || 0, peak: total || 0, w: {} });
  // 常规数据：60s 一行（每分钟口径），没有空档 → 原样返回
  const norm = []; for (let i = 0; i < 20; i++) norm.push(mkRow(i * 60000, 5));
  check('无空档时不插任何点', FG(norm).length === norm.length, FG(norm).length + '/' + norm.length);
  // 每分钟口径：中位数 60s → 阈值 max(240s, 90s) = 4 分钟；中间空 2 小时 → 应补零
  const g1 = [mkRow(0, 10), mkRow(60000, 8), mkRow(60000 + 7200000, 6), mkRow(60000 * 2 + 7200000, 4)];
  const f1 = FG(g1);
  check('空档被补成 6 个点（4 真 + 2 零）', f1.length === 6, 'len=' + f1.length);
  const z = f1.filter((r) => r.total === 0 && r.peak === 0);   // 注意不能写 !r.at —— at:0 是合法时间戳
  check('补的是 0 值点', z.length === 2 && z.every((r) => r.total === 0 && r.peak === 0));
  check('零点在空档两端（前点之后、后点之前）',
    z[0].at > g1[1].at && z[0].at < g1[2].at && z[1].at > g1[1].at && z[1].at < g1[2].at);
  check('零点保序', f1.every((r, i) => i === 0 || r.at > f1[i - 1].at));
  check('零点让曲线先掉零再抬升（前后真值不受影响）',
    f1[0].total === 10 && f1[1].total === 8 && f1[4].total === 6 && f1[5].total === 4);
  // 原始采样口径：1.5s 一行 → 中位数 1.5s → 阈值 90s；空 5 分钟 → 补零
  const g2 = [mkRow(0, 3), mkRow(1500, 3), mkRow(1500 + 300000, 3)];
  check('原始采样下 5 分钟空档也补零', FG(g2).length === 5, 'len=' + FG(g2).length);
  // 空档不足阈值（60s 口径下丢 2 分钟）→ 直接连线，不补
  const g3 = [mkRow(0, 3), mkRow(180000, 3)];
  check('小于阈值的短丢点仍直接连线', FG(g3).length === 2);
  // 少于 2 个点原样返回
  check('单点/空列表不炸', FG([]).length === 0 && FG([mkRow(0, 1)]).length === 1);
  check('画图与悬停都走补零列表', (appJs.match(/fillGaps\(rows\)/g) || []).length === 2);
}

const txt = out.join('\n') + '\n\n' + (bad ? `RESULT: FAIL (${bad} 项失败)` : `RESULT: PASS (${out.length} 项)`) + '\n';
fs.writeFileSync(path.join(root, 'tools', 'test_plug.out.txt'), txt, 'utf8');
process.stdout.write(txt);
process.exit(bad ? 1 : 0);
