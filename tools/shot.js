'use strict';
/**
 * Generic headless-screenshot helper (node-driven, because the session sandbox
 * cannot start GUI children from PowerShell).
 *   node tools/shot.js [url] [outPng] [height]
 *
 * ⚠️ DOES NOT WORK for the app's own page (http://127.0.0.1:<port>/).
 * That page holds an SSE stream (/api/stream) plus a rAF chart loop open, so
 * headless never reaches --virtual-time-budget and --screenshot hangs until it
 * is killed (verified 2026-09-22: spawnSync ETIMEDOUT after 120 s, no PNG).
 * For app-UI verification use tools/show_units.js instead — it lifts the real
 * conversion functions out of web/app.js and prints the exact numbers the panel
 * renders. Static pages (e.g. 软件介绍.html) screenshot fine with this script.
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const url = process.argv[2] || 'http://127.0.0.1:8799/';
const out = process.argv[3] || path.join(os.tmpdir(), 'shot.png');
const height = process.argv[4] || '2600';

const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
];
const exe = BROWSERS.find((p) => { try { return fs.existsSync(p); } catch (_) { return false; } });

const lines = [];
lines.push('browser=' + exe);
if (exe) {
  const tmp = path.join(os.tmpdir(), 'cukp_' + Date.now());
  fs.mkdirSync(tmp, { recursive: true });
  try { fs.rmSync(out, { force: true }); } catch (_) {}
  const args = [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--no-first-run', '--disable-extensions', '--mute-audio',
    '--screenshot=' + out,
    '--window-size=1340,' + height,
    '--virtual-time-budget=9000',
    '--user-data-dir=' + tmp,
    url,
  ];
  // spawnSync puts the exit code on .status -- there is NO .code. Writing r.code
  // always yields undefined, so `if (r.code !== 0)` is always true and the log
  // lies about failures. Keep the timeout short enough to stay under the
  // session's 120 s command limit, otherwise the tool kills us before we write.
  const r = spawnSync(exe, args, { timeout: 45000 });
  lines.push('status=' + r.status + '  signal=' + r.signal +
    '  error=' + (r.error ? String(r.error) : 'none'));
  lines.push('exists=' + fs.existsSync(out));
  if (fs.existsSync(out)) lines.push('bytes=' + fs.statSync(out).size);
  const err = (r.stderr || Buffer.alloc(0)).toString('utf8').trim();
  if (err) err.split(/\r?\n/).slice(-8).forEach((l) => lines.push('  | ' + l));
} else {
  lines.push('FAIL: no Edge/Chrome found');
}
const rep = path.join(os.tmpdir(), 'cuk_shot_result.txt');
fs.writeFileSync(rep, lines.join('\r\n'), 'utf8');
console.log(lines.join('\n'));
