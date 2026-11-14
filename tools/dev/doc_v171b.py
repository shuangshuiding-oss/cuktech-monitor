# -*- coding: utf-8 -*-
"""一次性脚本：文档同步「透明度滑块」（2026-10-05）。
用法: .venv/Scripts/python.exe tools/dev/doc_v171b.py
"""
import io

# ---------- 使用说明.txt（GBK + CRLF）----------
p = '使用说明.txt'
s = io.open(p, encoding='gbk').read()

old = """· **底色**三档循环（纯染色深浅，不再是系统材质）：
    深玻璃（默认）—— 半透明深色，窗外可辨、白字清晰
    浅透 —— 更透，适合深色壁纸
    不透明 —— 完全不透明，远程桌面/虚拟机/省电用这档"""
new = """· **透明度滑块**（顶栏右上「透 ──●── 56%」）：0 = 全透（窗外看得最清），
  100 = 完全不透明（远程桌面/虚拟机/省电用）。拖动**实时生效**，松手自动记住。
  出厂默认 56%。旧的"三档循环"已由滑块取代 —— 想多透就往左拉，想实一点往右拉。"""
assert old in s, '使用说明：找不到三档段'
s = s.replace(old, new)
s = s.replace('顶栏右侧是自绘的窗口按钮：底色档位 / 尺寸档位 / 最小化 / 全屏 / 关闭。',
              '顶栏右侧是自绘的窗口控件：透明度滑块 / 尺寸档位 / 最小化 / 全屏 / 关闭。')
s = s.replace('点「底色」按钮切到「不透明」；或以 --glass=solid 启动。',
              '把透明度滑块拉到 100%；或以 --glass=solid 启动。')
s = s.replace('\r\n', '\n').replace('\n', '\r\n')
io.open(p, 'w', encoding='gbk', newline='').write(s)
print('使用说明.txt ok')

# ---------- 软件介绍.md ----------
p = '软件介绍.md'
s = io.open(p, encoding='utf-8').read()
s = s.replace('底色三档可调（深玻璃 / 浅透 / 不透明）。',
              '透明度由顶栏滑块连续可调（0 = 全透 ~ 100 = 不透明，实时生效、自动记住）。')
io.open(p, 'w', encoding='utf-8', newline='\n').write(s)
print('软件介绍.md ok')
