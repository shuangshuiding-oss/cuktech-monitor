# -*- coding: utf-8 -*-
"""历史读取失败的定点诊断（只读，不改设备）。

比 read_hist_probe.py 多做三件关键事：
  1) 连接**之前**先扫广播 —— 区分「设备根本没广播（被别的中心端占着）」
     和「在广播但 connect 握手失败」。
  2) 打印 client.services（WinRT 已缓存的服务表）—— 用来验证
     "ibeacon 服务探测" 这类 trick 到底有没有把完整 GATT 表拉下来。
  3) 用 is_connected / 连接后读设备名 复核连接是否真的成立。

用法（应用运行中也行，但它自己会连设备）：
  .venv\Scripts\python.exe tools\dev\hist_diag.py A4:C1:38:3C:25:A2
"""
import asyncio
import struct
import sys
import time

from bleak import BleakClient, BleakScanner

CHAR_CLOCK = "ebe0ccb7-7a0a-4b0c-8a1a-6ff2997da3a6"
CHAR_HIST = "ebe0ccbc-7a0a-4b0c-8a1a-6ff2997da3a6"
CHAR_NUM = "ebe0ccb9-7a0a-4b0c-8a1a-6ff2997da3a6"
CHAR_IDX = "ebe0ccba-7a0a-4b0c-8a1a-6ff2997da3a6"

# 已知属于该设备的服务前缀（用来数"缓存里到底有哪几块"）
KNOWN = {
    "ebe0ccb0": "环境服务(温度/历史/电量)",
    "0000fe95": "小米 MiService",
    "0000fee7": "小米 MiService(alt)",
    "0000180a": "Device Information",
    "00001800": "Generic Access",
    "00001801": "Generic Attribute",
}


def diff_time():
    return time.strftime("%H:%M:%S")


