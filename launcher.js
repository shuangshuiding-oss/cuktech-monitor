'use strict';

/**
 * 应用窗口启动器。
 * 用 Edge / Chrome 的 --app 模式打开界面：无地址栏、无标签页、独立任务栏图标，
 * 观感等同原生桌面应用。找不到 Chromium 系浏览器时回退到系统默认浏览器。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  path.join(os.homedir(), 'AppData\\Local\\Google\\Chrome\\Application\\chrome.exe'),
  path.join(os.homedir(), 'AppData\\Local\\Microsoft\\Edge\\Application\\msedge.exe'),
];

function findBrowser() {
  for (const p of BROWSERS) {
    try { if (fs.existsSync(p)) return p; } catch (_) {}
  }
  return null;
}

function launchWindow(url, onLog) {
  const say = typeof onLog === 'function' ? onLog : () => {};
  if (process.env.CUKTECH_NO_WINDOW === '1') {
    say('已跳过窗口启动（测试模式）');
    return { browser: null, pid: 0 };
  }
  const browser = findBrowser();

  const child = (() => {
    if (!browser) {
      say('未找到 Edge/Chrome，改用系统默认浏览器打开');
      // windowsHide 必须为 false —— true 会给子进程传 SW_HIDE，
      // Chromium 主窗口会被隐藏（进程在跑但窗口看不见）。
      return spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: false });
    }
    const profile = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'CuktechMonitor', 'browser');
    try { fs.mkdirSync(profile, { recursive: true }); } catch (_) {}
    const args = [
      `--app=${url}`,
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=msEdgeFirstRunExperience,msEdgeSidebarV2,msEdgeIdentityFeature',
      '--window-size=1360,940',
      '--window-position=100,40',
    ];
    say('正在打开应用窗口：' + path.basename(browser));
    return spawn(browser, args, { detached: true, stdio: 'ignore', windowsHide: false });
  })();

  child.unref();
  return { browser, pid: child.pid };
}

module.exports = { launchWindow, findBrowser };
