"""v1.8.3 文档更新（第二块）：区间里加「半年」档。

三份文档里凡是列长窗的地方都补上"半年"（90 天 / 半年 / 1 年 / 全部）。

用法: python tools/dev/doc_v183b.py
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


def sub(text: str, old: str, new: str, tag: str) -> str:
    n = text.count(old)
    if n != 1:
        print('「%s」命中 %d 次：%s' % (tag, n, old[:50]))
        sys.exit(3)
    return text.replace(old, new)


# ------------------------------------------------------------ 使用说明.txt
t = load('使用说明.txt', 'gbk')
t = sub(t, '温度计读过内置历史之后，还会多出 90 天 / 1 年 / 全部 三档（共 15 档）。',
        '温度计读过内置历史之后，还会多出 90 天 / 半年 / 1 年 / 全部 四档（共 16 档）。', '档位清单')
t = sub(t, '**「90 天」「1 年」「全部」**三档：温湿度计自己',
        '**「90 天」「半年」「1 年」「全部」**四档：温湿度计自己', '354')
t = sub(t, '并放出「90 天」「1 年」「全部」三档。', '并放出「90 天」「半年」「1 年」「全部」四档。', '378')
t = sub(t, '* 功率曲线切到「90 天」「1 年」「全部」几乎是空的，这很正常：那几档是给温度计的',
        '* 功率曲线切到「90 天」「半年」「1 年」「全部」几乎是空的，这很正常：那几档是给温度计的', '495')
t = sub(t, '* 「90 天 / 1 年 / 全部」是**温度专用**的长窗（功率曲线切过去基本是空的）：温度计自己',
        '* 「90 天 / 半年 / 1 年 / 全部」是**温度专用**的长窗（功率曲线切过去基本是空的）：温度计自己', '长窗说明')
save('使用说明.txt', t, 'gbk')

# ------------------------------------------------------------ 软件介绍.md
m = load('软件介绍.md', 'utf-8')
m = sub(m, '还会多出**「90 天」「1 年」和「全部」**三档', '还会多出**「90 天」「半年」「1 年」和「全部」**四档', 'md-52')
save('软件介绍.md', m, 'utf-8')

# ------------------------------------------------------------ 软件介绍.html
h = load('软件介绍.html', 'utf-8')
h = sub(h, '还会多出「90 天」「1 年」「全部」三档', '还会多出「90 天」「半年」「1 年」「全部」四档', 'html-152')
h = sub(h, '读完区间里会多出<b>「90 天」「1 年」「全部」</b>三档',
        '读完区间里会多出<b>「90 天」「半年」「1 年」「全部」</b>四档', 'html-179')
save('软件介绍.html', h, 'utf-8')

print('\n'.join(stats))
print('完成')
