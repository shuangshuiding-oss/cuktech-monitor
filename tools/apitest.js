// 本轮新功能的接口自检（只读为主，只对 /api/yield 做了"开了立刻关"的往返）。
//
//   node tools\apitest.js
//
// 结果写 %TEMP%\cuk_apitest.txt；不动任何设备设置。
const http = require('http');
const fs = require('fs');
const path = require('path');

const APP = path.resolve(__dirname, '..');
const OUT = path.join(process.env.TEMP, 'cuk_apitest.txt');
const out = [];
const say = (m) => out.push(String(m));

function port() {
  return JSON.parse(fs.readFileSync(path.join(APP, 'data', 'ready.json'), 'utf8')).port;
}

function req(method, p, body) {
  return new Promise((resolve) => {
    const r = http.request(
      { host: '127.0.0.1', port: port(), path: p, method, timeout: 20000 },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, buf: Buffer.concat(chunks) }));
      },
    );
    r.on('error', (e) => resolve({ status: 0, error: e.message }));
    r.on('timeout', () => { try { r.destroy(); } catch (_) {} resolve({ status: 0, error: 'timeout' }); });
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

const getJson = async (p) => {
  const r = await req('GET', p);
  try { return JSON.parse(r.buf.toString('utf8')); } catch (_) { return { ok: false, error: 'parse fail ' + r.status }; }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 自动断言：以前这个脚本只"打印"，人得自己看 —— 于是漏掉了「≤1h 区间没走降采样，
// 一次下发 7000+ 个点」这种问题（打印出来是 rows=7200，一眼看不出对错）。
const asserts = [];
function expect(name, cond, extra) {
  const ok = !!cond;
  asserts.push(ok);
  say('  ' + (ok ? 'PASS' : 'FAIL') + '  断言: ' + name + (extra ? '   [' + extra + ']' : ''));
}

/** 等链路真的连上（采样/推送类断言的前置条件）。返回是否连上。 */
async function waitConnected(ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const st = await getJson('/api/state');
    if (st && st.link && st.link.state === 'connected') return true;
    await sleep(2000);
  }
  return false;
}

/** 挂上 SSE 通道收集 ms 毫秒的事件（顺手解析 event:/data: 两行）。 */
function sseWatch(ms, p) {
  return new Promise((resolve) => {
    const events = [];
    let hdrs = null;
    let code = 0;
    const r = http.request(
      { host: '127.0.0.1', port: port(), path: p || '/api/stream', method: 'GET' },
      (res) => {
        code = res.statusCode;
        hdrs = res.headers;
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          buf += chunk;
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, i);
            buf = buf.slice(i + 2);
            if (block.startsWith(':')) continue;           // 心跳注释帧
            const ev = (/^event:\s*(.+)$/m.exec(block) || [])[1];
            const data = (/^data:\s*(.+)$/m.exec(block) || [])[1];
            if (ev) events.push({ ev, data });
          }
        });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, events }));
      },
    );
    r.on('error', (e) => resolve({ status: 0, error: e.message, events }));
    setTimeout(() => {
      try { r.destroy(); } catch (_) {}
      resolve({ status: code || 200, headers: hdrs, events });
    }, ms);
    r.end();
  });
}

