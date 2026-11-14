// 收尾核查（只读）：当前时间、可疑无名文件、日志里的重连痕迹、dist 目录内容。
const fs = require('fs');
const path = require('path');

const APP = path.join(__dirname, '..');
const OUT = path.join(process.env.TEMP || '.', 'cuk_post.txt');
const out = [];

out.push('now = ' + new Date().toString());
out.push('now(iso) = ' + new Date().toISOString());

out.push('');
out.push('== 根目录可疑条目（纯数字名）==');
for (const e of fs.readdirSync(APP, { withFileTypes: true })) {
  if (/^\d+$/.test(e.name)) {
    const p = path.join(APP, e.name);
    const st = fs.statSync(p);
    let head = '';
    try { head = fs.readFileSync(p, 'utf8').slice(0, 200).replace(/\s+/g, ' '); } catch (_) { head = '(binary)'; }
    out.push(`${e.name}  ${st.size} bytes  mtime=${st.mtime.toLocaleString()}  head="${head}"`);
  }
}

out.push('');
out.push('== app.log 里的重连/异常痕迹（最后 4000 字符内）==');
try {
  const log = fs.readFileSync(path.join(APP, 'data', 'app.log'), 'utf8');
  const tail = log.slice(-4000);
  const hits = tail.split(/\r?\n/).filter((l) => /重连|重启|退出了|失败|错误|error|Error|reconnect/.test(l));
  out.push(hits.length ? hits.join('\n') : '(无)');
  const all = log.split(/\r?\n/).filter(Boolean);
  out.push('app.log 总行数=' + all.length + '  最后一行=' + all[all.length - 1]);
} catch (e) { out.push('ERR ' + e.message); }

out.push('');
out.push('== dist/ ==');
for (const e of fs.readdirSync(path.join(APP, 'dist'), { withFileTypes: true })) {
  const p = path.join(APP, 'dist', e.name);
  const st = fs.statSync(p);
  let extra = '';
  if (e.isDirectory()) {
    try { extra = ' files=' + fs.readdirSync(p).length; } catch (_) {}
  }
  out.push(`${e.isDirectory() ? 'DIR ' : 'FILE'} ${e.name}  ${st.size}  ${st.mtime.toLocaleString()}${extra}`);
}

out.push('');
out.push('== 桌面 .lnk ==');
try {
  const d = path.join(process.env.USERPROFILE || '', 'Desktop');
  for (const f of fs.readdirSync(d)) {
    if (/酷态科|Cuktech|cuktech/i.test(f)) {
      const st = fs.statSync(path.join(d, f));
      out.push(f + '  ' + st.size + '  ' + st.mtime.toLocaleString());
    }
  }
} catch (e) { out.push('ERR ' + e.message); }

fs.writeFileSync(OUT, out.join('\n'), 'utf8');
