// 只读调研：给「还能优化什么」做事实底稿
const fs = require('fs');
const path = require('path');
const ROOT = "C:\\Users\\shuan\\Tools\\CuktechMonitor";
const OUT = path.join(process.env.TEMP, 'cuk_review.txt');
const out = [];
const p = (...a) => out.push(...a.map(String));
const SKIP = new Set(['.venv', 'node_modules', '.git', 'dist', 'data', '__pycache__']);

function walk(dir, depth) {
  if (depth > 4) return;
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { p('ERR ' + dir + ' ' + e.message); return; }
  for (const e of ents) {
    if (SKIP.has(e.name)) continue;
    const full = path.join(dir, e.name);
    const rel = path.relative(ROOT, full).replace(/\\/g, '/');
    if (e.isDirectory()) { p('[D] ' + rel + '/'); walk(full, depth + 1); }
    else {
      let n = 0, sz = 0;
      const ext = path.extname(e.name).toLowerCase();
      try {
        sz = fs.statSync(full).size;
        if (['.js', '.py', '.html', '.css', '.ps1', '.bat', '.json', '.txt', '.md'].includes(ext)) {
          const t = fs.readFileSync(full, 'utf8').replace(/\r/g, '');
          n = t.split('\n').length;
        }
      } catch (_) {}
      p('[F] ' + rel.padEnd(52) + ' ' + String(sz).padStart(9) + ' B' + (n ? '  ' + String(n).padStart(5) + ' lines' : ''));
    }
  }
}
p('================ TREE ================');
walk(ROOT, 0);

p('', '================ DATA DIR ================');
try {
  for (const e of fs.readdirSync(path.join(ROOT, 'data'), { withFileTypes: true })) {
    const full = path.join(ROOT, 'data', e.name);
    const sz = e.isDirectory() ? '-' : fs.statSync(full).size;
    p((e.isDirectory() ? '[D] ' : '[F] ') + e.name.padEnd(30) + ' ' + sz);
  }
} catch (e) { p('ERR ' + e.message); }

p('', '================ DIST ================');
try { for (const e of fs.readdirSync(path.join(ROOT, 'dist'))) p(e); } catch (e) { p('ERR ' + e.message); }

p('', '================ server.js ROUTES ================');
try {
  const s = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8').split(/\r?\n/);
  s.forEach((l, i) => {
    if (/\/api\//.test(l) && /(===|startsWith|url\s*===|path\s*===|case\s+')/.test(l)) p((i + 1) + ': ' + l.trim().slice(0, 130));
  });
} catch (e) { p('ERR ' + e.message); }

p('', '================ TODO / FIXME / HACK ================');
function scanTodo(dir, depth) {
  if (depth > 4) return;
  let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
  for (const e of ents) {
    if (SKIP.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { scanTodo(full, depth + 1); continue; }
    if (!/\.(js|py|html|css|ps1)$/i.test(e.name)) continue;
    let t; try { t = fs.readFileSync(full, 'utf8'); } catch (_) { continue; }
    t.split(/\r?\n/).forEach((l, i) => {
      if (/\b(TODO|FIXME|HACK|XXX|待办|未实现|暂时|临时)\b/i.test(l)) {
        p(path.relative(ROOT, full).replace(/\\/g, '/') + ':' + (i + 1) + '  ' + l.trim().slice(0, 120));
      }
    });
  }
}
scanTodo(ROOT, 0);

p('', '================ web/index.html SECTIONS ================');
try {
  const h = fs.readFileSync(path.join(ROOT, 'web', 'index.html'), 'utf8').split(/\r?\n/);
  h.forEach((l, i) => {
    if (/^\s*(\/\/\s*=|<section|<!--\s*=|id="[a-zA-Z-]+")/.test(l) || /function\s+\w+\s*\(/.test(l)) {
      p((i + 1) + ': ' + l.trim().slice(0, 120));
    }
  });
} catch (e) { p('ERR ' + e.message); }

p('', '================ collector.py TOP-LEVEL ================');
try {
  const c = fs.readFileSync(path.join(ROOT, 'collector.py'), 'utf8').split(/\r?\n/);
  c.forEach((l, i) => { if (/^(def |class |[A-Z_]{3,} *=)/.test(l)) p((i + 1) + ': ' + l.trim().slice(0, 120)); });
} catch (e) { p('ERR ' + e.message); }

p('', '================ version / package.json ================');
try { p(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')); } catch (e) { p('ERR ' + e.message); }

fs.writeFileSync(OUT, out.join('\n'), 'utf8');
console.log('written ' + OUT + ' (' + out.length + ' lines)');
