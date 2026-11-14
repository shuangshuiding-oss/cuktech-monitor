'use strict';
/**
 * 只读地读 ready.json 里的端口，POST /api/quit 优雅退出应用。
 * 用法：node tools/quit_app.js
 */
const fs = require('fs');
const path = require('path');
const http = require('http');

const APP = path.join(__dirname, '..');
let port;
try {
  const j = JSON.parse(fs.readFileSync(path.join(APP, 'data', 'ready.json'), 'utf8'));
  port = j.port;
} catch (e) { console.log('没有 ready.json，应用可能没在跑：' + e.message); process.exit(0); }

const req = http.request({ host: '127.0.0.1', port, path: '/api/quit', method: 'POST', timeout: 5000 }, (res) => {
  res.resume();
  res.on('end', () => console.log('已请求退出，HTTP ' + res.statusCode + '（端口 ' + port + '）'));
});
req.on('timeout', () => { req.destroy(); console.log('超时'); });
req.on('error', (e) => console.log('ERR ' + e.message));
req.end();
