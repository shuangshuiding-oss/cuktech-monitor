"""小米云登录的网络兼容层：TLS 校验口径 + 证书链自检。

【为什么需要这个文件】
Python 3.13 起，`ssl.create_default_context()` 给客户端上下文（PROTOCOL_TLS_CLIENT）
默认加上了 `VERIFY_X509_STRICT`。这个"严格模式"比浏览器严得多：证书链里只要有一张
CA 证书的 `basicConstraints` 没标成 critical，OpenSSL 直接判死，报

    certificate verify failed: Basic Constraints of CA cert not marked critical
    (_ssl.c:1032)

小米账号服务（account.xiaomi.com）的证书链就踩在这条线上，Windows 自己的校验、
浏览器、以及 Python 3.12 及以前都接受同一条链。于是同一份便携包会出现
"A 电脑能扫码、B 电脑报上面那个错" —— 看着像软件坏了，其实是解释器默认值不同。

对策：**保留完整校验（验 CA + 验主机名）**，只把"严格模式"这面旗摘掉，
回到 3.12 及以前 / 浏览器的口径。

【第二种报错：unable to get local issuer certificate —— 这个不是严格模式】
    certificate verify failed: unable to get local issuer certificate (_ssl.c:1032)

  意思是**本机找不到任何信任的根给这条链做锚点**。和"严格模式"是两回事：
  严格模式是"找到根了，但那张 CA 的写法不合 OpenSSL 的严格规范"；这一条是"根本找不到根"。
  三种成因，处置完全不同 —— 所以必须实测，不能猜：

    ① 本机信任库里缺根证书（信任库被精简 / 系统长期没更新 / Windows 更新被关）：
       小米链的锚是 GoDaddy G2（见 tools/dev/make_ca_bundle.py 里的链图）。
       浏览器往往还能打开，因为它自带信任库；而 Python 用的是系统库。
    ② 网络里有人解密 HTTPS（公司 VPN / 校园网网关 / 杀软网页防护 / 抓包工具）：
       对方用自签根重签了连接，那张根没装进本机 → 同样报这一句。
    ③ 代理软件把 CONNECT 转给了自己的 TLS 端口，证书是它现签的。

  程序怎么区分：**用不校验证书的方式再握一次手（peek），把服务器/中间人真正出示的
  证书链读出来** —— 看叶证书的签发者是谁、再看链里的根在不在本机信任库里。
  ① 叶证书签发者仍是 GoDaddy（公共 CA），只是根不在库里 ⇒ missing-root
  ② 叶证书签发者变成了某个陌生名字（深信服/卡巴/Fiddler/公司域名…）⇒ mitm
  这只是**诊断**，peek 的上下文绝不会用于任何业务请求（见 _attempt(peek=True)）。

  针对 ①，包里带了一张 GoDaddy G2 根（vendor/ca/xiaomi-roots.pem），业务连接时
  「系统信任库 ∪ 随包根证书」一起用 —— 仍然完整校验 CA 与主机名，只是不再要求
  目标机器的根证书库必须完整。证书体检故意**不用**这个包，好让它如实反映系统状态。

【环境变量开关】
    CUKTECH_TLS_STRICT=1     重新打开严格模式（用来验证"是不是它导致的"）
    CUKTECH_TLS_INSECURE=1   彻底跳过证书校验。仅用于公司代理强制解密、换网络也不
                             可行的机器；这会让人能冒充小米服务器看到登录 cookie，
                             只在救急时用，且日志会打印醒目警告。

【命令行】
    python netfix.py --probe [--json] [--host account.xiaomi.com]
    输出人类可读的证书链体检报告，同时把报告写到 data/tls-report.txt。
    加 --json 时最后一行是机器可读的结论，供 server.js 解析。
"""

from __future__ import annotations

import json
import os
import socket
import ssl
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPORT = HERE / "data" / "tls-report.txt"

# 会让 Python 3.13 客户端上下文默认打开严格模式的旗子（3.13 之前不存在）。
_STRICT = getattr(ssl, "VERIFY_X509_STRICT", 0)
_PARTIAL = getattr(ssl, "VERIFY_X509_PARTIAL_CHAIN", 0)

DEFAULT_HOSTS = ("account.xiaomi.com", "ak.account.xiaomi.com")

# 随包的根证书（见 tools/dev/make_ca_bundle.py）。只在业务连接里额外加载；
# 证书体检不用它 —— 否则就永远看不出"这台机器缺根"了。
BUNDLE = HERE / "vendor" / "ca" / "xiaomi-roots.pem"

