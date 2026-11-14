"""v1.8.5 文档更新：

    · 抽稀改成"按时间分桶"（温度曲线单独一档 1200 点）—— 原来"任何区间压到 400 点"的说法要改
    · 顶栏改成圆角条
    · 排障里补一条：曲线上的大空档 = 那段时间电脑没开机，点「读取设备历史」可补

版本号 1.8.4 → 1.8.5。

用法: python tools/dev/doc_v185.py
"""
from __future__ import annotations

import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
CRLF = '\r\n'
stats = []


def load(name: str, enc: str) -> str:
    s = (ROOT / name).read_bytes().decode(enc)
    if s.count('\n') - s.count(CRLF):
        print('%s 里有裸 LF' % name)
        sys.exit(2)
    return s.replace(CRLF, '\n')


def save(name: str, s: str, enc: str) -> None:
    out = s.replace('\r\n', '\n').replace('\n', CRLF)
    data = out.encode(enc)
    (ROOT / name).write_bytes(data)
    stats.append('%-15s %6d 字节  CRLF %d' % (name, len(data), out.count(CRLF)))


def sub(text: str, old: str, new: str, tag: str, must: bool = True) -> str:
    n = text.count(old)
    if n == 0 and not must:
        print('跳过（已改过）：' + tag)
        return text
    if n != 1:
        print('「%s」命中 %d 次' % (tag, n))
        sys.exit(3)
    return text.replace(old, new)


# ------------------------------------------------------------ 使用说明.txt
t = load('使用说明.txt', 'gbk')
t = sub(t,
        '* 任何区间都先压到 400 个点以内再发给界面（按时间分组取均值、组内峰值单独保留），\n'
        '  所以选 30 天也不会卡，尖峰也不会被均值抹平。',
        '* 发给界面的点数有上限：**功率曲线 400 点，温度曲线 1200 点**（v1.8.5 起分开设）。\n'
        '  温度为什么给这么宽：它是两种粒度混着的（设备历史每小时一条 + 本应用 90 秒一条），\n'
        '  上限压到 400 的话 7 天档就要抽稀，一抽稀"每小时那条"就会被并掉一半 —— 实测曲线上\n'
        '  每天只剩 16 个点、相邻两点差 2 小时，看着一段段空白（像历史没读回来）。\n'
        '  抽稀本身也改成了**按时间分桶**（每桶代表时间轴上等宽的一段），不再"每 N 行算一组"：\n'
        '  后者在两种粒度混着时会跳到不规则的时刻上，把 1 小时的天然间隔放大成 2 小时。',
        '点数上限', must=False)
t = sub(t,
        '* 顶栏是贴在窗口顶部的一条玻璃：页面滚动时内容会从它下面经过并被模糊。',
        '* 顶栏是贴在窗口顶部的一条**圆角玻璃条**（v1.8.5 起下两角也是圆的）：页面滚动时内容\n'
        '  会从它下面经过并被模糊；按住空白处可以拖动窗口。',
        '顶栏', must=False)
t = sub(t,
        '* 想清空历史：删掉 data\\history\\ 整个目录和 data\\history-min.jsonl；',
        '* 曲线里有一大段空白（不是细碎的空档）：那多半是**那段时间电脑没开机**，采集停了。\n'
        '  温度计自己存着约半年的记录，点一次「读取设备历史」就能把那些小时补回来\n'
        '  （曲线下面那行说明里也会直接写明"有 N 段空档…"）。\n'
        '* 想清空历史：删掉 data\\history\\ 整个目录和 data\\history-min.jsonl；',
        '空档提示', must=False)
save('使用说明.txt', t, 'gbk')

# ------------------------------------------------------------ 软件介绍.md
m = load('软件介绍.md', 'utf-8')
m = sub(m,
        '- 任何区间都先压到 400 点以内再画（组内取均值，组内峰值单独保留），所以选 30 天也不卡，尖峰也不会被均值抹平。',
        '- 发给界面的点数有上限：功率曲线 400 点、**温度曲线 1200 点**（v1.8.5 起分开设），抽稀是'
        '**按时间分桶**取均值（不再"每 N 行算一组"）—— 温度是两种粒度混着的数据，按行分组会把'
        '每小时那条并掉、在曲线上留下一段段空白。所以选 30 天也不卡，尖峰也不会被均值抹平。',
        'md-点数', must=False)
m = sub(m,
        '- 顶栏是贴边的一条真玻璃，页面内容会从它下面滚过去并被模糊（全页只有这一处大模糊 —— 同屏几十块毛玻璃会掉帧）。',
        '- 顶栏是贴边的一条**圆角玻璃条**（v1.8.5 起下两角也是圆的），页面内容会从它下面滚过去并被模糊'
        '（全页只有这一处大模糊 —— 同屏几十块毛玻璃会掉帧）。',
        'md-顶栏', must=False)
m = m.replace('版本 1.8.4', '版本 1.8.5')
save('软件介绍.md', m, 'utf-8')

# ------------------------------------------------------------ 软件介绍.html
h = load('软件介绍.html', 'utf-8')
h = sub(h,
        '<li>任何区间都压到 400 点以内再画，组内取均值、峰值单独保留</li>',
        '<li>点数上限：功率曲线 400 点、<b>温度曲线 1200 点</b>（v1.8.5 起分开设）；抽稀<b>按时间分桶</b>'
        '取均值 —— 温度是两种粒度混着的，按行分组会把每小时那条并掉、留下空白</li>',
        'html-点数', must=False)
h = h.replace('版本 1.8.4', '版本 1.8.5')
save('软件介绍.html', h, 'utf-8')

# ------------------------------------------------------------ version.json
vj = load('version.json', 'utf-8')
save('version.json', vj.replace('1.8.4', '1.8.5'), 'utf-8')

print('\n'.join(stats))
print('完成')
