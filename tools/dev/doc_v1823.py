"""v1.8.23 文档更新（含版本号）：把「服务自己的黑窗口」讲清楚 + 记一笔开机自启动的排查。

背景（2026-10-11 用户报「开机自启动窗口打不开 … 这个窗口隐藏」）：
  截图里那个黑窗口（客户区 #0C0C0C）是 **server 自己的控制台**，只有一行
  「酷态科10号Ultra 服务已启动：…」。它会挂到 node 退出（几小时），而且**关掉它
  就等于立刻杀掉服务**。v1.8.23：server.js 一起来就把它 SW_HIDE；开机自启动的
  .lnk 改成直连 node.exe（不再经过 .bat，开机不起任何 cmd 窗口）。

用法: python tools/dev/doc_v1823.py
"""
import pathlib
import shutil
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
CRLF = "\r\n"
changed = 0


def load(name, enc):
    return (ROOT / name).read_bytes().decode(enc).replace(CRLF, "\n").replace("\r", "\n")


def save(name, s, enc):
    (ROOT / name).write_bytes(s.replace("\n", CRLF).encode(enc))


def sub1(s, old, new, tag):
    if s.count(old) != 1:
        print("  !! %s 命中 %d 次，跳过" % (tag, s.count(old)))
        return s, False
    print("  ok", tag)
    return s.replace(old, new), True


# ───────────────────────────── 1) 版本号
p = ROOT / 'version.json'
s = p.read_bytes().decode('utf-8')
s2, ok = sub1(s, '"version": "1.8.22"', '"version": "1.8.23"', 'version.json')
if ok:
    p.write_bytes(s2.encode('utf-8'))
    changed += 1

# ───────────────────────────── 2) 使用说明.txt（GBK + 整篇 CRLF）
DOC = '使用说明.txt'
bak = ROOT / (DOC + '.bak-v1823')
if not bak.exists():
    shutil.copyfile(ROOT / DOC, bak)
    print('  ok 备份 →', bak.name)

s = load(DOC, 'gbk')
lines = s.split('\n')

HELP_NEW = [
    '· **看到过一个黑色窗口？**（标题是「酷态科10号Ultra」或什么都没有，里面只有一行',
    '  「…服务已启动：http://127.0.0.1:8799/」）：那是**服务自己的命令行窗口**。v1.8.23 起',
    '  程序一起来就会把它**藏掉** —— 看不到、任务栏里也没有。',
    '  注意：如果你在旧版本里见过它：**别去关它**。关掉它等于把服务一起杀掉（那种关闭方式',
    '  不给程序任何清理机会：没有退出日志、data\\running.lock 还会残留，之后双击会像',
    '  「打不开」）。真要停：右键任务栏托盘图标选「退出」。',
    '  开机自启动那条路径（v1.8.23 起）**连命令行窗口都不会创建**：快捷方式直接指向',
    '  node，不再经过那个 .bat。',

    '· 双击**完全没反应**（连启动窗口都不弹、任务栏也没有功率图标）：看 data\\app.log 最后几行。',
    '  v1.8.22 起会写清是哪一种情况 —— 出现「残留的 running.lock 指向 pid …（进程已退出或',
    '  pid 被回收）→ 按新实例启动」就说明它已认出那是**残留记录**，会照常启动。',
    '  历史坑：服务意外退出后，Windows 会把它的 pid **回收给别的程序**，于是老版本每次',
    '  双击都误判成"软件还在跑"、只弹一个空窗口 —— 2026-10-09 修掉的就是这个。',
    '  真卡住时的兜底：删掉 data\\running.lock（若 data\\alive.json 还在也一并删），再双击一次。',
]

# 插在「双击完全没反应」那一段之后（该段的最后一行是"真卡住时的兜底"那句）
anchor = None
for i, l in enumerate(lines):
    if l.startswith('     真卡住时的兜底：删掉 data'):
        anchor = i
        break
if anchor is None:
    print('  !! 找不到插入锚点，跳过使用说明')
else:
    # 该段第一行是"· 双击**完全没反应**…"（往前找）
    seg_start = None
    for j in range(anchor, max(0, anchor - 12), -1):
        if lines[j].startswith('   · 双击**完全没反应**'):
            seg_start = j
            break
    if seg_start is None:
        print('  !! 找不到该段开头，跳过')
    else:
        # 用新的 6 行替换旧 6 行（内容更准），再把「看到黑色窗口」插进去
        lines[seg_start:anchor + 1] = HELP_NEW[6:] + [''] + HELP_NEW[:6]
        s = '\n'.join(lines)
        print('  ok 使用说明：新增「看到过一个黑色窗口」并把"双击没反应"更新（%d 行）'
              % len(HELP_NEW))
        changed += 1

if changed:
    save(DOC, s, 'gbk')

# ───────────────────────────── 3) 软件介绍.md / .html 版本号
s2 = load('软件介绍.md', 'utf-8')
s2, o1 = sub1(s2, '**版本 1.8.22 ｜', '**版本 1.8.23 ｜', 'md 版本号')
if o1:
    save('软件介绍.md', s2, 'utf-8')
    changed += 1

s2 = load('软件介绍.html', 'utf-8')
s2, o1 = sub1(s2, '<span>版本 1.8.22</span>', '<span>版本 1.8.23</span>', 'html 版本号')
if o1:
    save('软件介绍.html', s2, 'utf-8')
    changed += 1

print('changed =', changed)
if not changed:
    sys.exit(2)
