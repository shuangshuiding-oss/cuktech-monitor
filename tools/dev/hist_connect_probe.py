# -*- coding: utf-8 -*-
"""定点验证 LYWSD03MMC 连接失败的四种假设（只读）。

假设：
  H1  广播里有没有 service_uuids —— 本机实测是空的。BLE 中心端连外设**必须**先
      把广播报给系统的服务表填进缓存，没有服务表就连不上（WinRT 报 NotFound）。
      带 service_uuids=["ebe0ccb0-..."] 过滤扫一次，如果这样能扫到 → 假设成立。
  H2  先扫再连（scan-then-connect）的窗口太短 —— 分块扫 15s 命中后**立刻**连。
  H3  设备已经被某个"幽灵"中心端连着（Windows 蓝牙设置页、其它小程序）。
  H4  连接参数/时序问题 —— 连上后立刻 is_connected 复核。

用法：
  .venv\Scripts\python.exe tools\dev\hist_connect_probe.py            # 跑全部
  .venv\Scripts\python.exe tools\dev\hist_connect_probe.py h1         # 只跑某一项
"""
import asyncio
import sys
import time

from bleak import BleakClient, BleakScanner

SVC_ENV = "ebe0ccb0-7a0a-4b0c-8a1a-6ff2997da3a6"
CHAR_TEMP = "ebe0ccc1-7a0a-4b0c-8a1a-6ff2997da3a6"

if sys.platform.startswith("win"):
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())


def stamp():
    return time.strftime("%H:%M:%S")


def show_adv(tag, dev, adv):
    print("  [%s] %s addr=%s rssi=%s name=%r" % (stamp(), tag, dev.address, adv.rssi, dev.name))
    print("        service_uuids   = %s" % (list(adv.service_uuids) or "(空)"))
    print("        service_data    = %s" % ({str(k): bytes(v).hex() for k, v in (adv.service_data or {}).items()} or "(空)"))
    print("        manufacturer    = %s" % ({str(k): bytes(v).hex() for k, v in (adv.manufacturer_data or {}).items()} or "(空)"))
    print("        local_name      = %r" % adv.local_name)
    print("        platform_data   = %s" % (str(adv.platform_data)[:200],))


async def probe_h1(addr, seconds=20.0):
    """带 service_uuids 过滤扫描，看能否拿到服务表。"""
    print("\n===== H1：带 service_uuids 过滤扫描（%ds）=====" % seconds)
    found = []

    def cb(dev, adv):
        if dev.address.upper() != addr.upper():
            return
        if len(found) < 3:
            found.append((dev, adv))
            show_adv("H1 命中", dev, adv)

    scanner = BleakScanner(detection_callback=cb, service_uuids=[SVC_ENV])
    await scanner.start()
    waited = 0.0
    while waited < seconds and not found:
        await asyncio.sleep(0.5)
        waited += 0.5
    await scanner.stop()

    if found:
        print("  ✅ 带 UUID 过滤能扫到（%d 次）—— 说明广播里**有**服务 UUID 位" % len(found))
        print("     ⇒ 不带过滤时 service_uuids 为空 = bleak/WinRT 漏解析，不是设备没报")
    else:
        print("  ❌ 带 UUID 过滤 %ds 一次都没扫到 —— 说明这台设备的广播里**没有**服务 UUID 位" % seconds)
        print("     ⇒ 中心端拿不到服务表 ⇒ WinRT connect 必然报 NotFound（与实测吻合）")
    return bool(found)


async def probe_h2(addr, seconds=25.0):
    """扫描命中后立刻连接（不等扫描窗口结束）。"""
    print("\n===== H2：命中即连（分块扫 %ds）=====" % seconds)
    hit = {}

    def cb(dev, adv):
        if dev.address.upper() != addr.upper():
            return
        if "at" not in hit:
            hit["at"] = time.monotonic()
            hit["dev"] = dev
            hit["adv"] = adv

    scanner = BleakScanner(detection_callback=cb)
    await scanner.start()
    waited = 0.0
    while waited < seconds and "at" not in hit:
        await asyncio.sleep(0.2)
        waited += 0.2
    if "at" not in hit:
        await scanner.stop()
        print("  ❌ 没扫到，无法继续")
        return False
    print("  扫到（%.1fs，rssi=%s），立刻 connect…" % (waited, hit["adv"].rssi))
    show_adv("H2 命中", hit["dev"], hit["adv"])
    await scanner.stop()

    t0 = time.monotonic()
    try:
        client = BleakClient(addr, timeout=20.0)
        await client.connect()
        print("  ✅ 连上了（%.1fs）is_connected=%s" % (time.monotonic() - t0, client.is_connected))
        try:
            v = await client.read_gatt_char(CHAR_TEMP)
            print("     温度特征读回 %s" % v.hex())
        except Exception as exc:  # noqa: BLE001
            print("     温度特征读失败：%s: %s" % (type(exc).__name__, exc))
        await client.disconnect()
        return True
    except Exception as exc:  # noqa: BLE001
        print("  ❌ 失败：%s: %s（%.1fs）" % (type(exc).__name__, exc, time.monotonic() - t0))
        return False


async def probe_h4(addr):
    """用系统缓存的 BLEDevice 对象连（不扫描）。"""
    print("\n===== H4：discover 拿 BLEDevice 后再连 =====")
    devs = await BleakScanner.discover(timeout=15.0, return_adv=True)
    target = None
    for d, adv in devs.values():
        if d.address.upper() == addr.upper():
            target = d
            show_adv("H4 发现", d, adv)
            break
    if not target:
        print("  ❌ discover 没找到设备")
        return False
    for attempt in range(1, 4):
        t0 = time.monotonic()
        try:
            client = BleakClient(target, timeout=20.0)
            await client.connect()
            print("  ✅ 第 %d 次连上（%.1fs）" % (attempt, time.monotonic() - t0))
            await client.disconnect()
            return True
        except Exception as exc:  # noqa: BLE001
            print("  ❌ 第 %d 次失败：%s: %s（%.1fs）"
                  % (attempt, type(exc).__name__, exc, time.monotonic() - t0))
            await asyncio.sleep(5.0)
    return False


async def main():
    addr = sys.argv[2] if len(sys.argv) > 2 else "A4:C1:38:3C:25:A2"
    which = sys.argv[1].lower() if len(sys.argv) > 1 else "all"
    print("目标 %s  当前 %s" % (addr, stamp()))
    r = {}
    if which in ("all", "h1"):
        r["H1"] = await probe_h1(addr)
    if which in ("all", "h2"):
        r["H2"] = await probe_h2(addr)
    if which in ("all", "h4"):
        r["H4"] = await probe_h4(addr)
    print("\n===== 汇总 =====")
    for k, v in r.items():
        print("  %s: %s" % (k, "成功" if v else "失败"))


if __name__ == "__main__":
    asyncio.run(main())
