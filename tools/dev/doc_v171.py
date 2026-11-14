# -*- coding: utf-8 -*-
"""一次性脚本：更新三份文档的「窗口外观」说明（2026-10-05 玻璃改版）。
用法: .venv/Scripts/python.exe tools/dev/doc_v171.py
"""
import io

# ---------- 使用说明.txt（GBK + CRLF）----------
p = '使用说明.txt'
s = io.open(p, encoding='gbk').read()
old_seg_start = s.find('窗口外观（透明外壳 / 圆角 / 玻璃）')
assert old_seg_start > 0, '找不到旧段落标题'
seg_end = s.find('文件说明', old_seg_start)
assert seg_end > old_seg_start
# 「文件说明」标题前还有一条长分隔线，一并替换掉（新段落自带分隔线）
sep = s.rfind('────', old_seg_start, seg_end)
if sep > 0:
    seg_end = sep

new_seg = """窗口外观（透明外壳 / 圆角 / 底色）
──────────────────────────────────────────────
本版本起，窗口由 Electron 打开，会「透」出后面的桌面和其它程序：

· 窗口**没有系统标题栏**，整块是一块**大圆角**的玻璃（圆角 2.6rem）。
  圆角不只是 CSS 画的：主进程还会把窗口形状本身用 setShape 切成同一弧度。
· 2026-10-05：**彻底去掉了「圆角外残留直角/白边」**，根因有两个：
    1) Windows 11 会给无边框窗口自己画一圈圆角+阴影（roundedCorners 默认开），
       那圈系统框落在 CSS 圆角外面；现已 roundedCorners:false + hasShadow:false。
    2) 系统背景材质（亚克力/云母）按窗口**矩形**合成、无视圆角裁切，
       四个方角会被材质填满。现已完全弃用系统材质，「底色」只是一层
       CSS 半透明染色 —— 四角真正干净。
· 顶栏右侧是自绘的窗口按钮：底色档位 / 尺寸档位 / 最小化 / 全屏 / 关闭。
  拖动：按住顶栏空白处拖。双击顶栏 = 全屏。F11 = 全屏，Ctrl+W = 关窗。
· **底色**三档循环（纯染色深浅，不再是系统材质）：
    深玻璃（默认）—— 半透明深色，窗外可辨、白字清晰
    浅透 —— 更透，适合深色壁纸
    不透明 —— 完全不透明，远程桌面/虚拟机/省电用这档
· **尺寸**三档小/中/大：透明窗口在 Windows 上不能拖边缩放（系统限制），
  所以改成这几个预设 + 全屏。全屏时圆角自动归零（铺满屏幕不留缺口）。
· 打开 DevTools（F12）会让窗口暂时不透明，这是 Chromium 的限制，属正常。
· 界面里的「玻璃装饰」（彩色光斑、斜向高光、文字亮晕）已于 2026-10-05
  全部停用 —— 界面是干净的半透明面板，不再模仿玻璃反光。

· 如果打开后透明失效：点「底色」按钮切到「不透明」；或以 --glass=solid 启动。
  界面功能不受任何影响。

· 便携包与透明效果：
  给别人打包时默认**不带** Electron（那个运行时约 230MB）。
  没有 Electron 时窗口会自动回退成 Edge 的 --app 窗口 —— 功能一模一样，
  只是少了「透」这一层。要连透明外壳一起打包：
       powershell -ExecutionPolicy Bypass -File tools\\package.ps1 -WithElectron

──────────────────────────────────────────────
"""

new_s = s[:old_seg_start] + new_seg + s[seg_end:]
# CRLF 归一化（打包校验要求整篇一致）
new_s = new_s.replace('\r\n', '\n').replace('\n', '\r\n')
io.open(p, 'w', encoding='gbk', newline='').write(new_s)
print('使用说明.txt ok, chars =', len(new_s))

# ---------- 软件介绍 ----------
for p in ['软件介绍.md', '软件介绍.html']:
    s = io.open(p, encoding='utf-8').read()
    n = 0
    for a, b in [
        ('玻璃材质四档', '底色三档'),
        ('亚克力 acrylic —— 把窗口后面的东西模糊出来', '（系统亚克力/云母材质已弃用：它会按窗口矩形合成，导致圆角外出现方形残留）'),
        ('玻璃 · 亚克力', '底色 · 深玻璃'),
    ]:
        if a in s:
            s = s.replace(a, b)
            n += 1
    io.open(p, 'w', encoding='utf-8', newline='\n').write(s)
    print(p, 'replaced', n)
