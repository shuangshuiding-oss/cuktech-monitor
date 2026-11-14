// 自动断电（5V 空载）判定的离线回归 —— 不需要蓝牙、不需要充电头、不需要等 60 秒。
//
// 需求（2026-11-13）：「检查到充电口带 5V 以上电压、但没有电流，自动关闭该充电口」。
// 判定做成纯函数 autoOffStep()，这里喂"时间 + 读数"的序列，把每种该/不该动手的情形走一遍。
//
// ⚠️ 这个功能会**真的把端口断电**，所以"判错"的代价比一般 bug 高：
//    · 误判 → 正在充电的手机被断（用户以为坏了）
//    · 漏掉 disarmed → 每 15 分钟通断一次的死循环，继电器/开关会被折腾
//    · 阈值写反（>= 与 >）→ 0.02A 的涓流也被当成"无电流"
//
// 用法: node tools/test_auto_off.js
'use strict';
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

// ---- 1. 把两个函数切出来求值（不启动服务器）----
const fns = ['autoOffStep', 'normAutoOff', 'autoOffTrack'].map((n) => extractFn(src, n));
check('autoOffStep / normAutoOff / autoOffTrack 都切出来了', fns.every(Boolean),
  fns.map((f) => (f ? 'ok' : 'missing')).join('/'));
// ⚠️ 不能直接 indexOf('let config = loadConfig()')：**我自己写的注释里**就引用了这句，
//    于是永远命中注释、断言假红（第一次跑就踩了）。按行首锚定真实语句。
const defAt = src.indexOf('const AUTO_OFF_DEF');
const callMatch = src.match(/^let config = loadConfig\(\);/m);
const callAt = callMatch ? src.indexOf(callMatch[0]) : -1;
check('默认值 AUTO_OFF_DEF 在文件顶部常量区（const 有 TDZ，loadConfig 是顶层调用）',
  defAt > 0 && callAt > 0 && defAt < callAt,
  '定义位置 ' + defAt + ' < 调用位置 ' + callAt);

const A = new Function(
  'const AUTO_OFF_DEF = { enabled: true, vMin: 5, iMax: 0.02, idleSec: 5, restoreMin: 15, skipSmallA: true };\n'
  + fns.join('\n') + '\nreturn { autoOffStep, normAutoOff, autoOffTrack };')();

const CFG = A.normAutoOff({ enabled: true, vMin: 5, iMax: 0.02, idleSec: 60, restoreMin: 15 });

/** 跑一串 (ms, {v,a,enabled}) 时间点，返回动作序列。 */
function run(steps, cfg) {
  let st = { idleSince: 0, disarmed: false };
  const acts = [];
  for (const [now, s] of steps) {
    const r = A.autoOffStep(st, Object.assign({ enabled: true }, s), cfg || CFG, now);
    st = r.state;
    acts.push({ at: now, action: r.action, why: r.why });
  }
  return { acts, st };
}
const cuts = (r) => r.acts.filter((x) => x.action === 'cut');

// ---- 2. 该动手：5V 空载持续满 60 秒 ----
{
  const r = run([[0, { v: 5.0, a: 0 }], [30000, { v: 5.0, a: 0 }], [59999, { v: 5.0, a: 0 }],
    [60000, { v: 5.0, a: 0 }]]);
  check('5V/0A 持续 60 秒 → 关（只关一次）',
    cuts(r).length === 1 && cuts(r)[0].at === 60000, JSON.stringify(cuts(r)));
  check('不到 60 秒不动手', r.acts.slice(0, 3).every((x) => x.action === 'none'));
  check('关完进入 disarmed（防止立刻再来一次）', r.st.disarmed === true);
}

// ---- 3. 不该动手：正在取电 ----
{
  const r = run([[0, { v: 9, a: 2.5 }], [120000, { v: 9, a: 2.5 }], [300000, { v: 5, a: 1 }]]);
  check('有电流（2.5A）多久都不关', cuts(r).length === 0, JSON.stringify(cuts(r)));
}

// ---- 4. 不该动手：没插东西（0V）----
{
  const r = run([[0, { v: 0, a: 0 }], [600000, { v: 0, a: 0 }]]);
  check('没电压（0V）不关 —— 空口本来就没电', cuts(r).length === 0);
}

// ---- 5. 不该动手：端口已经是关的 ----
{
  const r = run([[0, { v: 5, a: 0, enabled: false }], [120000, { v: 5, a: 0, enabled: false }]]);
  check('端口已被关闭时不重复动手', cuts(r).length === 0);
}

