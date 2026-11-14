# -*- coding: utf-8 -*-
"""把 LYWSD03MMC 的原始广播字节整个 dump 出来，逐 AD 段解析（只读）。

bleak 的 AdvertisementData 在这一版上把 service_data 解析成空 {}（实测），
所以直接拿 platform_data 里的原始字节自己走 AD 结构：
  [len][type][payload...]
  0x01 Flags / 0x02,0x03 16-bit UUID / 0x06,0x07 128-bit UUID
  0x08,0x09 Shortened/Complete Local Name / 0x0A TX Power
  0x16 Service Data-16 / 0x21 Service Data-128 / 0xFF Manufacturer Specific

用法: .venv\Scripts\python.exe tools\dev\adv_dump.py [MAC] [秒数]
"""
import asyncio
import sys
import time

from bleak import BleakScanner

if sys.platform.startswith("win"):
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())

AD_TYPE = {
    0x01: "Flags", 0x02: "16-bit UUID 不全", 0x03: "16-bit UUID 全",
    0x04: "32-bit UUID 不全", 0x05: "32-bit UUID 全",
    0x06: "128-bit UUID 不全", 0x07: "128-bit UUID 全",
    0x08: "Shortened Local Name", 0x09: "Complete Local Name",
    0x0A: "TX Power", 0x0D: "Class of Device", 0x0E: "Simple Pairing Hash",
    0x0F: "Simple Pairing Randomizer", 0x10: "TK Value",
    0x11: "Security OOB Flags", 0x12: "Slave Connection Interval",
    0x14: "Solicitation 16-bit UUID", 0x15: "Solicitation 128-bit UUID",
    0x16: "Service Data - 16-bit UUID", 0x1B: "Solicitation 32-bit UUID",
    0x20: "Service Data - 32-bit UUID", 0x21: "Service Data - 128-bit UUID",
    0x22: "LE Secure Connections Confirm", 0x23: "LE Secure Connections Random",
    0x24: "URI", 0x27: "LE Supported Features", 0x29: "Encrypted Adv Data",
    0x2A: "Encrypted Adv Data (0x2A)", 0x3D: "3D Info",
    0xFF: "Manufacturer Specific",
}

SVC_EBE0 = "ebe0ccb0-7a0a-4b0c-8a1a-6ff2997da3a6"


def uuid128_le(b):
    return ("%s-%s-%s-%s-%s" % (b[0:4][::-1].hex(), b[4:6][::-1].hex(),
                                b[6:8][::-1].hex(), b[8:10].hex(), b[10:16].hex()))


def parse_ads(raw, label):
    print("  --- %s (%d 字节) ---" % (label, len(raw)))
    print("      hex: %s" % raw.hex())
    i = 0
    while i < len(raw):
        ln = raw[i]
        if ln == 0:
            i += 1
            continue
        if i + 1 + ln > len(raw):
            print("      [%2d] 长度越界 ln=%d 剩余=%d（可能被截断）" % (i, ln, len(raw) - i - 1))
            break
        typ = raw[i + 1]
        payload = raw[i + 2:i + 1 + ln]
        name = AD_TYPE.get(typ, "未知(0x%02x)" % typ)
        extra = ""
        if typ == 0x16 and len(payload) >= 2:
            extra = "  uuid=0x%04x data=%s" % (payload[1] << 8 | payload[0], payload[2:].hex())
        elif typ == 0x21 and len(payload) >= 16:
            extra = "  uuid=%s data=%s" % (uuid128_le(payload[:16]), payload[16:].hex())
        elif typ == 0xFF and len(payload) >= 2:
            extra = "  company=0x%04x data=%s" % (payload[1] << 8 | payload[0], payload[2:].hex())
        elif typ in (0x08, 0x09):
            extra = "  %r" % payload.decode("utf-8", "replace")
        elif typ == 0x07 and len(payload) >= 16:
            extra = "  uuid=%s" % uuid128_le(payload[:16])
        print("      [%2d] type=0x%02x %-28s len=%d%s" % (i, typ, name, ln - 1, extra))
        i += 1 + ln


async def main():
    addr = (sys.argv[1] if len(sys.argv) > 1 else "A4:C1:38:3C:25:A2").upper()
    secs = float(sys.argv[2]) if len(sys.argv) > 2 else 25.0
    print("dump %s 的原始广播，最多 %.0fs（当前 %s）" % (addr, secs, time.strftime("%H:%M:%S")))

    seen = []

    def cb(dev, adv):
        if dev.address.upper() != addr:
            return
        seen.append(dev.address)
        print("\n[%s] 第 %d 次命中 rssi=%s name=%r" % (
            time.strftime("%H:%M:%S"), len(seen), adv.rssi, adv.local_name))
        print("  bleak 解析结果：")
        print("    service_uuids   = %s" % (list(adv.service_uuids) or "(空)"))
        print("    service_data    = %s" % ({str(k): bytes(v).hex()
                                            for k, v in (adv.service_data or {}).items()} or "(空)"))
        print("    manufacturer    = %s" % ({str(k): bytes(v).hex()
                                            for k, v in (adv.manufacturer_data or {}).items()} or "(空)"))
        pd = adv.platform_data
        if pd:
            try:
                sender, raw = pd[0], bytes(pd[1])
                print("  platform_data.sender = %s  (Windows 地址类型)" % sender)
                parse_ads(raw, "设备发来的原始字节")
            except Exception as exc:  # noqa: BLE001
                print("  platform_data 解析失败：%s: %s" % (type(exc).__name__, exc))
                print("  原始值：%s" % (pd,))
        if len(seen) >= 3:
            return

    scanner = BleakScanner(detection_callback=cb)
    await scanner.start()
    waited = 0.0
    while waited < secs and len(seen) < 3:
        await asyncio.sleep(0.5)
        waited += 0.5
    await scanner.stop()

    if not seen:
        print("\n❌ %.0fs 内没扫到 %s" % (secs, addr))
    else:
        print("\n共命中 %d 次" % len(seen))


if __name__ == "__main__":
    asyncio.run(main())
