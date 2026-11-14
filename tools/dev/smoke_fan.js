// 风扇链路的端到端冒烟测试（dev 工具，不进分发包）。
//
// 为什么要它：风扇这块改动跨了 server.js / login.py / fan_collector.py / 界面四处，
// 而"应用跑起来才看得见"的东西（/api/state 里 fan 段、/api/fan/* 路由、SSE 的 fan 事件）
// 在会话里没法靠双击 bat 验证 —— 这里在**临时数据目录**里真起一次 server.js，
// 只用 HTTP 打接口，全程不碰用户的 data\。
//
//   node tools\dev\smoke_fan.js
//
// 判据：起得来（没有启动即崩）、/api/state.fan 形状对、四个风扇接口都回得出话、
// 没登录时给的是 need-login 而不是异常。
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const APP = path.resolve(__dirname, '..', '..');
const NODE = process.execPath;
const DATA = path.join(os.tmpdir(), 'cuk_fan_smoke_' + Date.now());

let pass = 0, fail = 0;
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log('PASS  ' + label + (extra ? '   — ' + extra : '')); }
  else { fail++; console.log('FAIL  ' + label + (extra ? '   — ' + extra : '')); }
};

function req(port, method, urlPath, body) {
  return new Promise((resolve) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const r = http.request({
      host: '127.0.0.1', port, path: urlPath, method,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {},
      timeout: 60000,
    }, (res) => {
      let s = '';
      res.on('data', (d) => s += d);
      res.on('end', () => {
        let j = null;
        try { j = JSON.parse(s); } catch (_) {}
        resolve({ status: res.statusCode, body: s, json: j });
      });
    });
    r.on('error', (e) => resolve({ status: 0, body: '', json: null, error: e.message }));
    r.on('timeout', () => { try { r.destroy(); } catch (_) {} resolve({ status: 0, json: null, error: 'timeout' }); });
    if (data) r.write(data);
    r.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(DATA, { recursive: true });
  // 温度计关掉：临时目录里没有 env.json 时会用默认地址去连**真的**那台温湿度计，
  // 会和用户正在跑的应用抢蓝牙（BLE 一个中心独占）。这里明确禁用。
  fs.writeFileSync(path.join(DATA, 'env.json'),
    JSON.stringify({ address: '', interval: 90, enabled: false }));

  console.log('临时数据目录: ' + DATA);
  const child = spawn(NODE, [path.join(APP, 'server.js'), '--no-window'], {
    cwd: APP,
    env: Object.assign({}, process.env, {
      CUKTECH_DATA: DATA, CUKTECH_NO_WINDOW: '1', CUKTECH_NO_TRAY: '1',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = [];
  child.stdout.on('data', (d) => logs.push(String(d)));
  child.stderr.on('data', (d) => logs.push(String(d)));

  // 等 ready.json（服务起来会写端口）
  let port = 0;
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    try {
      const r = JSON.parse(fs.readFileSync(path.join(DATA, 'ready.json'), 'utf8'));
      if (r && r.port) { port = r.port; break; }
    } catch (_) {}
    if (child.exitCode != null) break;
  }
  ok(port > 0, '服务在 30 秒内就绪（ready.json）', 'port=' + port + ' / exitCode=' + child.exitCode);
  if (!port) {
    console.log(logs.join('').slice(-3000));
    try { child.kill(); } catch (_) {}
    return finish();
  }

  const st = await req(port, 'GET', '/api/state');
  ok(st.json && st.json.ok, 'GET /api/state', 'status=' + st.status);
  const fan = st.json && st.json.fan;
  ok(!!fan, 'state 里有 fan 段');
  ok(fan && fan.running === false, '没登录时风扇采集器不跑（不是异常退出）', 'running=' + (fan && fan.running));
  ok(fan && fan.link && fan.link.state === 'need-login', '没登录时状态是 need-login', 'link=' + JSON.stringify(fan && fan.link));
  ok(fan && typeof fan.interval === 'number', '风扇轮询间隔在状态里', 'interval=' + (fan && fan.interval));
  // 功率/电量/曲线 2026-10-11 整体删除 —— 守住 payload 里不许再冒出这几个字段
  ok(fan && fan.energy === undefined && fan.ratedW === undefined,
    '风扇 payload 里已经没有 energy / ratedW（推算功率电量已删）',
    JSON.stringify(Object.keys(fan || {})));
  ok(st.json && st.json.energy && Number.isFinite(st.json.energy.totalWh), '充电头用电量那一块没被碰坏');

  const hi = await req(port, 'GET', '/api/fan/history?range=1h');
  ok(hi.status === 404, '风扇曲线接口 /api/fan/history 已下线（404）', 'status=' + hi.status);

  const ctl = await req(port, 'POST', '/api/fan/control', { name: 'power', value: true });
  ok(ctl.json && ctl.json.ok === false && /采集器/.test(ctl.json.error || ''),
    '没跑采集器时控制命令给出明确原因', JSON.stringify(ctl.json && ctl.json.error));
  const ctlBad = await req(port, 'POST', '/api/fan/control', { name: 'nope', value: 1 });
  ok(ctlBad.status === 400, '未知属性返回 400', 'status=' + ctlBad.status);

  // 「刷新一次」：没跑采集器时必须**立刻**回一句人话，不能干等 8 秒再报超时
  // （以前采集器的 read 命令什么都不做、也不回 ack，这条接口永远是假失败 —— 2026-10-11 修）
  const t0 = Date.now();
  const rf = await req(port, 'POST', '/api/fan/refresh');
  const rfMs = Date.now() - t0;
  ok(rf.json && rf.json.ok === false && /采集器/.test(rf.json.error || ''),
    '没跑采集器时刷新给出明确原因', JSON.stringify(rf.json && rf.json.error));
  ok(rfMs < 1500, '刷新没跑采集器时立刻回话（不等超时）', rfMs + ' ms');

  const probe = await req(port, 'POST', '/api/fan/probe');
  ok(probe.status === 400 && /登录/.test((probe.json && probe.json.error) || ''),
    '没登录时自检给出「先登录」而不是崩', JSON.stringify(probe.json && probe.json.error));

  const disc = await req(port, 'POST', '/api/fan/discover');
  ok(disc.json && disc.json.ok && Array.isArray(disc.json.rows), '局域网广播发现能跑', 'rows=' + (disc.json && disc.json.rows && disc.json.rows.length));

  const cfg = await req(port, 'POST', '/api/fan/config', { interval: 3 });
  ok(cfg.json && cfg.json.ok && cfg.json.interval === 3, '风扇设置可写', JSON.stringify(cfg.json));
  const cfgBad = await req(port, 'POST', '/api/fan/config', { interval: 999 });
  ok(cfgBad.json && cfgBad.json.interval === 3, '越界设置被夹回合法值', 'interval=' + (cfgBad.json && cfgBad.json.interval));

  const st2 = await req(port, 'GET', '/api/state');
  ok(st2.json && st2.json.fan && st2.json.fan.interval === 3, '设置已生效并回读', 'interval=' + (st2.json && st2.json.fan && st2.json.fan.interval));

  const envp = await req(port, 'GET', '/api/env');
  ok(envp.json && typeof envp.json.available === 'boolean' && envp.json.running === false,
    '温度计接口没被碰坏（本轮环境里它是暂停的）', JSON.stringify(envp.json && { running: envp.json.running, enabled: envp.json.enabled }));
  const hist = await req(port, 'GET', '/api/history?range=1h');
  ok(hist.json && hist.json.ok, '功率曲线接口没被碰坏');

  try { child.kill(); } catch (_) {}
  await sleep(1200);
  console.log('--- 服务日志尾部 ---');
  console.log(logs.join('').split('\n').slice(-12).join('\n'));
  finish();

  function finish() {
    console.log('\n============================================================');
    console.log(`风扇冒烟测试：${pass} PASS / ${fail} FAIL`);
    console.log('（临时目录 ' + DATA + ' 可以随时删掉）');
    process.exit(fail ? 1 : 0);
  }
})();
