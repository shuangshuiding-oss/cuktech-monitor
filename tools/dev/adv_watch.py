# -*- coding: utf-8 -*-
"""持续监听 LYWSD03MMC 的广播时间线（只读，最长 5 分钟）。

用途：确认"设备到底是不是间歇性广播"。LYWSD03MMC 平时约每 5~10 秒广播一次，
如果长时间（>60s）完全收不到，就说明它被某个中心端连着（连着时停止广播）。

同时打印每次命中的原始 AD 段 —— 用来确认广播里**到底有没有 GATT 服务 UUID**，
这是 WinRT 连接的前提（没有服务表 → connect 报 NotFound）。

用法: .venv\Scripts\python.exe tools\dev\adv_watch.py [MAC] [秒数]
"""
import asyncio
import sys
import time

from bleak import BleakScanner

if sys.platform.startswith("win"):
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())

AD_TYPE = {
    0x01: "Flags", 0x02: "16b UUID 不全", 0x03: "16b UUID 全",
    0x06: "128b UUID 不全", 0x07: "128b UUID 全",
    0x08: "Shortened Name", 0x09: "Complete Name", 0x0A: "TX Power",
    0x16: "ServiceData-16", 0x20: "ServiceData-32", 0x21: "ServiceData-128",
    0x29: "Encrypted Adv", 0x2A: "Encrypted Adv2", 0xFF: "Manufacturer",
}

# LYWSD03MMC 可能的服务 UUID（用于在广播里找它们）
CANDIDATE = {
    "ebe0ccb0": "环境服务", "ebe0ccbc": "历史", "ebe0ccc1": "温湿度",
    "fe95": "MiService(16b)", "0000fe95": "MiService", "181a": "ATC",
    "1809": "温度计profile", "180f": "电池", "180a": "DeviceInfo",
}


def uuid128_le(b):
    return ("%s-%s-%s-%s-%s" % (b[0:4][::-1].hex(), b[4:6][::-1].hex(),
                                b[6:8][::-1].hex(), b[8:10].hex(), b[10:16].hex()))


def parse_ads(raw):
    out = []
    i = 0
    while i < len(raw):
        ln = raw[i]
        if ln == 0:
            i += 1
            continue
        if i + 1 + ln > len(raw):
            out.append("      [%2d] 越界 ln=%d 剩余=%d" % (i, ln, len(raw) - i - 1))
            break
        typ = raw[i + 1]
        pl = raw[i + 2:i + 1 + ln]
        name = AD_TYPE.get(typ, "未知(0x%02x)" % typ)
        extra = ""
        hint = ""
        if typ in (0x02, 0x03):
            uuids = [pl[k + 1] << 8 | pl[k] for k in range(0, len(pl) - 1, 2)]
            extra = "  uuids=%s" % ["0x%04x" % u for u in uuids]
            for u in uuids:
                k = "%04x" % u
                if k in CANDIDATE:
                    hint += " <%s>" % CANDIDATE[k]
        elif typ in (0x06, 0x07) and len(pl) >= 16:
            for k in range(0, len(pl) - 15, 16):
                u = uuid128_le(pl[k:k + 16])
                extra += "  uuid=%s" % u
                if u[:8] in CANDIDATE:
                    hint += " <%s>" % CANDIDATE[u[:8]]
        elif typ == 0x16 and len(pl) >= 2:
            u = pl[1] << 8 | pl[0]
            extra = "  uuid=0x%04x data=%s" % (u, pl[2:].hex())
            if "%04x" % u in CANDIDATE:
                hint += " <%s>" % CANDIDATE["%04x" % u]
        elif typ == 0x21 and len(pl) >= 16:
            u = uuid128_le(pl[:16])
            extra = "  uuid=%s data=%s" % (u, pl[16:].hex())
            if u[:8] in CANDIDATE:
                hint += " <%s>" % CANDIDATE[u[:8]]
        elif typ == 0xFF and len(pl) >= 2:
            extra = "  company=0x%04x data=%s" % (pl[1] << 8 | pl[0], pl[2:].hex())
        elif typ in (0x08, 0x09):
            extra = "  %r" % pl.decode("utf-8", "replace")
        out.append("      [%2d] 0x%02x %-16s len=%d%s%s" % (i, typ, name, ln - 1, extra, hint))
        i += 1 + ln
    return out


