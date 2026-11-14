"""v1.8.21 文档更新（含版本号）。

背景：用户报「失焦预览和实际雾化不一样，把实际改成预览一样的」。
真因两条：① web/shell.js 的 invoke 白名单漏了 cuk:set-opacity-blur（值根本没进主进程）；
② 失焦那条路除了"页面染色"还有第二条旁路"整窗 alpha"，而预览只走染色 ⇒ 两者必然漂移。
v1.8.21 把整窗 alpha 那条链路删掉：失焦只调染色，与聚焦那条同口径（0 = 全透，100 = 不透明）。

用法: python tools/dev/doc_v1821.py
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
s2, ok = sub1(s, '"version": "1.8.20"', '"version": "1.8.21"', 'version.json')
if ok:
    p.write_bytes(s2.encode('utf-8'))
    changed += 1

# ───────────────────────────── 2) 使用说明.txt（GBK + 必须整篇 CRLF）
# 这两段是**成块**的说明，按行号替换比长串匹配稳（中文引号/空格肉眼难对齐）。
DOC = '使用说明.txt'
bak = ROOT / (DOC + '.bak-v1821')
if not bak.exists():
    shutil.copyfile(ROOT / DOC, bak)
    print('  ok 备份 →', bak.name)

s = load(DOC, 'gbk')
lines = s.split('\n')
if len(lines) < 480:
    print('  !! 行数不对（%d），中止' % len(lines))
    sys.exit(2)


def repl_by_anchor(block, first_key, last_key, tag):
    """按**锚点**找那一段（不要写死行号 —— 上一段改完长度就变了，行号会错位）。
    段 = 从以 first_key 开头的那行起，到 last_key 结尾那行为止（含）。
    找不到就跳过（幂等：改过之后再跑不会出错）。"""
    global lines, s
    start = None
    for i, ln in enumerate(lines):
        if ln.startswith(first_key):
            start = i
            break
    if start is None:
        print('  -- %s 已经改过（找不到旧锚点），跳过' % tag)
        return False
    end = None
    for j in range(start, min(start + 40, len(lines))):
        if last_key in lines[j]:
            end = j
            break
    if end is None:
        print('  !! %s 找不到结尾锚点，跳过' % tag)
        return False
    lines[start:end + 1] = block
    s = '\n'.join(lines)
    print('  ok', tag, '（%d 行 → %d 行）' % (end - start + 1, len(block)))
    return True


BLUR_BLOCK = [
    '· **「失焦」透明度滑块**（v1.8.16 起；v1.8.21 起与聚焦那条**同一口径**）：管的是**切到别的',
    '  窗口之后**这个窗口有多实 —— 0 = 全透（切走后能看清窗外），100 = 不透明，默认 **70%**。',
    '  它只调**界面这层染色**（窗外本来就由 acrylic 磨砂着，见下一条），所以往左拉 = 一块更干净',
    '  的磨砂玻璃、往右拉 = 更实更遮。',
    '  显示「跟随」= 与左边那条一致（**双击**可回到跟随）；拖动时**当场预览**：窗口立刻按失焦',
    '  的样子渲染、滑块数值后面显示「·预览」，约 3.5 秒回到聚焦观感（免得你以为窗口坏了）。',
    '  ★ 预览与真失焦走的是**同一条渲染路径**，所以**拖的时候看到什么样，切走之后就是什么样**。',
    '  （历史：v1.8.17 ~ v1.8.20 走的是"整窗透明度"那条路 —— 那时失焦的背板是 mica，一层不透明',
    '  的壁纸色调，只调染色看不到窗外，只能整窗降 alpha；代价是文字一起变淡，而且预览那条 IPC',
    '  当年没接上（web/shell.js 的 invoke 白名单漏了个 case），于是"预览"与"实际"必然对不上。',
    '  v1.8.21 把整窗 alpha 这条链路整个删掉，改为只染色，两者才真正统一。）',
]

BLUR_FIRST = '· **「失焦」透明度滑块**'
BLUR_LAST = '失焦时确实是 100%）。现在改成用焦点事件自己维护状态，不再猜。'

ok1 = repl_by_anchor(BLUR_BLOCK, BLUR_FIRST, BLUR_LAST, '使用说明：失焦滑块')
if ok1:
    changed += 1

FROST_BLOCK = [
    '· 窗口**失去焦点时磨砂不消失**（v1.8.10 起；v1.8.20 起换成更干净的做法）：聚焦和失焦',
    '  **用同一种材质（acrylic）**，所以切走之后窗外**依旧是模糊的** —— 磨砂一直在，不会突然',
    '  变成一块实色。**那一刻想更透 / 更实，就用顶栏那条「失焦」滑块调**（默认 70%）。',
    '  而且"拖动时的预览"与"真失焦"**走的是同一条渲染路径** —— 预览成什么样，切走就是什么样。',
    '  （历史：v1.8.10 ~ v1.8.19 走的是"失焦换 mica"的路子 —— mica 只给一层深色"壁纸色调"，',
    '  看着像块实色板，所以有「失焦后透明度没变」「预览和实际对不上」这两个反馈；v1.8.20 换成',
    '  两端都用 acrylic。也试过老式磨砂（SetWindowCompositionAttribute），实测会让窗口变成',
    '  不透明深色、还会丢系统圆角，不采用。）',
]

FROST_FIRST = '· 窗口**失去焦点时磨砂不消失**'
FROST_LAST = '不透明深色、还会丢系统圆角，不采用。）'

ok2 = repl_by_anchor(FROST_BLOCK, FROST_FIRST, FROST_LAST, '使用说明：失焦磨砂')
if ok2:
    changed += 1

if ok1 or ok2:
    save(DOC, s, 'gbk')

# ───────────────────────────── 3) 软件介绍.md / .html 版本号
s = load('软件介绍.md', 'utf-8')
s, o1 = sub1(s, '**版本 1.8.20 ｜', '**版本 1.8.21 ｜', 'md 版本号')
if o1:
    save('软件介绍.md', s, 'utf-8')
    changed += 1

s = load('软件介绍.html', 'utf-8')
s, o1 = sub1(s, '<span>版本 1.8.20</span>', '<span>版本 1.8.21</span>', 'html 版本号')
if o1:
    save('软件介绍.html', s, 'utf-8')
    changed += 1

print('changed =', changed)
if not changed:
    sys.exit(2)
