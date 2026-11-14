"""米家直流变频落地扇 1X（dmaker.fan.p5）—— miIO 局域网采集器。

作为 server.js 的子进程运行，每行一个 JSON 对象写 stdout。
Node 侧负责历史、界面和 HTTP API；本进程只负责这条 UDP 链路。

⚠️ 和酷态科充电头的最大区别：这是 **Wi-Fi（miIO，UDP 54321）** 设备，
   不是蓝牙。所以要 IP + token，而不是 BLE 地址 + bindkey。

⚠️ 本采集器**不做功率、不做电量**：这台风扇没有任何电参量属性可读
   （没有功率传感器、没有电量统计），所以只把设备回读到的状态原样报上去。
   v1.9.0 曾按档位推算瓦数、再积分出用电量，2026-10-11 按用户要求整体删除 ——
   推算出来的数看着像实测，反而误导。

配置从 --config 指定的 JSON 文件读（**不要放命令行里** —— 命令行参数在任务管理器
里对任何用户可见，token 会被看光）：

    {"ip": "192.168.1.50", "token": "00112233...", "interval": 2.0}

输出行类型
    {"t":"hello", "v":"1.0", "model":..., "ip":..., "writable":[...]}
    {"t":"link",  "state":"connecting|online|offline", "msg":...}
    {"t":"state", "at":<ms>, "ok":true, "props":{...}, "raw":[...]}
    {"t":"ack",   "id":<回显>, "ok":true, "siid":2, "piid":1, "value":..., "readback":...}
    {"t":"error", "msg":...}

stdin 命令（每行一个 JSON）
    {"cmd":"set", "id":7, "siid":2, "piid":1, "value":true}   → ack（含写后回读）
    {"cmd":"read"}          → 立刻读一次并推一帧 state（界面「刷新一次」用）
    {"cmd":"ping"}          → ack（只探活，不读设备）
    {"cmd":"quit"}
"""

from __future__ import annotations

import argparse
import json
import queue
import sys
import threading
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE / "vendor"))

from miio_lan import MiioDevice, MiioError, MiioTimeout, discover  # noqa: E402

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", newline="\n")
    except Exception:  # noqa: BLE001
        pass


# --------------------------------------------------------------- 属性表
#
# 来源：home.miot-spec.com/spec/dmaker.fan.p5（米家直流变频落地扇1X），
# 2026-09-23 逐条核对过。
#
#   siid 2 · fan
#     2.1 on                             bool   开关
#     2.2 horizontal-swing               bool   左右摆风
#     2.3 mode                           uint8  0 自然风 / 1 直吹风
#     2.4 fan-level                      uint8  1~4 档
#     2.5 horizontal-swing-included-angle uint16 30/60/90/120/140
#     2.6 fan-level (无级调速)            uint8  1~100
#     2.7 horizontal-angle               int16  只写，-7~7
#   siid 3 · physical-controls-locked
#     3.1                                bool   物理控制锁（童锁）
#   siid 4 · indicator-light
#     4.1 on                             bool   指示灯
#   siid 5 · alarm
#     5.1 alarm                          bool   提示音
#   siid 6 · countdown
#     6.1 countdown-time                 uint32 0~480 分钟
#
# ⚠️ 2.4 和 2.6 在规格库里都叫 fan-level：2.4 是 1~4 的档位，2.6 是 1~100 的
#    无级调速。界面上滑块走 2.6，快捷档位按钮走 2.4 —— 两个都要保留。
POLL_PROPS: list[tuple[int, int]] = [
    (2, 1), (2, 2), (2, 3), (2, 4), (2, 5), (2, 6),
    (3, 1), (4, 1), (5, 1), (6, 1),
]

# 属性名表，给界面直接用（键是 "siid.piid"）
PROP_NAMES = {
    "2.1": "power", "2.2": "oscillate", "2.3": "mode", "2.4": "level",
    "2.5": "angle", "2.6": "speed", "3.1": "child_lock", "4.1": "led",
    "5.1": "buzzer", "6.1": "off_timer",
}

