"""v1.8.2 文档更新：

    · 「读完设备历史 = 用它覆盖旧数据」（温度计章节）
    · 「磨砂」开关已删除、玻璃固定 acrylic（界面/桌面集成章节）

三个文件的编码与换行各不相同，统一在这里处理：
    使用说明.txt       GBK + CRLF（必须整篇统一：混进裸 LF 会让打包校验判 FAIL）
    软件介绍.md/.html  UTF-8 + CRLF

⚠️ 源码里别在双引号字符串中写 ASCII 双引号（会把自己劈成两半），中文强调用「」。

用法: python tools/dev/doc_v182.py
"""
from __future__ import annotations

import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
CRLF = '\r\n'


def load(name: str, enc: str) -> str:
    s = (ROOT / name).read_bytes().decode(enc)
    bare = s.count('\n') - s.count(CRLF)
    if bare:
        print('%s 里本来就有 %d 个裸 LF，先修好再改' % (name, bare))
        sys.exit(2)
    return s.replace(CRLF, '\n')      # 统一成 LF 再改，锚点里才好写；save() 会转回 CRLF


def save(name: str, s: str, enc: str) -> None:
    out = s.replace('\r\n', '\n').replace('\n', CRLF)
    data = out.encode(enc)
    (ROOT / name).write_bytes(data)
    print('%-16s %d 字节  CRLF %d  裸 LF %d' % (name, len(data), out.count(CRLF),
                                              out.count('\n') - out.count(CRLF)))


def insert_after(text: str, anchor: str, block: str, tag: str) -> str:
    if text.count(anchor) != 1:
        print('锚点不唯一（%d 次）[%s]：%s' % (text.count(anchor), tag, anchor[:46]))
        sys.exit(3)
    return text.replace(anchor, anchor + '\n' + block)


# ------------------------------------------------------------ 使用说明.txt
txt = load('使用说明.txt', 'gbk')
txt = insert_after(
    txt,
    '  · 读历史时的进度写的是「读取中 N 条（M 秒）」。别把 N 和设备的 152 条上限去比：'
    '\n    那 152 是设备**每轮保留**的条数，实际一次会把它内存里的历史全部推出来，'
    '\n    N 超过 152 是正常的（超过时会多一句「已超过设备保留上限」提示）。',
    '  · **读完历史 = 用它覆盖旧数据**（v1.8.2）：设备每小时记的是那一小时的**最高/最低**，'
    '\n    而本应用自己采的是 90 秒瞬时值 —— 两种粒度混在一张图上，「当日最低~最高」会忽宽忽窄'
    '\n    （跑过的那天上百个点、没跑的那天只有 24 个点），看着像数据坏了。所以读完历史会把'
    '\n    **设备历史覆盖到的那段时间**里的本机采样丢掉，统一成设备这一种来源；比历史更新'
    '\n    的那些新读数（当前小时之后采的）照常保留。覆盖多少天、丢了多少条会写进提示和日志。',
    'hist-覆盖',
)
txt = insert_after(
    txt,
    '· 界面里的「玻璃装饰」（彩色光斑、斜向高光、文字亮晕）已于 2026-10-05'
    '\n  全部停用 —— 界面是干净的半透明面板，不再模仿玻璃反光。',
    '· 「磨砂」开关已删除（v1.8.2）：玻璃**固定**是 acrylic 磨砂（窗外糊成柔和底色 +'
    '\n  系统圆角），不再提供「关」这一档 —— 关掉材质只剩一层不透明实色，没有意义。'
    '\n  观感强弱仍由右上角的透明度滑块调（往左更透、往右更实）。',
    'frost-删除',
)
save('使用说明.txt', txt, 'gbk')

# ------------------------------------------------------------ 软件介绍.md
md = load('软件介绍.md', 'utf-8')
md = insert_after(
    md,
    '- **按天视图**：一天一个点（当天均值），阴影带是当天的最高 ~ 最低；配一张按天明细表，'
    '\n  表里的「采样点数」用来自证"今天只有半天数据"。看一个季度只需要扫一眼，不必在几千个小时点里找规律。',
    '- **读完历史就覆盖旧数据（v1.8.2）**：设备每小时记的是该小时的最高/最低，本应用自己采的是 90 秒瞬时值，'
    '\n  两种粒度混着画会让「当日最低~最高」忽宽忽窄。因此读完历史会把**设备覆盖到的那段时间**的本机采样丢掉，'
    '\n  统一成设备一种来源（比历史更新于的新读数照常保留）。',
    'md-覆盖',
)
md = insert_after(
    md,
    '留下的是干净的半透明深色面板 + 清晰的白字；柔和投影保留，卡片依然有层次但不"装"玻璃。',
    '磨砂（acrylic 材质）**固定开**：窗外被糊成柔和底色 + 系统圆角，没有开关（v1.8.2 把那个按钮删了）。',
    'md-磨砂',
)
save('软件介绍.md', md, 'utf-8')

# ------------------------------------------------------------ 软件介绍.html
html = load('软件介绍.html', 'utf-8')
html = insert_after(
    html,
    '        <li>读完区间里会多出<b>「90 天」「全部」</b>两档；时间轴刻度随跨度自动换格式（时:分:秒 → 月-日）</li>',
    '        <li><b>读完历史就覆盖旧数据（v1.8.2）</b>：设备每小时记的是该小时最高/最低，本应用采的是 90 秒瞬时值，'
    '两种粒度混着画会让「当日最低~最高」忽宽忽窄 —— 读完历史会把设备覆盖到的那段时间的本机采样丢掉，'
    '统一成设备一种来源（更新的新读数照常保留）</li>',
    'html-覆盖',
)
html = insert_after(
    html,
    '        <li>开机自启动可选，放启动文件夹，不改注册表</li>',
    '        <li><b>磨砂固定开</b>（v1.8.2 删掉了开关）：窗外糊成柔和底色 + 系统圆角；'
    '观感强弱用右上角<b>透明度滑块</b>调（往左更透、往右更实）</li>',
    'html-磨砂',
)
save('软件介绍.html', html, 'utf-8')
print('完成')
