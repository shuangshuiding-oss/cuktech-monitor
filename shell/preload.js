'use strict';

/**
 * 预加载脚本：把外壳需要的 IPC 能力**显式、最小化**地暴露给页面。
 *
 * 为什么必须有这个文件（2026-09-23 修）：
 *   主窗口开的是 contextIsolation:true + nodeIntegration:false，渲染进程里
 *   **没有 require**。而 web/shell.js 原来直接写 `require('electron').ipcRenderer`，
 *   在真正的壳环境里会立刻抛错 —— 于是整个壳层（圆角/玻璃板/标题栏/拖动/
 *   玻璃档位/尺寸档位）全部静默失效。外观上只是"窗口是方的、右上一圈白边、
 *   按住拖不动"，根本联想不到是这里。
 *   （之前没暴露，是因为 ELECTRON_RUN_AS_NODE=1 让 Electron 退化成了纯 Node，
 *    渲染进程压根没起来，两个问题叠在一起，互相掩盖。）
 *
 * 暴露面刻意收窄：只给页面这几个动作，且每个都在主进程里有对应的 handler。
 * 不暴露 ipcRenderer 本身、不暴露任意通道名 —— 页面拿不到执行任意 IPC 的能力。
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('__CUK_SHELL__', true);

contextBridge.exposeInMainWorld('cukShell', {
  // 拖动：三个动作，坐标是屏幕绝对坐标
  dragStart: (pt) => ipcRenderer.send('cuk:drag-start', pt),
  dragMove: (pt) => ipcRenderer.send('cuk:drag-move', pt),
  dragEnd: () => ipcRenderer.send('cuk:drag-end'),
  // 告诉主进程，页面上量出来的圆角实际是多少像素（原生蒙版要用同一个数）
  radius: (px) => ipcRenderer.send('cuk:radius', { px }),

  // 窗口控制
  minimize: () => ipcRenderer.invoke('cuk:minimize'),
  toggleMax: () => ipcRenderer.invoke('cuk:toggle-max'),
  close: () => ipcRenderer.invoke('cuk:close'),
  setOpacity: (v) => ipcRenderer.invoke('cuk:set-opacity', v),
  // 失焦档（0~100；null = 跟随聚焦）。第二参 {preview:true} = 拖动时当场预览整窗 alpha。
  setOpacityBlur: (v, o) => ipcRenderer.invoke('cuk:set-opacity-blur', v, o),
  setTheme: (t) => ipcRenderer.invoke('cuk:set-theme', t),
  setSize: (name) => ipcRenderer.invoke('cuk:set-size', name),
  info: () => ipcRenderer.invoke('cuk:info'),
  shot: (name) => ipcRenderer.invoke('cuk:shot', name),
  // 自检 / 兜底判定用：查一下"窗外到底是不是活的"（走像素采样，见主进程说明）
  transCheck: () => ipcRenderer.invoke('cuk:trans-check'),
});