# 公共 CA 的名字特征。叶证书的签发者命中这里 ⇒ 连接没被重签（不是中间人），
# 失败只可能是"本机缺根"；反过来不命中 ⇒ 对方用的是私有根，几乎一定是解密。
PUBLIC_CA_HINTS = (
    "godaddy", "digicert", "globalsign", "sectigo", "comodo", "geotrust", "thawte",
    "letsencrypt", "let's encrypt", "isrg", "entrust", "certum", "amazon", "cloudflare",
    "google trust", "gts ", "microsoft", "baltimore", "starfield", "symantec", "verisign",
    "quovadis", "swisssign", "actalis", "secom", "twca", "harica", "izenpe", "affirmtrust",
    "usertrust", "ssl.com", "buypass", "telias", "naver", "certigna", "d-trust", "vtrus",
    "cfca", "wotrus", "trustasia", "gdca", "shanghai ca", "itrus", "cmic",
)

# 会做 HTTPS 解密的常见软件，装在机器上的根证书基本就这几个名字。
MITM_HINTS = (
    "fiddler", "charles", "mitmproxy", "proxyman", "burp", "httptoolkit",
    "sangfor", "深信服", "easyconnect", "atrust", "天融信", "topsec", "网神",
    "奇安信", "qianxin", "深信", "安恒", "dbappsecurity",
    "zscaler", "netskope", "forcepoint", "bluecoat", "symantec web",
    "kaspersky", "eset", "avast", "avg ", "bitdefender", "dr.web",
    "adguard", "360", "qihoo", "tencent", "电脑管家", "金山", "猎豹",
    "clash", "v2ray", "shadowsocks", "surge", "quantumult", "小飞机",
    "wireshark", "nprobe", "ssl eye",
)

_ctx_cache: ssl.SSLContext | None = None
_notes: list[str] = []


# --------------------------------------------------------------------- 开关

def _flag(name: str) -> bool:
    return os.environ.get(name, "").strip() in ("1", "true", "yes", "on")


def insecure_requested() -> bool:
    return _flag("CUKTECH_TLS_INSECURE")


def strict_requested() -> bool:
    return _flag("CUKTECH_TLS_STRICT")


# --------------------------------------------------------------- 会话/上下文

def bundle_info() -> dict:
    """随包根证书的情况：在不在、几张、都是谁。"""
    info: dict = {"file": str(BUNDLE), "exists": BUNDLE.is_file(), "count": 0, "subjects": []}
    if not info["exists"]:
        return info
    try:
        import warnings

        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            from cryptography import x509
            for block in BUNDLE.read_text(encoding="ascii", errors="replace").split("-----BEGIN CERTIFICATE-----")[1:]:
                pem = "-----BEGIN CERTIFICATE-----" + block
                try:
                    c = x509.load_pem_x509_certificate(pem.encode("ascii"))
                    info["count"] += 1
                    info["subjects"].append(c.subject.rfc4514_string())
                except Exception:  # noqa: BLE001
                    continue
    except Exception as exc:  # noqa: BLE001
        info["error"] = str(exc)
    return info


def ssl_context() -> ssl.SSLContext | None:
    """返回给 aiohttp 用的上下文。None 表示"彻底跳过校验"（仅 insecure 开关）。

    ⚠️ 这里**只放宽严格模式 + 多挂一张随包根**，绝不关校验：
       verify_mode 保持 CERT_REQUIRED、check_hostname 保持 True。
    """
    global _ctx_cache
    if insecure_requested():
        if not _notes:
            _notes.append("已跳过 TLS 证书校验（CUKTECH_TLS_INSECURE=1，仅救急用）")
        return None
    if _ctx_cache is None:
        ctx = ssl.create_default_context()
        if _STRICT and not strict_requested():
            ctx.verify_flags &= ~_STRICT
            _notes.append("已放宽 OpenSSL 严格模式（兼容小米证书链；仍验 CA 与主机名）")
        elif _STRICT and strict_requested():
            _notes.append("严格模式已按 CUKTECH_TLS_STRICT=1 强制打开")
        # 系统信任库之外补上随包根证书：目标机器信任库被精简/没更新时也能连，
        # 仍然走完整校验（只是信任锚多一张明确的公共根）。
        bi = bundle_info()
        if bi["exists"] and bi["count"]:
            try:
                ctx.load_verify_locations(cafile=str(BUNDLE))
                _notes.append("信任锚：系统库 + 随包根证书 %d 张" % bi["count"])
            except Exception as exc:  # noqa: BLE001
                _notes.append("随包根证书加载失败（继续用系统库）：%s" % exc)
        _ctx_cache = ctx
    return _ctx_cache


