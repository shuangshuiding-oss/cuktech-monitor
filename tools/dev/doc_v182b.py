"""v1.8.2 文档更新（第二块：软件介绍 + 剩余的使用说明改动 + 新增「1 年」档）。

第一块（doc_v182.py）已经把「读完历史覆盖旧数据」和「磨砂开关删除」写进 使用说明.txt。
这里补：
    · 软件介绍.md / .html 的同两条
    · 回归修正：软件介绍里的「按天」功能标签被全局版本替换误改成 v1.8.2，改回 v1.8.1
    · 三份文档都补上新增的「1 年」区间档

用法: python tools/dev/doc_v182b.py
"""
from __future__ import annotations

import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
CRLF = '\r\n'

stats = []


def load(name: str, enc: str) -> str:
    s = (ROOT / name).read_bytes().decode(enc)
    bare = s.count('\n') - s.count(CRLF)
    if bare:
        print('%s 里本来就有 %d 个裸 LF，先修好再改' % (name, bare))
        sys.exit(2)
    return s.replace(CRLF, '\n')


def save(name: str, s: str, enc: str) -> None:
    out = s.replace('\r\n', '\n').replace('\n', CRLF)
    data = out.encode(enc)
    (ROOT / name).write_bytes(data)
    stats.append('%-15s %6d 字节  CRLF %d  裸 LF %d' % (name, len(data), out.count(CRLF),
                                                       out.count('\n') - out.count(CRLF)))


def sub(text: str, old: str, new: str, tag: str, want: int = 1) -> str:
    n = text.count(old)
    if n != want:
        print('「%s」命中 %d 次（期望 %d）：%s' % (tag, n, want, old[:46]))
        sys.exit(3)
    return text.replace(old, new)


def insert_after(text: str, anchor: str, block: str, tag: str) -> str:
    n = text.count(anchor)
    if n != 1:
        print('锚点不唯一（%d 次）[%s]：%s' % (n, tag, anchor[:46]))
        sys.exit(3)
    return text.replace(anchor, anchor + '\n' + block)


RANGE_LONG = '「90 天」「1 年」「全部」'

# ------------------------------------------------------------ 使用说明.txt
t = load('使用说明.txt', 'gbk')
t = sub(t,
        '6 小时 / 24 小时 / 7 天 / 30 天（共 12 档）',
        '6 小时 / 24 小时 / 7 天 / 30 天（共 12 档）\n'
        '  温度计读过内置历史之后，还会多出 90 天 / 1 年 / 全部 三档（共 15 档）。', 'range-list')
t = insert_after(
    t,
    '* 30 天区间的"点"是每分钟的均值，看趋势足够；想看某一秒的尖峰请切回 1 分钟。',
    '* 「90 天 / 1 年 / 全部」是**温度专用**的长窗（功率曲线切过去基本是空的）：温度计自己'
    '\n  存着约半年历史，读一次就能填满长窗。窗口超过 300 天时，时间轴刻度会写成「年-月」'
    '\n  （跨年时"月-日"会看不出是哪一年）。', 'range-long')
t = sub(t, '**「90 天」和「全部」**两档：温湿度计自己', '**「90 天」「1 年」「全部」**三档：温湿度计自己', '354')
t = sub(t, '并放出「90 天」「全部」两档。', '并放出「90 天」「1 年」「全部」三档。', '378')
t = sub(t, '* 功率曲线切到「90 天」「全部」几乎是空的，这很正常：那两档是给温度计的',
        '* 功率曲线切到「90 天」「1 年」「全部」几乎是空的，这很正常：那几档是给温度计的', '495')
save('使用说明.txt', t, 'gbk')

# ------------------------------------------------------------ 软件介绍.md
m = load('软件介绍.md', 'utf-8')
m = sub(m, '- **「按天」开关（v1.8.2）**', '- **「按天」开关（v1.8.1）**', 'md-按天版本', 1)
m = sub(m, '还会多出**「90 天」和「全部」**两档', '还会多出**「90 天」「1 年」和「全部」**三档', 'md-52')
m = insert_after(
    m,
    '- **按天视图**：一天一个点（当天均值），阴影带是当天的最高 ~ 最低；配一张按天明细表，'
    '表里的「采样点数」用来自证"今天只有半天数据"。看一个季度只需要扫一眼，不必在几千个小时点里找规律。',
    '- **读完历史就覆盖旧数据（v1.8.2）**：设备每小时记的是该小时的最高/最低，本应用自己采的是 90 秒瞬时值，'
    '两种粒度混着画会让「当日最低~最高」忽宽忽窄。因此读完历史会把**设备覆盖到的那段时间**的本机采样丢掉，'
    '统一成设备一种来源（比历史更新的新读数照常保留）。', 'md-覆盖')
m = insert_after(
    m,
    '留下的是干净的半透明深色面板 + 清晰的白字；柔和投影保留，卡片依然有层次但不"装"玻璃。',
    '磨砂（acrylic 材质）是**固定开**的：窗外被糊成柔和底色 + 系统圆角，没有开关（v1.8.2 把那个按钮删了）。',
    'md-磨砂')
save('软件介绍.md', m, 'utf-8')

# ------------------------------------------------------------ 软件介绍.html
h = load('软件介绍.html', 'utf-8')
h = sub(h, '<b>按天看温湿度（v1.8.2）</b>', '<b>按天看温湿度（v1.8.1）</b>', 'html-按天版本', 1)
h = sub(h, '还会多出「90 天」「全部」两档', '还会多出「90 天」「1 年」「全部」三档', 'html-152')
h = sub(h, '读完区间里会多出<b>「90 天」「全部」</b>两档', '读完区间里会多出<b>「90 天」「1 年」「全部」</b>三档', 'html-179')
h = insert_after(
    h,
    '        <li>读完区间里会多出<b>「90 天」「1 年」「全部」</b>三档；时间轴刻度随跨度自动换格式（时:分:秒 → 月-日）</li>',
    '        <li><b>读完历史就覆盖旧数据（v1.8.2）</b>：设备每小时记的是该小时最高/最低，本应用采的是 90 秒瞬时值，'
    '两种粒度混着画会让「当日最低~最高」忽宽忽窄 —— 读完历史会把设备覆盖到的那段时间的本机采样丢掉，'
    '统一成设备一种来源（更新的新读数照常保留）</li>', 'html-覆盖')
h = insert_after(
    h,
    '        <li>开机自启动可选，放启动文件夹，不改注册表</li>',
    '        <li><b>磨砂固定开</b>（v1.8.2 删掉了开关）：窗外糊成柔和底色 + 系统圆角；'
    '观感强弱用右上角<b>透明度滑块</b>调（往左更透、往右更实）</li>', 'html-磨砂')
save('软件介绍.html', h, 'utf-8')

print('\n'.join(stats))
print('完成')
