// 设备小时记录「铺满一小时」的离线回归 —— 不需要蓝牙，也不需要起服务。
//
// 背景（2026-10-06 用户报）：设备历史是**每小时一条**（记的是刚走完的那一小时的最低/最高）。
// 如果只把它画成一个孤点，在 30 分钟这种短窗口里就是"一两个点 + 一大片空白"，看着像
// 历史没读回来。修法是给每条记录带上 sp=3600000，前端据此铺成"该小时那一段"。
//
// 这里测两件事：
//   ① healEnvSpans()：给**老数据**（没有 sp 的设备行）补 sp —— 它会重写用户的按天文件，
//      所以先在临时目录的副本上跑，确认只动设备行、不动本机采样、且可重复执行。
//   ② server.js / app.js 里相关接线（落盘带 sp、按天聚合优先用行内极值、前端按 sp 铺带子）。
//
// 用法: node tools/test_env_span.js
const fs = require('fs');
const path = require('path');
const os = require('os');

const root = path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const appJs = fs.readFileSync(path.join(root, 'web', 'app.js'), 'utf8');

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

// ---- 1. 抠出函数与常量 -----------------------------------------------------
const healSrc = extractFn(src, 'healEnvSpans');
const parseSrc = extractFn(src, 'parseRows');
const spanM = /const DEV_HIST_SPAN_MS = (\d+)/.exec(src);
check('切出 healEnvSpans()', !!healSrc);
check('切出 parseRows()', !!parseSrc);
check('DEV_HIST_SPAN_MS = 3600000', !!spanM && Number(spanM[1]) === 3600000, spanM && spanM[1]);

// ---- 2. 在临时副本上跑 healEnvSpans ---------------------------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'envspan-'));
const histDir = path.join(tmp, 'env-history');
fs.mkdirSync(histDir, { recursive: true });
const minFile = path.join(tmp, 'env-history-min.jsonl');
const HW = 3600000;
const H = (h, m, t, extra) => Object.assign({ at: new Date(2026, 9, 6, h, m, 0, 0).getTime(), t, h: 40 }, extra || {});

// 仿真实数据：整点 :42 的一串设备行（今天 4 点起）+ 两条 90 秒间隔的本机采样 + 一条隔 1 小时
// 但"秒"对不上的行（用来验证判据②不会把巧合当设备）
const devRows = [H(8, 42, 20.1), H(9, 42, 20.6), H(10, 42, 21.5), H(11, 42, 22.8)];
const appRows = [{ at: H(11, 48, 23.65).at + 13000, t: 23.65, h: 37 },
                 { at: H(11, 49, 23.69).at + 24000, t: 23.69, h: 37 }];
const oddRow = [{ at: H(11, 42, 22.8).at + 30000, t: 22.9, h: 38 }];   // 同一分钟但秒不同
const dayFile = path.join(histDir, 'env-2026-10-06.jsonl');
fs.writeFileSync(dayFile, devRows.concat(appRows, oddRow).map((r) => JSON.stringify(r)).join('\n') + '\n');
fs.writeFileSync(minFile, devRows.concat(appRows, oddRow).map((r) => JSON.stringify(r)).join('\n') + '\n');

