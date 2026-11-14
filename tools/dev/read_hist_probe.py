# -*- coding: utf-8 -*-
"""实测读取 LYWSD03MMC 历史数据：读时间基准 + 订阅历史 notify，打印前几条原始字节。

用法: .venv/Scripts/python.exe tools/dev/read_hist_probe.py <MAC>
"""
import asyncio
import struct
import sys
import time

from bleak import BleakClient, BleakScanner

CHAR_TIME = "ebe0ccb7-7a0a-4b0c-8a1a-6ff2997da3a6"   # TermCIC 口径：Unix 时间
CHAR_TIME_ALT = "ebe0ccbb-7a0a-4b0c-8a1a-6ff2997da3a6"  # 旧代码口径
CHAR_HIST = "ebe0ccbc-7a0a-4b0c-8a1a-6ff2997da3a6"
CHAR_NUM = "ebe0ccb9-7a0a-4b0c-8a1a-6ff2997da3a6"


async def main(address):
    got = []

    def on_notify(_s, data: bytearray):
        b = bytes(data)
        got.append(b)
        print("\n[notify] len=%d hex=%s" % (len(b), b.hex()))
        if len(b) >= 14:
            idx, ts, tmax, hmax, tmin, hmin = struct.unpack_from("<IIhBhB", b, 0)
            print("  idx=%d ts=%d" % (idx, ts))
            print("  tmax: /10=%.1f  /100=%.2f   (hmax=%d)" % (tmax / 10.0, tmax / 100.0, hmax))
            print("  tmin: /10=%.1f  /100=%.2f   (hmin=%d)" % (tmin / 10.0, tmin / 100.0, hmin))

    print("扫描中（12s，先让设备进 WinRT 缓存）...")
    await BleakScanner.discover(timeout=12)

    async with BleakClient(address, timeout=20) as client:
        print("connected")
        for name, ch in [("TIME(b7)", CHAR_TIME), ("TIME_ALT(bb)", CHAR_TIME_ALT), ("NUM(b9)", CHAR_NUM)]:
            try:
                v = await client.read_gatt_char(ch)
                print("%s = %s (%d bytes)" % (name, v.hex(), len(v)))
                if name.startswith("TIME") and len(v) >= 4:
                    val = struct.unpack_from("<I", v, 0)[0]
                    print("    -> u32=%d  现在-%d = %.0f 秒" % (val, int(time.time()), time.time() - val))
            except Exception as e:
                print("%s 读失败: %s: %s" % (name, type(e).__name__, e))

        print("\n订阅历史 notify...（收 3 条即退出）")
        await client.start_notify(CHAR_HIST, on_notify)
        for _ in range(30):
            if len(got) >= 3:
                break
            await asyncio.sleep(1)
        await client.stop_notify(CHAR_HIST)
        print("收到 %d 条" % len(got))


if __name__ == "__main__":
    mac = sys.argv[1] if len(sys.argv) > 1 else "A4:C1:38:3C:25:A2"
    asyncio.run(main(mac))
