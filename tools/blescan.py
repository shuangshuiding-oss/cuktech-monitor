"""扫描附近所有 BLE 广播，原样打印广播内容。

用途有两个：
  1. 回答"我家里是不是已经有一台能读温度的蓝牙设备了"，省一笔钱。
  2. 新买的温度计到手后，先把它的原始广播字节抓下来，再照着写解析器。

用法（必须用工程自带的 venv，bleak 装在那里）：
    .venv\\Scripts\\python.exe tools\\blescan.py --seconds 15
    .venv\\Scripts\\python.exe tools\\blescan.py --seconds 20 --out tools\\dev\\blescan.txt
"""

import argparse
import asyncio
import json
import sys
from pathlib import Path

# 自己充电头的 MAC：只用来"扫到它不算发现新设备"。**换成你自己的**（或删掉这一行）。
CHARGER_MAC = "AA:BB:CC:DD:EE:FF"

# 广播里出现的 service UUID / company id 里，跟"环境传感器"有关的那些。
# 带 ? 的是社区里常见但没在官方文档核过的，只当线索用。
SERVICE_HINTS = {
    "fe95": "MiBeacon（小米生态，加密居多）",
    "fcd2": "BTHome（DIY/刷机固件常用，明文）",
    "181a": "Environmental Sensing（明文温度服务）",
    "181c": "User Data",
    "feed": "私有协议?（廉价温湿度计常见）",
    "fff0": "私有协议?",
    "aa01": "私有协议?",
}
COMPANY_HINTS = {
    0x0098: "Xiaomi?",
    0x004C: "Apple",
    0x0006: "Microsoft",
    0x0075: "Samsung",
    0x00E0: "Google",
    0x0059: "Nordic（很多 beacon/模块用）",
}
# 设备名里的关键词
NAME_HINTS = (
    "lywsd", "mjwsd", "cgg", "cgd", "qingping", "atc", "temp", "thermo",
    "hygro", "ibs", "inkbird", "sensor", "bthome", "ruuvi", "th-", "th_",
)


def hexdict(d):
    return {str(k).lower(): v.hex() for k, v in (d or {}).items()}


def looks_like_env_sensor(row):
    why = []
    for u in row["service_uuids"]:
        short = u.split("-")[0].lower()
        if short in SERVICE_HINTS:
            why.append(f"service {short} = {SERVICE_HINTS[short]}")
    for k in list(row["service_data"]) + list(row["manufacturer_data"]):
        short = k.split("-")[0].lower()
        if short in SERVICE_HINTS:
            why.append(f"data {short} = {SERVICE_HINTS[short]}")
    for cid in row["manufacturer_data"]:
        try:
            v = int(cid, 16)
        except ValueError:
            continue
        if v in COMPANY_HINTS:
            why.append(f"company 0x{v:04x} = {COMPANY_HINTS[v]}")
    name = (row["name"] or "").lower()
    for w in NAME_HINTS:
        if w in name:
            why.append(f"名字含 '{w}'")
            break
    return why


async def scan(seconds):
    from bleak import BleakScanner

    found = await BleakScanner.discover(timeout=seconds, return_adv=True)
    rows = []
    for dev, adv in found.values():
        rows.append({
            "address": dev.address.upper(),
            "rssi": getattr(adv, "rssi", None),
            "name": dev.name or getattr(adv, "local_name", None),
            "tx_power": getattr(adv, "tx_power", None),
            "service_uuids": sorted(adv.service_uuids or []),
            "manufacturer_data": hexdict(adv.manufacturer_data),
            "service_data": hexdict(adv.service_data),
        })
    rows.sort(key=lambda r: (r["rssi"] is None, -(r["rssi"] if r["rssi"] is not None else -999)))
    return rows


def report(rows, seconds):
    out = []
    out.append(f"BLE 扫描 {seconds}s：发现 {len(rows)} 个广播源")
    out.append("=" * 78)
    cands = []
    for r in rows:
        tag = ""
        if r["address"] == CHARGER_MAC:
            tag = "  <- 本项目的充电头"
        why = looks_like_env_sensor(r) if r["address"] != CHARGER_MAC else []
        if why:
            cands.append((r, why))
            tag = "  ★ 疑似温度/环境传感器"
        name = r["name"] or "(无名)"
        out.append(f"{r['address']}  RSSI {r['rssi']:>4}  {name}{tag}")
        if r["service_uuids"]:
            out.append(f"    services  : {', '.join(r['service_uuids'])}")
        for cid, val in r["manufacturer_data"].items():
            hint = COMPANY_HINTS.get(int(cid, 16), "") if cid.startswith("0x") or len(cid) <= 4 else ""
            out.append(f"    manuf 0x{cid}: {val}  {hint}".rstrip())
        for uuid, val in r["service_data"].items():
            out.append(f"    svcdata {uuid}: {val}")
        for w in why:
            out.append(f"    └ 命中：{w}")
    out.append("=" * 78)
    if cands:
        out.append(f"可疑候选 {len(cands)} 个：")
        for r, why in cands:
            out.append(f"  - {r['address']}  {r['name'] or '(无名)'}  RSSI {r['rssi']}  ← {'; '.join(why)}")
    else:
        out.append("没有发现任何像温度/环境传感器的广播（说明家里没有现成的可白嫖设备）。")
    return "\n".join(out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seconds", type=float, default=15.0)
    ap.add_argument("--out", default=None, help="把报告写到这个文件（同时也会打印）")
    ap.add_argument("--json", default=None, help="把原始数据写成 JSON")
    args = ap.parse_args()

    rows = asyncio.run(scan(args.seconds))
    text = report(rows, args.seconds)
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    print(text)
    if args.out:
        p = Path(args.out)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text + "\n", encoding="utf-8")
        print(f"\n[已写入 {p}]")
    if args.json:
        p = Path(args.json)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"[原始数据写入 {p}]")


if __name__ == "__main__":
    main()