def connector_kwargs() -> dict:
    """可直接展开给 aiohttp.ClientSession(**kwargs)。"""
    import aiohttp

    ctx = ssl_context()
    if ctx is None:
        return {"connector": aiohttp.TCPConnector(ssl=False)}
    return {"connector": aiohttp.TCPConnector(ssl=ctx)}


def notes() -> list[str]:
    return list(_notes)


def describe() -> str:
    ssl_context()
    return "；".join(_notes) if _notes else "TLS 校验：默认口径"


# ------------------------------------------------------------------ 错误识别

def _walk(exc: BaseException):
    seen = set()
    cur: BaseException | None = exc
    while cur is not None and id(cur) not in seen:
        seen.add(id(cur))
        yield cur
        nxt = cur.__cause__ if cur.__cause__ is not None else cur.__context__
        cur = nxt if isinstance(nxt, BaseException) else None


def is_cert_error(exc: BaseException) -> bool:
    """是不是"证书校验失败"，用于：① 立刻终止而不是当瞬时错误重试 ② 换成人话。"""
    marks = (
        "CERTIFICATE_VERIFY_FAILED", "SSLCertVerificationError",
        "certificate verify failed", "Basic Constraints",
        "self-signed certificate", "unable to get local issuer",
        "hostname mismatch", "certificate has expired",
    )
    for e in _walk(exc):
        if isinstance(e, ssl.SSLCertVerificationError):
            return True
        text = "%s: %s" % (type(e).__name__, e)
        if any(m.lower() in text.lower() for m in marks):
            return True
    return False


def friendly_error(exc: BaseException) -> str:
    """把 OpenSSL 的天书换成能让普通人动手的中文。"""
    text = "%s: %s" % (type(exc).__name__, exc)
    low = text.lower()
    if "basic constraints" in low:
        return (
            "无法与小米服务器建立 HTTPS 连接：本机的证书校验没能通过"
            "（小米证书链里有 CA 证书未按 OpenSSL 的严格模式标注）。"
            "已自动放宽校验口径 —— 若仍失败，通常是本机装了会解密 HTTPS 的软件"
            "（抓包工具 / 杀软网页防护 / 公司 VPN 客户端 / 加速器）或该网络做了拦截。"
            "请先点「网络自检」看结论，或换一个网络（如手机热点）重试。"
        )
    if "local issuer" in low or "unable to get" in low:
        return (
            "无法与小米服务器建立 HTTPS 连接：「这台电脑找不到可信的根证书」来验证小米的证书"
            "（不是证书过期，也不是软件版本问题）。常见三种原因："
            "① 系统的根证书库被精简过或长期没更新（多见于精简版系统、关了 Windows 更新的机器）；"
            "② 网络里的设备在解密 HTTPS（公司 VPN / 校园网 / 杀软网页防护 / 抓包工具），"
            "它用自己的证书重签了连接，而那张根没装进本机；"
            "③ 代理软件把连接转给了自己的端口。"
            "请点「网络自检」——它会读出对方真正出示的证书链，直接告诉你是①还是②；"
            "报告在 data\\tls-report.txt，发给作者就能远程判断。"
        )
    if "expired" in low or "not yet valid" in low:
        return "无法与小米服务器建立 HTTPS 连接：本机系统时间不对（证书不在有效期内），请校准系统时间后重试。"
    if "self-signed" in low:
        return (
            "无法与小米服务器建立 HTTPS 连接：对方用的是自签名证书 —— "
            "这几乎一定是本机/本网络的 HTTPS 被解密（公司 VPN、校园网、杀软网页防护、抓包工具）。"
            "请关掉它们或换个网络（手机热点最快），也可以点「网络自检」看是哪张根证书。"
        )
    return "无法与小米服务器建立 HTTPS 连接：" + text


# ------------------------------------------------------------------ 证书链自检