async def main(address):
    addr = address.upper()
    print("[%s] 目标 %s" % (diff_time(), addr))

    # ---------------------------------------------------------- 1. 广播可见性
    print("\n=== 1) 扫描广播（15s）===")
    hit = {"n": 0, "rssi": None, "name": None, "svc": [], "manuf": []}

    def cb(dev, adv):
        if dev.address.upper() != addr:
            return
        hit["n"] += 1
        hit["rssi"] = adv.rssi
        hit["name"] = dev.name or adv.local_name
        for u in (adv.service_uuids or []):
            if str(u).lower() not in hit["svc"]:
                hit["svc"].append(str(u).lower())
        for cid in (adv.manufacturer_data or {}):
            if cid not in hit["manuf"]:
                hit["manuf"].append(cid)

    try:
        scanner = BleakScanner(detection_callback=cb)
        await scanner.start()
        for _ in range(30):
            await asyncio.sleep(0.5)
            if hit["n"]:
                break
        await scanner.stop()
    except Exception as exc:  # noqa: BLE001
        print("  扫描异常：%s: %s" % (type(exc).__name__, exc))

    if hit["n"]:
        print("  ✅ 在广播：命中 %d 次  rssi=%s  name=%s" % (hit["n"], hit["rssi"], hit["name"]))
        print("     广播里的服务: %s" % (hit["svc"] or "(无)"))
        print("     厂商数据 id : %s" % (hit["manuf"] or "(无)"))
        print("     ⇒ 设备没被别的中心端占着，问题在连接/订阅环节")
    else:
        print("  ❌ 15 秒内一次都没扫到 —— 设备**不广播**了")
        print("     ⇒ 已被某个中心端连着（手机米家 / 平板 / 家里的网关 / 本应用的轮询进程）")
        print("     ⇒ 这种状态下 connect 必然失败，重试多少次都一样，先找谁连着它")

    # ---------------------------------------------------------- 2. 连接尝试
    print("\n=== 2) 连接 ===")
    t0 = time.monotonic()
    try:
        client = BleakClient(addr, timeout=25.0)
        await client.connect()
    except Exception as exc:  # noqa: BLE001
        print("  ❌ connect 失败：%s: %s（耗时 %.1fs）"
              % (type(exc).__name__, exc, time.monotonic() - t0))
        return
    print("  ✅ connect 返回，耗时 %.1fs，is_connected=%s"
          % (time.monotonic() - t0, client.is_connected))

    try:
        # ------------------------------------------------------ 3. 服务表
        print("\n=== 3) 连接后拿到的 GATT 服务表 ===")
        try:
            svcs = client.services
            known = []
            for s in svcs:
                u = str(s.uuid).lower()
                tag = ""
                for pref, name in KNOWN.items():
                    if u.startswith(pref):
                        tag = " <- " + name
                        break
                known.append("  %s%s" % (u, tag))
            for line in known:
                print(line)
            print("  共 %d 个服务" % len(known))
            svc_uuids = [str(s.uuid).lower() for s in svcs]
            has_env = any(u.startswith("ebe0ccb0") for u in svc_uuids)
            has_hist = any("ebe0ccbc" in str(c.uuid).lower()
                           for s in svcs for c in s.characteristics)
            print("  → 含环境服务(ebe0ccb0): %s   含历史特征(ebe0ccbc): %s" % (has_env, has_hist))
            if not has_hist:
                print("  ⚠️ 服务表里没有历史特征 —— WinRT 缓存不完整，"
                      "这解释了 BleakCharacteristicNotFoundError")
        except Exception as exc:  # noqa: BLE001
            print("  服务表读取失败：%s: %s" % (type(exc).__name__, exc))

        # ------------------------------------------------------ 4. 关键特征试读
        print("\n=== 4) 关键特征试读 ===")
        for name, ch in [("时钟(b7)", CHAR_CLOCK), ("记录数(b9)", CHAR_NUM),
                         ("索引(ba)", CHAR_IDX)]:
            try:
                v = await client.read_gatt_char(ch)
                extra = ""
                if name.startswith("时钟") and len(v) >= 4:
                    val = struct.unpack_from("<I", v, 0)[0]
                    extra = "  u32=%d  (现在-u32=%.0f 秒)" % (val, time.time() - val)
                elif len(v) >= 2:
                    extra = "  u16LE=%d" % struct.unpack_from("<H", v, 0)[0]
                print("  ✅ %-10s %s%s" % (name, v.hex(), extra))
            except Exception as exc:  # noqa: BLE001
                print("  ❌ %-10s %s: %s" % (name, type(exc).__name__, exc))

        # ------------------------------------------------------ 5. 历史订阅
        print("\n=== 5) 订阅历史 notify（最多等 25s）===")
        got = []

        def on_notify(_s, data: bytearray):
            got.append(bytes(data))

        try:
            await client.start_notify(CHAR_HIST, on_notify)
            print("  start_notify 返回成功，等数据…")
        except Exception as exc:  # noqa: BLE001
            print("  ❌ start_notify 失败：%s: %s" % (type(exc).__name__, exc))
        else:
            for i in range(25):
                await asyncio.sleep(1)
                if got:
                    print("  第 %ds 收到 %d 条" % (i + 1, len(got)))
                    break
            if not got:
                print("  ⚠️ 25 秒零条 —— 连上了但设备不推数据（连接被别的中心端抢走？）")
            for b in got[:5]:
                print("    len=%d %s" % (len(b), b.hex()))
            try:
                await client.stop_notify(CHAR_HIST)
            except Exception:  # noqa: BLE001
                pass
    finally:
        try:
            await client.disconnect()
            print("\n已断开")
        except Exception:  # noqa: BLE001
            pass


if __name__ == "__main__":
    mac = sys.argv[1] if len(sys.argv) > 1 else "A4:C1:38:3C:25:A2"
    if sys.platform.startswith("win"):
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
    asyncio.run(main(mac))
