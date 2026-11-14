"""v1.8.18 文档更新：失焦档默认 80→70；补「时序 bug」与「失焦没有磨砂」两条说明。

用法: python tools/dev/doc_v1818.py
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
s2, ok = sub1(s, '"version": "1.8.17"', '"version": "1.8.18"', 'version.json')
if ok:
    p.write_bytes(s2.encode('utf-8'))
    changed += 1

# ───────────────────────────── 2) 使用说明.txt
s = load('使用说明.txt', 'gbk')

s, ok1 = sub1(s,
    '（桌面、别的窗口），而不只是界面变淡。默认 **80%**（轻微透）；往左更透、**最低 15%**\n',
    '（桌面、别的窗口），而不只是界面变淡。默认 **70%**；往左更透、**最低 15%**\n',
    '使用说明 默认值 80→70')

old2 = ('  为什么以前调它像没反应：v1.8.16 只调了"界面染色"这一层，而失焦时的背板是 mica\n'
        '  （**不透明的壁纸色调**），染色怎么调都只是"多露一点 mica"，看不到窗外。\n')
new2 = ('  为什么以前调它像没反应：v1.8.16 只调了"界面染色"这一层，而失焦时的背板是 mica\n'
        '  （**不透明的壁纸色调**），染色怎么调都只是"多露一点 mica"，看不到窗外。\n'
        '  v1.8.18 又修了一个**时序判断错误**：早先版本在"窗口刚失焦"那一刻误判成仍有焦点，\n'
        '  于是又把透明度设回 100% —— 表现就是"怎么调都没反应"（从外面读窗口的真实透明度，\n'
        '  失焦时确实是 100%）。现在改成用焦点事件自己维护状态，不再猜。\n')
s, ok2 = sub1(s, old2, new2, '使用说明 时序 bug 说明')

old3 = ('  不会突然变成一块实色。切回来立刻恢复真模糊。**那一刻想更透 / 更实，就用顶栏那条\n'
        '  「失焦」滑块调** —— 它降的是**整窗透明度**，所以能真的看见窗外（默认 80%）。\n')
new3 = ('  不会突然变成一块实色。切回来立刻恢复真模糊。**那一刻想更透 / 更实，就用顶栏那条\n'
        '  「失焦」滑块调** —— 它降的是**整窗透明度**，所以能真的看见窗外（默认 70%）。\n'
        '  注：失焦时**没有磨砂** —— 窗外是**直透、不模糊**。因为系统规定 acrylic 一失焦就降级\n'
        '  成实色；也试过老式磨砂那条路（SetWindowCompositionAttribute），实测会让窗口变成\n'
        '  不透明深色、还会把系统圆角弄丢，所以没采用。\n')
s, ok3 = sub1(s, old3, new3, '使用说明 失焦无磨砂')
if ok1 or ok2 or ok3:
    save('使用说明.txt', s, 'gbk')
    changed += 1

# ───────────────────────────── 3) 软件介绍.md
s = load('软件介绍.md', 'utf-8')
s, ok1 = sub1(s, '**版本 1.8.17 ｜', '**版本 1.8.18 ｜', 'md 版本号')
old = ('真的能看见窗外）：默认 80%、最低 15%，「跟随」时与聚焦那条一致（拖动即预览、双击回跟随）。\n')
new = ('真的能看见窗外）：默认 70%、最低 15%，「跟随」时与聚焦那条一致（拖动即预览、双击回跟随）。\n')
s, ok2 = sub1(s, old, new, 'md 默认值')
if ok1 or ok2:
    save('软件介绍.md', s, 'utf-8')
    changed += 1

# ───────────────────────────── 4) 软件介绍.html
s = load('软件介绍.html', 'utf-8')
s, ok1 = sub1(s, '<span>版本 1.8.17</span>', '<span>版本 1.8.18</span>', 'html 版本号')
old = '顶栏那条「失焦」默认 80%、最低 15%'
new = '顶栏那条「失焦」默认 70%、最低 15%'
s, ok2 = sub1(s, old, new, 'html 默认值')
if ok1 or ok2:
    save('软件介绍.html', s, 'utf-8')
    changed += 1

print('changed =', changed)
if not changed:
    sys.exit(2)