def _chain_info(ss, store: dict | None = None, peek: bool = False) -> list[dict]:
    """把握手拿到的证书链翻译成 subject/issuer/basicConstraints/是否在信任库里。

    peek=True 时优先取"未经校验的链"：校验失败时 OpenSSL 仍然把对方出示的证书留在
    这里，这正是判断"谁签的"的关键。
    """
    certs: list[bytes] = []
    order = ("get_unverified_chain", "get_verified_chain") if peek else \
            ("get_verified_chain", "get_unverified_chain")
    for getter in order:
        fn = getattr(ss, getter, None)
        if fn is None:
            continue
        try:
            got = fn() or []
        except Exception:  # noqa: BLE001
            continue
        if got:
            # ⚠️ 不同 Python/OpenSSL 组合回来的东西不一样：3.13 是 _ssl.Certificate
            #    （要 public_bytes()），有的构建直接给 DER bytes。两种都要吃得下，
            #    否则链接手拿到了却"解不出来"，报告里只剩一行 AttributeError。
            certs = []
            for c in got:
                try:
                    certs.append(c.public_bytes() if hasattr(c, "public_bytes") else bytes(c))
                except Exception:  # noqa: BLE001
                    continue
            break

    store = store or {}
    known = store.get("der") or set()
    subjects = store.get("subjects") or set()

    out: list[dict] = []
    for i, der in enumerate(certs):
        item: dict = {"i": i, "subject": "?", "issuer": "?", "bcCritical": None, "isCA": None,
                      "inStore": None, "selfSigned": None, "notAfter": None}
        try:
            import warnings

            with warnings.catch_warnings():
                # 有些老根证书的序列号是负数，cryptography 会对每张都喊一次，把日志刷满
                warnings.simplefilter("ignore")
                from cryptography import x509  # 便携包里有；没有就退化成只报名字
                c = x509.load_der_x509_certificate(der)
            item["subject"] = c.subject.rfc4514_string()
            item["issuer"] = c.issuer.rfc4514_string()
            item["selfSigned"] = c.subject == c.issuer
            try:
                item["notAfter"] = c.not_valid_after_utc.strftime("%Y-%m-%d")
            except Exception:  # noqa: BLE001
                pass
            try:
                bc = c.extensions.get_extension_for_class(x509.BasicConstraints)
                item["bcCritical"] = bool(bc.critical)
                item["isCA"] = bool(bc.value.ca)
            except x509.ExtensionNotFound:
                item["bcCritical"] = None
                item["isCA"] = None
            if known:
                import hashlib

                item["inStore"] = hashlib.sha256(der).hexdigest() in known
            elif subjects:
                # 信任库里按 DER 对不上时退一步看名字（微软库里同一张根可能有多份编码）
                item["inStore"] = item["subject"].lower() in subjects
        except Exception:  # noqa: BLE001
            try:
                pem = ssl.DER_cert_to_PEM_cert(der)
                import tempfile

                with tempfile.NamedTemporaryFile("w", suffix=".pem", delete=False) as fh:
                    fh.write(pem)
                    tmp = fh.name
                try:
                    info = ssl._ssl._test_decode_cert(tmp)  # noqa: SLF001
                    fmt = lambda seq: "/".join(  # noqa: E731
                        "%s=%s" % (k, v) for part in seq for k, v in part)
                    item["subject"] = fmt(info.get("subject", ()))
                    item["issuer"] = fmt(info.get("issuer", ()))
                    item["selfSigned"] = item["subject"] == item["issuer"]
                finally:
                    try:
                        os.unlink(tmp)
                    except OSError:
                        pass
            except Exception:  # noqa: BLE001
                pass          # 解不出来就只留 "?"，不能让体检本身炸掉
        out.append(item)
    return out


def _attempt(host: str, port: int, relax: bool, peek: bool = False,
             store: dict | None = None) -> dict:
    """握一次手。

    peek=True 是**纯诊断**模式：关掉校验，只为把"对方真正出示的证书链"读出来。
    ⚠️ 它绝不会用于任何业务请求 —— 全文件只有 probe() 会传 peek=True。
    """
    mode = "peek" if peek else ("relaxed" if relax else "strict")
    res: dict = {"mode": mode, "ok": False, "error": None,
                 "tls": None, "cipher": None, "chain": []}
    try:
        ctx = ssl.create_default_context()
        if peek:
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE       # 仅读证书，见上面的警告
        elif relax and _STRICT:
            ctx.verify_flags &= ~_STRICT
        with socket.create_connection((host, port), timeout=15) as sock:
            with ctx.wrap_socket(sock, server_hostname=host) as ss:
                res["ok"] = True
                res["tls"] = ss.version()
                try:
                    res["cipher"] = ss.cipher()[0]
                except Exception:  # noqa: BLE001
                    pass
                # 证书链单独兜一层：解不出来也不能把"握手成功"这条结论弄脏
                try:
                    res["chain"] = _chain_info(ss, store, peek)
                except Exception as exc:  # noqa: BLE001
                    res["chain"] = []
                    res["chainError"] = "%s: %s" % (type(exc).__name__, exc)
    except Exception as exc:  # noqa: BLE001
        res["error"] = "%s: %s" % (type(exc).__name__, exc)
    return res


