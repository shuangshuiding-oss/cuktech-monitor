// 诊断：外壳的 additionalArguments 到底有没有传进渲染进程？
// 结果写 %TEMP%\_argv_probe.txt
'use strict';
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const OUT = path.join(process.env.TEMP || __dirname, '_argv_probe.txt');
const lines = [];
lines.push('main process.argv = ' + JSON.stringify(process.argv));

app.whenReady().then(async () => {
  const w = new BrowserWindow({
    width: 420, height: 300, show: false,
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: true,
      additionalArguments: ['--cuk-shell=electron'],
    },
  });
  await w.loadURL('about:blank');
  try {
    const r = await w.webContents.executeJavaScript(`JSON.stringify({
      argv: process.argv,
      hasFlag: process.argv.indexOf('--cuk-shell=electron') >= 0,
      argv0: process.argv[0],
      type: typeof process,
      versions: process.versions.electron,
    })`);
    lines.push('renderer = ' + r);
  } catch (e) {
    lines.push('renderer err = ' + e.message);
  }
  fs.writeFileSync(OUT, lines.join('\r\n'));
  app.quit();
});
