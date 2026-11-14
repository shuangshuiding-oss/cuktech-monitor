"""v1.8.1 文档更新（第二块）：软件介绍.md / 软件介绍.html。

补两件事：
    · 「按天」看温湿度（曲线压成一天一个点 + 按天明细表）
    · 登录的 TLS 口径（Python 3.13 严格模式 / 网络自检）

这两个文件是 **CRLF**（和代码文件的 LF 不同），所以统一用 Python 读写：读进来
归一化成 LN 再写回时统一转 CRLF，避免混进裸 LF。

用法: python tools/dev/doc_v181b.py
"""
from __future__ import annotations

import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
CRLF = '\r\n'

MD = ROOT / '软件介绍.md'
HTML = ROOT / '软件介绍.html'


def load(p: pathlib.Path) -> str:
    s = p.read_bytes().decode('utf-8')
    bare = s.count('\n') - s.count(CRLF)
    if bare:
        print('%s 里本来就有 %d 个裸 LF' % (p.name, bare))
        sys.exit(2)
    return s.replace(CRLF, '\n')


def save(p: pathlib.Path, s: str) -> None:
    out = s.replace('\r\n', '\n').replace('\n', CRLF)
    p.write_bytes(out.encode('utf-8'))
    print('%s -> %d 字节，CRLF %d，裸 LF %d' % (p.name, len(out.encode('utf-8')),
                                              out.count(CRLF), out.count('\n') - out.count(CRLF)))


def insert_after(text: str, anchor: str, block: str) -> str:
    if text.count(anchor) != 1:
        print('锚点不唯一（%d 次）：%s' % (text.count(anchor), anchor[:50]))
        sys.exit(3)
    return text.replace(anchor, anchor + '\n' + block)


# ------------------------------------------------------------------ markdown
md = load(MD)

md = insert_after(
    md,
    '- 温湿度曲线读完温度计的内置历史后，还会多出**「90 天」和「全部」**两档（功率曲线到不了这么长，那两档是给温度看的）。',
    '- **「按天」开关（v1.8.1）**：温度卡片右上角那个按钮把曲线从"每次读数一个点"压成**一天一个点** —— '
    '纵轴是当天的**均值**，橙色阴影带是那天的**最低 ~ 最高**；曲线下面另给一张**按天明细表**'
    '（日期 / 均温 / 当天最低~最高 / 均湿 / 采样点数，最近 31 天）。90 天、全部这种长区间有上千个点，'
    '按天之后一眼就是"哪几天热"。打开时若窗口短于 7 天会自动跳到 7 天，选择会记住。',
)

md = insert_after(
    md,
    '- 曲线把**温度（橙，左轴）和湿度（青，右轴）**画在一起，共用一条时间轴；空档处**直接断开连线、不补 0**（温度没有「0℃ = 没数据」的语义）。',
    '- **按天视图**：一天一个点（当天均值），阴影带是当天的最高 ~ 最低；配一张按天明细表，'
    '表里的「采样点数」用来自证"今天只有半天数据"。看一个季度只需要扫一眼，不必在几千个小时点里找规律。',
)

md = insert_after(
    md,
    '- **授权只做一次**：扫码从小米云取这台设备的 12 字节蓝牙密钥，之后全部本地直连，不需要填任何地址。',
    '- **登录的 TLS 口径**：Python 3.13 起客户端会默认给 HTTPS 打开 OpenSSL 的严格模式，它比浏览器严得多 ——'
    ' 小米证书链里只要有一张 CA 证书的 `basicConstraints` 没标成 critical 就直接判死'
    '（报 `Basic Constraints of CA cert not marked critical`）。程序因此显式只关掉那一面旗子，'
    '**CA 校验与主机名校验照做**。登录弹层里的「网络自检」会现场拉一遍小米服务器的证书链，'
    '区分「本机没问题」「只是严格模式误判」「网络被中间人解密（抓包工具/杀软网页防护/公司 VPN/加速器）」三种情况，'
    '报告写到 `data\\tls-report.txt`。',
)

save(MD, md)

# ------------------------------------------------------------------ html
html = load(HTML)

html = insert_after(
    html,
    '        <li>读完区间里会多出<b>「90 天」「全部」</b>两档；时间轴刻度随跨度自动换格式（时:分:秒 → 月-日）</li>',
    '        <li><b>按天看温湿度（v1.8.1）</b>：卡片右上角「按天」把曲线压成<b>一天一个点</b> —— '
    '纵轴是当天均值，橙色阴影带是当天<b>最低 ~ 最高</b>；下面另给一张<b>按天明细表</b>'
    '（日期 / 均温 / 当天最低~最高 / 均湿 / 采样点数，最近 31 天）</li>\n'
    '        <li>打开『按天』时若窗口短于 7 天会自动跳到 7 天（一天一个点，短窗口画不出东西）；'
    '表里的「采样点数」用来自证<b>今天只有半天数据</b></li>',
)

html = insert_after(
    html,
    '    <strong>授权只做一次</strong>：扫码从小米云取这台设备的 12 字节蓝牙密钥，之后全部本地直连，不需要填任何地址。<br>',
    '    <strong>登录的 TLS 口径</strong>：Python 3.13 起客户端默认给 HTTPS 打开 OpenSSL 的严格模式，'
    '它比浏览器严得多 —— 小米证书链里只要有一张 CA 证书的 <code>basicConstraints</code> 没标成 critical 就直接判死。'
    '程序只关掉那一面旗子，<strong>CA 校验与主机名校验照做</strong>；登录弹层的「网络自检」会现场拉一遍证书链，'
    '区分「本机正常 / 严格模式误判 / 网络被中间人解密」，报告写 <code>data\\tls-report.txt</code>。<br>',
)

save(HTML, html)
print('完成')