// ---- 6. 防死循环：关闭→恢复后不再自动关（要等拔插或重新取电）----
{
  const r = run([[0, { v: 5, a: 0 }], [65000, { v: 5, a: 0 }],
    // 15 分钟后自动恢复，端口回到有电压；此时应保持"不武装"
    [960000, { v: 5, a: 0 }], [1020000, { v: 5, a: 0 }], [1200000, { v: 5, a: 0 }]]);
  check('恢复后一直 5V/0A 也不再关（否则会每 15 分钟通断一次）',
    cuts(r).length === 1 && cuts(r)[0].at === 65000, JSON.stringify(cuts(r)));
  check('这种"保持不动"的原因标成 disarmed',
    r.acts[r.acts.length - 1].why === 'disarmed', r.acts[r.acts.length - 1].why);
}

// ---- 7. 重新武装：拔掉（0V）或重新取电后，下一次空载还会关 ----
{
  const r1 = run([[0, { v: 5, a: 0 }], [65000, { v: 5, a: 0 }], [70000, { v: 0, a: 0 }],
    [80000, { v: 5, a: 0 }], [150000, { v: 5, a: 0 }]]);
  check('拔掉再插上 → 重新武装，再空载 60 秒会再关一次',
    cuts(r1).length === 2, JSON.stringify(cuts(r1)));
  const r2 = run([[0, { v: 5, a: 0 }], [65000, { v: 5, a: 0 }], [70000, { v: 5, a: 1.2 }],
    [80000, { v: 5, a: 0 }], [150000, { v: 5, a: 0 }]]);
  check('重新取电后再空载 → 也会再关（说明有电流能解除 disarmed）',
    cuts(r2).length === 2, JSON.stringify(cuts(r2)));
}

// ---- 8. 阈值边界 ----
{
  const r = run([[0, { v: 5, a: 0.02 }], [90000, { v: 5, a: 0.02 }]]);
  check('电流正好等于 iMax(0.02) 视为空载（用 > 而不是 >=）', cuts(r).length === 1);
  const r2 = run([[0, { v: 5, a: 0.03 }], [90000, { v: 5, a: 0.03 }]]);
  check('0.03A 视为有负载，不关（涓流/耳机仓不该被切）', cuts(r2).length === 0);
  const r3 = run([[0, { v: 4.9, a: 0 }], [90000, { v: 4.9, a: 0 }]]);
  check('4.9V 低于 vMin 不关（协商瞬态）', cuts(r3).length === 0);
  const r4 = run([[0, { v: 5.0, a: 0 }], [120000, { v: 5.0, a: 0 }]],
    A.normAutoOff({ idleSec: 120 }));
  check('idleSec 改成 120 → 120 秒才关', cuts(r4).length === 1 && cuts(r4)[0].at === 120000,
    JSON.stringify(cuts(r4)));
}

// ---- 9. 参数归一化（界面上乱填也不能写进离谱的值）----
{
  const c = A.normAutoOff({ vMin: -3, iMax: 99, idleSec: 0, restoreMin: 9999, enabled: 'x' });
  check('vMin 夹到 3..20', c.vMin === 3, String(c.vMin));
  check('iMax 夹到 0..0.5', c.iMax === 0.5, String(c.iMax));
  check('idleSec 至少 5 秒', c.idleSec === 5, String(c.idleSec));
  check('restoreMin 最多 240 分钟', c.restoreMin === 240, String(c.restoreMin));
  check('enabled 只有明确 false 才关（传个乱七八糟的值仍算开）', c.enabled === true);
  check('skipSmallA 默认开', c.skipSmallA === true);
}