# 可写白名单：(名称, 类型, 允许范围)。范围是 (min, max) 或 None（bool 无范围）。
# 校验全在这里做 —— 即使上层界面被改坏，也写不进奇怪的值。
WRITABLE: dict[tuple[int, int], tuple[str, str, tuple[int, int] | None]] = {
    (2, 1): ("power", "bool", None),
    (2, 2): ("oscillate", "bool", None),
    (2, 3): ("mode", "uint8", (0, 1)),
    (2, 4): ("level", "uint8", (1, 4)),
    (2, 5): ("angle", "uint16", (30, 140)),
    (2, 6): ("speed", "uint8", (1, 100)),
    (3, 1): ("child_lock", "bool", None),
    (4, 1): ("led", "bool", None),
    (5, 1): ("buzzer", "bool", None),
    (6, 1): ("off_timer", "uint32", (0, 480)),
}

# 摆风夹角只认这五个值（规格表列的就是这五个）
ANGLE_VALUES = (30, 60, 90, 120, 140)
MODE_NAMES = {0: "自然风", 1: "直吹风"}


def emit(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def note(msg: str) -> None:
    sys.stderr.write(msg + "\n")
    sys.stderr.flush()


def main() -> int:
    ap = argparse.ArgumentParser(description="米家落地扇 miIO 采集器")
    ap.add_argument("--config", required=True, help="JSON 配置文件路径（含 ip/token）")
    ap.add_argument("--probe", action="store_true", help="只连一次、打印属性就退出（排查用）")
    args = ap.parse_args()

    cfg_path = Path(args.config)
    try:
        cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
    except Exception as exc:  # noqa: BLE001
        emit({"t": "error", "msg": "读配置失败 %s：%s" % (cfg_path, exc)})
        return 2

    ip = str(cfg.get("ip") or "").strip()
    token = str(cfg.get("token") or "").strip()
    interval = float(cfg.get("interval") or 2.0)
    interval = min(30.0, max(0.5, interval))

    if not ip:
        # 没配 IP：广播发现一次（局域网里可能有别的 miIO 设备，找不到就报错让上层去查云）
        emit({"t": "link", "state": "scanning", "msg": "未配置 IP，正在局域网广播发现…"})
        try:
            found = discover(timeout=5.0)
        except Exception as exc:  # noqa: BLE001
            found = []
            note("discover failed: %s" % exc)
        if found:
            note("discovered: %s" % json.dumps(found, ensure_ascii=False))
            ip = found[0]["ip"]
            emit({"t": "link", "state": "scanning",
                  "msg": "发现 %d 台 miIO 设备，暂用 %s" % (len(found), ip)})
        else:
            emit({"t": "error", "msg": "没有配置设备 IP，局域网广播也没发现 miIO 设备"})
            return 3

    try:
        dev = MiioDevice(ip, token, log=note)
    except MiioError as exc:
        emit({"t": "error", "msg": "token 不可用：%s" % exc})
        return 4

    emit({"t": "hello", "v": "1.0", "model": "dmaker.fan.p5", "ip": ip,
          "interval": interval,
          "writable": [{"siid": s, "piid": p, "name": n, "type": t,
                        "range": r} for (s, p), (n, t, r) in WRITABLE.items()],
          "props": [{"siid": s, "piid": p, "name": PROP_NAMES["%d.%d" % (s, p)]}
                    for s, p in POLL_PROPS]})

    # ---------------------------------------------------------- 读一次
    def read_all() -> dict:
        """一次 get_properties 读全部属性，返回 {名称: 值}。

        miIO 的应答是一个数组，每项形如
            {"did":"prop","siid":2,"piid":1,"code":0,"value":true}
        code != 0 表示该属性读取失败（属性不存在 / 不支持）。
        """
        res = dev.get_properties(POLL_PROPS)
        by_key = {(r.get("siid"), r.get("piid")): r for r in (res or [])}
        props: dict[str, object] = {}
        raw: list[dict] = []
        for s, p in POLL_PROPS:
            key = "%d.%d" % (s, p)
            name = PROP_NAMES[key]
            r = by_key.get((s, p))
            if r is None:
                props[name] = None
                raw.append({"key": key, "name": name, "code": None, "value": None})
                continue
            code = r.get("code")
            val = r.get("value") if code == 0 else None
            props[name] = val
            raw.append({"key": key, "name": name, "code": code, "value": val})
        return {"props": props, "raw": raw}

    def snapshot() -> dict:
        got = read_all()
        props = dict(got["props"])
        props["mode_text"] = MODE_NAMES.get(props.get("mode")) if isinstance(props.get("mode"), int) else None
        return {
            "t": "state",
            "at": int(time.time() * 1000),
            "ok": True,
            "ip": ip,
            "props": props,
            "raw": got["raw"],
            # 诊断计数：timeouts 一直涨说明网络/设备不稳
            "timeouts": dev.timeouts,
            "retransmits": dev.retransmits,
        }

    # --probe：连一次、把属性打出来就退（给用户/我排查用，不参与正常轮询）
    if args.probe:
        try:
            hs = dev.handshake()
            emit({"t": "link", "state": "online",
                  "msg": "握手成功 device_id=%d stamp=%d" % (hs["device_id"], hs["stamp"])})
            snap = snapshot()
            emit(snap)
            emit({"t": "link", "state": "done", "msg": "probe 完成"})
            return 0
        except Exception as exc:  # noqa: BLE001
            emit({"t": "error", "msg": "%s：%s" % (type(exc).__name__, exc)})
            return 1

    # ---------------------------------------------------------- 命令通道
    cmd_q: "queue.Queue[dict]" = queue.Queue()
    wake = threading.Event()
    stop = threading.Event()

    def stdin_reader() -> None:
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except Exception:  # noqa: BLE001
                note("忽略无法解析的命令行：%r" % line[:200])
                continue
            cmd_q.put(obj)
            wake.set()
            if obj.get("cmd") == "quit":
                stop.set()
                return

    threading.Thread(target=stdin_reader, daemon=True, name="stdin").start()

    def normalize(siid: int, piid: int, value):
        """按白名单把界面来的值规范化，非法就抛 ValueError。"""
        spec = WRITABLE.get((siid, piid))
        if spec is None:
            raise ValueError("属性 %d.%d 不在可写白名单里" % (siid, piid))
        name, typ, rng = spec
        if typ == "bool":
            if isinstance(value, str):
                value = value.strip().lower() in ("1", "true", "on", "yes")
            return bool(value)
        try:
            ival = int(value)
        except (TypeError, ValueError):
            raise ValueError("%s 需要整数，收到 %r" % (name, value)) from None
        if rng and not (rng[0] <= ival <= rng[1]):
            raise ValueError("%s 超出范围 %s~%s（收到 %s）" % (name, rng[0], rng[1], ival))
        if (siid, piid) == (2, 5) and ival not in ANGLE_VALUES:
            raise ValueError("摆风夹角只支持 %s，收到 %s"
                             % ("/".join(str(a) for a in ANGLE_VALUES), ival))
        return ival

    def handle_command(cmd: dict) -> None:
        """执行一条来自界面的命令，回一个 ack。写后**一定回读确认**。"""
        cid = cmd.get("id")
        kind = cmd.get("cmd")
        if kind in ("ping", "read"):
            if kind == "ping":
                emit({"t": "ack", "id": cid, "ok": True, "cmd": "ping"})
            else:
                # 「立刻读一次」：界面上的「刷新一次」走这条。
                # ⚠️ 这里**必须真的去读设备**：以前这条命令直接 return（什么都不做），
                #    于是服务端 await 一个永远不来的 ack、8 秒后报"超时"——
                #    按钮点下去只等到一句假失败，而设备其实好好的。
                try:
                    emit(snapshot())
                    emit({"t": "ack", "id": cid, "ok": True, "cmd": "read"})
                except Exception as exc:  # noqa: BLE001
                    emit({"t": "ack", "id": cid, "ok": False, "cmd": "read",
                          "error": "%s：%s" % (type(exc).__name__, exc)})
            return
        if kind != "set":
            emit({"t": "ack", "id": cid, "ok": False, "error": "未知命令 %r" % kind})
            return
        try:
            siid = int(cmd.get("siid"))
            piid = int(cmd.get("piid"))
        except (TypeError, ValueError):
            emit({"t": "ack", "id": cid, "ok": False, "error": "siid/piid 非法"})
            return
        try:
            value = normalize(siid, piid, cmd.get("value"))
        except ValueError as exc:
            emit({"t": "ack", "id": cid, "ok": False, "siid": siid, "piid": piid,
                  "error": str(exc)})
            return

        ack: dict = {"t": "ack", "id": cid, "ok": False, "cmd": "set",
                     "siid": siid, "piid": piid, "value": value}
        try:
            res = dev.set_properties([(siid, piid, value)])
            entry = (res or [{}])[0]
            code = entry.get("code")
            ack["code"] = code
            if code not in (0, None):
                ack["error"] = "设备拒绝写入（code=%s）" % code
                emit(ack)
                return
            # 回读确认：界面上的开关状态必须是设备的真实状态，不能是"我以为"
            rb = dev.get_properties([(siid, piid)])
            rb_entry = (rb or [{}])[0]
            readback = rb_entry.get("value") if rb_entry.get("code") in (0, None) else None
            ack["readback"] = readback
            ack["ok"] = readback == value
            if not ack["ok"]:
                ack["error"] = ("写入后回读不一致：写 %r，读回 %r"
                                % (value, readback))
        except (MiioError, MiioTimeout) as exc:
            ack["error"] = "%s：%s" % (type(exc).__name__, exc)
        except Exception as exc:  # noqa: BLE001
            ack["error"] = "%s：%s" % (type(exc).__name__, exc)
        emit(ack)
        # 写完立刻推一帧新状态，界面不用等下一个轮询周期
        try:
            emit(snapshot())
        except Exception as exc:  # noqa: BLE001
            note("写后立即刷新失败：%s" % exc)

    # ---------------------------------------------------------- 主循环
    emit({"t": "link", "state": "connecting", "msg": "正在连接 %s…" % ip})
    fails = 0
    online = False

    while not stop.is_set():
        # 1) 先把命令处理掉 —— 界面点了开关要马上有反应
        while not cmd_q.empty() and not stop.is_set():
            handle_command(cmd_q.get())

        if stop.is_set():
            break

        # 2) 轮询读一次
        t0 = time.monotonic()
        try:
            snap = snapshot()
            emit(snap)
            if not online:
                online = True
                emit({"t": "link", "state": "online", "msg": "已连接 %s" % ip})
            fails = 0
        except (MiioError, MiioTimeout) as exc:
            fails += 1
            online = False
            emit({"t": "link", "state": "offline",
                  "msg": "第 %d 次失败：%s" % (fails, exc)})
            # 连续失败 3 次就重新握手 —— 设备重启后 stamp/did 会变，
            # 抱着旧的 did 发命令只会一直超时。
            if fails >= 3:
                dev.handshook = False
                try:
                    dev.handshake()
                    emit({"t": "link", "state": "online", "msg": "重新握手成功"})
                    fails = 0
                except Exception as exc2:  # noqa: BLE001
                    note("重新握手失败：%s" % exc2)
        except Exception as exc:  # noqa: BLE001
            fails += 1
            emit({"t": "error", "msg": "%s：%s" % (type(exc).__name__, exc)})

        # 3) 等下一个周期（命令来了就提前醒来）
        wait = max(0.0, interval - (time.monotonic() - t0))
        if wait > 0 and not stop.is_set():
            if wake.wait(wait):
                wake.clear()

    emit({"t": "link", "state": "stopped", "msg": "采集器退出"})
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(0)