async def main():
    addr = (sys.argv[1] if len(sys.argv) > 1 else "A4:C1:38:3C:25:A2").upper()
    secs = float(sys.argv[2]) if len(sys.argv) > 2 else 300.0

    if addr == "ALL":
        devs = await BleakScanner.discover(timeout=min(secs, 25.0), return_adv=True)
        print("共 %d 台设备：" % len(devs))
        for dev_addr, (d, adv) in sorted(devs.items()):
            print("  %-18s rssi=%-5s name=%-24r svc=%s mfg=%s" % (
                dev_addr, adv.rssi, d.name or adv.local_name,
                list(adv.service_uuids)[:3] or "(空)",
                list((adv.manufacturer_data or {}).keys()) or "(空)"))
        return

    t0 = time.monotonic()
    print("监听 %s，最多 %.0fs（%s 开始）" % (addr, secs, time.strftime("%H:%M:%S")))
    print("（正常 LYWSD03MMC 约每 5~10 秒广播一次；>60 秒完全没有 = 被连着占住了）")

    hits = []
    dumped = 0

    def cb(dev, adv):
        nonlocal dumped
        if dev.address.upper() != addr:
            return
        el = time.monotonic() - t0
        hits.append(el)
        print("\n[%s  +%.1fs] 第 %d 次命中 rssi=%s" % (
            time.strftime("%H:%M:%S"), el, len(hits), adv.rssi))
        if dumped < 2:
            dumped += 1
            print("    bleak: service_uuids=%s" % (list(adv.service_uuids) or "(空)"))
            print("    bleak: service_data =%s" % ({str(k): bytes(v).hex()
                                                    for k, v in (adv.service_data or {}).items()} or "(空)"))
            print("    bleak: manufacturer =%s" % ({str(k): bytes(v).hex()
                                                    for k, v in (adv.manufacturer_data or {}).items()} or "(空)"))
            pd = adv.platform_data
            if pd:
                try:
                    raw = bytes(pd[1])
                    print("    Windows 地址类型 sender=%s，原始字节：" % (pd[0],))
                    for line in parse_ads(raw):
                        print(line)
                except Exception as exc:  # noqa: BLE001
                    print("    platform_data 解析失败：%s" % exc)
        # 广播间隔
        if len(hits) >= 2:
            gap = hits[-1] - hits[-2]
            if gap > 20:
                print("    ↑ 距上次间隔 %.0fs（异常长 → 中间被占用了）" % gap)

    scanner = BleakScanner(detection_callback=cb)
    await scanner.start()
    while time.monotonic() - t0 < secs:
        await asyncio.sleep(1.0)
        el = time.monotonic() - t0
        if int(el) % 30 == 0 and not any(abs(h - el) < 0.6 for h in hits):
            pass
    await scanner.stop()

    total = time.monotonic() - t0
    print("\n===== 时间线汇总（%.0fs）=====" % total)
    if not hits:
        print("  ❌ 一次都没收到 —— 设备全程被某个中心端连着（停止广播）")
    else:
        print("  命中 %d 次，平均间隔 %.1fs" % (len(hits), total / len(hits)))
        gaps = [hits[i + 1] - hits[i] for i in range(len(hits) - 1)]
        if gaps:
            big = [g for g in gaps if g > 15]
            print("  最大间隔 %.1fs，>15s 的长间隔 %d 处 %s"
                  % (max(gaps), len(big), ["%.0fs" % g for g in big[:8]]))


if __name__ == "__main__":
    asyncio.run(main())
