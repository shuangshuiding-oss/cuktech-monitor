// 收尾整理：
//  1) 打印根目录"纯数字名"残留文件的内容（十六进制 + 转义文本），不删
//  2) 删除 dist/ 下改名前的旧产物（可从源码重打，属本次改名产生的冗余）
//  3) 调 POST /api/shortcut，按新名字重建桌面快捷方式
// 结果写 %TEMP%\cuk_tidy.txt
const fs = require('fs');
const path = require('path');
const http = require('http');

const APP = path.join(__dirname, '..');
const DIST = path.join(APP, 'dist');
const OUT = path.join(process.env.TEMP || '.', 'cuk_tidy.txt');
const out = [];

function hex(buf, n) {
  return buf.slice(0, n).map((b) => b.toString(16).padStart(2, '0')).join(' ');
}
function esc(buf) {
  return Buffer.from(buf).toString('utf8').replace(/[^\x20-\x7e\u4e00-\u9fff]/g, '·');
}

out.push('== 1) 纯数字名残留文件 ==');
for (const e of fs.readdirSync(APP, { withFileTypes: true })) {
  if (!/^\d+$/.test(e.name)) continue;
  const p = path.join(APP, e.name);
  const buf = fs.readFileSync(p);
  out.push(`${e.name}  ${buf.length} bytes`);
  out.push('  hex: ' + hex(buf, 48));
  out.push('  txt: ' + esc(buf));
}

out.push('');
out.push('== 2) dist 清理 ==');
const OLD = ['酷态科充电监视器', '酷态科充电监视器-便携版.zip'];
for (const name of OLD) {
  const p = path.join(DIST, name);
  if (!fs.existsSync(p)) { out.push('跳过（不存在）：' + name); continue; }
  try {
    fs.rmSync(p, { recursive: true, force: true });
    out.push('已删除：' + name);
  } catch (e) { out.push('删除失败：' + name + ' → ' + e.message); }
}
for (const e of fs.readdirSync(DIST, { withFileTypes: true })) {
  out.push('保留：' + (e.isDirectory() ? 'DIR ' : 'FILE') + ' ' + e.name);
}

out.push('');
out.push('== 3) 重建桌面快捷方式 ==');
const readyPath = path.join(APP, 'data', 'ready.json');
let port = 0;
try { port = JSON.parse(fs.readFileSync(readyPath, 'utf8')).port; } catch (_) {}

(async () => {
  if (!port) out.push('拿不到端口，跳过');
  else {
    const body = await new Promise((resolve) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/api/shortcut', method: 'POST', timeout: 20000 }, (r) => {
        let s = ''; r.setEncoding('utf8');
        r.on('data', (d) => { s += d; });
        r.on('end', () => resolve(s));
      });
      req.on('error', (e) => resolve('ERR ' + e.message));
      req.on('timeout', () => { try { req.destroy(); } catch (_) {} resolve('ERR timeout'); });
      req.end();
    });
    out.push('响应：' + body);
    try {
      const d = path.join(process.env.USERPROFILE, 'Desktop');
      for (const f of fs.readdirSync(d)) if (/酷态科/.test(f)) out.push('桌面：' + f);
    } catch (e) { out.push('列桌面失败：' + e.message); }
  }
  fs.writeFileSync(OUT, out.join('\n'), 'utf8');
})();
