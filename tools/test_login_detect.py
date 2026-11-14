# 单元测 login.py 的「自动认出 AD1204U」与 token 校验逻辑（不联网、不连设备）。
import sys, importlib.util, json, tempfile, os

spec = importlib.util.spec_from_file_location("login", r"C:\Users\shuan\Tools\CuktechMonitor\login.py")
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

cases_dev = [
    ({"model": "njcuk.fitting.ad1204", "name": "酷态科 10 号 Ultra"}, True),
    ({"model": "njcuk.fitting.1204e", "name": "CUKTECH 1204E"}, True),
    ({"model": "njcuk.fitting.ad1204.2", "name": "x"}, True),      # 版本后缀也要认得出
    ({"model": "xiaomi.wifi.s1", "name": "小米something"}, False),
    ({"model": "cuktech.fitting.ab1234", "name": "AD1204U 充电头"}, True),  # 靠名字兜底
    ({}, False),
]
ok = True
for dev, want in cases_dev:
    got = m._looks_like_ad1204(dev)
    ok = ok and (got == want)
    print(("PASS" if got == want else "FAIL"), "device", dev, "->", got)

cases_tok = [
    ("0123456789abcdef0123456789abcdef", "0123456789abcdef01234567"),  # 32 hex -> 前 24
    ("0123456789abcdef01234567", "0123456789abcdef01234567"),          # 24 hex 原样
    ("ABCDEF0123456789ABCDEF01", "abcdef0123456789abcdef01"),         # 大写转小写（24 hex）
    ("0123", None),                                                     # 太短
    ("zzzzzzzzzzzzzzzzzzzzzzzz", None),                                 # 非 hex
    ("", None),
]
for raw, want in cases_tok:
    got = m._valid_token(raw)
    ok = ok and (got == want)
    print(("PASS" if got == want else "FAIL"), "token", raw[:12], "->", got)

# find_token_by_mac（vendor 原函数）对显式 MAC 路径的回归
sys.path.insert(0, r"C:\Users\shuan\Tools\CuktechMonitor\vendor")
from cuktech_ble.xiaomi_cloud import find_token_by_mac  # noqa: E402
fake = [{"mac": "AA:BB:CC:DD:EE:FF", "token": "a" * 32}]
t = find_token_by_mac(fake, "aa:bb:cc:dd:ee:ff")
ok = ok and (t == "a" * 24)
print(("PASS" if t == "a" * 24 else "FAIL"), "find_token_by_mac ->", (t or "None")[:8], "...")
print("RESULT:", "PASS" if ok else "FAIL")
