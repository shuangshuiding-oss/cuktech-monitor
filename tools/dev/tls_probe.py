"""TLS 链探针：定位 account.xiaomi.com:443 证书校验失败的真正原因。

只用标准库 + certifi，把四种组合都试一遍：
    A. certifi 信任库 + 严格模式（Python 3.13 默认）
    B. certifi 信任库 + 关闭 VERIFY_X509_STRICT（3.12 及以前的行为）
    C. 系统信任库 + 严格模式
    D. 系统信任库 + 关闭严格模式
并把服务端实际发来的证书链（subject/issuer）打出来，判断是不是被中间人代理。

用法：
    python tools/dev/tls_probe.py [host] [port]
"""

from __future__ import annotations

import base64
import os
import socket
import ssl
import sys
import tempfile

HOST = sys.argv[1] if len(sys.argv) > 1 else "account.xiaomi.com"
PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 443

CANARY_FLAGS = {
    "VERIFY_X509_STRICT": getattr(ssl, "VERIFY_X509_STRICT", None),
    "VERIFY_X509_PARTIAL_CHAIN": getattr(ssl, "VERIFY_X509_PARTIAL_CHAIN", None),
    "VERIFY_X509_TRUSTED_FIRST": getattr(ssl, "VERIFY_X509_TRUSTED_FIRST", None),
}

try:
    import certifi
    CAFILE = certifi.where()
    CAVER = getattr(certifi, "__version__", "?")
except Exception as exc:  # noqa: BLE001
    CAFILE, CAVER = None, "MISSING (%s)" % exc


def describe(der: bytes) -> str:
    """把 DER 证书转成 subject/issuer 一行文本。"""
    pem = ssl.DER_cert_to_PEM_cert(der)
    fd, path = tempfile.mkstemp(suffix=".pem")
    try:
        with os.fdopen(fd, "w", encoding="ascii") as fh:
            fh.write(pem)
        info = ssl._ssl._test_decode_cert(path)  # noqa: SLF001
        sub = "/".join("%s=%s" % (k, v) for part in info.get("subject", ()) for k, v in part)
        iss = "/".join("%s=%s" % (k, v) for part in info.get("issuer", ()) for k, v in part)
        return "subject[%s]  issuer[%s]" % (sub, iss)
    except Exception as exc:  # noqa: BLE001
        return "<decode failed: %s>" % exc
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass


def attempt(cafile, strict: bool):
    label = ("certifi" if cafile else "system") + ("+strict" if strict else "+relaxed")
    try:
        ctx = ssl.create_default_context(cafile=cafile) if cafile else ssl.create_default_context()
        if not strict and CANARY_FLAGS["VERIFY_X509_STRICT"] is not None:
            ctx.verify_flags &= ~ssl.VERIFY_X509_STRICT
        with socket.create_connection((HOST, PORT), timeout=20) as sock:
            with ctx.wrap_socket(sock, server_hostname=HOST) as ss:
                chain = []
                got = None
                if hasattr(ss, "get_verified_chain"):
                    try:
                        got = ss.get_verified_chain()
                    except Exception:  # noqa: BLE001
                        got = None
                if got:
                    chain = [c.public_bytes() for c in got]
                if not chain and hasattr(ss, "get_unverified_chain"):
                    try:
                        chain = [c.public_bytes() for c in (ss.get_unverified_chain() or [])]
                    except Exception:  # noqa: BLE001
                        chain = []
                return {
                    "label": label,
                    "flags": hex(ctx.verify_flags),
                    "result": "OK  cipher=%s  %s" % (ss.cipher()[0], ss.version()),
                    "chain": chain,
                }
    except Exception as exc:  # noqa: BLE001
        return {
            "label": label,
            "flags": None,
            "result": "FAIL  %s: %s" % (type(exc).__name__, exc),
            "chain": [],
        }


def main() -> int:
    print("=" * 78)
    print("host            : %s:%d" % (HOST, PORT))
    print("python          : %s" % sys.version.replace("\n", " "))
    print("openssl         : %s" % ssl.OPENSSL_VERSION)
    print("certifi         : %s  (%s)" % (CAVER, CAFILE))
    print("default flags   : %s" % hex(ssl.create_default_context().verify_flags))
    for name, val in CANARY_FLAGS.items():
        print("  %-28s = %s" % (name, val))
    print("env proxy       : HTTP_PROXY=%r HTTPS_PROXY=%r ALL_PROXY=%r NO_PROXY=%r"
          % (os.environ.get("HTTP_PROXY"), os.environ.get("HTTPS_PROXY"),
             os.environ.get("ALL_PROXY"), os.environ.get("NO_PROXY")))
    print("=" * 78)

    for cafile, strict in ((CAFILE, True), (CAFILE, False), (None, True), (None, False)):
        if cafile is None and CAFILE is None:
            continue
        res = attempt(cafile, strict)
        print("\n[%-10s] flags=%s" % (res["label"], res["flags"]))
        print("  %s" % res["result"])
        for i, der in enumerate(res["chain"]):
            tag = "leaf " if i == 0 else ("root?" if i == len(res["chain"]) - 1 else "inter")
            print("    %s #%d %s" % (tag, i, describe(der)))
    print("\n" + "=" * 78)
    print("判读：")
    print("  只有 A 失败、B 成功  -> Python 3.13 的严格模式误杀小米证书链（本工程的 bug，改代码即可）")
    print("  A/B 都失败           -> 本机网络有中间人拦截（代理/杀软/加速器装了自签根证书）")
    print("  链里出现陌生 issuer  -> 同上，证书不是小米官方的")
    return 0


if __name__ == "__main__":
    sys.exit(main())
