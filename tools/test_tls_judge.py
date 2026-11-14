"""离线回归：小米云证书体检的「定性」判断（netfix.judge / classify_host）。

背景
----
2026-10-24 有人反馈在**别人电脑**上网络自检报：

    account.xiaomi.com：连不上（SSLCertVerificationError: ... unable to get local
    issuer certificate (_ssl.c:1032)）

这条和"Basic Constraints"那条是**完全不同的两件事**：
    · Basic Constraints  → 找到根了，但那根不合 OpenSSL 严格模式的写法（3.13 才有）
    · unable to get local issuer → 根本找不到可信的根
后者又有两种成因，处置相反：
    ① 本机信任库缺根（机器问题，程序可以随包带根自愈）
    ② 本机/本网络在解密 HTTPS（安全事件，必须换网络，绝不能"绕过"了事）
光看报错分不出是哪一种 —— 所以程序现在会再"偷看"一次对方出示的证书链，
按"叶证书的签发者是不是公共 CA"来定性。

这个测试就是守住这套定性逻辑：**不需要网络、不需要证书**，喂合成数据即可。
判错方向是要付出代价的（把 MITM 说成"缺根"，用户就安心地把密码交给中间人了）。

跑法
----
    .venv\\Scripts\\python.exe tools\\test_tls_judge.py
"""

from __future__ import annotations

import pathlib
import sys

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(ROOT))

import netfix  # noqa: E402

CHECKS = 0
FAILURES: list[str] = []


def check(desc: str, cond, detail: str = "") -> None:
    global CHECKS
    CHECKS += 1
    if cond:
        print("  PASS  " + desc)
    else:
        FAILURES.append(desc + ("   [" + detail + "]" if detail else ""))
        print("  FAIL  " + desc + (("   [" + detail + "]") if detail else ""))


GD_LEAF = "CN=*.account.xiaomi.com"
GD_INT = "CN=GoDaddy TLS Intermediate CA DV - R1v1,O=GoDaddy.com,C=US"
GD_XROOT = "CN=GoDaddy TLS Root CA - R1,O=GoDaddy.com,C=US"
GD_ROOT = ("CN=Go Daddy Root Certificate Authority - G2,O=GoDaddy.com\\, Inc.,"
           "L=Scottsdale,ST=Arizona,C=US")


def cert(i, subject, issuer, *, self_signed=False, in_store=None, is_ca=True,
         bc_critical=True):
    return {"i": i, "subject": subject, "issuer": issuer, "isCA": is_ca,
            "bcCritical": bc_critical, "selfSigned": self_signed or subject == issuer,
            "inStore": in_store, "notAfter": "2037-12-31"}


def host(hostname, *, strict_ok, relaxed_ok, relaxed_err=None, peek_chain=None,
         peek_ok=True, peek_err=None):
    h = {
        "host": hostname, "port": 443,
        "strict": {"ok": strict_ok, "error": None if strict_ok else
                   "SSLCertVerificationError: [SSL: CERTIFICATE_VERIFY_FAILED] "
                   "certificate verify failed: Basic Constraints of CA cert not marked critical"},
        "relaxed": {"ok": relaxed_ok, "error": None if relaxed_ok else relaxed_err,
                    "chain": [], "tls": "TLSv1.2"},
    }
    if peek_chain is not None or not peek_ok:
        h["peek"] = {"ok": peek_ok, "error": peek_err,
                     "chain": peek_chain or [], "tls": "TLSv1.2" if peek_ok else None}
    return h


def verdict_of(hosts) -> dict:
    data = {"hosts": hosts, "verdict": "", "advice": [],
            "cas": {"count": 76, "suspicious": []}}
    return netfix.judge(data)


# ---------------------------------------------------------------- 1. 正常
def t_ok():
    print("- 正常：两种口径都通 → ok")
    d = verdict_of([host("account.xiaomi.com", strict_ok=True, relaxed_ok=True)])
    check("verdict = ok", d["verdict"] == "ok", d["verdict"])
    check("不会冒出'在解密'之类的结论",
          not any("解密" in a for a in d["advice"]), str(d["advice"]))


