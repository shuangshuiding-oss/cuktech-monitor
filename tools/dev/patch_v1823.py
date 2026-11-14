"""v1.8.23 补丁：把启动 bat 改成「隐藏启动 server」，并修掉两个既有 bug。

背景（2026-10-11 用户报「开机自启动窗口打不开 … 这个窗口隐藏」）：
  截图里的黑窗口（#0C0C0C，一行 node 的 stdout「酷态科10号Ultra 服务已启动：…」）
  就是 `start "" /min node server.js` 留下的 **server 自己的控制台窗口**。
  它会一直挂到 node 退出（几小时），而且**关掉它就等于立刻杀掉服务**。

顺便发现两个既有 bug：
  ① bat 里 `"%HERE%\\data\\ready.json"` 被写成了 `"%HERE%\\data` + **CR** + `eady.json"` ——
     原作者在 Python/JS 字符串里写了 `\\data\\ready.json`，其中 `\\r` 被**当成转义序列**，
     两个字符 `\\r` 变成了一个 CR 字节（连反斜杠一起吃掉）。cmd 把 CR 当行尾 ⇒ findstr
     那行被拦腰截断 ⇒ `REUSED` 永远不生效 ⇒ **"软件本来就在运行" 的提示根本不会出现**
     （一律显示"启动成功…正在打开应用窗口"，而实际可能没开窗口 → 正是"窗口打不开"的观感）。
  ② `start /min` 会为 node 建一个真实控制台窗口（本次要修的）。

用法: python tools/dev/patch_v1823.py
"""
import io
import shutil
import sys

ROOT = __import__('pathlib').Path(__file__).resolve().parents[2]
BAT = ROOT / '启动酷态科10号Ultra.bat'

bak = ROOT / (BAT.name + '.bak-v1823')
if not bak.exists():
    shutil.copyfile(BAT, bak)
    print('ok 备份 →', bak.name)

raw = BAT.read_bytes()
changed = 0

# ── 1) 修「r 被 CR 吃掉」：`"...\data<CR>eady.json"` → `"...\data\ready.json"`
bad = b'"%HERE%\\data\ready.json"'.replace(b'\\data', b'\\data\x0d')
good = b'"%HERE%\\data\\ready.json"'
n = raw.count(bad)
if n:
    raw = raw.replace(bad, good)
    print('ok 修掉 %d 处「r 被 CR 吃掉」（findstr 的路径被截断 → REUSED/UPGRADE 检测失效）' % n)
    changed += 1
else:
    print('-- 该处已修过（没找到 %r）' % bad)

# 兜底：任何位置都不该有裸 CR（CR 数必须等于 LF 数）
extra_cr = raw.count(b'\r') - raw.count(b'\n')
if extra_cr:
    print('!! 仍有 %d 个多余的 CR 字节，请人工检查' % extra_cr)
else:
    print('ok CR 与 LF 数量一致（没有裸 CR）')

s = raw.decode('gbk')

# ── 2) 隐藏启动 server
OLD_START = 'start "" /min "%NODE%" "%HERE%\\server.js" %NOARG%\r\n'
NEW_START = (
    'rem 启动 server。注意：必须走 hidden-start.vbs —— node 是控制台程序，直接 start 会得到\r\n'
    'rem 一个**真实存在的黑窗口**：它一直挂到 node 退出（几小时），而且**关掉它就等于\r\n'
    'rem 立刻杀掉服务**（CTRL_CLOSE_EVENT，无任何清理：没有退出日志、data\\running.lock\r\n'
    'rem 还会残留）。2026-10-11 用户就是被这个黑窗口坑的。\r\n'
    'rem 走 vbs 时 node 的控制台是「隐藏」的：没有窗口、任务栏也不会有条目。\r\n'
    'if exist "%HERE%\\hidden-start.vbs" (\r\n'
    '  wscript.exe //nologo "%HERE%\\hidden-start.vbs" "%NODE%" "%HERE%\\server.js" %NOARG%\r\n'
    ') else (\r\n'
    '  start "" /min "%NODE%" "%HERE%\\server.js" %NOARG%\r\n'
    ')\r\n'
)
if OLD_START in s:
    s = s.replace(OLD_START, NEW_START)
    print('ok 改成隐藏启动（hidden-start.vbs）')
    changed += 1
else:
    print('!! 没找到 `start "" /min` 那一行，跳过')

# ── 3) 后台档（开机自启动）直接退出，别让那个 cmd 窗口在开机时停留十几秒
OLD_WAIT = 'set /a N=0\r\n:wait\r\n'
NEW_WAIT = (
    'rem 后台档（开机自启动）：不打印任何东西、也不等 ready.json —— 没人在看这个窗口，\r\n'
    'rem 早点退出就能让开机时那个 cmd 窗口一闪而过。服务由上面那条隐藏启动负责。\r\n'
    'if defined NOARG exit /b 0\r\n'
    '\r\n'
    'set /a N=0\r\n'
    ':wait\r\n'
)
if OLD_WAIT in s:
    s = s.replace(OLD_WAIT, NEW_WAIT)
    print('ok 后台档改为不等待 ready.json（减少开机时的窗口停留）')
    changed += 1
else:
    print('!! 没找到 wait 段，跳过')

if not changed:
    print('changed = 0')
    sys.exit(2)

# ── 收尾：整篇 CRLF + GBK 写回
s = s.replace('\r\n', '\n').replace('\r', '\n').replace('\n', '\r\n')
BAT.write_bytes(s.encode('gbk'))
data = BAT.read_bytes()
print('写入完成：%d 字节，CR=%d LF=%d（应相等）' % (len(data), data.count(b'\r'), data.count(b'\n')))
