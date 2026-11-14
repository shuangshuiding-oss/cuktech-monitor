// 「双击桌面快捷方式打不开」的离线回归（2026-10-08 用户报）。
//
// 现场：桌面快捷方式 → 启动酷态科10号Ultra.bat → node server.js。
//   · 软件其实**已经在跑**（窗口被关了、只剩托盘在），8799 被它占着；
//   · 老代码的接管判据只有 /api/ping（1.2 秒超时），老实例一忙就判 false →
//     于是又起一个实例 → 撞端口 → 顺延 → 落在 Windows 保留端口 8800 → EACCES → 退出；
//   · bat 还在等 ready.json，15 秒后报「未能启动」——用户看到的就是「快捷方式打不开」。
//
// 本次修法：
//   ① 接管判据改成「lock 里的 pid 还活着」或「HTTP 探活有应答」，探活超时放宽到 2.5 秒；
//   ② 端口表换掉落在 `netsh int ipv4 show excludedportrange` 里的 8800；顺延判据连带认 EACCES；
//   ③ 接管成功要把 ready.json 写回（带 reused 标记），bat 才不会报「启动失败」；
//   ④ /api/show 从 POST 块提到顶层（老版本 GET 会 404）。
//
// 2026-10-09 第二次报「我电脑上的打不开了」——判据①里的 "pid 还活着" 被 **PID 回收**骗了：
//   服务（pid 17372）下午退出，Windows 把该 pid 回收给 msedgewebview2.exe；
//   process.kill(17372,0) 照样成功 ⇒ 每次双击都判"已在运行"⇒ 开一个指向死端口的空壳 ⇒ 打不开。
// 本次修法（⑤⑥）：
//   ⑤ 探活失败时**必须**再看心跳文件 alive.json（运行中的服务每 5 秒刷一次）——
//      心跳停 = 那个进程真没了，pid 现在是谁的都不算数；
//   ⑥ 残留 lock 被识破时写一条日志（否则下次同样"查不下去"）。
//
// 用法: node tools/test_singleton.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const root = path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'server.js'), 'utf8');

const out = [];
let bad = 0;
const check = (name, cond, extra) => {
  if (!cond) bad++;
  out.push((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '   — ' + extra : ''));
};

