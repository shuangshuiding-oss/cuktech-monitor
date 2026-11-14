"""连上一台 BLE 设备，把它的 GATT 结构和服务/特征值原样打印出来，并试读。

只读不写：任何 write/notify 之外的属性都不碰，不会改设备设置。

用法：
    .venv\\Scripts\\python.exe tools\\bledev.py --address A4:C1:38:3C:25:A2
    .venv\\Scripts\\python.exe tools\\bledev.py --address XX --listen 15
"""

import argparse
import asyncio
import sys
from pathlib import Path

# 已知的服务/特征 UUID，命中就打上人类能懂的名字
KNOWN = {
    "0000180a-0000-1000-8000-00805f9b34fb": "Device Information",
    "00002a24-0000-1000-8000-00805f9b34fb": "  型号字符串",
    "00002a26-0000-1000-8000-00805f9b34fb": "  ★固件版本",
    "00002a25-0000-1000-8000-00805f9b34fb": "  序列号",
    "00002a27-0000-1000-8000-00805f9b34fb": "  硬件版本",
    "00002a19-0000-1000-8000-00805f9b34fb": "  ★电量%",
    "0000180f-0000-1000-8000-00805f9b34fb": "Battery Service",
    "0000fe95-0000-1000-8000-00805f9b34fb": "Xiaomi (MiBeacon)",
    "ebe0ccb0-7a0a-4b0c-8a1a-6ff2997da3a6": "★LYWSD03 自定义服务",
    "ebe0ccc1-7a0a-4b0c-8a1a-6ff2997da3a6": "  ★温度/湿度/电量 (notify)",
    "ebe0ccc2-7a0a-4b0c-8a1a-6ff2997da3a6": "  单位设置",
    "ebe0ccc3-7a0a-4b0c-8a1a-6ff2997da3a6": "  时间/历史",
    "ebe0ccb7-7a0a-4b0c-8a1a-6ff2997da3a6": "  连接间隔",
}


def label(uuid):
    return KNOWN.get(uuid.lower(), "")


async def run(address, listen, out):
    from bleak import BleakClient

    lines = []

    def say(s=""):
        lines.append(s)
        print(s)

    notes = []

    def on_notify(char, data: bytearray):
        notes.append((str(char.uuid), bytes(data).hex()))
        say(f"    [通知] {char.uuid}: {bytes(data).hex()}")

    async with BleakClient(address, timeout=30.0) as client:
        say(f"已连接 {address}  mtu={getattr(client, 'mtu_size', '?')}")
        say("=" * 78)
        for svc in client.services:
            say(f"SVC {svc.uuid}  {label(svc.uuid)}")
            for ch in svc.characteristics:
                props = ",".join(ch.properties)
                say(f"  CH  {ch.uuid}  [{props}]  {label(ch.uuid)}")

        say("-" * 78)
        say("逐特征尝试读取（只读）：")
        for svc in client.services:
            for ch in svc.characteristics:
                if "read" not in ch.properties:
                    continue
                try:
                    raw = await client.read_gatt_char(ch)
                    txt = ""
                    try:
                        s = bytes(raw).decode("utf-8")
                        if all(32 <= ord(c) < 127 for c in s):
                            txt = f'  ascii="{s}"'
                    except Exception:
                        pass
                    say(f"  READ {ch.uuid} {label(ch.uuid)}: {bytes(raw).hex()}{txt}")
                except Exception as e:
                    say(f"  READ {ch.uuid} {label(ch.uuid)}: 失败 ({type(e).__name__}: {e})")

        subs = [ch for svc in client.services for ch in svc.characteristics if "notify" in ch.properties]
        if subs and listen > 0:
            say("-" * 78)
            say(f"订阅 {len(subs)} 个可通知特征，听 {listen}s：")
            for ch in subs:
                try:
                    await client.start_notify(ch, on_notify)
                except Exception as e:
                    say(f"  订阅 {ch.uuid} 失败 ({type(e).__name__}: {e})")
            await asyncio.sleep(listen)
            for ch in subs:
                try:
                    await client.stop_notify(ch)
                except Exception:
                    pass
            if not notes:
                say("  没收到任何通知（原厂固件常见：需要米家 bindkey 才推数据）")

    text = "\n".join(lines)
    if out:
        p = Path(out)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text + "\n", encoding="utf-8")
        print(f"\n[已写入 {p}]")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--address", required=True)
    ap.add_argument("--listen", type=float, default=14.0)
    ap.add_argument("--out", default=None)
    args = ap.parse_args()
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    asyncio.run(run(args.address, args.listen, args.out))


if __name__ == "__main__":
    main()