_store_cache: dict | None = None


def _store_index() -> dict:
    """本机信任库的索引：根证书数、DER 指纹集、subject 集、疑似解密软件的根。

    用来判定"这条链的根在不在本机库里"。有它才能把
    「unable to get local issuer」明确分到"缺根"还是"被中间人重签"。
    """
    global _store_cache
    if _store_cache is not None:
        return _store_cache
    info: dict = {"count": 0, "der": set(), "subjects": set(), "suspicious": [], "error": None}
    import hashlib

    for store in ("ROOT", "CA"):
        try:
            items = ssl.enum_certificates(store)
        except Exception as exc:  # noqa: BLE001
            info["error"] = str(exc)
            continue
        for der, _enc, _trust in items:
            info["count"] += 1
            info["der"].add(hashlib.sha256(der).hexdigest())
            try:
                import warnings

                with warnings.catch_warnings():
                    warnings.simplefilter("ignore")
                    from cryptography import x509

                    name = x509.load_der_x509_certificate(der).subject.rfc4514_string()
            except Exception:  # noqa: BLE001
                continue
            info["subjects"].add(name.lower())
            low = name.lower()
            for hint in MITM_HINTS:
                if hint in low:
                    if name not in info["suspicious"]:
                        info["suspicious"].append(name)
                    break
    _store_cache = info
    return info


def _system_cas() -> dict:
    """兼容旧调用：只返回 count / suspicious。"""
    st = _store_index()
    return {"count": st["count"], "suspicious": list(st["suspicious"]), "error": st["error"]}


def _system_cas() -> dict:
    """列出本机信任库里的根证书，挑出看着像"解密中间人"的那些。"""
    info: dict = {"count": 0, "suspicious": [], "error": None}
    try:
        for store in ("ROOT", "CA"):
            try:
                items = ssl.enum_certificates(store)
            except Exception:  # noqa: BLE001
                continue
            for der, _enc, _trust in items:
                info["count"] += 1
                try:
                    from cryptography import x509

                    c = x509.load_der_x509_certificate(der)
                    name = c.subject.rfc4514_string()
                except Exception:  # noqa: BLE001
                    continue
                low = name.lower()
                for hint in MITM_HINTS:
                    if hint in low:
                        if name not in info["suspicious"]:
                            info["suspicious"].append(name)
                        break
    except Exception as exc:  # noqa: BLE001
        info["error"] = str(exc)
    return info


def _proxy_info() -> dict:
    out: dict = {
        "env": {k: os.environ.get(k) for k in
                ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
                 "http_proxy", "https_proxy") if os.environ.get(k)},
        "winProxyEnable": None, "winProxyServer": None, "winAutoConfig": None,
    }
    try:
        import winreg

        with winreg.OpenKey(winreg.HKEY_CURRENT_USER,
                            r"Software\Microsoft\Windows\CurrentVersion\Internet Settings") as k:
            for key, field in (("ProxyEnable", "winProxyEnable"),
                               ("ProxyServer", "winProxyServer"),
                               ("AutoConfigURL", "winAutoConfig")):
                try:
                    out[field] = winreg.QueryValueEx(k, key)[0]
                except OSError:
                    pass
    except Exception:  # noqa: BLE001
        pass
    return out


def _is_public_ca(name: str) -> bool:
    """签发者的名字像不像公共 CA。

    ⚠️ 不能直接 `hint in name`：拿 self-signed.badssl.com 试过 ——
    "bad`ssl.com`" 里正好含 "ssl.com"，于是自签证书被误判成"公共 CA 签发"，
    定性直接翻成"本机缺根"。这种误判会把"被中间人解密"说成"系统小毛病"，
    是这套诊断里最不能犯的错。所以按 RDN 拆开、按词边界匹配。
    """
    import re

    for seg in (name or "").split(","):
        val = seg.split("=", 1)[-1].strip().strip('"').lower()
        if not val:
            continue
        for hint in PUBLIC_CA_HINTS:
            if re.search(r"(^|[^a-z0-9])%s([^a-z0-9]|$)" % re.escape(hint.lower()), val):
                return True
    return False


