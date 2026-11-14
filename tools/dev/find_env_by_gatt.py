# -*- coding: utf-8 -*-
"""验证「温度计是不是换了随机 MAC 地址」（只读）。

背景：2026-10-05 实测
  · 固定 MAC A4:C1:38:3C:25:A2 现在完全扫不到（扫 3 轮，最长 90s 零命中）；
  · 但周边台设备里有 CC:4D:75:BB:47:1F（RSSI −51，无名，manufacturer id 911）
    和 44:D8:6D:BF:BB:D0 / 51:AC:C2:71:35:A1（同名同 mfg=911）。

manufacturer id 911 = 0x038F —— 小米生态链（miaomiaoce/秒秒测）的常见 id，
且 0x038F 的字节序反过来看是 "8F 03"，需要逐字节核对是不是 EBE0 段的位移。

这个脚本：
  1) 扫 N 秒，把所有 **manufacturer id 含 911/0x038F** 或 **无名 + RSSI 强** 的设备原始
     字节 dump 出来，看能不能在里面找到 LYWSD03MMC 的 EBE0 服务数据；
  2) 对候选设备逐个尝试连接 + 枚举 GATT，看服务表里有没有 ebe0ccb0（环境服务）。
     有 → 就是温度计换了地址。

用法: .venv\Scripts\python.exe tools\dev\find_env_by_gatt.py [秒数]
"""
import asyncio
import sys
import time

from bleak import BleakClient, BleakScanner

if sys.platform.startswith("win"):
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())

ENV_SVC = "ebe0ccb0"
HIST_CH = "ebe0ccbc"
MIAOMIAO_ID = 911


def parse_mfg(adv):
    out = []
    for cid, data in (adv.manufacturer_data or {}).items():
        b = bytes(data)
        tag = ""
        if cid == MIAOMIAO_ID:
            tag = " <秒秒测/小米生态链>"
        # 在这条厂商数据里找 ebe0 字节模式（大小端都试）
        h = b.hex()
        if "ebe0" in h:
            tag += " ⚠️含 ebe0 字节"
        if "b0cc" in h:
            tag += " ⚠️含 b0cc 字节"
        out.append("    mfg[%d=0x%04x]%s : %s" % (cid, cid, tag, h))
    return out


async def main():
    secs = float(sys.argv[1]) if len(sys.argv) > 1 else 25.0
    print("扫描 %.0fs，找无名/秒秒测候选（%s）" % (secs, time.strftime("%H:%M:%S")))

    cands = {}

    def cb(dev, adv):
        if "at" in cands.get(dev.address, {}):
            return
        mfg_ids = list((adv.manufacturer_data or {}).keys())
        strong = adv.rssi is not None and adv.rssi > -70
        no_name = not (dev.name or adv.local_name)
        if MIAOMIAO_ID in mfg_ids or (strong and no_name):
            cands[dev.address] = {"at": True, "rssi": adv.rssi, "name": dev.name,
                                  "adv": adv, "dev": dev}

    scanner = BleakScanner(detection_callback=cb)
    await scanner.start()
    t0 = time.monotonic()
    while time.monotonic() - t0 < secs:
        await asyncio.sleep(0.5)
    await scanner.stop()

    print("\n候选 %d 台：" % len(cands))
    for a, c in sorted(cands.items(), key=lambda kv: -(kv[1]["rssi"] or -999)):
        print("\n  %s  rssi=%s  name=%r" % (a, c["rssi"], c["name"]))
        for line in parse_mfg(c["adv"]):
            print(line)
        print("    service_uuids = %s" % (list(c["adv"].service_uuids) or "(空)"))
        if c["adv"].service_data:
            print("    service_data  = %s" % {str(k): bytes(v).hex()
                                              for k, v in c["adv"].service_data.items()})

    # 逐个连上去看 GATT 服务表里有没有 ebe0ccb0
    print("\n===== 逐个连接验证是否温度计（看有没有 ebe0ccb0 环境服务）=====")
    for a, c in sorted(cands.items(), key=lambda kv: -(kv[1]["rssi"] or -999))[:6]:
        t0 = time.monotonic()
        try:
            client = BleakClient(a, timeout=15.0)
            await client.connect()
        except Exception as exc:  # noqa: BLE001
            print("  %s  connect 失败：%s: %s（%.1fs）"
                  % (a, type(exc).__name__, str(exc)[:70], time.monotonic() - t0))
            continue
        try:
            svcs = [str(s.uuid).lower() for s in client.services]
            hit = [u for u in svcs if u.startswith(ENV_SVC)]
            print("  %s  连上了（%.1fs）服务数=%d%s"
                  % (a, time.monotonic() - t0, len(svcs),
                     "  ★★★ 发现环境服务 ebe0ccb0 —— 就是温度计换了地址！" if hit else ""))
            if hit:
                for s in client.services:
                    if str(s.uuid).lower().startswith(ENV_SVC):
                        for ch in s.characteristics:
                            print("        %s  %s" % (ch.uuid, ch.properties))
        except Exception as exc:  # noqa: BLE001
            print("  %s  服务表读取失败：%s: %s" % (a, type(exc).__name__, str(exc)[:70]))
        finally:
            try:
                await client.disconnect()
            except Exception:  # noqa: BLE001
                pass


if __name__ == "__main__":
    asyncio.run(main())