# ------------------------------------------------------ 2. 只有严格模式失败
def t_strict_only():
    print("- 严格模式误杀 → strict-only（不是故障，程序已默认放宽）")
    h = host("account.xiaomi.com", strict_ok=False, relaxed_ok=True)
    h["strict"]["chain"] = [cert(0, GD_LEAF, GD_INT, is_ca=False),
                            cert(1, GD_INT, GD_XROOT),
                            cert(2, GD_XROOT, GD_ROOT),
                            cert(3, GD_ROOT, GD_ROOT, self_signed=True, in_store=True)]
    d = verdict_of([h])
    check("verdict = strict-only", d["verdict"] == "strict-only", d["verdict"])
    check("结论里点明是严格模式", any("严格模式" in a for a in d["advice"]), str(d["advice"]))


# ------------------------------------ 3. 缺根：签名者仍是公共 CA，根不在本机库
def t_missing_root():
    print("- 缺根：签发者仍是 GoDaddy，但本机信任库没有那张根 → missing-root")
    chain = [cert(0, GD_LEAF, GD_INT, is_ca=False),
             cert(1, GD_INT, GD_XROOT),
             cert(2, GD_XROOT, GD_ROOT),
             cert(3, GD_ROOT, GD_ROOT, self_signed=True, in_store=False)]
    h = host("account.xiaomi.com", strict_ok=False, relaxed_ok=False,
             relaxed_err="SSLCertVerificationError: [SSL: CERTIFICATE_VERIFY_FAILED] "
                          "certificate verify failed: unable to get local issuer certificate "
                          "(_ssl.c:1032)",
             peek_chain=chain)
    d = verdict_of([h])
    check("verdict = missing-root", d["verdict"] == "missing-root", d["verdict"])
    check("指出了缺哪张根", d.get("missingRoot") == GD_ROOT, str(d.get("missingRoot")))
    check("明确说'不是网络被拦'", any("不是网络被拦" in a for a in d["advice"]), str(d["advice"]))
    check("因为随包带了这张根，告知'登录照常可用'",
          any("随包带了这张根证书" in a for a in d["advice"]), str(d["advice"]))
    check("不会误报成中间人", not any("中间人" in a or "解密" in a for a in d["advice"]),
          str(d["advice"]))


# --------------------------------------------- 4. 中间人：叶证书被私有根重签
def t_mitm():
    print("- 中间人：叶证书由陌生私有根重签 → mitm（这条判断错了会害人）")
    chain = [cert(0, GD_LEAF, "CN=FortiGate-60F,O=Fortinet,C=US", is_ca=False),
             cert(1, "CN=FortiGate-60F,O=Fortinet,C=US",
                  "CN=FortiGate-60F,O=Fortinet,C=US", self_signed=True, in_store=False)]
    h = host("account.xiaomi.com", strict_ok=False, relaxed_ok=False,
             relaxed_err="SSLCertVerificationError: [SSL: CERTIFICATE_VERIFY_FAILED] "
                          "certificate verify failed: self-signed certificate in "
                          "certificate chain (_ssl.c:1032)",
             peek_chain=chain)
    d = verdict_of([h])
    check("verdict = mitm", d["verdict"] == "mitm", d["verdict"])
    check("点名了签发者", any("FortiGate" in a for a in d["advice"]), str(d["advice"]))
    check("提醒别输密码 / 换网络",
          any("手机热点" in a for a in d["advice"]), str(d["advice"]))
    check("绝不说'已自动处理'之类的安抚话",
          not any("无需你" in a or "自动放宽" in a for a in d["advice"]), str(d["advice"]))


# ---------------------------------- 4b. 名字里"看着像公共 CA"的坑（实际踩过）
def t_public_ca_matcher():
    print("- 公共 CA 识别不能靠子串（badssl.com 含 ssl.com，曾把自签判成'缺根'）")
    check('*.badssl.com 不算公共 CA', not netfix._is_public_ca("CN=*.badssl.com,O=BadSSL"))
    check("GoDaddy 中间 CA 算", netfix._is_public_ca(GD_INT))
    check("DigiCert 算", netfix._is_public_ca("CN=DigiCert TLS RSA SHA256 2020 CA1"))
    check("陌生私有 CA 不算", not netfix._is_public_ca("CN=FortiGate-60F,O=Fortinet"))
    check("空名字不算", not netfix._is_public_ca(""))
    # 端到端：自签的叶证书（issuer == subject == 主机名）必须判 mitm，不能判缺根
    chain = [cert(0, "CN=*.badssl.com,O=BadSSL", "CN=*.badssl.com,O=BadSSL", is_ca=False)]
    h = host("self-signed.badssl.com", strict_ok=False, relaxed_ok=False,
             relaxed_err="SSLCertVerificationError: certificate verify failed: "
                          "self-signed certificate (_ssl.c:1032)",
             peek_chain=chain)
    d = verdict_of([h])
    check("自签叶证书 → mitm（不是 missing-root）", d["verdict"] == "mitm", d["verdict"])


