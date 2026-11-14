// 只读健康检查：读 ready.json 拿端口，再抓 /api/state 与 /api/log 尾部。
// 用法： node tools/health.js   （结果写 %TEMP%\cuk_health.txt，避免控制台编码问题）
const http = require('http');
const fs = require('fs');
const path = require('path');

const APP = path.join(__dirname, '..');
const READY = path.join(APP, 'data', 'ready.json');
const OUT = path.join(process.env.TEMP || '.', 'cuk_health.txt');

function get(port, p) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: p, timeout: 6000 }, (r) => {
      let s = '';
      r.setEncoding('utf8');
      r.on('data', (d) => { s += d; });
      r.on('end', () => resolve(s));
    });
    req.on('error', reject);
    req.on('timeout', () => { try { req.destroy(); } catch (_) {} reject(new Error('timeout')); });
  });
}

(async () => {
  const out = [];
  let port = 0;
  try {
    const r = JSON.parse(fs.readFileSync(READY, 'utf8'));
    port = r.port;
    out.push('ready.json: port=' + r.port + ' pid=' + r.pid);
  } catch (e) {
    out.push('ready.json 读不到：' + e.message);
  }
  if (!port) { fs.writeFileSync(OUT, out.join('\n'), 'utf8'); return; }

  try {
    const st = JSON.parse(await get(port, '/api/state'));
    out.push('version=' + st.version);
    out.push('link=' + JSON.stringify(st.link));
    out.push('sample=' + JSON.stringify(st.sample || st.live || null));
    out.push('status=' + JSON.stringify(st.status || null).slice(0, 500));
    out.push('config=' + JSON.stringify(st.config || null));
  } catch (e) {
    out.push('/api/state 失败：' + e.message);
  }

  try {
    const lg = JSON.parse(await get(port, '/api/log'));
    out.push('--- log tail(15) ---');
    out.push(lg.lines.slice(-15).join('\n'));
  } catch (e) {
    out.push('/api/log 失败：' + e.message);
  }
  fs.writeFileSync(OUT, out.join('\n'), 'utf8');
})();