def _bundle_subjects() -> list[str]:
    return bundle_info().get("subjects") or []


def classify_host(h: dict, store: dict, bundle: list[str]) -> dict:
    """给一台主机的失败定性。返回 {cls, missing, signer, detail}。

    纯函数，不联网 —— 有它才敢写"别人电脑上报这个错，到底是哪一种"。
    """
    err = (h.get("relaxed") or {}).get("error") or ""
    low = err.lower()
    out = {"cls": "ok", "missing": None, "signer": None, "detail": ""}
    if (h.get("relaxed") or {}).get("ok"):
        return out

    if "expired" in low or "not yet valid" in low:
        out.update(cls="expired", detail="证书不在有效期内 —— 系统时间或时区不对")
        return out

    peek = h.get("peek") or {}
    chain = peek.get("chain") or (h.get("relaxed") or {}).get("chain") or []
    if not peek.get("ok") or not chain:
        out.update(cls="unreachable",
                   detail=(peek.get("error") or err or "连不上").strip())
        return out

    leaf = chain[0]
    signer = leaf.get("issuer") or ""
    out["signer"] = signer
    if _is_public_ca(signer):
        # 连接没被重签：签名者还是公共 CA ⇒ 本机缺根（信任库不全）
        top = chain[-1]
        missing = top.get("subject") if top.get("selfSigned") else top.get("issuer")
        out.update(cls="missing-root", missing=missing,
                   detail="签发者是公共 CA（%s），但本机信任库里没有能签它的根" % signer)
        return out

    out.update(cls="mitm",
               detail="对方出示的证书由「%s」签发，不是公共 CA" % (signer or "?"))
    return out


