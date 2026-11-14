'use strict';
/**
 * 验证「开机自启动」的完整往返：
 *   tray -> 启动文件夹里出现 .lnk（Arguments 应为 bg）
 *   window -> .lnk 仍在（Arguments 应为空）
 *   off -> .lnk 消失
 * 只在最后一步落到 off 或调用方指定的档位，避免意外改变用户的开机行为。
 * 用法：node tools/autostart_test.js [最终档位 off|tray|window]
 */
const fs = require('fs');
const path = require('path');
const http = require('http');

const APP = path.join(__dirname, '..');
const LNK = path.join(process.env.APPDATA || '', 'Microsoft', 'Windows',
  'Start Menu', 'Programs', 'Startup', '酷态科10号Ultra.lnk');
const FINAL = process.argv[2] || 'off';
const OUT = path.join(process.env.TEMP || '.', 'cuk_autostart.txt');
const lines = [];

function port() {
  return JSON.parse(fs.readFileSync(path.join(APP, 'data', 'ready.json'), 'utf8')).port;
}

function post(p, obj) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(obj);
    const req = http.request({
      host: '127.0.0.1', port: port(), path: p, method: 'POST', timeout: 20000,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let b = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { b += d; });
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(new Error(b.slice(0, 200))); } });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

(async () => {
  lines.push('lnk = ' + LNK);
  const step = async (mode) => {
    const r = await post('/api/autostart', { mode });
    const exists = fs.existsSync(LNK);
    lines.push(`POST mode=${mode} -> ok=${r.ok} mode=${r.mode} | .lnk 存在=${exists}`);
    return { r, exists };
  };

  await step('tray');
  await step('window');
  const last = await step('off');
  if (last.exists) lines.push('!! off 之后 .lnk 还在（删除失败）');

  if (FINAL !== 'off') {
    const f = await step(FINAL);
    lines.push('最终档位 = ' + f.r.mode);
  } else {
    lines.push('最终档位 = off');
  }
  fs.writeFileSync(OUT, lines.join('\n') + '\n', 'utf8');
  console.log('written ' + OUT);
})().catch((e) => { console.log('ERR ' + e.message); });
