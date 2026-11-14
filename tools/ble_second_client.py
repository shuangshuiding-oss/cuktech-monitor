# 只读实验：在应用已经占用 BLE 的情况下，试着再开第二个 BLE 连接。
# 用来回答"电脑连着的时候，手机米家还能不能控制"—— BLE 外设要么允许多连接，要么只允许一个。
# 全程只读：不写任何特征值（不碰 MiOT 认证/命令通道）。
import asyncio
import os
import sys
import time

from bleak import BleakClient, BleakScanner

ADDR = "AA:BB:CC:DD:EE:FF"
OUT = os.path.join(os.environ.get("TEMP", "."), "cuk_second.txt")

lines = []


def w(msg):
    lines.append(msg)


async def main():
    w(f"target = {ADDR}")
    t0 = time.time()
    try:
        dev = await BleakScanner.find_device_by_address(ADDR, timeout=15.0)
    except Exception as e:
        dev = None
        w(f"scan error: {type(e).__name__}: {e}")
    w(f"found = {bool(dev)}  ({time.time() - t0:.1f}s)")
    if not dev:
        w("结论：扫不到设备 → 可能被独占或被应用占满")
        return

    t1 = time.time()
    try:
        async with BleakClient(dev, timeout=25.0) as c:
            w(f"second connect OK in {time.time() - t1:.2f}s  is_connected={c.is_connected}")
            nread = 0
            for s in c.services:
                for ch in s.characteristics:
                    if "read" not in ch.properties:
                        continue
                    try:
                        v = await c.read_gatt_char(ch)
                        w(f"  read {ch.uuid} -> {v.hex()}")
                        nread += 1
                    except Exception as e:
                        w(f"  read {ch.uuid} ERR {type(e).__name__}: {e}")
                    if nread >= 6:
                        break
                if nread >= 6:
                    break
            await asyncio.sleep(2.0)
            w("holding 2s... still connected = " + str(c.is_connected))
    except Exception as e:
        w(f"second connect FAILED in {time.time() - t1:.2f}s: {type(e).__name__}: {e}")


try:
    asyncio.run(main())
except Exception as e:
    w(f"fatal: {type(e).__name__}: {e}")

with open(OUT, "w", encoding="utf-8") as f:
    f.write("\n".join(lines))
print("done")
sys.exit(0)
