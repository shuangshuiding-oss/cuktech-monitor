// 温湿度「取数合成 + 抽稀」的离线回归 —— 不需要蓝牙，也不需要起服务。
//
// 背景（2026-10-08 用户报"温度还是没覆盖"）：文件和日志都是好的（每天 24 条设备记录都在），
// 但短/中长窗口的曲线上每天只剩 16 个点、相邻两点差 2 小时，看着一段段空白。两个原因：
//
//   ① **同一批设备行在日文件和分钟文件里各存了一份**（覆盖写两边都写），取数时两条来源
//      都读（长区间缺一条就只看得到一个月）→ 同一时刻出现两行；
//   ② 抽稀是"每 N 行分一组取均值"，行数被 ① 翻倍之后，分组边界就跟时间对不上了：
//      每小时那条被并掉一半，抽出来的点还跳到不规则的时刻上。
//
// 修法：`mergeEnvSources()` 按 at 去重（同一时刻留信息更全的那行）+ `downsampleEnv()`
// **按时间分桶**（桶宽 = 窗口 / 点数上限，至少 1 分钟），并把温度曲线的点数上限单独提到 1200。
//
// 用法: node tools/test_env_query.js
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'server.js'), 'utf8');

const out = [];
let bad = 0;
const check = (name, cond, extra) => {
  if (!cond) bad++;
  out.push((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '   — ' + extra : ''));
};

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

// ---- 1. 抠出需要的函数 -----------------------------------------------------
const parts = ['envNum', 'mergeEnvSources', 'downsampleEnv', 'envBucketRow'].map((n) => extractFn(src, n));
check('四个函数都切出来了', parts.every(Boolean), parts.map((p) => (p ? 'ok' : 'missing')).join('/'));
const envMaxM = /const ENV_MAX_POINTS = (\d+)/.exec(src);
check('ENV_MAX_POINTS 存在且 ≥ 1000', !!envMaxM && Number(envMaxM[1]) >= 1000, envMaxM && envMaxM[1]);
check('取数时用的是 ENV_MAX_POINTS（不是 CHART_MAX_POINTS）',
  /downsampleEnv\(inWin, ENV_MAX_POINTS\)/.test(src));
check('取数走 mergeEnvSources 去重', /src = mergeEnvSources\(src\);/.test(src));

let Q = null;
if (parts.every(Boolean)) {
  try {
    Q = new Function(parts.join('\n') +
      '\nconst round1 = (v) => Math.round(Number(v) * 10) / 10;' +
      '\nconst round3 = (v) => Math.round(Number(v) * 1000) / 1000;' +
      '\nreturn { envNum, mergeEnvSources, downsampleEnv, envBucketRow };')();
    check('四个函数能被求值', true);
  } catch (e) { check('四个函数能被求值', false, e.message); }
}

const HW = 3600000;
const MIN = 60000;
const day0 = new Date(2026, 9, 2, 0, 0, 0, 0).getTime();

