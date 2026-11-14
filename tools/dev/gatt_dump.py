# -*- coding: utf-8 -*-
"""针对候选设备枚举完整 GATT 服务表 + 试读关键特征（只读）。

用法: .venv\Scripts\python.exe tools\dev\gatt_dump.py CC:4D:75:BB:47:1F ["44:D8:6D:BF:BB:D0"]
"""
import asyncio
import sys

from bleak import BleakClient

if sys.platform.startswith("win"):
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())

HINT = {
    "ebe0ccb0": "★环境服务（LYWSD03MMC）",
    "ebe0ccc1": "★温湿度 read+notify",
    "ebe0ccbc": "★历史记录 notify",
    "ebe0ccb7": "★设备时钟",
    "ebe0ccb9": "记录数/电量",
    "ebe0ccba": "记录索引",
    "ebe0ccbe": "单位 F/C",
    "0000fe95": "小米 MiService",
    "0000fdaa": "小米 快连/认证",
    "0000fdb3": "小米 快连/认证",
    "00001812": "HID",
    "0000180a": "DeviceInfo",
    "0000180f": "Battery",
    "00001809": "HealthThermometer",
}


def hint(u):
    for k, v in HINT.items():
        if u.replace("-", "").startswith(k):
            return "   " + v
    return ""


async def dump(addr):
    print("\n===== %s =====" % addr)
    try:
        client = BleakClient(addr, timeout=20.0)
        await client.connect()
    except Exception as exc:  # noqa: BLE001
        print("  connect 失败：%s: %s" % (type(exc).__name__, exc))
        return
    try:
        print("  connected. services:")
        for s in client.services:
            su = str(s.uuid).lower()
            print("    SVC %s%s" % (su, hint(su)))
            for ch in s.characteristics:
                cu = str(ch.uuid).lower()
                print("        CH  %s  [%s]%s" % (cu, ",".join(ch.properties), hint(cu)))
        # 试读几个可读特征，看是不是温湿度计
        print("  -- 试读所有 readable 特征 --")
        for s in client.services:
            for ch in s.characteristics:
                if "read" not in ch.properties:
                    continue
                cu = str(ch.uuid).lower()
                if cu.startswith("00002a00") or cu.startswith("00002a01"):
                    continue
                try:
                    v = await client.read_gatt_char(ch)
                    note = ""
                    if "ccc1" in cu and len(v) >= 2:
                        import struct
                        note = "  → %.2f ℃  %d%%" % (struct.unpack_from("<h", v, 0)[0] / 100.0, v[2] if len(v) > 2 else -1)
                    print("      %s = %s (len=%d)%s" % (cu, bytes(v).hex(), len(v), note))
                except Exception as exc:  # noqa: BLE001
                    print("      %s 读失败：%s" % (cu, type(exc).__name__))
    finally:
        try:
            await client.disconnect()
        except Exception:  # noqa: BLE001
            pass


async def main():
    for a in sys.argv[1:] or ["CC:4D:75:BB:47:1F"]:
        await dump(a)
        await asyncio.sleep(2.0)


if __name__ == "__main__":
    asyncio.run(main())
