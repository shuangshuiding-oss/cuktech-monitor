// 后端「曲线取数」两个纯函数的离线测试：直接从 server.js 里抽真实函数/常量来跑，
// 不留副本（副本会跟实现漂移，测了等于没测）。
//
//   node tools\test_server_hist.js
//
// 结果写 %TEMP%\cuk_hist.txt。为什么测这两个：
//   1) downsample 是「后端把任何区间都压到 CHART_MAX_POINTS 以内」的唯一执行者。
//      2026-09-22 发现 ≤1h 那条分支**漏掉了这一步**：0.5s 采样下选「1 小时」会一次
//      下发 7200 个点（≈600KB JSON），区间切换明显发卡，而且和说明书里写的不一致。
//   2) historyMax 决定内存里留多少原始点。原来写死 3600 —— 那是按 1.5s 采样算的
//      「90 分钟」，间隔一旦调到 0.5s 就只剩 30 分钟，「1 小时」区间左半张永远空着。
const fs = require('fs');
const path = require('path');

const APP = path.resolve(__dirname, '..');
const OUT = path.join(process.env.TEMP, 'cuk_hist.txt');
const src = fs.readFileSync(path.join(APP, 'server.js'), 'utf8');

/** 按名字剪出一个函数（花括号配对，能处理嵌套与字符串）。 */
function cut(name) {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('找不到函数 ' + name);
  const j = src.indexOf('{', i);
  let depth = 0;
  for (let k = j; k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}') { depth--; if (depth === 0) return src.slice(i, k + 1); }
    else if (src[k] === '"' || src[k] === "'" || src[k] === '`') {
      const q = src[k];
      k++;
      while (k < src.length && src[k] !== q) { if (src[k] === '\\') k++; k++; }
    }
  }
  throw new Error('函数 ' + name + ' 花括号不配对');
}

/** 剪出一个 const 声明：对象/数组用花括号配对，标量取到第一个分号。 */
function cutConst(name) {
  const re = new RegExp('^const\\s+' + name + '\\s*=\\s*', 'm');
  const m = re.exec(src);
  if (!m) throw new Error('找不到常量 ' + name);
  const start = m.index;
  const bodyAt = m.index + m[0].length;
  const open = '{[';
  if (open.includes(src[bodyAt])) {
    const close = src[bodyAt] === '{' ? '}' : ']';
    let depth = 0;
    for (let k = bodyAt; k < src.length; k++) {
      if (src[k] === src[bodyAt]) depth++;
      else if (src[k] === close) { depth--; if (depth === 0) return src.slice(start, k + 2); }
    }
    throw new Error('常量 ' + name + ' 括号不配对');
  }
  const semi = src.indexOf(';', bodyAt);
  if (semi < 0) throw new Error('常量 ' + name + ' 缺分号');
  return src.slice(start, semi + 1);
}