# ------------------------------------------------------------ 5. 系统时间
def t_expired():
    print("- 系统时间不对 → expired")
    h = host("account.xiaomi.com", strict_ok=False, relaxed_ok=False,
             relaxed_err="SSLCertVerificationError: certificate has expired (_ssl.c:1032)",
             peek_chain=[])
    d = verdict_of([h])
    check("verdict = expired", d["verdict"] == "expired", d["verdict"])
    check("让用户校准时间", any("时间" in a for a in d["advice"]), str(d["advice"]))


# ---------------------------------------------------- 6. 连都没连上（非证书）
def t_unreachable():
    print("- TCP 都没通 → unreachable（不是证书问题）")
    h = host("account.xiaomi.com", strict_ok=False, relaxed_ok=False,
             relaxed_err="ConnectionRefusedError: [WinError 10061] 由于目标计算机积极拒绝",
             peek_ok=False, peek_err="TimeoutError: timed out")
    d = verdict_of([h])
    check("verdict = unreachable", d["verdict"] == "unreachable", d["verdict"])
    check("不把网络问题说成证书问题",
          not any("证书" in a and "解密" in a for a in d["advice"]), str(d["advice"]))


# ------------------------------------------------------------- 7. 安全护栏
def t_guardrails():
    print("- 护栏：peek 只能用于诊断，业务上下文必须仍然完整校验")
    src = (ROOT / "netfix.py").read_text(encoding="utf-8")
    # 只数**真正的调用点**：注释/文档字符串里也写着 "peek=True"（还带着 _attempt(…），
    # 所以按完整调用写法匹配，别用 "peek=True" 这种会撞注释的碎片。
    call = "_attempt(h, port, True, peek=True"
    call_sites = [ln for ln in src.splitlines()
                  if call in ln and not ln.lstrip().startswith("#")]
    check("peek 只在一个地方被打开（probe 里）", len(call_sites) == 1, str(call_sites))
    check("peek 的调用点在 probe() 里，不在别处",
          len(call_sites) == 1 and "item[\"peek\"]" in call_sites[0], str(call_sites))
    body = src.split("def ssl_context(", 1)[1].split("\ndef ", 1)[0]
    check("业务上下文不设 CERT_NONE", "CERT_NONE" not in body)
    check("业务上下文不关主机名校验", "check_hostname = False" not in body)
    check("业务上下文仍 load_verify_locations（多挂随包根，不是少校验）",
          "load_verify_locations" in body)
    check("insecure 开关仍然只认显式环境变量",
          'CUKTECH_TLS_INSECURE' in src and "insecure_requested()" in body)


# ------------------------------------------------------------ 8. 随包根证书
def t_bundle():
    print("- 随包根证书：存在、能解析、覆盖小米链的锚")
    bi = netfix.bundle_info()
    check("vendor/ca/xiaomi-roots.pem 存在", bi["exists"], bi.get("file", ""))
    check("能解析出至少 1 张", bi["count"] >= 1, str(bi["count"]))
    check("里面有 GoDaddy G2（小米链的锚）",
          any("Go Daddy Root Certificate Authority - G2" in s for s in bi["subjects"]),
          str(bi["subjects"]))
    check("加载后上下文里多了一份锚点（不影响系统库）",
          not netfix.insecure_requested() and netfix.ssl_context() is not None)


def main() -> int:
    print("== 小米云证书体检：定性判断（离线，无网络） ==")
    for fn in (t_ok, t_strict_only, t_missing_root, t_mitm, t_public_ca_matcher,
               t_expired, t_unreachable, t_guardrails, t_bundle):
        fn()
    print("")
    if FAILURES:
        print("RESULT: FAIL  (%d checks, %d failed)" % (CHECKS, len(FAILURES)))
        for f in FAILURES:
            print("  - " + f)
        return 1
    print("RESULT: PASS  (%d checks, 0 failed)" % CHECKS)
    return 0


if __name__ == "__main__":
    sys.exit(main())
