// 离屏截一张网页 —— 给"改完样式自己看一眼"用。
//
// 为什么不直接用无头 Edge：本项目的页面有**常驻 SSE**（/api/stream），无头 Edge
// 截出来常常是空白；而项目自带 Electron（外壳就是它），用它渲染最接近真实观感。
//
// 用法:
//   electron tools/dev/shot_page.js [url] [out.png] [width] [height] [waitMs]
// 例:
//   node_modules\electron\dist\electron.exe tools\dev\shot_page.js ^
//     "http://127.0.0.1:8799/" "%TEMP%\page.png" 1360 900 6000
//
// 注：这截的是**浏览器里的页面**（没有 .winbar 那条拖动栏，那是壳里才有的）。
//     要看壳里的真实窗口，用外壳自带的探针口：curl "http://127.0.0.1:8810/shot?name=x"。
'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const url = process.argv[2] || 'http://127.0.0.1:8799/';
const out = process.argv[3] || path.join(process.env.TEMP || '.', 'page_shot.png');
const W = Number(process.argv[4] || 1360);
const H = Number(process.argv[5] || 900);
const WAIT = Number(process.argv[6] || 5000);

app.disableHardwareAcceleration();          // 离屏截图不需要 GPU，省得在沙箱里闹脾气

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: W, height: H, show: false, frame: false,
    webPreferences: { backgroundThrottling: false },
  });
  try {
    await win.loadURL(url);
  } catch (e) {
    console.error('loadURL 失败: ' + (e && e.message));
    app.exit(2);
    return;
  }
  await new Promise((r) => setTimeout(r, WAIT));   // 等 SSE 首帧 + 数字动效落定
  try {
    const img = await win.webContents.capturePage();
    fs.writeFileSync(out, img.toPNG());
    const s = img.getSize();
    console.log('ok ' + out + '  ' + s.width + 'x' + s.height);
  } catch (e) {
    console.error('capturePage 失败: ' + (e && e.message));
    app.exit(3);
    return;
  }
  app.exit(0);
});