def judge(data: dict) -> dict:
    """把所有握手结果汇成一个人能照着行动的结论（verdict + advice）。

    纯函数：只读 data，不联网。这样它能在离线测试里被喂各种假数据。
    verdict:
        ok           两种口径都通
        strict-only  只有严格模式失败（3.13 的默认口径太严）
        missing-root 本机信任库缺根（不是中间人）
        mitm         连接被私有根重签（本机/本网络在解密 HTTPS）
        expired      系统时间不对
        unreachable  根本没握上手（DNS/防火墙/代理端口）
    """
    store = _store_index()
    bundle = _bundle_subjects()
    host_res = []
    for h in data.get("hosts") or []:
        info = classify_host(h, store, bundle)
        info["host"] = h.get("host")
        host_res.append(info)
    data["classify"] = host_res

    ok_all = all(x["cls"] == "ok" for x in host_res)
    if ok_all:
        strict_fail = [h for h in data["hosts"] if not h["strict"]["ok"]]
        bc_odd = []
        for h in data["hosts"]:
            # 用 .get：judge 是纯函数，可能被离线测试喂"只有结论没有链"的简版数据
            chain = ((h.get("relaxed") or {}).get("chain")
                     or (h.get("strict") or {}).get("chain") or [])
            for c in chain:
                if c.get("isCA") and c.get("bcCritical") is False:
                    bc_odd.append("%s (%s)" % (c.get("subject"), h["host"]))
        if not strict_fail:
            data["verdict"] = "ok"
            data["advice"].append("证书链正常，两种口径都能连上小米服务器。")
            if bc_odd:
                data["advice"].append(
                    "不过链里确实有未标 critical 的 CA（%s）—— 这正是严格模式会误杀的写法，"
                    "本程序已默认放宽口径，不影响使用。" % bc_odd[0])
        else:
            data["verdict"] = "strict-only"
            data["advice"].append(
                "严格模式下握手失败、放宽后成功 —— 确诊：Python 3.13 的严格模式误杀了"
                "小米证书链。本程序已默认放宽，无需你做任何事。")
            if bc_odd:
                data["advice"].append("元凶证书：%s" % "; ".join(bc_odd[:3]))
        return data

    # 有主机连不上：按"最需要动手"的顺序取一条主结论
    bad = [x for x in host_res if x["cls"] != "ok"]
    order = ("expired", "unreachable", "mitm", "missing-root")
    pick = next((c for c in order if any(x["cls"] == c for x in bad)), "mitm")
    data["verdict"] = pick
    for x in bad:
        data["advice"].append("%s：%s" % (x["host"], x["detail"]))

    if pick == "missing-root":
        miss = next((x["missing"] for x in bad if x["cls"] == "missing-root" and x["missing"]),
                    "（记不出名字）")
        data["missingRoot"] = miss
        covered = any(miss.lower() in s.lower() or s.lower() in miss.lower() for s in bundle)
        data["advice"].append("本机信任库缺的是这张根证书：%s" % miss)
        data["advice"].append(
            "这不是软件坏了，也不是网络被拦 —— 只是这台机器的根证书库不全"
            "（常见于精简版/GHOST 系统，或 Windows 更新长期关闭 —— 根证书就靠它自动下载）。")
        if covered:
            data["advice"].append(
                "本程序已随包带了这张根证书，登录照常可用（仍然完整校验 CA 与主机名）；"
                "这份报告只是告诉你机器的证书库状态。")
        else:
            data["advice"].append(
                "随包根证书里没有这张：请① 让 Windows 更新保持开启（根证书靠它自动下载）"
                "② 或手动安装该根证书 ③ 或用浏览器打开小米登录页下载证书。")
        data["advice"].append(
            "自查办法：用浏览器打开 https://account.xiaomi.com —— 浏览器自带信任库，"
            "能打开就说明网络没被拦，纯粹是系统信任库缺根。")
    elif pick == "mitm":
        data["advice"].append(
            "这类情况是「本机或本网络在解密 HTTPS」：杀软「网页防护」、公司 VPN"
            "（深信服 aTrust/EasyConnect 等）、校园网网关、抓包工具（Fiddler/Charles）、"
            "带 MITM 的代理软件，都会用自己的根证书重签连接。")
        data["advice"].append(
            "处理：关掉上述功能，或换一个网络（手机热点最快）再登录。"
            "在没弄清楚之前别输入小米账号密码 —— 登录态会经过那个中间人。")
        for c in data["cas"]["suspicious"]:
            data["advice"].append("本机信任库里发现疑似解密软件的根证书：%s" % c)
        if not data["cas"]["suspicious"]:
            data["advice"].append(
                "本机信任库里没找到明显的解密软件根证书 —— 说明拦截发生在网络侧"
                "（路由器/网关/公司网络），只能换网络。")
    elif pick == "expired":
        data["advice"].append("请把系统时间和时区校准（右下角时间 → 同步），再重试。")
    elif pick == "unreachable":
        data["advice"].append(
            "这一类不是证书问题：TCP 都没连上。查 DNS、防火墙、代理端口是否在监听。")
    return data


def probe(hosts=DEFAULT_HOSTS, port: int = 443) -> dict:
    """体检：严格/放宽两种口径都握一次手；失败时再"偷看"一次对方出示的证书链。"""
    ctx = ssl.create_default_context()
    store = _store_index()
    vp = ssl.get_default_verify_paths()
    data: dict = {
        "python": sys.version.split()[0],
        "openssl": ssl.OPENSSL_VERSION,
        "strictDefault": bool(_STRICT and (ctx.verify_flags & _STRICT)),
        "flags": hex(ctx.verify_flags),
        "probeTs": int(time.time()),
        "proxy": _proxy_info(),
        "cas": _system_cas(),
        "trust": {
            "cafile": vp.cafile, "capath": vp.capath, "opensslCafile": vp.openssl_cafile,
            "env": {k: os.environ.get(k) for k in
                    ("SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE")
                    if os.environ.get(k)},
            "storeCount": store["count"],
        },
        "bundle": {k: v for k, v in bundle_info().items() if k != "error"},
        "hosts": [],
        "verdict": "",
        "advice": [],
    }
    for h in hosts:
        strict = _attempt(h, port, False, store=store)
        relaxed = _attempt(h, port, True, store=store)
        item = {"host": h, "port": port, "strict": strict, "relaxed": relaxed}
        # 只有"放宽口径也失败"时才需要偷看 —— 那是真要定性的场合
        if not relaxed["ok"]:
            item["peek"] = _attempt(h, port, True, peek=True, store=store)
        data["hosts"].append(item)
    return judge(data)


