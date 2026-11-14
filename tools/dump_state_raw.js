'use strict';
/**
 * 只读：把 /api/state 的原始结构完整落盘，方便看「充电头到底报了什么」。
 * 用于排查「识别到的设备型号/协议」这类字段是否存在。
 * 用法：node tools/dump_state_raw.js
 */
const fs = require('fs');
const path = require('path');
const http = require('http');

const APP = path.join(__dirname, '..');
const OUT = path.join(process.env.TEMP || '.', 'cuk_state_raw.txt');

function readPort() {
  const j = JSON.parse(fs.readFileSync(path.join(APP, 'data', 'ready.json'), 'utf8'));
  return j.port || j;
}

function get(port, p) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: p, timeout: 8000 }, (res) => {
      let b = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { b += d; });
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

(async () => {
  const out = [];
  let port;
  try { port = readPort(); } catch (e) { console.log('no ready.json: ' + e.message); return; }
  out.push('port = ' + port);
  const st = await get(port, '/api/state');
  out.push('version = ' + st.version);
  out.push('link = ' + JSON.stringify(st.link));
  out.push('device = ' + JSON.stringify(st.device));
  out.push('autostart = ' + (st.config ? st.config.autostart : '?'));
  out.push('config = ' + JSON.stringify(st.config));
  const latest = st.latest || {};
  out.push('');
  out.push('--- latest.ports ---');
  for (const p of latest.ports || []) {
    out.push(JSON.stringify(p));
  }
  out.push('');
  out.push('--- latest.raw (设备应答的全部属性) ---');
  for (const it of latest.raw || []) {
    out.push('piid=' + it.piid + ' type=' + it.type + ' value=' + it.value +
      ' (0x' + (Number(it.value) >>> 0).toString(16) + ')' +
      ' status=' + it.status + ' raw=' + it.raw);
  }
  fs.writeFileSync(OUT, out.join('\n'), 'utf8');
  // 顺带把识别记录也带出来（每次新组合一行）
  try {
    const id = fs.readFileSync(path.join(APP, 'data', 'ident.log'), 'utf8');
    fs.appendFileSync(OUT, '\n--- data/ident.log ---\n' + id, 'utf8');
  } catch (_) { fs.appendFileSync(OUT, '\n--- data/ident.log ---\n(还没有)\n', 'utf8'); }
  console.log('written ' + OUT);
})().catch((e) => { console.log('ERR ' + e.message); });
