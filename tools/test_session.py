"""离线回归：MIOT 会话层的「重传 / 乱序 / 会话失活」判定。

背景
----
2026-09-22 用户报「蓝牙连接过一会就断连」。根因**不是蓝牙**：链路层一直在正常收帧，
是我们这一层把「重复帧 / 乱序帧」当成了会话失效 —— 每一次都让整条 MIOT 会话作废、
重扫蓝牙、重新认证。用户看到的每次「断」，都是这个。

修好之后必须有东西守着它，否则下次谁把窗口收窄、或者把判据改回 `frame.counter <
self._rx_counter` 就直接判死，问题会原样复发。

这个测试**不需要蓝牙、不需要充电头**：`classify_inbound()` 是纯判定，喂合成帧即可。

跑法
----
    .venv\\Scripts\\python.exe tools\\test_session.py
"""

from __future__ import annotations

import pathlib
import sys

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(ROOT / "vendor"))

from cuktech_ble.xiaomi.auth import MiSessionKeys          # noqa: E402
from cuktech_ble.xiaomi.session import (                    # noqa: E402
    MAX_RX_OUT_OF_ORDER,
    MiSession,
    MiSessionReauthenticationRequired,
    MiotFrame,
)

FAILURES: list[str] = []
CHECKS = 0


def check(ok: bool, label: str) -> None:
    global CHECKS
    CHECKS += 1
    if not ok:
        FAILURES.append(label)
        print("  FAIL  " + label)


def new_session() -> MiSession:
    """造一个不接蓝牙的会话：判定逻辑不碰 auth，也不碰密钥的实际内容。"""
    keys = MiSessionKeys(
        dev_key=bytes(16), app_key=bytes(16), dev_iv=bytes(16), app_iv=bytes(16)
    )
    return MiSession(None, keys)          # type: ignore[arg-type]


_FEED_SEQ = 0


def feed(sess: MiSession, counter: int, ciphertext: bytes | None = None) -> str:
    """模拟 _recv_encrypted() -> _reader_loop() 那两步（_recv_encrypted 先入 _rx_raw）。

    没显式给密文时**每次都造一段不同的**：去重判定会回看最近 16 帧，
    如果测试自己把同一 (counter, 密文) 喂两遍，第二遍会被当成重传丢掉，
    结果测的就不是乱序逻辑了。
    """
    global _FEED_SEQ
    if ciphertext is None:
        _FEED_SEQ += 1
        ciphertext = b"#%04d" % _FEED_SEQ
    frame = MiotFrame(counter=counter, ciphertext=ciphertext, direction="rx")
    sess._rx_raw.append(frame)                                   # noqa: SLF001
    verdict = sess.classify_inbound(frame)
    if verdict != "duplicate":
        sess.advance_rx_counter(frame)
    return verdict


# --------------------------------------------------------------------- 用例


def t_normal_sequence() -> None:
    """正常递增：都判 new，水位一路前进。"""
    s = new_session()
    for c in (0, 1, 2):
        check(feed(s, c) == "new", f"normal counter={c} -> new")
    check(s._rx_counter == 3, "watermark advanced to 3")
    check(s.rx_duplicates == 0 and s.rx_out_of_order == 0, "no dup / no lag on a clean run")


def t_duplicate_retransmission() -> None:
    """逐字节相同的重传：判 duplicate、丢弃、**水位不动**。"""
    s = new_session()
    ct = b"\x11" * 12
    check(feed(s, 5, ct) == "new", "first copy -> new")
    before = s._rx_counter
    check(feed(s, 5, ct) == "duplicate", "byte-identical resend -> duplicate")
    check(s._rx_counter == before, "duplicate must NOT advance the watermark")
    check(s.rx_duplicates == 1, "rx_duplicates counted")


def t_same_counter_other_payload() -> None:
    """counter 相同但密文不同 -> 不是重传，按乱序处理（别把它当重传丢掉）。"""
    s = new_session()
    check(feed(s, 5, b"\x11" * 12) == "new", "cmp frame -> new")
    check(feed(s, 5, b"\x22" * 12) == "out_of_order", "same counter, other payload -> out_of_order")
    check(s.rx_duplicates == 0, "must not be counted as a duplicate")
    check(s.rx_out_of_order == 1, "counted as out_of_order")


def t_out_of_order_within_window() -> None:
    """倒退 1 帧：照常路由，且水位只进不退。"""
    s = new_session()
    feed(s, 199)
    feed(s, 200)                     # 水位 -> 201
    check(feed(s, 199) == "out_of_order", "lag=2 -> out_of_order")
    check(s._rx_counter == 201, "watermark stays at 201")
    check(feed(s, 201) == "new", "next real frame still fine")
    check(s._rx_counter == 202, "watermark -> 202")


