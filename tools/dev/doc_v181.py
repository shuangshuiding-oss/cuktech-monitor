"""v1.8.1 文档更新：往 使用说明.txt 里补两块内容。

    · 「按天」视图（温湿度卡片）
    · 登录报证书错的排障条目 + 新增文件说明（netfix.py / test_env_daily.js）

这个文件是 GBK + CRLF 的，写回时必须整篇归一化成 CRLF：工具链里有一条
"0 裸 LF" 的打包校验，混进去一个 LF 就判 FAIL。所以不用文本替换，统一走 Python：
读 GBK → 改 → 断言 CRLF 干净 → 写 GBK。

⚠️ 注意：源码里的字符串只用 ASCII 单引号或中文引号「」，绝不能在双引号字符串里
   写 ASCII 双引号 —— 那是自己把自己劈成两半。

用法: python tools/dev/doc_v181.py
"""
from __future__ import annotations

import pathlib
import sys

DOC = pathlib.Path(__file__).resolve().parents[2] / '使用说明.txt'
CRLF = '\r\n'

raw0 = DOC.read_bytes()
size0 = len(raw0)
txt = raw0.decode('gbk')
crlf0 = txt.count(CRLF)
bare0 = txt.count('\n') - crlf0
if bare0:
    print('原文里就有 %d 个裸 LF，先修好再改' % bare0)
    sys.exit(2)

edits = 0


def insert_after(anchor: str, block: str) -> None:
    global txt, edits
    n = txt.count(anchor)
    if n != 1:
        print('锚点不唯一（%d 次）：%s' % (n, anchor[:40]))
        sys.exit(3)
    txt = txt.replace(anchor, anchor + CRLF + block)
    edits += 1


# ---- 1. 温湿度曲线章节：补「按天」视图 ------------------------------------
insert_after(
    '· 鼠标悬停看某一点的具体温湿度。断网/退出后重开，曲线会从磁盘回填，右半张不会空白。',
    '· 卡片右上角的**「按天」**按钮（v1.8.1）把曲线从「每次读数一个点」压成**一天一个点**：'
    + CRLF + '  纵轴是当天的**均值**，橙色阴影带是那天的**最低 ~ 最高**。长区间（30 天以上）'
    '上千个点密密麻麻看不出规律，' + CRLF + '  按天之后一眼就知道哪几天热、哪天开过空调。'
    + CRLF + '· 打开「按天」后曲线下面会多一张**按天明细表**：日期 / 均温 / 当天最低~最高 / '
    '均湿 / 当天最低~最高 / 采样点数，' + CRLF + '  最近的排最上面（最多列 31 天，更长的区间'
    '会写明一共多少天）。鼠标悬停某一天也能看到这几个数。' + CRLF +
    '· 打开时会自动把过短的区间跳到「7 天」——一天一个点，1 小时的窗口最多画出一个点。'
    + CRLF + '  表里的「采样点数」是用来自证的：**今天**是还没过完的一天，它的点数比昨天少是对的。'
    + CRLF + '  这个开关会记住，下次打开还是按天。',
)

# ---- 2. 文件说明：新增 netfix.py ------------------------------------------
insert_after(
    'login.py           小米云扫码登录',
    'netfix.py          小米云登录的 TLS 口径 + 证书自检（兼容 Python 3.13 的严格模式；'
    + CRLF + '                   可单独运行：python netfix.py --probe 出一份证书链体检报告）',
)

# ---- 3. 文件说明：新增按天回归测试 ----------------------------------------
insert_after(
    'tools\\test_plug.js       插拔记账离线回归（插/拔/抖动不切断/充饱不算拔出/重启恢复），'
    + CRLF + '                          90 项断言',
    'tools\\test_env_daily.js  按天温湿度聚合离线回归（本地日期分组/坏行不当 0℃/均值自洽），'
    + CRLF + '                          39 项断言',
)

# ---- 4. 排障：登录证书错（放在「找不到 Python」后面，新用户第一次就会碰到）----
insert_after(
    '* 提示找不到 Python：运行 tools\\setup-env.ps1 重建运行环境。',
    '* 点「登录小米云」报证书错（certificate verify failed / Basic Constraints of CA cert'
    + CRLF + '  not marked critical）：Python 3.13 起客户端默认打开了 OpenSSL 的严格模式，'
    '它比浏览器严得多 ——' + CRLF + '  小米证书链里只要有一张 CA 证书的 basicConstraints 没标成 '
    'critical 就直接判死。本版本默认放宽了这一项' + CRLF + '  （**CA 校验和主机名校验照做**，'
    '只是不再启用那面额外严格的旗子）。如果还是失败，点弹层里的「网络自检」，' + CRLF +
    '  它会给出三种结论之一：' + CRLF +
    '    ① 证书链正常 —— 说明是别的问题（先看系统时间对不对）；' + CRLF +
    '    ② 只是严格模式误判 —— 本程序已自动放宽，点「重试」即可；' + CRLF +
    '    ③ 本机/本网络在解密 HTTPS —— 抓包工具、杀软网页防护、公司 VPN 客户端、加速器'
    '这类软件' + CRLF + '       会装一张自己的根证书来看你的加密流量。请关掉它们或换个网络'
    '（手机热点最快），再点「重试」。' + CRLF + '       注意：第 ③ 种情况下即使登录成功，'
    '你的扫码授权也是经过中间人的，换干净网络更重要。' + CRLF +
    '  体检报告会存到 data\\tls-report.txt，里面逐张列出小米服务器发来的证书链和签发者，'
    + CRLF + '  是不是中间人一眼就能看出来。' + CRLF +
    '* 功率曲线切到「90 天」「全部」几乎是空的，这很正常：那两档是给温度计的' + CRLF +
    '  （设备内置历史约半年），功率只有留在磁盘上的那些天。',
)

out = txt.replace('\r\n', '\n').replace('\n', CRLF)
data = out.encode('gbk')
DOC.write_bytes(data)

print('插入 %d 处' % edits)
print('字节 %d -> %d（+%d）' % (size0, len(data), len(data) - size0))
print('CRLF %d，裸 LF %d，BOM %s' % (out.count(CRLF), out.count('\n') - out.count(CRLF),
                                    data[:3] == b'\xef\xbb\xbf'))