if (Q) {
  // ---- 2. mergeEnvSources：按 at 去重，留信息更全的那行 -------------------
  const dev = { at: day0 + 39 * MIN + 44000, t: 20.1, h: 40, sp: HW, tmin: 19.8, tmax: 20.4 };
  const dup = { at: dev.at, t: 20.1, h: 40 };                       // 日文件里那一份（少了 sp/区间）
  const loc = { at: day0 + 41 * MIN, t: 20.3, h: 41 };              // 本机 90 秒采样
  const locDup = { at: loc.at, t: 20.3, h: 41, b: 77 };             // 同一分钟的另一份（带电量）
  const m = Q.mergeEnvSources([dup, dev, loc, locDup, null, { at: 'x' }]);
  check('去重后只剩两个时刻', m.length === 2, JSON.stringify(m.map((r) => r.at)));
  check('同一时刻留的是"信息更全"的那行（带 sp/区间）',
    m[0].sp === HW && m[0].tmin === 19.8, JSON.stringify(m[0]));
  check('按时间升序', m[0].at < m[1].at);
  check('带 b 的那份胜出（本机采样）', m[1].b === 77, JSON.stringify(m[1]));
  check('脏数据被丢掉（null / at 不是数字）', m.length === 2);

  // ---- 3. downsampleEnv：按时间分桶，不掉点、不留洞 ----------------------
  // 造 7 天：每天 24 条设备行（每小时一条）+ 每 90 秒一条本机采样（只在前两天，模拟"刚跑过"）
  const rows = [];
  for (let d = 0; d < 7; d += 1) {
    for (let h = 0; h < 24; h += 1) {
      const at = day0 + d * 86400000 + h * HW + 39 * MIN + 44000;
      rows.push({ at, t: 20 + h * 0.1, h: 40, sp: HW, tmin: 19.5 + h * 0.1, tmax: 20.5 + h * 0.1 });
    }
    if (d >= 5) {
      for (let k = 0; k < 960; k += 1) {
        const at = day0 + d * 86400000 + k * 90000;
        rows.push({ at, t: 21.5, h: 41 });
      }
    }
  }
  rows.sort((a, b) => a.at - b.at);
  const maxGapOf = (list) => {
    let m = 0;
    for (let i = 1; i < list.length; i += 1) m = Math.max(m, list[i].at - list[i - 1].at);
    return m;
  };
  // 小样本（120 条 ≤ 上限）应当原样返回：保住每小时那条的 sp/最低最高
  const fewRows = rows.slice(0, 120);
  const same = Q.downsampleEnv(fewRows, 1200);
  check('行数没超上限时原样返回（保住每小时的 sp/区间）', same === fewRows, same.length + ' / ' + fewRows.length);

  const many = rows.concat(rows.map((r) => Object.assign({}, r, { at: r.at + 1 })));   // 人为撑到 > 上限
  const ds = Q.downsampleEnv(many, 1200);
  check('超过上限才抽稀，且点数 ≤ 上限', ds.length <= 1200 && ds.length < many.length, ds.length + ' 点 / 输入 ' + many.length);
  // ⚠️ 关键判据：**抽稀不能制造新的空洞**。老实现（每 N 行分组）会把 60 分钟的天然间隔
  //    放大到 120 分钟 —— 那正是用户看到的"一段段空白"。所以比的是"输出最大间隔 vs 输入最大间隔"。
  const bucket = Math.max(MIN, Math.ceil((rows[rows.length - 1].at - rows[0].at) / 1200));
  check('抽稀后没有比输入更大的空洞（老实现会把 60 分钟放大成 120 分钟）',
    maxGapOf(ds) <= Math.max(maxGapOf(many) * 1.5, bucket * 2),
    '输入最大间隔 ' + Math.round(maxGapOf(many) / 60000) + ' 分钟 → 输出 '
    + Math.round(maxGapOf(ds) / 60000) + ' 分钟');
  check('抽稀后的时间戳仍在原时间范围内',
    ds[0].at >= many[0].at && ds[ds.length - 1].at <= many[many.length - 1].at);
  check('抽稀不产生"假 0℃"（缺温度的桶写 null 而不是 0）',
    ds.every((r) => r.t == null || r.t > 5), JSON.stringify(ds.filter((r) => r.t != null && r.t <= 5).slice(0, 3)));
  const noT = Q.downsampleEnv([{ at: 1 * MIN, h: 40 }, { at: 3 * MIN, h: 41 }, { at: 5 * MIN, h: 42 }], 2);
  check('整桶没有温度时 t = null（不是 0）', noT.every((r) => r.t === null), JSON.stringify(noT));
  check('桶宽至少 1 分钟（短窗口硬压也不会把一个桶算成 0 宽）',
    Q.downsampleEnv(rows.slice(0, 300), 10).length <= 300);

  // ---- 4. 真实数据：修完之后每天的点数应当回到 ~24（设备那几天是满的）----
  const histDir = path.join(root, 'data', 'env-history');
  const minFile = path.join(root, 'data', 'env-history-min.jsonl');
  const read = (p) => {
    try { return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch (_) { return []; }
  };
  if (fs.existsSync(minFile)) {
    const src2 = [];
    for (let i = 0; i < 7; i += 1) {
      const d = new Date(Date.now() - i * 86400000);
      const p = path.join(histDir, 'env-' + d.toISOString().slice(0, 10) + '.jsonl');
      src2.push(...read(p));
    }
    src2.push(...read(minFile));
    // ⚠️ 这条以前是「真实数据里必须还有重复行」—— 那是在断言**当前数据长什么样**。
    //    数据自愈过一次（服务已经按 at 去重写盘）之后就再也找不到重复行，
    //    断言必红，而代码是对的（2026-11-08 就这么红了一次）。
    //    真正的不变量是「合并幂等 + 结果里没有重复时间点」，与数据现状无关。
    const mergedRaw = Q.mergeEnvSources(src2);
    if (src2.length > mergedRaw.length) {
      check('真实数据：重复行会被合并掉（曾经"每天只剩 16 点"的元凶）',
        mergedRaw.length < src2.length, src2.length + ' -> ' + mergedRaw.length + ' 行');
    } else {
      out.push('INFO  真实数据：当前没有重复行（早已自愈），跳过"重复行被合并"这条');
    }
    const mergedTwice = Q.mergeEnvSources(mergedRaw);
    check('真实数据：合并是幂等的（再合一次不增不减）',
      mergedTwice.length === mergedRaw.length, mergedRaw.length + ' -> ' + mergedTwice.length);
    check('真实数据：合并结果里没有重复时间点',
      new Set(mergedRaw.map((r) => r.at)).size === mergedRaw.length,
      new Set(mergedRaw.map((r) => r.at)).size + ' 个不同时刻 / ' + mergedRaw.length + ' 行');
    const merged = mergedRaw;
    const perDay = new Map();
    for (const r of merged) {
      const k = new Date(r.at).toISOString().slice(0, 10);
      perDay.set(k, (perDay.get(k) || 0) + 1);
    }
    const devDays = [...perDay.entries()].filter(([k]) => {
      const day = merged.filter((r) => new Date(r.at).toISOString().slice(0, 10) === k);
      return day.length >= 20 && day.filter((r) => r.sp).length >= 20;
    });
    check('真实数据：设备覆盖的那些天，每天 ≥ 22 个点（旧实现只剩 16）',
      devDays.length === 0 || devDays.every(([, v]) => v >= 22),
      devDays.length + ' 天全部达标');

    // 精确模拟「7 天」这一档（用户看的就是它）：日文件(7 天) + 分钟文件 → 去重 → 取窗口 → 抽稀
    const since = Date.now() - 7 * 86400000;
    const win = Q.downsampleEnv(Q.mergeEnvSources(src2).filter((r) => r.at >= since), 1200);
    const perDay2 = new Map();
    for (const r of win) {
      const k = new Date(r.at).toISOString().slice(0, 10);
      perDay2.set(k, (perDay2.get(k) || 0) + 1);
    }
    let g = 0;
    for (let i = 1; i < win.length; i += 1) g = Math.max(g, win[i].at - win[i - 1].at);
    out.push('INFO  7 天档模拟：' + win.length + ' 点 / 每天 '
      + [...perDay2.entries()].map(([k, v]) => k.slice(5) + ':' + v).join(' ')
      + ' / 最大间隔 ' + Math.round(g / 60000) + ' 分钟');
    // ⚠️ 判据别写成「总点数 > 300」：设备是**每小时一条**，7 天本来就只有约 168 点
    //    （2026-10-08 实测 172 点 → 旧判据误报 FAIL）。这条要守的回归是
    //    「去重没把同一小时的重复行吃掉」——坏掉时每天会掉到 16 点。
    //    最早那天（可能只覆盖半个下午）和今天（还没过完）本来就不完整，跳过它们。
    const dayKeys = [ ...perDay2.keys() ].sort();
    const todayKey = new Date().toISOString().slice(0, 10);
    const fullDays = dayKeys.filter((k) => k !== dayKeys[0] && k !== todayKey);
    check('7 天档：完整的天每天 ≥ 22 点（最早/今天可能不完整，跳过）',
      fullDays.length >= 2 && fullDays.every((k) => perDay2.get(k) >= 22),
      fullDays.map((k) => k.slice(5) + ':' + perDay2.get(k)).join(' '));
    // ⚠️ 上限别写死 300：7 天窗口里除了约 168 条设备小时记录，还有本机 90 秒采样（电脑开着
    //    就一直在攒，实测已到 334 点），总量由降采样上限（1200）兜着。这条只守"没被吃掉一半"，
    //    真正的回归是上面那条"完整的天每天 ≥ 22 点"。
    check('7 天档：总点数 ≥ 设备小时记录数、且不超过降采样上限',
      win.length >= 140 && win.length <= 1250, win.length + ' 点');
    // ⚠️ 判据不是"间隔必须 ≤ 70 分钟"：电脑没开机那几段（比如夜里关机 8 小时）本来就没有数据，
    //    那种空洞要靠"读设备历史"来补，不是抽稀的锅。抽稀的锅是**把已有数据的间隔放大**
    //    （老实现把 60 分钟的天然间隔放大成 120 分钟）。
    const rawWin = Q.mergeEnvSources(src2).filter((r) => r.at >= since);
    let gr = 0;
    for (let i = 1; i < rawWin.length; i += 1) gr = Math.max(gr, rawWin[i].at - rawWin[i - 1].at);
    check('7 天档：抽稀没有把空洞放大（输出最大间隔 ≈ 输入最大间隔）',
      g <= Math.max(gr * 1.5, 70000), '输入 ' + Math.round(gr / 60000) + ' 分钟 → 输出 ' + Math.round(g / 60000) + ' 分钟');
  } else {
    out.push('SKIP  真实数据用例（没有 data/env-history-min.jsonl）');
  }
}

const txt = out.join('\n') + '\n\n' + (bad ? `RESULT: FAIL (${bad} 项失败)` : `RESULT: PASS (${out.length} 项)`) + '\n';
fs.writeFileSync(path.join(root, 'tools', 'test_env_query.out.txt'), txt, 'utf8');
process.stdout.write(txt);
process.exit(bad ? 1 : 0);