def t_lag_boundary() -> None:
    """窗口边界：lag == MAX_RX_OUT_OF_ORDER 容忍，lag == MAX+1 才判会话失活。"""
    s = new_session()
    feed(s, 100)                     # 水位 -> 101
    wm = s._rx_counter
    check(MAX_RX_OUT_OF_ORDER == 24, "window constant is 24 (guard against silent narrowing)")
    check(feed(s, wm - 24) == "out_of_order", "lag = window -> tolerated")
    raised = False
    try:
        feed(s, wm - 25)
    except MiSessionReauthenticationRequired:
        raised = True
    check(raised, "lag = window + 1 -> MiSessionReauthenticationRequired")


def t_incident_replay() -> None:
    """复现当初那条报错：got=172, expected >= 174, previous=173 —— 它**不该**判死。

    这是整个问题的起点。日志里三条报错分别是 prev-1 / prev-1 / prev-2，
    全部落在窗口内，所以旧代码每次都在这里把好的会话掐掉。
    """
    s = new_session()
    feed(s, 173)                     # previous=173 -> 水位 174
    check(s._rx_counter == 174, "watermark == 174, matching the log line")
    raised = False
    try:
        verdict = feed(s, 172)       # got counter=172
    except MiSessionReauthenticationRequired:
        raised = True
        verdict = "<raised>"
    check(not raised, "the frame that used to kill the session must NOT raise")
    check(verdict == "out_of_order", "it is an out-of-order frame")
    check(s.rx_out_of_order == 1, "counted once")


def t_window_is_a_window_not_a_strike_counter() -> None:
    """窗口是「幅度」不是「次数」：连续 24 帧乱序也不该判死。"""
    s = new_session()
    feed(s, 500)                     # 水位 -> 501
    wm = s._rx_counter
    verdicts = [feed(s, wm - 1) for _ in range(MAX_RX_OUT_OF_ORDER)]
    check(all(v == "out_of_order" for v in verdicts), "all tolerable lags pass")
    check(s.rx_out_of_order == MAX_RX_OUT_OF_ORDER, "all counted")
    check(s._rx_counter == wm, "watermark never walked back")


def t_large_jump_raises_with_counters() -> None:
    """真正的会话重置（大幅失步）才判死，且报错要带三个计数器便于对账。"""
    s = new_session()
    feed(s, 173)
    feed(s, 174)
    msg = ""
    try:
        feed(s, 10)
    except MiSessionReauthenticationRequired as exc:
        msg = str(exc)
    check(bool(msg), "far jump raises")
    check("moved backwards too far" in msg, "message explains it")
    check("got counter=10" in msg, "message carries got counter")
    check("expected >=" in msg, "message carries expected counter")
    check("previous counter=" in msg, "message carries previous counter")


def t_rx_raw_window_size() -> None:
    """重传判定只看得到最近 MAX_CAPTURED_FRAMES 帧 —— 这是设计前提，写下来防误解。"""
    from cuktech_ble.xiaomi.session import MAX_CAPTURED_FRAMES
    s = new_session()
    check(MAX_CAPTURED_FRAMES == 16, "captured-frame window is 16 (dup detection lookback)")
    check(s._rx_raw.maxlen == MAX_CAPTURED_FRAMES, "_rx_raw deque actually bounded")


def t_version_single_source() -> None:
    """版本号只允许有 version.json 一个来源（server 写 1.3.0 / collector 写 1.3 漂过一次）。"""
    import json

    vf = ROOT / "version.json"
    check(vf.exists(), "version.json exists")
    try:
        version = json.loads(vf.read_text(encoding="utf-8"))["version"]
    except Exception as exc:                                     # noqa: BLE001
        check(False, f"version.json parses ({exc})")
        return
    check(bool(version.strip()), "version.json carries a version")
    # 界面顶栏显示的型号也走同一个文件，别再在各处写死 AD1204U。
    check(bool(json.loads(vf.read_text(encoding="utf-8")).get("model", "").strip()),
          "version.json carries a model")

    server = (ROOT / "server.js").read_text(encoding="utf-8")
    check("const VERSION = '1." not in server, "server.js has no hardcoded version literal")
    # 别钉读取函数的名字（readVersion -> readMeta 改过一次就误报了）——
    # 要守的是"版本只从 version.json 读"这个不变量本身。
    check("VERSION_FILE" in server and "readFileSync(VERSION_FILE" in server,
          "server.js reads version.json (VERSION_FILE)")

    collector = (ROOT / "collector.py").read_text(encoding="utf-8")
    check('"v": "1.' not in collector, "collector.py hello has no hardcoded version literal")
    check("app_version()" in collector, "collector.py reads version.json")


TESTS = [
    t_normal_sequence,
    t_duplicate_retransmission,
    t_same_counter_other_payload,
    t_out_of_order_within_window,
    t_lag_boundary,
    t_incident_replay,
    t_window_is_a_window_not_a_strike_counter,
    t_large_jump_raises_with_counters,
    t_rx_raw_window_size,
    t_version_single_source,
]


def main() -> int:
    print("== MIOT session-layer regression (offline, no BLE) ==")
    for fn in TESTS:
        print("- " + fn.__name__)
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
