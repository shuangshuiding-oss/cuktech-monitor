"""把 bat 里「走 vbs 隐藏启动」那段换回来（改成 node 自己隐藏控制台）。

为什么改主意：vbs 那条路（wscript + WshShell.Run 样式 0）在**会话沙箱里没法验证** ——
沙箱里连控制台都没有（实测 GetConsoleWindow() 恒为 NULL），更别说跑 wscript（LOLBin 被拦）。
一个没法验证的组件不该放在开机启动的关键路径上。
改成：node 自己一启动就把控制台窗口隐藏（server.js 的 hideOwnConsole）。这条能验证逻辑，
而且**不管谁把 node 拉起来的都有效**（bat / 快捷方式 / 手动）。

用法: python tools/dev/patch_v1823b.py
"""
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
BAT = ROOT / '启动酷态科10号Ultra.bat'
BS = chr(92)
CRLF = chr(13) + chr(10)

s = BAT.read_bytes().decode('gbk')
changed = 0

# ---- 1) 把 vbs 那一段换回普通的 start /min（保留 bg 快速退出与裸 CR 的修复）----
OLD = (
    'rem 启动 server。注意：必须走 hidden-start.vbs' + '_PLACEHOLDER_'
)
# 用「首尾行」定位整段，避免手写全部转义
lines = s.split(CRLF)
start = None
end = None
for i, l in enumerate(lines):
    if l.startswith('rem 启动 server。注意：必须走'):
        start = i
    if start is not None and l.strip() == ')' and i > start:
        end = i
        break
if start is None or end is None:
    print('!! 没找到 vbs 启动段 (start=%r end=%r)' % (start, end))
    sys.exit(2)

NEW = [
    'rem 启动 server。注意：node 是控制台程序，这样起会得到一个**真实存在的控制台窗口**——',
    'rem 它会一直挂到 node 退出（几小时），而且**关掉它就等于立刻杀掉服务**',
    'rem （CTRL_CLOSE_EVENT，无任何清理：没有退出日志、data' + BS + 'running.lock 还会残留）。',
    'rem 2026-10-11 用户就是被这个黑窗口坑的。',
    'rem 解法不在这一行，而在 node 自己：server.js 一启动就把自己的控制台窗口**隐藏**',
    'rem （hideOwnConsole，koffi 调 user32.ShowWindow 传 SW_HIDE）—— 见 server.js 那段说明。',
    'rem /min 只是保险：万一隐藏失败，它至少是「最小化」而不是弹在屏幕中央。',
    'start "" /min "%NODE%" "%HERE%' + BS + 'server.js" %NOARG%',
]
print('替换第 %d~%d 行（%d 行 → %d 行）' % (start + 1, end + 1, end - start + 1, len(NEW)))
lines[start:end + 1] = NEW
s = CRLF.join(lines)
changed += 1

# ---- 2) 确认没有残留 ----
for bad in ['hidden-start', 'wscript']:
    if bad in s:
        print('!! 仍有残留: %s' % bad)

s = s.replace(CRLF, '\n').replace(chr(13), '\n').replace('\n', CRLF)
BAT.write_bytes(s.encode('gbk'))
data = BAT.read_bytes()
print('写回完成：%d 字节，CR=%d LF=%d' % (len(data), data.count(bytes([13])), data.count(bytes([10]))))
