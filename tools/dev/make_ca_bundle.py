"""从本机 Windows 信任库里抽出小米证书链需要的**根证书**，存成随包携带的 PEM。

为什么要随包带根证书：
    便携包用的是 Windows 系统信任库（OpenSSL 的 enum_certificates），这是对的做法；
    但有一类机器会报
        unable to get local issuer certificate
    因为它的信任库里根本没有小米链的根 —— 常见于「精简版/GHOST 系统」「关了 Windows
    更新（根证书靠它自动下载）」「企业 GPO 裁剪过信任库」的机器。
    便携包的定位是「拷过去就能用」，不该依赖目标机器的根证书库是否完整。

边界（很重要）：
    · 只抽**小米当前证书链实际用到的那一两张根**，不是整个 Mozilla 根证书包 ——
      少一张证书就多一份信任面，够用就行。
    · 业务请求仍然做**完整校验**（验 CA + 验主机名），只是把信任锚从「只有系统库」
      变成「系统库 ∪ 随包这几张」。不会 CERT_NONE、不会 verify=False。
    · 证书体检（netfix.py --probe）**故意不用**这个包，这样报告如实反映系统状态，
      能看出「这台机器少了哪张根」。

用法:
    python tools/dev/make_ca_bundle.py                    # 用默认清单
    python tools/dev/make_ca_bundle.py --list             # 只列出本机 GoDaddy 根
"""

from __future__ import annotations

import argparse
import ssl
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "vendor" / "ca" / "xiaomi-roots.pem"

# 小米 account.xiaomi.com 现在的链：
#   叶 *.account.xiaomi.com
#     ← GoDaddy TLS Intermediate CA DV - R1v1
#       ← GoDaddy TLS Root CA - R1（交叉签名）
#         ← Go Daddy Root Certificate Authority - G2   ← Windows 里的那张锚
DEFAULT_SUBJECTS = (
    "Go Daddy Root Certificate Authority - G2",
    "GoDaddy TLS Root CA - R1",
)


def store_certs():
    import warnings

    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        from cryptography import x509
        for der, _enc, _trust in ssl.enum_certificates("ROOT"):
            try:
                yield x509.load_der_x509_certificate(der), der
            except Exception:  # noqa: BLE001
                continue


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--list", action="store_true", help="只列出本机信任库里的 GoDaddy 根")
    ap.add_argument("--out", default=str(OUT))
    args = ap.parse_args(argv)

    found = []
    for cert, der in store_certs():
        subj = cert.subject.rfc4514_string()
        if "oDaddy" not in subj:
            continue
        if args.list:
            print("%-70s 到期 %s" % (subj, cert.not_valid_after_utc.date()))
        for want in DEFAULT_SUBJECTS:
            if want.lower() in subj.lower():
                found.append((want, subj, der))

    if args.list:
        return 0

    if not found:
        print("!! 本机信任库里没找到清单里的根证书，无法生成随包根")
        return 1

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    parts = []
    for want, subj, der in found:
        pem = ssl.DER_cert_to_PEM_cert(der)
        parts.append("# %s\n%s" % (want, pem))
    out.write_text("".join(parts), encoding="ascii")
    print("写入 %s（%d 张根证书，%d 字节）" % (out, len(parts), out.stat().st_size))
    for want, subj, _ in found:
        print("  + %s" % want)

    # 立刻验证能被 ssl 读回来 —— 读不回来等于没带。
    # ⚠️ 不能拿「默认库 + 这个文件」前后的 CA 数做比较：本机信任库里本来就有这张根，
    #    OpenSSL 会对重复锚点去重，数字一点都不会涨（第一次写这段就踩了，误判成失败）。
    #    改成用一个**空的**客户端上下文只装这个文件，数出来才是包里真正有几张。
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    ctx.load_verify_locations(cafile=str(out))
    stats = ctx.cert_store_stats()
    print("校验：仅加载该文件时 CA %d 张（应为 %d）" % (stats["x509_ca"], len(parts)))
    return 0 if stats["x509_ca"] == len(parts) else 2


if __name__ == "__main__":
    sys.exit(main())
