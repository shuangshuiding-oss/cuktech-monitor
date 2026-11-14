# -*- coding: utf-8 -*-
"""枚举 LYWSD03MMC 的所有 GATT service/characteristic，确认历史相关特征是否暴露。

用法: .venv/Scripts/python.exe tools/dev/enum_gatt.py <MAC>
"""
import asyncio
import sys

from bleak import BleakClient, BleakScanner

# 历史相关特征（TermCIC / afer92 / pvvx 口径）
HIST_RELATED = {
    "ebe0ccbc": "历史数据（READ+NOTIFY，Last idx 152）",
    "ebe0ccb7": "设备时间 Unix（READ+WRITE）",
    "ebe0ccbb": "设备时间（旧代码用的）",
    "ebe0ccb9": "记录数（READ）",
    "ebe0ccba": "记录索引（READ+WRITE）",
    "ebe0ccbe": "单位 F/C（READ+WRITE）",
    "ebe0ccc1": "实时温湿度电压（READ+NOTIFY）",
    "ebe0ccc4": "电量（READ）",
}


async def main(address):
    print("扫描 %s ..." % address)
    devices = await BleakScanner.discover(timeout=12)
    found = None
    for d in devices:
        if d.address.lower() == address.lower():
            found = d
            break
    print("发现设备:", found.name if found else "(未在扫描列表，尝试直接连接)")

    async with BleakClient(address, timeout=20) as client:
        print("已连接:", client.is_connected)
        for svc in client.services:
            print("\n[Service] %s" % svc.uuid)
            for ch in svc.characteristics:
                tail = ch.uuid[-8:].lower()
                props = ",".join(ch.properties)
                tag = ""
                if tail in HIST_RELATED:
                    tag = "  <<< " + HIST_RELATED[tail]
                print("  %s  [%s]%s" % (ch.uuid, props, tag))


if __name__ == "__main__":
    mac = sys.argv[1] if len(sys.argv) > 1 else "A4:C1:38:3C:25:A2"
    asyncio.run(main(mac))
