# 只读实验 2：不扫描，直接按地址连（模拟"米家里已经添加过这台设备、记得地址"的情形）。
# 用来回答：设备被电脑占用时，第二个中心（手机）能不能凭已知地址硬连上去。
# 全程只读，不写任何特征值。
import asyncio
import os
import sys
import time

from bleak import BleakClient

ADDR = "AA:BB:CC:DD:EE:FF"
OUT = os.path.join(os.environ.get("TEMP", "."), "cuk_second2.txt")
lines = []


def w(m):
    lines.append(m)


async def main():
    w("模式：不扫描，直接按地址连接（等价于米家已知地址时的重连）")
    t = time.time()
    try:
        async with BleakClient(ADDR, timeout=25.0) as c:
            w(f"直连成功 in {time.time() - t:.2f}s  is_connected={c.is_connected}")
            await asyncio.sleep(2.0)
            w("保持 2 秒后仍连接 = " + str(c.is_connected))
    except Exception as e:
        w(f"直连失败 in {time.time() - t:.2f}s: {type(e).__name__}: {e}")


try:
    asyncio.run(main())
except Exception as e:
    w(f"fatal: {type(e).__name__}: {e}")

with open(OUT, "w", encoding="utf-8") as f:
    f.write("\n".join(lines))
print("done")
sys.exit(0)
