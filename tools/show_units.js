'use strict';
/**
 * Print what the energy panel actually renders, using the REAL conversion
 * functions lifted out of web/app.js and the REAL numbers from /api/energy.
 *
 * Why not just screenshot the page? Headless Edge never settles on this page:
 * the UI keeps an SSE stream (/api/stream) plus a rAF chart loop open, so
 * --virtual-time-budget never expires and --screenshot hangs forever.
 *
 *   node tools/show_units.js [port]
 * Writes %TEMP%\cuk_units.txt
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const APP = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(APP, 'web', 'app.js'), 'utf8');

// Same extraction trick as tools/test_kwh.js: app.js is a browser script (no
// exports) so we lift the single-line `const` declarations by regex and eval.
const NAMES = ['CELL_V', 'scaleFix', 'fmtKwh', 'mahFix', 'grp', 'fmtMah', 'fmtDur'];
const found = [];
for (const n of NAMES) {
  const re = new RegExp('^const\\s+' + n + '\\s*=.*$', 'm');
  const m = src.match(re);
  if (!m) throw new Error('missing const ' + n);
  found.push(m[0]);
}
const fns = {};
new Function('exports', found.join('\n') + '\n' +
  'exports.CELL_V=CELL_V;exports.fmtKwh=fmtKwh;exports.fmtMah=fmtMah;' +
  'exports.mahFix=mahFix;exports.scaleFix=scaleFix;exports.grp=grp;exports.fmtDur=fmtDur;')(fns);

const port = Number(process.argv[2] || 0) ||
  (() => { try { return JSON.parse(fs.readFileSync(path.join(APP, 'data', 'ready.json'), 'utf8')).port; } catch (_) { return 8799; } })();

function get(p) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: p, timeout: 6000 }, (res) => {
      let b = '';
      res.on('data', (d) => { b += d; });
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout ' + p)); });
    req.on('error', reject);
  });
}

const lines = [];
const row = (label, wh) => lines.push(
  '  ' + label.padEnd(16) + fns.fmtKwh(wh).padStart(10) + ' 度   ' +
  Number(wh || 0).toFixed(3).padStart(10) + ' Wh   ' + fns.fmtMah(wh).padStart(12) + ' mAh');

(async () => {
  const e = await get('/api/energy');
  lines.push('port=' + port + '  CELL_V=' + fns.CELL_V + '  (mAh = Wh / 3.7 * 1000)');
  lines.push('');
  lines.push('== 用电信息三格（大数字=度，副行=Wh · mAh）==');
  row('今日', e.today && e.today.wh);
  row('累计', e.totalWh);
  const cur = e.current || {};
  row('本次会话', cur.wh !== undefined ? cur.wh : cur.totalWh);
  lines.push('');
  lines.push('== 每个口（本次充电 / 今日）==');
  for (const id of ['c1', 'c2', 'c3', 'a']) {
    const label = ({ c1: 'C1', c2: 'C2', c3: 'C3', a: 'USB-A' })[id];
    const wh = (e.ports && e.ports[id]) || 0;
    row(label, wh);
  }
  lines.push('');
  lines.push('== 正在充的（plugsLive，端口卡「本次充电」旁会带时长）==');
  const live = e.plugsLive || [];
  if (!live.length) lines.push('  （当前没有口在充电）');
  for (const g of live) row(g.label + ' 充电中', g.wh);
  for (const g of live) lines.push('    ' + g.label + ' 已充 ' + fns.fmtDur(g.ms) + '  (ms=' + g.ms + ')');
  lines.push('');
  lines.push('== 插拔记录（plugs）共 ' + ((e.plugs && e.plugs.length) || 0) + ' 条 ==');
  for (const g of (e.plugs || []).slice(0, 8)) {
    lines.push('  ' + String(g.label).padEnd(6) + new Date(g.start).toLocaleString('zh-CN') + '  ' +
      fns.fmtKwh(g.wh) + ' 度 · ' + Number(g.wh).toFixed(3) + ' Wh · ' + fns.fmtMah(g.wh) + ' mAh · ' + fns.fmtDur(g.ms));
  }
  const out = lines.join('\r\n');
  fs.writeFileSync(path.join(os.tmpdir(), 'cuk_units.txt'), out, 'utf8');
  console.log(out);
})().catch((err) => {
  const t = 'ERR ' + (err && err.message);
  fs.writeFileSync(path.join(os.tmpdir(), 'cuk_units.txt'), t, 'utf8');
  console.log(t);
});