const budget = [];
const out = [];
const say = (m) => out.push(String(m));
function check(name, cond, extra) {
  const ok = !!cond;
  budget.push({ ok, name });
  say('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + name + (extra ? '   [' + extra + ']' : ''));
}

const consts = [
  cutConst('PORTS'), cutConst('round3'), cutConst('zeroPorts'),
  cutConst('CHART_MAX_POINTS'), cutConst('HISTORY_RANGES'),
  cutConst('HISTORY_MAX_MIN'), cutConst('HISTORY_MAX_CAP'),
].join('\n');
const code = [cut('historyMax'), cut('downsample'), cut('queryHistory'), cut('seedHistory'),
  cut('minRowsClean'), cut('flushMinute')].join('\n');

let fakeNow = 1800000000000;
const scope = { console, Date: { now: () => fakeNow }, config: { interval: 1.5 }, state: { history: [] }, minRows: [], files: {} };
const factory = new Function('scope', `
  const { Date, console } = scope;
  ${consts}
  let config = scope.config;
  let state = scope.state;
  let minBucket = null;
  const HIST_MIN = 'min';
  const readMinRows = () => scope.minRows;
  const parseRows = (f) => (Array.isArray(scope.files[f]) ? scope.files[f].map((r) => Object.assign({}, r)) : []);
  const histDayPath = (ts) => 'day' + Math.floor(ts / 86400000);
  // seedHistory / flushMinute 的文件系统依赖：一个只认 scope.files 的假 fs。
  const fs = {
    existsSync: (f) => Array.isArray(scope.files[f]),
    appendFileSync: (f, txt) => {
      const cur = scope.files[f] || (scope.files[f] = []);
      for (const l of String(txt).split(/\\r?\\n/)) if (l) cur.push(JSON.parse(l));
    },
    writeFileSync: (f, txt) => {
      const out = [];
      for (const l of String(txt).split(/\\r?\\n/)) if (l) out.push(JSON.parse(l));
      scope.files[f] = out;
    },
  };
  ${code}
  return {
    setConfig: (c) => { config = c; scope.config = c; },
    setState: (s) => { state = s; scope.state = s; },
    setBucket: (b) => { minBucket = b; },
    bucket: () => minBucket,
    config: () => config,
    state: () => state,
    historyMax, downsample, queryHistory, seedHistory, minRowsClean, flushMinute,
    HISTORY_RANGES, CHART_MAX_POINTS, HIST_MIN,
  };
`);
const api = factory(scope);

// ---------------------------------------------------------------- 1. downsample
say('=== 1. downsample：把任意长的点列压到 CHART_MAX_POINTS 以内 ===');
const maxP = api.CHART_MAX_POINTS;
say('  (CHART_MAX_POINTS = ' + maxP + ')');

const raw7200 = [];
for (let i = 0; i < 7200; i++) raw7200.push({ at: 1800000000000 + i * 500, total: 10 + (i % 7), w: { c1: 1, c2: 2, c3: 3, a: 4 } });

const few = raw7200.slice(0, 120);
check('点数不超过上限时原样返回（短窗保真）', api.downsample(few, maxP).length === 120,
  'len=' + api.downsample(few, maxP).length);
check('原样返回时是同一个数组引用（没有多余拷贝）', api.downsample(few, maxP) === few);

const ds = api.downsample(raw7200, maxP);
check('7200 点被压到上限以内', ds.length <= maxP, 'len=' + ds.length);
check('压缩比足够大（>10 倍）', raw7200.length / ds.length > 10, 'x' + (raw7200.length / ds.length).toFixed(1));
check('末尾点的时间戳保留（曲线右边界靠它）', ds[ds.length - 1].at === raw7200[raw7200.length - 1].at,
  'at=' + ds[ds.length - 1].at);
check('n 字段加起来等于原始点数（没漏没重）',
  ds.reduce((a, r) => a + r.n, 0) === raw7200.length, 'sum n=' + ds.reduce((a, r) => a + r.n, 0));
check('at 严格递增（前端按序画线）', ds.every((r, i) => i === 0 || r.at > ds[i - 1].at));

const flat = [];
for (let i = 0; i < 5000; i++) flat.push({ at: 1800000000000 + i * 1000, total: 42, w: { c1: 42, c2: 0, c3: 0, a: 0 }, peak: 42 });
const fds = api.downsample(flat, maxP);
check('恒定信号压缩后仍是原值（均值没算错）', fds.every((r) => Math.abs(r.total - 42) < 1e-9), 'first=' + fds[0].total);

const spiky = [];
for (let i = 0; i < 3000; i++) spiky.push({ at: 1800000000000 + i * 1000, total: 5, w: { c1: 5, c2: 0, c3: 0, a: 0 }, peak: i === 1500 ? 240 : 5 });
const sds = api.downsample(spiky, maxP);
check('组内峰值被保留（尖峰不会被均值抹掉）', Math.max(...sds.map((r) => r.peak)) === 240,
  'maxPeak=' + Math.max(...sds.map((r) => r.peak)));

// ---------------------------------------------------------------- 2. historyMax
say('');
say('=== 2. historyMax：内存上限必须覆盖整整 1 小时 ===');
const ranges = api.HISTORY_RANGES;
say('  (HISTORY_RANGES[\'1h\'] = ' + ranges['1h'] + 's；/api/config 只允许 interval 在 0.5~10s)');

// ⚠️ 覆盖时长 = 点数 × 间隔（不是 点数 ÷ 间隔 —— 第一版这里写反了，四个断言全假失败）。
const covered = (hm, iv) => hm * iv;
for (const iv of [10, 5, 2, 1.5, 1, 0.5]) {
  api.setConfig({ interval: iv });
  const hm = api.historyMax();
  check('采样 ' + iv + 's 时缓冲能覆盖 1 小时', covered(hm, iv) >= ranges['1h'],
    '上限=' + hm + ' 点 → ' + (covered(hm, iv) / 60).toFixed(0) + ' 分钟');
}

api.setConfig({ interval: 1.5 });
const h15 = api.historyMax();
api.setConfig({ interval: 0.5 });
const h05 = api.historyMax();
check('间隔 1.5s 时不低于原值 3600（不缩水）', h15 >= 3600, 'hm=' + h15);
check('间隔变小 → 上限变大（0.5s 给到 7200 以上）', h05 >= 7200, 'hm=' + h05);
check('0.5s 是合法间隔的下限，此时正好覆盖 1 小时', covered(h05, 0.5) >= ranges['1h'],
  (covered(h05, 0.5) / 60).toFixed(0) + ' 分钟');
check('config 缺失时按 1.5s 兜底、不抛异常', (() => {
  api.setConfig({});
  return api.historyMax() === 3600;
})(), 'hm=' + api.historyMax());
// 越界/损坏的配置只走安全阀，不需要保证覆盖 1 小时，但绝不能抛异常或无限增长
for (const iv of [0.2, 0.05, 0]) {
  api.setConfig({ interval: iv });
  const hm = api.historyMax();
  check('损坏配置 interval=' + iv + ' 被安全阀挡住', Number.isFinite(hm) && hm > 0 && hm <= 24000, 'hm=' + hm);
}

// ---------------------------------------------------------------- 3. queryHistory
say('');
say('=== 3. queryHistory：≤1h 也走压缩（说明书承诺「任何区间 ≤400 点」）===');
api.setConfig({ interval: 0.5 });
const hist = [];
for (let i = 0; i < 7200; i++) hist.push({ at: fakeNow - (7200 - i) * 500, total: 20 + (i % 5), w: { c1: 20, c2: 0, c3: 0, a: 0 } });
scope.state = { history: hist };
api.setState({ history: hist });

for (const rk of ['1m', '5m', '10m', '30m', '1h']) {
  const q = api.queryHistory(rk, ranges[rk]);
  check(rk + ' 区间下发点数 ≤ ' + maxP, q.rows.length <= maxP, 'len=' + q.rows.length);
  check(rk + ' 区间走内存原始件', q.source === 'raw', 'source=' + q.source);
  check(rk + ' 区间时间戳落在窗口内', q.rows.every((r) => r.at >= fakeNow - ranges[rk] * 1000));
}

// 30 分钟是「中等窗」：既要真的铺满 30 分钟（不是被当成短窗截断），
// 又不能把 1 小时的数据全塞进来（那就是区间秒数接错了）。桶宽 = 3600/400 = 9s。
const q30 = api.queryHistory('30m', ranges['30m']);
const span30 = fakeNow - q30.rows[0].at;
check('30m 区间秒数 = 1800', q30.seconds === 1800, 'seconds=' + q30.seconds);
check('30m 区间的点铺满 30 分钟', span30 >= ranges['30m'] * 1000 * 0.97,
  '最早点距现在 ' + (span30 / 1000).toFixed(0) + 's（窗口 ' + ranges['30m'] + 's）');
check('30m 区间不会把 1 小时的点都塞进来', span30 <= ranges['1h'] * 1000 * 0.6,
  '耗时 ' + (span30 / 1000).toFixed(0) + 's');
check('30m 区间点数多于 1 分钟窗（细节确实更多）', q30.rows.length > api.queryHistory('1m', ranges['1m']).rows.length,
  '30m=' + q30.rows.length + '  1m=' + api.queryHistory('1m', ranges['1m']).rows.length);
const q1h = api.queryHistory('1h', ranges['1h']);
// 分桶后每组的 at 取组内最后一个采样点，所以最早一行会比窗口起点晚最多一个桶宽
// （7200/400=18 点 × 0.5s = 9s）。判据放到 98%，既能容这点偏移，
// 又能抓住「只剩最后 30 分钟」（旧实现只有 50%）这种回归。
const span1h = fakeNow - q1h.rows[0].at;
check('1h 区间的点铺满整小时（不是只有最后 30 分钟）',
  span1h >= ranges['1h'] * 1000 * 0.98,
  '最早点距现在 ' + (span1h / 1000).toFixed(0) + 's（窗口 ' + ranges['1h'] + 's，占 ' + (span1h / ranges['1h'] / 10).toFixed(0) + '%）');
check('1h 区间点数接近上限（没有被腰斩）', q1h.rows.length >= 380, 'len=' + q1h.rows.length);

// 长区间走磁盘降采样文件，同样要有点
scope.minRows = [];
for (let i = 0; i < 5000; i++) scope.minRows.push({ at: fakeNow - (5000 - i) * 60000, total: 30, peak: 30, w: { c1: 30, c2: 0, c3: 0, a: 0 } });
const q6h = api.queryHistory('6h', ranges['6h']);
check('6h 区间走降采样文件', q6h.source === 'minute', 'source=' + q6h.source);
check('6h 区间下发点数 ≤ ' + maxP, q6h.rows.length <= maxP, 'len=' + q6h.rows.length);

// v1.6.5 新增 2/3/4 小时：走分钟文件，且点数正好是窗口内的分钟数（不抽稀、也不缺角）。
// 判据两层：① source=minute ② 点数 ≈ 窗口分钟数（分钟行 1:1，误差给 ±2 行）
//          ③ 最早点铺满窗口的 97% 以上（抓「区间秒数接错 / 只取到一半」）。
for (const rk of ['2h', '3h', '4h']) {
  const q = api.queryHistory(rk, ranges[rk]);
  const want = ranges[rk] / 60;
  check(rk + ' 区间走分钟文件', q.source === 'minute', 'source=' + q.source);
  check(rk + ' 区间点数 ≈ 窗口分钟数（不抽稀）', Math.abs(q.rows.length - want) <= 2,
    'len=' + q.rows.length + '  期望 ' + want);
  check(rk + ' 区间下发点数 ≤ ' + maxP, q.rows.length <= maxP, 'len=' + q.rows.length);
  check(rk + ' 区间时间戳严格递增', q.rows.every((r, i) => i === 0 || r.at > q.rows[i - 1].at));
  const span = fakeNow - q.rows[0].at;
  check(rk + ' 区间的点铺满窗口', span >= ranges[rk] * 1000 * 0.97,
    '最早点距现在 ' + (span / 1000).toFixed(0) + 's（窗口 ' + ranges[rk] + 's）');
  check(rk + ' 区间秒数 = ' + ranges[rk], q.seconds === ranges[rk], 'seconds=' + q.seconds);
}

// ---------------------------------------------------------------- 4. seedHistory
say('');
say('=== 4. seedHistory：重启后 1 小时内的曲线不留白 ===');
const dayOf = (ts) => 'day' + Math.floor(ts / 86400000);
const mk = (at, total) => ({ at, total, w: { c1: total, c2: 0, c3: 0, a: 0 } });

// 1s 采样攒了 2.5 小时 → 只有最近 1 小时该被装进内存
api.setConfig({ interval: 1 });
scope.files = {};
const big = [];
for (let i = 0; i < 9000; i++) big.push(mk(fakeNow - (9000 - i) * 1000, 10));
scope.files[dayOf(fakeNow)] = big;
const n1 = api.seedHistory();
const seededRows = api.state().history;
check('预热确实装进了点', n1 > 0 && seededRows.length === n1, 'n=' + n1);
check('只保留最近 1 小时（更早的丢掉）',
  seededRows.every((r) => r.at >= fakeNow - ranges['1h'] * 1000),
  '最早点距现在 ' + ((fakeNow - seededRows[0].at) / 1000).toFixed(0) + 's');
check('预热点数不超过内存上限', seededRows.length <= api.historyMax(), 'len=' + seededRows.length + ' 上限=' + api.historyMax());
check('按时间升序（前端直接画）', seededRows.every((r, i) => i === 0 || r.at > seededRows[i - 1].at));
check('字段被规整过（at/total/w 都在）',
  seededRows.every((r) => Number.isFinite(r.at) && Number.isFinite(r.total) && r.w && Number.isFinite(r.w.c1)));

// 采样间隔改小了：内存上限变大，但磁盘上只有 1s 一个点，不该凭空变多
api.setConfig({ interval: 0.5 });
const n2 = api.seedHistory();
check('间隔改成 0.5s 后上限变大、装进去的点跟着上限走',
  n2 >= n1 && n2 <= api.historyMax(), 'n1=' + n1 + ' n2=' + n2 + ' 上限=' + api.historyMax());

// 采样间隔从 0.5s 调大到 10s：磁盘上点很密，必须被 slice(-need) 截断
api.setConfig({ interval: 10 });
const dense = [];
for (let i = 0; i < 7200; i++) dense.push(mk(fakeNow - (7200 - i) * 500, 10));
scope.files[dayOf(fakeNow)] = dense;
const n3 = api.seedHistory();
check('磁盘点比上限密时按上限截断（只留最近的那一段）', n3 === api.historyMax() || n3 <= api.historyMax(),
  'n3=' + n3 + ' 上限=' + api.historyMax());
check('截断留下的是最近的点', api.state().history[api.state().history.length - 1].at === dense[dense.length - 1].at);

// 跨零点：今天的文件还不存在，要能用昨天的
scope.files = {};
const y = [];
for (let i = 0; i < 3600; i++) y.push(mk(fakeNow - 60 * 1000 - i * 1000, 7));
scope.files[dayOf(fakeNow - 86400000)] = y;
const n4 = api.seedHistory();
check('今天的文件不存在时退回昨天', n4 > 0, 'n=' + n4);

// 磁盘上什么都没有 / 文件损坏：返回 0，不抛异常
scope.files = {};
api.setState({ history: [] });
check('没有任何历史文件时安静返回 0', api.seedHistory() === 0);
scope.files[dayOf(fakeNow)] = [{ at: null }, { at: 'x', total: 1 }, { junk: true }];
check('文件内容损坏时不抛异常、也不装垃圾点', (() => {
  const n = api.seedHistory();
  return n === 0;
})(), 'n=' + api.state().history.length);
// 只有 at 没有 w 的行也要能被规整（老版本文件缺字段）
scope.files[dayOf(fakeNow)] = [{ at: fakeNow - 1000, total: 5 }];
const n5 = api.seedHistory();
check('缺 w 字段的老行被补成 0 而不是 undefined',
  n5 === 1 && api.state().history[0].w && api.state().history[0].w.c1 === 0,
  JSON.stringify(api.state().history[0]));

// ---------------------------------------------------------------- 5. 分钟文件不重复
say('');
say('=== 5. flushMinute / minRowsClean：同一分钟只能有一行 ===');
// 真实故障（2026-09-22 实际文件里 8 处）：迟到采样把已写过的分钟重新开桶，
// 于是同一分钟出现两行、内容还不一样 —— 长区间曲线在同一横坐标有两个值。
const MIN = api.HIST_MIN;
const minute = (s) => Math.floor(fakeNow / 60000) * 60000 + s * 60000;
const bucketOf = (m, n, total) => ({ minute: m, n, total, peak: total, ports: { c1: total, c2: 0, c3: 0, a: 0 } });

scope.files[MIN] = [];
const m1 = minute(0);
api.setBucket(bucketOf(m1, 120, 1200));
api.flushMinute();
check('第一次落盘写出 1 行', scope.files[MIN].length === 1, 'lines=' + scope.files[MIN].length);
check('写出的是均值而不是总和', scope.files[MIN][0].total === 10, 'total=' + scope.files[MIN][0].total);

api.setBucket(bucketOf(m1, 20, 400));
api.flushMinute();
check('同一分钟再来一次（采样更少）不新增行', scope.files[MIN].length === 1, 'lines=' + scope.files[MIN].length);
check('而且原来那行没被残行覆盖', scope.files[MIN][0].n === 120, 'n=' + scope.files[MIN][0].n);

api.setBucket(bucketOf(m1, 140, 1400));
api.flushMinute();
check('同一分钟这条更全 → 就地替换、仍然只有 1 行', scope.files[MIN].length === 1, 'lines=' + scope.files[MIN].length);
check('替换后拿到更全的采样数', scope.files[MIN][0].n === 140, 'n=' + scope.files[MIN][0].n);

api.setBucket(bucketOf(minute(1), 60, 0));
api.flushMinute();
check('下一分钟正常追加', scope.files[MIN].length === 2, 'lines=' + scope.files[MIN].length);

// minRowsClean 要能修老文件（时间戳用"真实"的量级，否则会被区间过滤掉变成空断言）
const T = Math.floor(fakeNow / 60000) * 60000;
const dupFile = [
  { at: T - 120000, n: 49, total: 8.656 },
  { at: T - 180000, n: 10, total: 1 },
  { at: T - 120000, n: 24, total: 0 },
  { at: T - 60000, n: 30, total: 2 },
  { at: null, n: 1, total: 3 },
  { junk: true },
];
const cl = api.minRowsClean(dupFile);
check('去重后只剩有效分钟', cl.length === 3, 'len=' + cl.length);
check('按时间排序（前端能直接画）',
  cl.map((r) => r.at).join(',') === [T - 180000, T - 120000, T - 60000].join(','),
  cl.map((r) => r.at).join(','));
check('重复分钟保留采样更全的那条（n=49 而不是 n=24）', cl[1].n === 49, 'n=' + cl[1].n);
check('坏行被丢掉而不是抛异常', cl.every((r) => Number.isFinite(r.at)));

// 端到端：拿修好的文件去查长区间，时间戳必须严格递增
scope.minRows = api.minRowsClean(dupFile);
const qq = api.queryHistory('6h', ranges['6h']);
check('整理过的分钟文件能查出点（非空，避免空数组假通过）', qq.rows.length === 3, 'len=' + qq.rows.length);
check('整理过的分钟文件 → 查询结果时间戳严格递增',
  qq.rows.every((r, i) => i === 0 || r.at > qq.rows[i - 1].at),
  JSON.stringify(qq.rows.map((r) => r.at)));
const dupRows = dupFile.filter((r) => Number.isFinite(r.at));
check('未整理的重复文件确实会破坏递增（说明这条断言抓得住 bug）',
  !dupRows.every((r, i) => i === 0 || r.at > dupRows[i - 1].at),
  JSON.stringify(dupRows.map((r) => r.at)));

const fails = budget.filter((b) => !b.ok).length;
say('');
say('共 ' + budget.length + ' 项断言，失败 ' + fails + ' 项');
const txt = out.join('\n');
fs.writeFileSync(OUT, txt, 'utf8');
console.log(txt);
process.exitCode = fails ? 1 : 0;