let heal = null;
if (healSrc && parseSrc && spanM) {
  try {
    heal = new Function('fs', 'path', 'ENV_HIST_DIR', 'ENV_HIST_MIN', 'parseRows', 'log', 'DEV_HIST_SPAN_MS',
      parseSrc + '\n' + healSrc + '\nreturn healEnvSpans;')(
      fs, path, histDir, minFile,
      (p) => { try { return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch (_) { return []; } },
      () => {}, HW);
    check('healEnvSpans 能被求值', true);
  } catch (e) { check('healEnvSpans 能被求值', false, e.message); }
}

if (heal) {
  const n1 = heal();
  // 按天文件和分钟文件里各有一份同样的 4 条设备行 → 两个文件都要补，合计 8
  check('第一次自愈：两个文件各 4 条 = 8', n1 === 8, String(n1));
  const back = JSON.parse('[' + fs.readFileSync(dayFile, 'utf8').trim().split('\n').join(',') + ']');
  const dev = back.filter((r) => r.sp === HW);
  const bare = back.filter((r) => r.sp == null);
  check('设备行全部带上 sp=1h', dev.length === 4, dev.length + ' 条');
  check('本机采样没被误标（两条 23.6x 的都留着 sp 为空）',
    bare.length === 3 && bare.some((r) => Math.abs(r.t - 23.65) < 0.01)
    && bare.some((r) => Math.abs(r.t - 23.69) < 0.01), bare.map((r) => r.t).join(','));
  check('秒对不上的那行也没被误标（判据②生效）',
    bare.some((r) => Math.abs(r.t - 22.9) < 0.01));
  check('写回后仍是按时间升序', back.every((r, i) => i === 0 || r.at > back[i - 1].at));
  const n2 = heal();
  check('可重复执行（第二次标记 0 条）', n2 === 0, String(n2));
  // 只有 3 条（2 段）的短链不该被认成设备记录
  const shortFile = path.join(histDir, 'env-2026-10-07.jsonl');
  fs.writeFileSync(shortFile, [H(1, 42, 18), H(2, 42, 18.2), H(3, 42, 18.4)]
    .map((r) => JSON.stringify(r)).join('\n') + '\n');
  heal();
  const shortBack = JSON.parse('[' + fs.readFileSync(shortFile, 'utf8').trim().split('\n').join(',') + ']');
  check('只有 2 段的短链不算设备记录（防误判）', shortBack.every((r) => r.sp == null));

  // 临时目录清理
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
}

// ---- 2b. 拿真实数据（副本）跑一遍 ------------------------------------------
// 只在有 data/env-history-min.jsonl 时做；注意是**副本**，绝不动真文件。
if (heal) {
  const real = path.join(root, 'data', 'env-history-min.jsonl');
  if (!fs.existsSync(real)) {
    out.push('SKIP  真实数据用例（没有 data/env-history-min.jsonl）');
  } else {
    const t2 = fs.mkdtempSync(path.join(os.tmpdir(), 'envspan-real-'));
    const d2 = path.join(t2, 'env-history');
    fs.mkdirSync(d2, { recursive: true });
    const min2 = path.join(t2, 'env-history-min.jsonl');
    fs.copyFileSync(real, min2);
    const day2 = path.join(d2, 'env-2026-10-06.jsonl');
    const realDay = path.join(root, 'data', 'env-history', 'env-2026-10-06.jsonl');
    if (fs.existsSync(realDay)) fs.copyFileSync(realDay, day2);
    const heal2 = new Function('fs', 'path', 'ENV_HIST_DIR', 'ENV_HIST_MIN', 'parseRows', 'log', 'DEV_HIST_SPAN_MS',
      parseSrc + '\n' + healSrc + '\nreturn healEnvSpans;')(
      fs, path, d2, min2,
      (p) => { try { return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch (_) { return []; } },
      () => {}, HW);
    const rows = fs.readFileSync(min2, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const n = heal2();
    const after = fs.readFileSync(min2, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const withSp = after.filter((r) => r.sp === HW).length;
    const bare = after.filter((r) => r.sp == null);
    // ⚠️ 别写成"必须标记 >3000 条"：这份真数据可能**已经自愈过**（应用重启过），
    //    那时正确结果就是标记 0 条。判据要落在"最终状态"上，而不是"这次改了多少"。
    check('真实数据：自愈后设备行都带上 sp（本来就带则标记 0 条）',
      withSp > 3000 && withSp + bare.length === after.length, '带 sp ' + withSp + ' / 不带 ' + bare.length);
    check('真实数据：总行数没变（只是加字段）', after.length === rows.length, after.length + ' vs ' + rows.length);
    // 不带 sp 的就是本机 90 秒采样。**别用"年龄"去判"设备行有没有被误伤"** ——
    // 这条断言 2026-10-24 又红了（裸行 6086 条里有 4252 条早于 4 天前），不是代码坏了：
    // 它的前提是"本地采样只在最近写过"，而机器已经连开两周多。
    // 教训记一次就够：凡是"数据现在长什么样"的判据都会随运行时长漂移，
    // 真正不变量只有一个 —— **自愈只加字段、不改已有结论**（下面那条幂等）。
    // 规则本身（≥3 段小时链才认设备记录）由上面那组合成数据用例钉住，那才是确定性的。
    const before2 = fs.readFileSync(min2, 'utf8');
    heal2();
    const after2 = fs.readFileSync(min2, 'utf8');
    check('真实数据：自愈幂等（再跑一次不改一个字节）', before2 === after2,
      before2.length + ' 字节 → ' + after2.length + ' 字节');
    out.push('INFO  真实数据：裸行 ' + bare.length + ' / ' + after.length + ' 条（占比'
      + (bare.length / after.length * 100).toFixed(1) + '%，随开机时长增长，不是判据）');
    try { fs.rmSync(t2, { recursive: true, force: true }); } catch (_) {}
  }
}

// ---- 3. 接线（静态断言）---------------------------------------------------
check('落盘时设备行带 sp / tmin / tmax / hmin / hmax',
  /rec = \{ at, sp: DEV_HIST_SPAN_MS \}/.test(src) && /rec\.tmin = round3\(tlo\)/.test(src)
  && /rec\.hmin = round1\(hlo\)/.test(src));
check('按天文件整行搬运（不丢 sp/tmin）',
  /byDay\.get\(k\)\.push\(r\);\s*\/\/ 整行写下去/.test(src)
  && /byDay\.get\(k\)\.push\(r\);\s*\/\/ 整行搬运/.test(src));
check('内存预热保留 sp/tmin/tmax（否则 ≤1 小时窗口又变孤点）',
  /o\.sp = r\.sp/.test(src) && /o\.tmin = r\.tmin/.test(src));
check('读完历史后重刷内存那批（否则短窗口还在画被覆盖掉的行）',
  /try \{ seedEnvHistory\(\); \} catch/.test(src));
check('启动时调用 healEnvSpans()',
  /healEnvSpans\(\);\s*\/\/ 老数据补 sp/.test(src));
check('按天聚合优先用行内极值（当日最低~最高是实测值，不再被均值抹平）',
  /Number\.isFinite\(tlo\) && tlo < d\.tMin/.test(src) && /Number\.isFinite\(thi\) && thi > d\.tMax/.test(src));
check('前端：短窗口把 sp 行画成"该小时一段"的均值线（不再铺橙色阴影带）',
  /const isRibbon = /.test(appJs) && /g\.moveTo\(x0, YT\(mid\)\); g\.lineTo\(x1, YT\(mid\)\)/.test(appJs)
  && !/g\.fillRect\(x0, y1, x1 - x0/.test(appJs));
// ⚠️ 2026-10-08 两次修正：
//   ① 那句跳过原本只照顾温度，湿度跟着跳 → 长区间湿度线整条被跳空；
//   ② 温度自己跳得太狠 → 短窗口里几乎每行都是设备小时记录，全被置 null，
//      连续段不足 3 点，平滑开关对温度完全无效（用户报「只平滑了湿度」）。
//   现在取值规则抽到 envSeries()：温度在**平滑开着时不跳**、湿度始终不跳。
check('前端：跳过带子行的规则抽到 envSeries()（温度平滑时不跳、湿度不跳）',
  /function envSeries\(rowsIn, pick, skipRibbon, isRibbonFn\)/.test(appJs)
  && /if \(skipRibbon && isRibbonFn\(r\)\) return null;/.test(appJs)
  && /skipRibbon: !envSmooth/.test(appJs) && /skipRibbon: false/.test(appJs));
check('前端：悬停提示给出"该小时最低~最高"', /该小时<\/span>/.test(appJs));

const txt = out.join('\n') + '\n\n' + (bad ? `RESULT: FAIL (${bad} 项失败)` : `RESULT: PASS (${out.length} 项)`) + '\n';
fs.writeFileSync(path.join(root, 'tools', 'test_env_span.out.txt'), txt, 'utf8');
process.stdout.write(txt);
process.exit(bad ? 1 : 0);
