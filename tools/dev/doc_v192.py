"""v1.9.2 文档改写：把「证书错」那段拆成两类，并写清"缺根"怎么办。

⚠️ 教训（本项目踩过两次）：**不要按行号改 GBK 文档** —— 前一段长度一变，后面全错位。
   这里全部用锚点定位。
⚠️ 写完必须整篇归一化 CRLF，否则打包校验判 FAIL。
"""

from __future__ import annotations

import io
import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parents[2]
CRLF = "\r\n"
ENV = "gbk"

OLD_START = "* 点「登录小米云」报证书错（certificate verify failed / Basic Constraints of CA cert"
OLD_END = "是不是中间人一眼就能看出来。"      # 比较时已 strip，别再带前导空格

NEW = [
    "* 点「登录小米云」报证书错：先分清是哪一种，处置完全不同 ——",
    "  A. 报错尾巴是「Basic Constraints of CA cert not marked critical」",
    "     Python 3.13 起客户端默认打开了 OpenSSL 的严格模式，比浏览器严得多：小米证书链里",
    "     只要有一张 CA 证书的 basicConstraints 没标成 critical 就直接判死。本版本默认放宽了",
    "     这一项（CA 校验和主机名校验照做，只是不再启用那面额外严格的旗子）。",
    "  B. 报错尾巴是「unable to get local issuer certificate」",
    "     这台电脑找不到可信的根证书。两种成因，处置相反：",
    "     ① 系统的根证书库不全 —— 精简版系统、或长期关着 Windows 更新的机器（根证书就靠它",
    "        自动下载）。本版本已随包带了一张 GoDaddy 根证书（vendor\\ca\\xiaomi-roots.pem），",
    "        业务连接用「系统库 + 随包根」，这种机器照样能登录，完整校验一个都没少。",
    "     ② 本机或本网络在解密 HTTPS —— 抓包工具、杀软网页防护、公司 VPN、校园网网关、",
    "        带解密功能的代理软件，都会用自己的证书重签连接。这种情况**必须换网络再登录**",
    "        （手机热点最快），别在它上面输小米密码。",
    "  分不清是 ① 还是 ②？点登录弹层里的「网络自检」，它会读出对方真正出示的证书链，",
    "  直接给出结论之一：",
    "    证书链正常 / 只是严格模式误判 / 这台电脑证书库缺一张根（并写出缺的是哪一张）/",
    "    本机或本网络在解密 HTTPS / 系统时间不对 / 根本没连上（不是证书问题）。",
    "  体检报告会存到 data\\tls-report.txt，逐张列出证书的签发者、以及它是否在本机信任库里 ——",
    "  把这整份文件发给作者，远程就能判断是哪一种，不用猜。",
]


def main() -> int:
    p = ROOT / "使用说明.txt"
    text = io.open(p, encoding=ENV, newline="").read()
    lines = text.split(CRLF)

    start = next((i for i, l in enumerate(lines) if l.startswith(OLD_START)), None)
    end = next((i for i, l in enumerate(lines) if l.strip() == OLD_END), None)
    if start is None or end is None or end < start:
        print("!! 锚点没找到：start=%r end=%r" % (start, end))
        return 1
    print("替换第 %d~%d 行（共 %d 行）" % (start + 1, end + 1, end - start + 1))

    lines[start:end + 1] = NEW
    out = CRLF.join(lines)
    # 整篇归一化：绝不能混进裸 LF/CR，否则 verify_package 判 FAIL
    out = out.replace("\r\n", "\n").replace("\r", "\n").replace("\n", "\r\n")
    io.open(p, "wb").write(out.encode(ENV))

    raw = open(p, "rb").read()
    print("写完：%d 字节，CR=%d LF=%d，CRLF=%d"
          % (len(raw), raw.count(b"\r"), raw.count(b"\n"), raw.count(b"\r\n")))
    return 0 if raw.count(b"\r") == raw.count(b"\n") else 2


if __name__ == "__main__":
    raise SystemExit(main())
