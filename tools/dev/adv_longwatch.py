# -*- coding: utf-8 -*-
"""连续长时间监听 + 高频探测：确认温度计到底还广播不广播。

用两路并行：
  A) BleakScanner 持续监听（detection_callback），记录每次命中与间隔；
  B) 每 15 秒做一次 discover，比对"这一刻能不能看到它"。

用法: .venv\Scripts\python.exe tools/dev/adv_longwatch.py [MAC] [秒数]
"""
import asyncio
import sys
import time

from bleak import BleakScanner

if sys.platform.startswith("win"):
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())

TARGET = (sys.argv[1] if len(sys.argv) > 1 else "A4:C1:38:3C:25:A2").upper()
SECS = float(sys.argv[2]) if len(sys.argv) > 2 else 180.0


async def main():
    t0 = time.monotonic()
    hits = []
    other_named = {}

    def cb(dev, adv):
        name = dev.name or adv.local_name or ""
        if name and name not in other_named:
            other_named[name] = dev.address
        if dev.address.upper() != TARGET:
            return
        hits.append(time.monotonic() - t0)
        print("  [%s +%.1fs] 命中 #%d rssi=%s name=%r"
              % (time.strftime("%H:%M:%S"), hits[-1], len(hits), adv.rssi, dev.name))

    print("长监听 %s，%.0fs（%s 起）" % (TARGET, SECS, time.strftime("%H:%M:%S")))
    scanner = BleakScanner(detection_callback=cb)
    await scanner.start()

    nxt = 15.0
    while True:
        el = time.monotonic() - t0
        if el >= SECS:
            break
        await asyncio.sleep(1.0)
        if el >= nxt:
            nxt += 15.0
            print("  ...已监听 %.0fs，命中 %d 次，已看到 %d 个有名字的设备"
                  % (el, len(hits), len(other_named)))
    await scanner.stop()

    print("\n===== 结果 =====")
    print("监听 %.0fs，%s 命中 %d 次" % (SECS, TARGET, len(hits)))
    if hits:
        gaps = [hits[i + 1] - hits[i] for i in range(len(hits) - 1)]
        if gaps:
            print("  间隔：min %.1fs  中位 %.1fs  max %.1fs" % (
                min(gaps), sorted(gaps)[len(gaps) // 2], max(gaps)))
    else:
        print("  ❌ 全程零命中 —— 设备不广播（被占用 / 换地址 / 没电）")
    print("  期间看到的有名字设备：" + ", ".join(sorted(other_named.keys())[:20]))


if __name__ == "__main__":
    asyncio.run(main())
