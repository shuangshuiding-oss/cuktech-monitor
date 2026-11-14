// 二次清理：
//  - 删掉两个 14 字节的 UTF-16 数字残留文件（1392 / 3440）
//  - 重试删除 dist/酷态科充电监视器（先清只读属性，再带重试）
const fs = require('fs');
const path = require('path');

const APP = path.join(__dirname, '..');
const DIST = path.join(APP, 'dist');
const OUT = path.join(process.env.TEMP || '.', 'cuk_tidy2.txt');
const out = [];

for (const name of ['1392', '3440']) {
  const p = path.join(APP, name);
  if (!fs.existsSync(p)) { out.push('已不存在：' + name); continue; }
  try { fs.rmSync(p, { force: true }); out.push('已删除残留文件：' + name); }
  catch (e) { out.push('删除失败：' + name + ' → ' + e.code); }
}

function clearReadonly(dir) {
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    try {
      if (e.isDirectory()) n += clearReadonly(p);
      else { const st = fs.statSync(p); if (!(st.mode & 0o200)) { fs.chmodSync(p, 0o666); n++; } }
    } catch (_) {}
  }
  return n;
}

const target = path.join(DIST, '酷态科充电监视器');
if (!fs.existsSync(target)) out.push('旧目录已不存在');
else {
  let freed = 0;
  try {
    let n = 0;
    const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else { try { if (!(fs.statSync(p).mode & 0o200)) { fs.chmodSync(p, 0o666); n++; } } catch (_) {} } } };
    walk(target);
    out.push('清掉只读属性文件数：' + n);
  } catch (e) { out.push('清只读失败：' + e.message); }

  for (let i = 1; i <= 4; i++) {
    try { fs.rmSync(target, { recursive: true, force: true, maxRetries: 3 }); out.push('第 ' + i + ' 次删除成功'); freed = 1; break; }
    catch (e) { out.push('第 ' + i + ' 次失败：' + e.code + ' ' + e.message.split('\n')[0]); }
  }
  if (!freed) {
    try {
      const walk2 = (d, base) => { let s = 0; for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); s += e.isDirectory() ? walk2(p, base + '/' + e.name) : fs.statSync(p).size; } return s; };
      out.push('残留目录大小 ≈ ' + (walk2(target, '') / 1048576).toFixed(1) + ' MB');
      out.push('残留顶层条目：' + fs.readdirSync(target).slice(0, 12).join(', '));
    } catch (e) { out.push('统计失败：' + e.message); }
  }
}

out.push('');
out.push('dist 现状：');
for (const e of fs.readdirSync(DIST, { withFileTypes: true })) {
  const st = fs.statSync(path.join(DIST, e.name));
  out.push((e.isDirectory() ? 'DIR ' : 'FILE') + ' ' + e.name + '  ' + st.size + '  ' + st.mtime.toLocaleString());
}
out.push('');
out.push('根目录现状：');
for (const e of fs.readdirSync(APP, { withFileTypes: true })) out.push((e.isDirectory() ? 'DIR  ' : 'FILE ') + e.name);

fs.writeFileSync(OUT, out.join('\n'), 'utf8');