(async () => {
  say('port = ' + port());

  const ping = await getJson('/api/ping');
  say('ping: v=' + ping.v);

  const st = await getJson('/api/state');
  say('state: link=' + JSON.stringify(st.link));
  say('state: version=' + st.version);
  say('state: config=' + JSON.stringify(st.config));
  say('state: notices=' + JSON.stringify((st.notices || []).slice(-3)) + ' seq=' + st.noticeSeq);
  say('state: yield=' + JSON.stringify(st.yield));
  // 页面心跳：几秒内 = 界面活着；一直没有 = 没开窗口或页面脚本卡死了。
  const beatAge = st.pageBeatAt ? Math.round((Date.now() - st.pageBeatAt) / 1000) : null;
  say('state: 页面心跳 = ' + (beatAge == null ? '还没收到过（窗口没开 / 页面脚本卡住）' : beatAge + ' 秒前'));

  say('');
  say('--- 区间取数（说明书承诺：任何区间都 ≤400 点）---');
  for (const r of ['1m', '5m', '10m', '30m', '1h', '2h', '3h', '4h', '6h', '24h', '7d', '30d']) {
    const h = await getJson('/api/history?range=' + r);
    const rows = h.rows || [];
    say(`history range=${r}: source=${h.source} seconds=${h.seconds} rows=${rows.length}` +
      (rows.length ? ' firstAt=' + new Date(rows[0].at).toLocaleTimeString('zh-CN') +
        ' lastTotal=' + rows[rows.length - 1].total : ''));
    expect(r + ' 下发点数 ≤ 400', rows.length <= 400, 'len=' + rows.length);
    expect(r + ' 时间戳严格递增', rows.every((x, i) => i === 0 || x.at > rows[i - 1].at));
    if (r === '30m') expect('30m 区间秒数 = 1800', h.seconds === 1800, 'seconds=' + h.seconds);
  }
  const legacy = await getJson('/api/history?seconds=300');
  say('history legacy seconds=300: source=' + legacy.source + ' rows=' + (legacy.rows || []).length);
  expect('legacy seconds 参数也受 400 点上限约束', (legacy.rows || []).length <= 400,
    'len=' + (legacy.rows || []).length);

  for (const w of ['days', 'sessions', 'ports']) {
    const r = await req('GET', '/api/export?what=' + w);
    const txt = r.buf ? r.buf.toString('utf8') : '';
    const lines = txt.split('\r\n').filter(Boolean);
    const bom = r.buf && r.buf.length >= 3 && r.buf[0] === 0xEF && r.buf[1] === 0xBB && r.buf[2] === 0xBF;
    say(`export ${w}: status=${r.status} bom=${bom} rows=${Math.max(0, lines.length - 1)}`);
    say('   head: ' + lines.slice(0, 3).join(' | '));
    say('   disp: ' + (r.headers ? r.headers['content-disposition'] : '-'));
  }

  const lg = await getJson('/api/log');
  say('');
  say('--- log tail ---');
  for (const l of (lg.lines || []).slice(-18)) say('  ' + l);

  say('');
  say('--- history freshness（验证那个 10 秒缓存已经修掉）---');
  // 前置条件：必须真的在采。后面还有"让位往返"会把采集器重启、蓝牙重连要十几秒 ——
  // 所以**顺序很重要**：这条和下面 SSE 这条都必须在让位测试**之前**跑
  // （2026-09-22 就因为顺序颠倒，测了半天"蓝牙还在重连"）。
  const linked = await waitConnected(90000);
  say('链路状态: ' + (linked ? 'connected（开始测新鲜度）' : '仍未连接 —— 下面结果不可信'));
  const h1 = await getJson('/api/history?range=1m');
  await sleep(3000);
  const h2 = await getJson('/api/history?range=1m');
  const a1 = h1.rows && h1.rows.length ? h1.rows[h1.rows.length - 1].at : 0;
  const a2 = h2.rows && h2.rows.length ? h2.rows[h2.rows.length - 1].at : 0;
  say('1m rows: ' + (h1.rows || []).length + ' -> ' + (h2.rows || []).length +
    '   lastAt 前进了 ' + (a2 - a1) + ' ms / 3s');
  say(a2 > a1 ? 'PASS: /api/history 每次都拿到新数据' : 'FAIL: /api/history 还在返回旧缓存');

  say('');
  say('--- /api/stream（SSE 实时推送）---');
  const sv = await sseWatch(6500);
  say('status=' + sv.status + '  content-type=' + (sv.headers ? sv.headers['content-type'] : '-'));
  const counts = {};
  for (const e of sv.events) counts[e.ev] = (counts[e.ev] || 0) + 1;
  say('6.5 秒内收到: ' + JSON.stringify(counts));
  const samples = sv.events.filter((e) => e.ev === 'sample');
  if (samples.length) {
    const f = JSON.parse(samples[0].data);
    const l = JSON.parse(samples[samples.length - 1].data);
    const gap = Math.round((l.row.at - f.row.at) / Math.max(1, samples.length - 1));
    say('  首个 sample: at=' + new Date(f.row.at).toLocaleTimeString('zh-CN') +
      '  total=' + f.row.total + 'W  载荷含实时点=' + !!(f.latest && f.latest.ports));
    say('  相邻 sample 平均间隔 = ' + gap + ' ms（≈ 采样间隔即为正常）');
    say(samples.length >= 2 ? 'PASS: 推送通道在工作' : 'WARN: 样本太少');
  } else {
    say('FAIL: 6.5 秒内一个 sample 都没有 —— 推送没工作（先确认链路是 connected）');
  }

  // ⚠️ 破坏性测试放最后：让位会把采集器停掉再重启，之后十几秒内没有数据。
  say('');
  say('--- yield round trip（放最后：会重启采集器）---');
  const y1 = await req('POST', '/api/yield', { minutes: 1 });
  say('POST /api/yield {minutes:1} -> ' + y1.buf.toString('utf8'));
  await sleep(1500);
  const st2 = await getJson('/api/state');
  say('  link=' + st2.link.state + '  collecting=' + st2.collecting + '  yield=' + JSON.stringify(st2.yield));
  const y2 = await req('POST', '/api/yield', { cancel: true });
  say('POST /api/yield {cancel:true} -> ' + y2.buf.toString('utf8'));
  await sleep(3000);
  const st3 = await getJson('/api/state');
  say('  after cancel: link=' + st3.link.state + '  collecting=' + st3.collecting + '  yield=' + JSON.stringify(st3.yield));
  say(st2.collecting === false && st3.collecting === true
    ? 'PASS: 让位能停能收' : 'FAIL: 让位状态不对');
  expect('让位能停能收', st2.collecting === false && st3.collecting === true,
    'stop=' + st2.collecting + ' restart=' + st3.collecting);

  say('');
  const nFail = asserts.filter((x) => !x).length;
  say('自动断言：共 ' + asserts.length + ' 项，失败 ' + nFail + ' 项');
  fs.writeFileSync(OUT, out.join('\n'), 'utf8');
  fs.writeFileSync(OUT.replace(/\.txt$/, '.exit.txt'), String(nFail ? 1 : 0), 'utf8');
  console.log('written ' + OUT + '  failed=' + nFail);
  process.exitCode = nFail ? 1 : 0;
})();
