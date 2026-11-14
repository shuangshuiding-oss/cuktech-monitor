// 图表「防抖动」几个纯函数的离线测试：直接从 web/app.js 里抽出真实函数体跑断言，
// 不做副本（副本会跟实现漂移，测了等于没测）。
//
//   node tools\test_chart.js
//
// 结果写 %TEMP%\cuk_chart.txt。为什么测这几个：
//   1) 曲线"前后跳动"的一个来源是两条数据来源（SSE 增量 / 定时整份拉取）写同一个数组，
//      重合或乱序的点会让线往回缩一格 —— 由 mergeRow / setRows 负责去重与保序。
//   2) 另一个来源是 Y 轴量程随窗口里的峰值来回变 —— 由 yMaxFor 的滞后负责。
//   3) PPS 在相邻电压档之间抖，原始值天生是锯齿 —— 由 smoothValues 负责显示层平滑。
const fs = require('fs');
const path = require('path');

const APP = path.resolve(__dirname, '..');
const OUT = path.join(process.env.TEMP, 'cuk_chart.txt');
const src = fs.readFileSync(path.join(APP, 'web', 'app.js'), 'utf8');

/** 按名字从源码里剪出一个函数（用花括号配对，能处理嵌套）。 */
function cut(name) {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('找不到函数 ' + name);
  let j = src.indexOf('{', i);
  let depth = 0;
  for (let k = j; k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}') { depth--; if (depth === 0) return src.slice(i, k + 1); }
    else if (src[k] === '"' || src[k] === "'" || src[k] === '`') {   // 跳过字符串
      const q = src[k];
      k++;
      while (k < src.length && src[k] !== q) { if (src[k] === '\\') k++; k++; }
    }
  }
  throw new Error('函数 ' + name + ' 花括号不配对');
}

