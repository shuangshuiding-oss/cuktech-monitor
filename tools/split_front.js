// 把 web/index.html 拆成 index.html + style.css + app.js（只做一次，幂等保护）。
//
// 为什么：原来 1162 行单文件，内联 CSS + 内联 JS，改一处要在 HTML 里滚很久。
// 拆分后仍然是普通 <link> / <script src>，零依赖、不需要任何构建步骤。
//
// 用法：node tools/split_front.js
// 原文件会备份到 tools/dev/index.html.inline.bak
const fs = require('fs');
const path = require('path');

const APP = path.resolve(__dirname, '..');
const WEB = path.join(APP, 'web');
const IDX = path.join(WEB, 'index.html');

let html = fs.readFileSync(IDX, 'utf8');

if (html.indexOf('<style>') < 0) {
  console.log('already split (no inline <style> found); nothing to do');
  process.exit(0);
}

const openStyle = '<style>';
const closeStyle = '</style>';
const openScript = '<script>';
const closeScript = '</script>';

const sOpen = html.indexOf(openStyle);
const sClose = html.indexOf(closeStyle, sOpen);
const jOpen = html.indexOf(openScript, sClose);
const jClose = html.lastIndexOf(closeScript);
if (sOpen < 0 || sClose < 0 || jOpen < 0 || jClose < 0) {
  console.error('marker not found: sOpen=%d sClose=%d jOpen=%d jClose=%d', sOpen, sClose, jOpen, jClose);
  process.exit(2);
}

const css = html.slice(sOpen + openStyle.length, sClose).replace(/^\s*\n/, '').replace(/\s*\n?\s*$/, '\n');
const js = html.slice(jOpen + openScript.length, jClose).replace(/^\s*\n/, '').replace(/\s*\n?\s*$/, '\n');

const bakDir = path.join(APP, 'tools', 'dev');
fs.mkdirSync(bakDir, { recursive: true });
fs.writeFileSync(path.join(bakDir, 'index.html.inline.bak'), html, 'utf8');

const cssHead = '/* 酷态科10号Ultra 界面样式 —— 从 index.html 里拆出来的。\n'
  + '   仍然是普通 <link rel="stylesheet">，零依赖、无需打包。 */\n\n';
const jsHead = '/* 酷态科10号Ultra 界面脚本 —— 从 index.html 里拆出来的。\n'
  + '   原先 1162 行单文件，改一处要在 HTML 里滚很久；现在分开放，\n'
  + '   仍然是普通 <script src>，没有引入任何构建步骤。 */\n\n';

fs.writeFileSync(path.join(WEB, 'style.css'), cssHead + css, 'utf8');
fs.writeFileSync(path.join(WEB, 'app.js'), jsHead + js, 'utf8');

const out = html.slice(0, sOpen)
  + '<link rel="stylesheet" href="style.css">'
  + html.slice(sClose + closeStyle.length, jOpen)
  + '<script src="app.js"></script>'
  + html.slice(jClose + closeScript.length);
fs.writeFileSync(IDX, out, 'utf8');

const before = html.split('\n').length;
const after = out.split('\n').length;
console.log('style.css  ' + css.split('\n').length + ' lines');
console.log('app.js     ' + js.split('\n').length + ' lines');
console.log('index.html ' + before + ' -> ' + after + ' lines');
console.log('backup     ' + path.join(bakDir, 'index.html.inline.bak'));