// ---- 10. 接线检查（改坏了会静默失效的那些点）----
check('触发时留可追溯记录（addNotice 落 app.log + 托盘气泡，不是只在内存 400 行里）',
  /addNotice\('autooff'/.test(src));
check('每帧 state 都会跑一次判定', /autoOffTick\(obj\)/.test(src));
check('动手走的是现成的端口开关（读-改-写 2.16 位掩码）',
  /setPort\(p\.id, 'off'\)/.test(src) && /function setPort/.test(src));
check('关完会挂自动恢复计时', /autoOffRestore\(p\.id, cfg\.restoreMin\)/.test(src));
check('配置接口能存 autoOff', /j\.autoOff && typeof j\.autoOff === 'object'/.test(src));
check('关掉功能时会把计时清干净（不留半截）',
  /autoOffState\.clear\(\)/.test(src) && /autoOffTimers\.clear\(\)/.test(src));
check('界面有开关与四个参数', ['ao-on', 'ao-v', 'ao-i', 'ao-sec', 'ao-restore']
  .every((id) => fs.readFileSync(path.join(root, 'web', 'index.html'), 'utf8').includes('id="' + id + '"')));
check('启用开关用的是和端口开关同一个 .switch 组件（v1.9.7）',
  /class="switch" id="ao-on"/.test(fs.readFileSync(path.join(root, 'web', 'index.html'), 'utf8'))
  && /\$\('#ao-on'\)\.onclick/.test(fs.readFileSync(path.join(root, 'web', 'app.js'), 'utf8')));
check('界面用 change 而不是 input（避免输 0.02 时逐字符写坏阈值）',
  /\$\('#ao-i'\)\.onchange/.test(fs.readFileSync(path.join(root, 'web', 'app.js'), 'utf8')));


// ---- 11. 异常检查：episode 记账（v1.9.6）----
{
  const T = A.autoOffTrack;
  // 进入空载 → 开一个 episode
  const r1 = T(null, { v: 5, a: 0 }, CFG, 1000, 0);
  check('第一次空载就开一条记录（不会每帧刷一条）',
    !!r1.episode && r1.closed === null, JSON.stringify(r1));

  // 期间取电 → 结束，action=clear
  const r2 = T(r1.episode, { v: 5, a: 1.2 }, CFG, 9000, 0);
  check('重新取电 → 事件结束、标成自行恢复',
    r2.closed && r2.closed.action === 'clear' && r2.closed.durMs === 8000,
    JSON.stringify(r2.closed));

  // 拔掉 → 同样结束
  const r3 = T(r1.episode, { v: 0, a: 0 }, CFG, 5000, 0);
  check('拔掉（0V）→ 事件结束', r3.closed && r3.closed.action === 'clear');

  // 持续空载：vMax / aMax 取这段里的最大值
  const r4 = T({ start: 0, vMax: 5, aMax: 0.01, lastV: 5, lastA: 0.01 },
    { v: 9, a: 0.02 }, CFG, 4000, 0);
  check('电压/电流范围按这段里的最大值记（不是取最后一帧）',
    r4.episode.vMax === 9 && r4.episode.aMax === 0.02, JSON.stringify(r4.episode));

  // 刚自动关过：端口电压还没来得及掉，别把那几帧残影记成"自行恢复"
  const r5 = T(null, { v: 5, a: 0 }, CFG, 10000, 9500);
  check('刚关完 5 秒内不新开记录（避免关完紧跟一条假"自行恢复"）',
    r5.episode === null, JSON.stringify(r5));
  const r6 = T(null, { v: 5, a: 0 }, CFG, 20000, 10000);
  check('超过 5 秒后又能正常开记录', !!r6.episode);

  // 低于门槛不记
  const r7 = T(null, { v: 4.9, a: 0 }, CFG, 1000, 0);
  check('4.9V 不算"有电压"（不记录）', r7.episode === null);
  const r8 = T(null, { v: 5, a: 0.03 }, CFG, 1000, 0);
  check('0.03A 不算"没电流"（不记录）', r8.episode === null);
}

// ---- 12. 默认值与记录落盘 ----
{
  const d = A.normAutoOff(undefined);
  check('默认 5 秒就关（用户 2026-11-13 要求）', d.idleSec === 5, String(d.idleSec));
  check('源码里的 AUTO_OFF_DEF 也确实是 5（桩别和真值漂移）',
    /idleSec: 5, restoreMin: 15/.test(src));
  check('功能默认开启', d.enabled === true);
  check('记录写独立文件（不混进 app.log）',
    /const AUTO_OFF_LOG = path\.join\(DATA, 'auto-off\.jsonl'\)/.test(src));
  check('事件会 append 到该文件', /appendFileSync\(AUTO_OFF_LOG/.test(src));
  check('启动时载入历史（重启后列表还在）', /loadAutoOffEvents\(\);/.test(src));
  check('有明细接口 /api/auto-off', /'\/api\/auto-off'/.test(src));
  check('有清空接口', /'\/api\/auto-off\/clear'/.test(src));
  check('界面有异常检查板块', fs.readFileSync(path.join(root, 'web', 'index.html'), 'utf8')
    .includes('id="ao-table"'));
}

console.log(out.join('\n'));
console.log('RESULT ' + (out.filter((l) => l.startsWith('PASS')).length) + ' PASS / ' + bad + ' FAIL');
process.exit(bad ? 1 : 0);