const budget = [];
const out = [];
const say = (m) => out.push(String(m));
function check(name, cond, extra) {
  const ok = !!cond;
  budget.push({ ok, name });
  say('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + name + (extra ? '   [' + extra + ']' : ''));
}

// 在受控作用域里求值真实函数：只提供它们真正用到的外部名字。
let fakeNow = 1000000;
const scope = {
  rows: [],
  hidden: {},
  localStorage: { getItem: () => null, setItem: () => {} },
  Date: { now: () => fakeNow },
  console,
};
const code = [cut('niceMax'), cut('yMaxFor'), cut('smoothValues'), cut('alphaForGap'), cut('mergeRow'), cut('setRows')].join('\n');
// yScale 是这些函数依赖的模块级状态，单独给一个。
const factory = new Function('scope', `
  const { Date, localStorage, hidden, console } = scope;
  let rows = scope.rows;
  const yScale = { max: 0, shrinkAt: 0 };
  ${code}
  return {
    get rows() { return rows; },
    set rows(v) { rows = v; },
    niceMax, yMaxFor, smoothValues, alphaForGap, mergeRow, setRows, yScale,
  };
`);
const api = factory(scope);

say('=== 1. mergeRow / setRows：去重与保序（曲线往回缩的根源）===');
api.rows = [];
check('第一个点能进', api.mergeRow({ at: 1000, total: 10 }) === true);
check('更晚的点能进', api.mergeRow({ at: 2000, total: 11 }) === true);
const lenBefore = api.rows.length;
check('同一时刻的点被覆盖、不新增', api.mergeRow({ at: 2000, total: 12 }) === false && api.rows.length === lenBefore,
  'len=' + api.rows.length);
check('同一时刻覆盖的是最新值', api.rows[api.rows.length - 1].total === 12, 'total=' + api.rows[api.rows.length - 1].total);
check('更早的点被丢弃（不会往回缩）', api.mergeRow({ at: 500, total: 9 }) === false && api.rows.length === lenBefore);
check('乱序输入下数组始终严格递增',
  api.rows.every((r, i) => i === 0 || r.at > api.rows[i - 1].at), JSON.stringify(api.rows.map((r) => r.at)));

const dupes = [{ at: 1, total: 1 }, { at: 2, total: 2 }, { at: 2, total: 22 }, { at: 3, total: 3 }];
const cleaned = api.setRows(dupes);
check('setRows 按时刻去重', cleaned.length === 3, 'len=' + cleaned.length);
check('setRows 保留后到的值', cleaned[1].total === 22, 'total=' + cleaned[1].total);

say('');
say('=== 2. smoothValues：压掉锯齿与单点毛刺 ===');
const pps = [13.2, 14.4, 13.2, 14.4, 13.2, 14.4, 13.2, 14.4];
const p2p = (a) => Math.max(...a) - Math.min(...a);
// 原始采样的平滑强度（间隔 ≤3s → α=0.2）
const rawAlpha = api.alphaForGap(500);
check('原始采样间隔取到强平滑系数', rawAlpha === 0.2, 'α=' + rawAlpha);
check('分钟级数据用轻度平滑', api.alphaForGap(60000) === 0.5, 'α=' + api.alphaForGap(60000));
check('更粗的数据不再叠加惯性', api.alphaForGap(300000) === 1, 'α=' + api.alphaForGap(300000));
check('原始信号确实是锯齿（前提成立）', p2p(pps) > 1, 'p2p=' + p2p(pps).toFixed(2));
// ⚠️ 必须测**稳态**：滤波器头几个点是暂态（从初始值爬向振荡中心），
//    拿整段（含暂态）算峰峰值会把衰减率严重低估 —— 第一次就是这么误判的。
const long = [];
for (let i = 0; i < 60; i++) long.push(i % 2 ? 14.4 : 13.2);
const longSm = api.smoothValues(long, rawAlpha);
const tail = (a) => a.slice(-20);
// 判据用两条，比"压掉百分之多少"更接近实际观感：
//   1) 至少压掉 7 成（α=0.2 实测 8 成）；
//   2) 残余抖动要小于 0.3W —— 这已经低于设备自己 0.1V 量化档造成的读数台阶（≈0.12W）
//      再叠加一层，屏幕上就是一条干净的线，而不是来回抽的锯齿。
check('稳态峰峰值至少压掉 7 成', p2p(tail(longSm)) < p2p(tail(long)) * 0.3,
  '平滑后 p2p=' + p2p(tail(longSm)).toFixed(3) + ' / 原始 ' + p2p(tail(long)).toFixed(2));
check('残余抖动 < 0.3W（视觉上不可见）', p2p(tail(longSm)) < 0.3,
  '残余=' + p2p(tail(longSm)).toFixed(3) + 'W');
check('平滑后仍围绕真实中值（没有被拉偏）',
  Math.abs(tail(longSm).reduce((a, b) => a + b, 0) / 20 - 13.8) < 0.05,
  '均值=' + (tail(longSm).reduce((a, b) => a + b, 0) / 20).toFixed(3));
const spike = [10, 10, 30, 10, 10];
const ss = api.smoothValues(spike, rawAlpha);
check('单点毛刺被中值滤波压掉', ss[2] < 15, '峰值处平滑值=' + ss[2].toFixed(2));
check('长度不变（与 rows 一一对应）', ss.length === spike.length);
const flat = [5, 5, 5, 5, 5];
check('恒定信号不被改形', api.smoothValues(flat, rawAlpha).every((v) => Math.abs(v - 5) < 1e-9));
check('少于 3 点直接原样返回', api.smoothValues([1, 2], rawAlpha).length === 2);
// 代价要可见：阶跃响应别拖太久（0.5s 一个点，2 秒内应走过大半）
const step = [0, 0, 0, 10, 10, 10, 10, 10, 10];
const st = api.smoothValues(step, rawAlpha);
check('阶跃 2 秒内走到 55% 以上（响应不至于拖沓）', st[6] > 5.5, '4 个点后=' + st[6].toFixed(2));

say('');
say('=== 3. yMaxFor：量程有滞后（尖峰滑出窗口时曲线才不会整条弹跳）===');
const y1 = api.yMaxFor(api.niceMax(15 * 1.12));
check('首次给出量程', y1 >= 20, 'yMax=' + y1);
const yBig = api.yMaxFor(api.niceMax(180 * 1.12));
check('变大立刻生效（不能切掉尖峰）', yBig >= 200, 'yMax=' + yBig);
const yStay = api.yMaxFor(api.niceMax(15 * 1.12));
check('刚变小不会立刻缩（滞后生效）', yStay >= 200, 'yMax=' + yStay);
fakeNow += 5000;          // 5 秒后
const yShrunk = api.yMaxFor(api.niceMax(15 * 1.12));
check('过了滞后期确实缩回去了', yShrunk <= 40, 'yMax=' + yShrunk);
check('niceMax 取整到整齐刻度', api.niceMax(15.2) === 20 && api.niceMax(0.5) === 5,
  api.niceMax(15.2) + ',' + api.niceMax(0.5));

const fails = budget.filter((b) => !b.ok).length;
say('');
say('共 ' + budget.length + ' 项断言，失败 ' + fails + ' 项');
const txt = out.join('\n');
fs.writeFileSync(OUT, txt, 'utf8');
console.log(txt);
process.exitCode = fails ? 1 : 0;