def format_report(d: dict) -> str:
    L: list[str] = []
    add = L.append
    add("酷态科10号Ultra · 小米云证书自检")
    add("=" * 60)
    add("时间        : %s" % time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(d["probeTs"])))
    add("Python      : %s" % d["python"])
    add("OpenSSL     : %s" % d["openssl"])
    add("严格模式默认: %s   (verify_flags=%s)" % ("开（3.13 及以后）" if d["strictDefault"] else "关", d["flags"]))
    px = d["proxy"]
    add("系统代理    : %s" % (px.get("winProxyServer") or "无"))
    add("          自动配置: %s" % (px.get("winAutoConfig") or "无"))
    add("环境变量代理: %s" % (px.get("env") or "无"))
    add("信任库根证书: %d 张%s" % (d["cas"]["count"],
                                ("，其中疑似解密中间人 %d 张" % len(d["cas"]["suspicious"]))
                                if d["cas"]["suspicious"] else ""))
    tr = d.get("trust") or {}
    add("信任库来源  : 系统库（%d 张）；cafile=%s；capath=%s"
        % (tr.get("storeCount") or 0, tr.get("cafile") or "无", tr.get("capath") or "无"))
    add("          内置 openssl CA: %s" % (tr.get("opensslCafile") or "无"))
    if tr.get("env"):
        add("          相关环境变量: %s" % tr["env"])
    bd = d.get("bundle") or {}
    add("随包根证书  : %s（%d 张：%s）"
        % ("有" if bd.get("exists") else "无", bd.get("count") or 0,
           "; ".join(bd.get("subjects") or []) or "-"))
    for s in d["cas"]["suspicious"]:
        add("    ! %s" % s)
    for h in d["hosts"]:
        add("")
        add("---- %s:%d" % (h["host"], h["port"]))
        for mode in ("strict", "relaxed"):
            r = h[mode]
            tag = "严格模式" if mode == "strict" else "放宽口径"
            if r["ok"]:
                add("  %s: 成功  %s / %s" % (tag, r["tls"], r["cipher"]))
            else:
                add("  %s: 失败  %s" % (tag, r["error"]))
        # 校验失败时，真正有用的是"对方出示了什么" —— 那来自 peek
        chain = (h.get("peek") or {}).get("chain") or h["relaxed"]["chain"] or h["strict"]["chain"]
        src = "（对方出示，未经校验）" if (h.get("peek") or {}).get("chain") else ""
        if src:
            add("  证书链%s:" % src)
        for c in chain:
            role = "叶证书" if c["i"] == 0 else ("根" if c.get("selfSigned") else "中间")
            bc = c.get("bcCritical")
            bc_txt = "-" if bc is None else ("critical" if bc else "未标 critical <== 严格模式会拒绝")
            inst = c.get("inStore")
            add("    #%d %s  %s" % (c["i"], role, c.get("subject")))
            add("       签发者: %s" % c.get("issuer"))
            add("       basicConstraints: CA=%s, %s%s"
                % (c.get("isCA"), bc_txt,
                   ("   到期: " + c["notAfter"]) if c.get("notAfter") else ""))
            # 只有"自签的根"才要求在本机信任库里；中间证书本来就随连接下发，不必在库。
            # 全打印出来只会让人以为哪里都缺。
            if c.get("selfSigned") or inst:
                add("       %s" % ("在本机信任库" if inst else "【不在本机信任库 —— 缺的就是它】"))
    cls = d.get("classify") or []
    if cls:
        add("")
        add("判定明细:")
        for c in cls:
            add("  %s → %s%s" % (c.get("host"), c.get("cls"),
                                 ("（缺根：%s）" % c["missing"]) if c.get("missing") else ""))
    add("")
    add("=" * 60)
    add("结论: %s" % d["verdict"])
    for a in d["advice"]:
        add("  · %s" % a)
    return "\n".join(L)


def main(argv: list[str]) -> int:
    host = None
    if "--host" in argv:
        try:
            host = argv[argv.index("--host") + 1]
        except IndexError:
            host = None
    if "--probe" in argv:
        d = probe((host,) if host else DEFAULT_HOSTS)
        text = format_report(d)
        print(text)
        try:
            REPORT.parent.mkdir(parents=True, exist_ok=True)
            REPORT.write_text(text + "\n", encoding="utf-8")
            d["reportFile"] = str(REPORT)
        except Exception as exc:  # noqa: BLE001
            d["reportFile"] = None
            d["reportError"] = str(exc)
        if "--json" in argv:
            print(json.dumps(d, ensure_ascii=False))
        # strict-only 算"能用"：程序默认口径就是放宽后的，不该让调用方当失败处理
        return 0 if d["verdict"] in ("ok", "strict-only") else 1
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
