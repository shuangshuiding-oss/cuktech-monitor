"""v1.8.19 文档更新：失焦档预览时长 2s → 3.5s；预览时数值显示「·预览」。

用法: python tools/dev/doc_v1819.py
"""
import pathlib
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
s2, ok = sub1(s, '"version": "1.8.18"', '"version": "1.8.19"', 'version.json')
if ok:
    p.write_bytes(s2.encode('utf-8'))
    changed += 1

# ───────────────────────────── 2) 使用说明.txt
s = load('使用说明.txt', 'gbk')
old = ('  显示「跟随」= 与左边那条一致（**双击**可回到跟随）；拖动时**当场预览**（松手约 2 秒\n'
       '  回到聚焦观感 —— 免得你以为窗口坏了）。注：**聚焦时永远不透明**，这档只在失焦那一刻生效。\n')
new = ('  显示「跟随」= 与左边那条一致（**双击**可回到跟随）；拖动时**当场预览**：窗口会立刻按\n'
       '  失焦的样子变透、滑块数值后面显示「·预览」，松手约 3.5 秒回到聚焦观感（免得你以为窗口\n'
       '  坏了）。注：**聚焦时永远不透明**，这档只在失焦那一刻生效。\n'
       '  v1.8.19 又堵了一个坑：**按下滑块时窗口会重新获得焦点**，早先那版 focus 事件会把透明度\n'
       '  立刻拉回 100%、把预览盖掉 —— 表现就是"拖着一点反应都没有"。现在预览期间 focus 不覆盖。\n')
s, ok1 = sub1(s, old, new, '使用说明：预览说明')
if ok1:
    save('使用说明.txt', s, 'gbk')
    changed += 1

# ───────────────────────────── 3) 软件介绍.md
s = load('软件介绍.md', 'utf-8')
s, ok1 = sub1(s, '**版本 1.8.18 ｜', '**版本 1.8.19 ｜', 'md 版本号')
if ok1:
    save('软件介绍.md', s, 'utf-8')
    changed += 1

# ───────────────────────────── 4) 软件介绍.html
s = load('软件介绍.html', 'utf-8')
s, ok1 = sub1(s, '<span>版本 1.8.18</span>', '<span>版本 1.8.19</span>', 'html 版本号')
if ok1:
    save('软件介绍.html', s, 'utf-8')
    changed += 1

print('changed =', changed)
if not changed:
    sys.exit(2)
