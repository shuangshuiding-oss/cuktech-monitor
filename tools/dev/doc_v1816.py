"""v1.8.16 文档更新：失焦透明度滑块（顶栏新增一条「失焦」滑块）。

用法: python tools/dev/doc_v1816.py
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
s2, ok = sub1(s, '"version": "1.8.15"', '"version": "1.8.16"', 'version.json')
if ok:
    p.write_bytes(s2.encode('utf-8'))
    changed += 1

# ───────────────────────────── 2) 使用说明.txt
s = load('使用说明.txt', 'gbk')
anchor = ('  出厂默认 56%。旧的"三档循环"已由滑块取代 —— 想多透就往左拉，想实一点往右拉。\n')
ins = (
    '· **「失焦」透明度滑块**（v1.8.16，紧挨着上面那个）：管的是**切到别的窗口之后**这个窗口\n'
    '  有多透。默认显示「跟随」= 与左边那条一致（也就是以前的行为）；拖它就分开设置。拖动时\n'
    '  **当场预览**（松手约 2 秒回到聚焦观感 —— 免得你以为窗口坏了），**双击**它回到「跟随」。\n'
    '  为什么单开一档：失焦时系统把材质从 acrylic 换成 mica（见下面那条），而 mica 只给"壁纸\n'
    '  色调"，多透/多实只能靠界面这层染色来调，也就是这条滑块。设过的值会自动记住。\n')
s, ok1 = sub1(s, anchor, anchor + ins, '使用说明 透明度段')

anchor2 = ('  不会突然变成一块实色。切回来立刻恢复真模糊。\n')
s, ok2 = sub1(s, anchor2,
              '  不会突然变成一块实色。切回来立刻恢复真模糊。**那一刻想更透 / 更实，'
              '就用顶栏那条「失焦」滑块调**（见上面"透明度滑块"那两条）。\n',
              '使用说明 失焦段补一句')
if ok1 or ok2:
    save('使用说明.txt', s, 'gbk')
    changed += 1

# ───────────────────────────── 3) 软件介绍.md
s = load('软件介绍.md', 'utf-8')
s, ok1 = sub1(s, '**版本 1.8.15 ｜', '**版本 1.8.16 ｜', 'md 版本号')
old = ('- 窗外实时可见：桌面壁纸、别的窗口，都是活的。透明度由顶栏滑块连续可调'
       '（0 = 全透 ~ 100 = 不透明，实时生效、自动记住）。\n')
new = ('- 窗外实时可见：桌面壁纸、别的窗口，都是活的。透明度由顶栏滑块连续可调'
       '（0 = 全透 ~ 100 = 不透明，实时生效、自动记住）。**失焦时**（切到别的窗口后）'
       '另有「失焦」滑块单独调（v1.8.16）：默认「跟随」聚焦那条，拖动即预览、双击回跟随。\n')
s, ok2 = sub1(s, old, new, 'md 透明度那条')
if ok1 or ok2:
    save('软件介绍.md', s, 'utf-8')
    changed += 1

# ───────────────────────────── 4) 软件介绍.html
s = load('软件介绍.html', 'utf-8')
s, ok1 = sub1(s, '<span>版本 1.8.15</span>', '<span>版本 1.8.16</span>', 'html 版本号')
anchor = ('<li><b>磨砂固定开</b>（v1.8.2 删掉了开关）：窗外糊成柔和底色 + 系统圆角；'
          '观感强弱用右上角<b>透明度滑块</b>调（往左更透、往右更实）</li>\n')
ins = ('<li><b>「失焦」透明度可以单独调</b>（v1.8.16）：顶栏透明度滑块旁边多了一条「失焦」——'
       '管的是<b>切到别的窗口之后</b>这个窗口有多透。默认「跟随」聚焦那条，拖动即预览、'
       '双击回跟随（失焦时系统把材质换成 mica，多透只能靠这层染色调）</li>\n')
s, ok2 = sub1(s, anchor, anchor + ins, 'html 补一条')
if ok1 or ok2:
    save('软件介绍.html', s, 'utf-8')
    changed += 1

print('changed =', changed)
if not changed:
    sys.exit(2)
