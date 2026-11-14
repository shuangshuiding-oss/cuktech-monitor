"""v1.8.3 文档更新：设备小时记录画成"该小时一段"。

三份文档各补一句（温度计章节），并顺手把版本号从 1.8.2 提到 1.8.3。

编码/换行：使用说明.txt = GBK+CRLF，软件介绍.md/.html = UTF-8+CRLF。
⚠️ 双引号字符串里别写 ASCII 双引号。

用法: python tools/dev/doc_v183.py
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
        print('%s 里本来就有 %d 个裸 LF' % (name, bare))
        sys.exit(2)
    return s.replace(CRLF, '\n')


def save(name: str, s: str, enc: str) -> None:
    out = s.replace('\r\n', '\n').replace('\n', CRLF)
    data = out.encode(enc)
    (ROOT / name).write_bytes(data)
    stats.append('%-15s %6d 字节  CRLF %d  裸 LF %d' % (name, len(data), out.count(CRLF),
                                                       out.count('\n') - out.count(CRLF)))


def insert_after(text: str, anchor: str, block: str, tag: str) -> str:
    n = text.count(anchor)
    if n != 1:
        print('锚点不唯一（%d 次）[%s]：%s' % (n, tag, anchor[:46]))
        sys.exit(3)
    return text.replace(anchor, anchor + '\n' + block)


txt = load('使用说明.txt', 'gbk')
txt = insert_after(
    txt,
    '  · **读完历史 = 用它覆盖旧数据**（v1.8.2）：设备每小时记的是那一小时的**最高/最低**，',
    '  · **每小时一条，但画的是一段**（v1.8.3）：设备每条记录覆盖的是**刚走完的那一小时**，'
    '\n    所以曲线把它铺成横跨那一小时的一小段带子（上沿最高、下沿最低、中间一条均线），'
    '\n    而不是一个孤零零的点。没有这个处理的话，切到「30 分钟」看就会以为"历史只读回来'
    '\n    一两个点"—— 其实那一个小时是有数据的，只是设备一小时才记一次。'
    '\n    想看连续的历史曲线请用 7 天 / 30 天 / 全部；短窗口本来就只能显示到"当前这一小时"为止。'
    '\n    老数据（v1.8.2 之前落盘的）只有均值、没有最高/最低，启动时会自动补上"这一段"的跨度；'
    '\n    再点一次「读取设备历史」就能把每小时的最低/最高也补回来（带子更饱满）。',
    'hist-小时带',
)
save('使用说明.txt', txt, 'gbk')

md = load('软件介绍.md', 'utf-8')
md = insert_after(
    md,
    '- **读完历史就覆盖旧数据（v1.8.2）**：设备每小时记的是该小时的最高/最低，本应用自己采的是 90 秒瞬时值，',
    '- **每小时一条，画成一段（v1.8.3）**：设备记录覆盖的是刚走完的那一小时，所以曲线把它铺成横跨一小时的带子'
    '（最低~最高 + 均线），不是一个孤点 —— 切到 30 分钟窗口也不会再"只有一两个点、其余全空白"。',
    'md-小时带',
)
md = md.replace('版本 1.8.2', '版本 1.8.3')
save('软件介绍.md', md, 'utf-8')

html = load('软件介绍.html', 'utf-8')
html = insert_after(
    html,
    '        <li>读完区间里会多出<b>「90 天」「1 年」「全部」</b>三档；时间轴刻度随跨度自动换格式（时:分:秒 → 月-日）</li>',
    '        <li><b>每小时一条，画成一段（v1.8.3）</b>：设备记录覆盖的是刚走完的那一小时，曲线把它铺成横跨一小时的带子'
    '（最低~最高 + 均线）而不是孤点 —— 切到 30 分钟窗口也不会再"只有一两个点、其余全空白"</li>',
    'html-小时带',
)
html = html.replace('版本 1.8.2', '版本 1.8.3')
save('软件介绍.html', html, 'utf-8')

# version.json（CRLF）
vj = load('version.json', 'utf-8')
save('version.json', vj.replace('1.8.2', '1.8.3'), 'utf-8')

print('\n'.join(stats))
print('完成')