function extractFn(text, name) {
  let start = text.indexOf('function ' + name + '(');
  if (start < 0) return null;
  if (text.slice(Math.max(0, start - 6), start) === 'async ') start -= 6;   // await 要跟着 async
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

/** 一个只会应答 /api/ping 与 /api/show 的"假实例"。 */
function makeFake() {
  const hits = { ping: 0, showPost: 0, showGet: 0 };
  const srv = http.createServer((req, res) => {
    const p = String(req.url || '').split('?')[0];
    res.setHeader('Content-Type', 'application/json');
    if (p === '/api/ping') { hits.ping++; return res.end(JSON.stringify({ ok: true, v: '9.9.9-test' })); }
    if (p === '/api/show') {
      if (req.method === 'POST') hits.showPost++; else hits.showGet++;
      return res.end(JSON.stringify({ ok: true, shell: 'fake' }));
    }
    res.statusCode = 404; res.end('{}');
  });
  return { srv, hits };
}
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
const close = (srv) => new Promise((r) => { try { srv.close(() => r()); } catch (_) { r(); } });

(async function main() {
  // ---- 1. 静态：端口表 / 顺延判据 / 路由层级 / 接管与 listen 的先后 ----
  const portsM = /const PREFERRED_PORTS = \[([^\]]*)\]/.exec(src);
  const ports = portsM ? portsM[1].split(',').map((s) => Number(s.trim())).filter(Number.isFinite) : [];
  // 本机 `netsh int ipv4 show excludedportrange protocol=tcp` 里的几个（绑上去是 EACCES，不是 EADDRINUSE）
  const RESERVED = [5357, 8000, 8200, 8800, 8821, 8850, 27339];
  check('候选端口表能解析出来', ports.length >= 3, ports.join(','));
  check('候选端口不含系统保留段（8000/8200/8800/8821/8850…）',
    ports.length > 0 && !ports.some((p) => RESERVED.includes(p)), ports.join(','));
  check('顺延判据同时认 EADDRINUSE 与 EACCES',
    /err\.code === 'EADDRINUSE' \|\| err\.code === 'EACCES'/.test(src));
  check('listen 失败日志写出真实错误码（EACCES 不再显得像"端口被占"）',
    /被占用或保留（\$\{err\.code\}）/.test(src));
  const iShow = src.indexOf("if (p === '/api/show')");
  const iPost = src.indexOf("if (req.method === 'POST')");
  check('/api/show 在顶层（不在 POST 块里，GET 也能用）', iShow > 0 && iPost > 0 && iShow < iPost,
    'show@' + iShow + ' post@' + iPost);
  const iAttach = src.indexOf('if (await attachToRunning())');
  const iListen = src.indexOf('  tryListen();');
  check('接管判断排在 tryListen 之前', iAttach > 0 && iListen > 0 && iAttach < iListen,
    'attach@' + iAttach + ' listen@' + iListen);
  check('openWindow 支持显式目标端口（接管时本进程还没 listen）',
    /function openWindow\(url, targetPort\)/.test(src) && /targetPort \|\| \(server\.address\(\)/.test(src));
  check('DATA 可用环境变量覆盖（测试得在临时目录里跑，别弄坏真 lock）',
    /process\.env\.CUKTECH_DATA \|\|/.test(src));

  // ---- 1.5 心跳（v1.8.22）：光有 pidAlive 会被 PID 回收骗，必须有第二个证据 ----
  check('有独立的心跳文件（不是复用 running.lock）',
    /const ALIVE = path\.join\(DATA, 'alive\.json'\)/.test(src)
    && /const ALIVE_EVERY_MS = \d+/.test(src) && /const ALIVE_FRESH_MS = \d+/.test(src));
  check('服务启动时开心跳、退出时删心跳（不删会让下次启动误判"还有实例在跑"）',
    /startAlive\(\);\s*\/\/ 心跳/.test(src)
    && /stopAlive\(\);\s*\/\/ 心跳必须跟着删/.test(src)
    && /fs\.renameSync\(tmp, ALIVE\)/.test(src));
  check('探活失败时**必须**过心跳，不能只凭 pid 就认（否则 PID 回收 = 用户打不开）',
    /if \(!pidAlive\(lk\.pid\)\) return null;/.test(src)
    && /if \(!aliveFresh\(lk\.pid\)\) return null;/.test(src));
  check('残留 lock 被识破时留日志（不然下次还是"查不下去"）',
    /残留的 running\.lock 指向 pid/.test(src));
  check('认的依据写进日志（探活应答 / 心跳，一眼分辨对方是"在跑"还是"忙"）',
    /依据：\$\{hit\.why === 'probe' \? '探活应答' : '心跳，对方正忙'\}/.test(src));

  // ---- 2. 行为：抠出判定助手单独求值 ----
  const fns = ['probe', 'pidAlive', 'aliveFresh', 'resolveRunningInstance'].map((n) => extractFn(src, n));
  check('四个判定函数都切出来了', fns.every(Boolean), fns.map((f) => (f ? 'ok' : 'missing')).join('/'));
  // aliveFresh 依赖 ALIVE / ALIVE_FRESH_MS 两个模块级常量，测试里给一份临时文件顶上
  const aliveFile = path.join(os.tmpdir(), 'cuk-alive-test-' + process.pid + '.json');
  const api = new Function('http', 'fs', 'ALIVE', 'ALIVE_FRESH_MS',
    "const VERSION = '1.8.6-test';\n" + fns.join('\n')
    + '\nreturn { probe, pidAlive, aliveFresh, resolveRunningInstance };')(
    http, fs, aliveFile, 30000);

  check('pidAlive(自己) = true', api.pidAlive(process.pid) === true);
  check('pidAlive(不存在的 pid) = false', api.pidAlive(999999999) === false);

  // ---- ★ PID 回收：这就是 2026-10-09「打不开」的根因，单独钉一条 ----
  try { fs.unlinkSync(aliveFile); } catch (_) {}
  check('心跳文件不存在时 aliveFresh = false（老版本没写过心跳，也认作"不是它"）',
    api.aliveFresh(process.pid) === false);
  fs.writeFileSync(aliveFile, JSON.stringify({ pid: process.pid, hb: Date.now() }));
  check('心跳新鲜 + pid 对得上 → true（忙碌中的实例，不能另起一个）',
    api.aliveFresh(process.pid) === true);
  check('心跳新鲜但 pid 对不上 → false（别人的心跳，不算数）',
    api.aliveFresh(process.pid + 1) === false);
  fs.writeFileSync(aliveFile, JSON.stringify({ pid: process.pid, hb: Date.now() - 10 * 60 * 1000 }));
  check('心跳是 10 分钟前的 → false（进程早没了，pid 多半已被回收）',
    api.aliveFresh(process.pid) === false);
  fs.writeFileSync(aliveFile, '{ 半个 JSON');
  check('心跳文件写坏了 → false（宁可按新实例启动，也不能卡住用户）',
    api.aliveFresh(process.pid) === false);

  const fake = makeFake();
  const fakePort = await listen(fake.srv);
  const st = await api.probe(fakePort);
  check('probe 能拿到假实例的应答（含版本号）', !!st && st.v === '9.9.9-test', JSON.stringify(st));

  const dead = http.createServer(() => {});
  const deadPort = await listen(dead);
  await close(dead);
  check('probe 对没人听的端口返回 null（不抛异常）', (await api.probe(deadPort)) === null, 'port=' + deadPort);

  const hit1 = await api.resolveRunningInstance({ port: fakePort, pid: process.pid, at: Date.now() });
  check('活 pid + 有应答 → 认，并发现版本不一致（outdated）',
    !!hit1 && hit1.outdated === true && hit1.version === '9.9.9-test', JSON.stringify(hit1));
  check('认的依据标成 probe（探活应答是铁证）', !!hit1 && hit1.why === 'probe', hit1 && hit1.why);
  const hit2 = await api.resolveRunningInstance({ port: deadPort, pid: 999999999, at: Date.now() });
  check('死 pid + 没人听 → 不认（不能拦着正常启动）', hit2 === null, JSON.stringify(hit2));
  const hit3 = await api.resolveRunningInstance({ port: fakePort, pid: 999999999, at: Date.now() - 10 * 86400000 });
  check('陈年 lock（10 天前）→ 不认', hit3 === null, JSON.stringify(hit3));
  const hit4 = await api.resolveRunningInstance({ port: fakePort, pid: 999999999, at: Date.now() });
  check('pid 死了但端口上有同款程序应答 → 认（探活兜底）', !!hit4, JSON.stringify(hit4));
  // ★ 2026-10-09 的现场：探活失败 + pid 活着（其实已被回收）+ 心跳是陈的 → **必须不认**。
  //   这一条要是回退成 true，用户就会重新看到"双击没反应"。
  fs.writeFileSync(aliveFile, JSON.stringify({ pid: process.pid, hb: Date.now() - 30 * 60 * 1000 }));
  const hit5 = await api.resolveRunningInstance({ port: deadPort, pid: process.pid, at: Date.now() });
  check('★探活失败 + pid 活着但心跳是陈的 → 不认（PID 回收不再骗过我们）',
    hit5 === null, JSON.stringify(hit5));
  // 反过来：探活失败 + pid 活着 + 心跳新鲜 = 真的只是忙 → 必须认（否则会起第二个抢 BLE）
  fs.writeFileSync(aliveFile, JSON.stringify({ pid: process.pid, hb: Date.now() }));
  const hit6 = await api.resolveRunningInstance({ port: deadPort, pid: process.pid, at: Date.now() });
  check('探活失败 + pid 活着 + 心跳新鲜 → 认（忙碌中的实例，不能另起一个抢蓝牙）',
    !!hit6 && hit6.why === 'heartbeat', JSON.stringify(hit6));
  try { fs.unlinkSync(aliveFile); } catch (_) {}
  // 探活次数：st(1) + hit1(1) + hit4(1) + hit5(1) + hit6(1) = 5（hit2 探的是那个死端口；hit3 过期提前返回不探）
  check('判定过程确实探了活', fake.hits.ping >= 3, 'ping 次·' + fake.hits.ping);
  await close(fake.srv);

  // ---- 3. 端到端：临时 DATA 里造一个"已有实例"，真跑一次 server.js ----
  //     （server.js 的接管路径不会 boot()，所以不会起采集器/托盘/窗口 —— 不碰真实例）
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cuk-single-'));
  const fake2 = makeFake();
  const fp2 = await listen(fake2.srv);
  fs.writeFileSync(path.join(tmp, 'running.lock'),
    JSON.stringify({ port: fp2, pid: process.pid, at: Date.now() }));
  fs.writeFileSync(path.join(tmp, 'alive.json'),
    JSON.stringify({ pid: process.pid, hb: Date.now() }));

  const r = await new Promise((resolve) => {
    const ch = spawn(process.execPath, [path.join(root, 'server.js')], {
      cwd: root,
      env: Object.assign({}, process.env, {
        CUKTECH_DATA: tmp, CUKTECH_NO_WINDOW: '1', CUKTECH_NO_TRAY: '1',
      }),
      stdio: [ 'ignore', 'pipe', 'pipe' ],
    });
    let so = ''; let se = '';
    ch.stdout.on('data', (d) => { so += d; });
    ch.stderr.on('data', (d) => { se += d; });
    const t = setTimeout(() => { try { ch.kill(); } catch (_) {} resolve({ timeout: true, so, se, code: null }); }, 30000);
    ch.on('close', (code) => { clearTimeout(t); resolve({ code, so, se }); });
    ch.on('error', (e) => { clearTimeout(t); resolve({ spawnErr: String(e && e.message), so, se }); });
  });

  check('真跑 server.js：没有 spawn 失败', !r.spawnErr, r.spawnErr || '');
  check('识别出已有实例并正常退出（exit 0；老代码这里是 exit 1）',
    r.code === 0, 'code=' + r.code + (r.timeout ? '（超时被杀）' : ''));
  check('输出里告诉了用户"已经在运行"', /已经在运行/.test(r.so), (r.so || '').trim().slice(0, 110));
  check('接管路径没有自己去 listen（stdout 里没有"服务已启动"）',
    !/服务已启动/.test(r.so), (r.so || '').trim().slice(0, 110));
  const ready = (() => {
    try { return JSON.parse(fs.readFileSync(path.join(tmp, 'ready.json'), 'utf8')); } catch (_) { return null; }
  })();
  check('把 ready.json 写回（bat 才不会报"启动失败"）', !!ready && ready.reused === true, JSON.stringify(ready));
  check('ready.json 里带 upgrade 标记（bat 据此提示"运行中的是旧版"）',
    !!ready && !!ready.upgrade, ready && JSON.stringify(ready.upgrade));
  check('接管时请求了老实例的 /api/show，且走 POST（兼容老版本只认 POST 的路由）',
    fake2.hits.showPost >= 1, 'POST 次·' + fake2.hits.showPost + ' / GET 次·' + fake2.hits.showGet);

  await close(fake2.srv);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}

  console.log(out.join('\n'));
  console.log('RESULT ' + (out.length - bad) + ' PASS / ' + bad + ' FAIL');
  process.exit(bad ? 1 : 0);
})();
