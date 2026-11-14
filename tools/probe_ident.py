"""只读实验：充电头有没有把「识别到的接入设备」通过蓝牙暴露出来？

背景
----
AD1204U 屏幕上能显示接入设备相关的信息，用户希望 App 里也显示「品牌」。
已知事实：siid=2 的属性表是固定的（piid 1..0x15），0x16..0x40 曾经「整批」超时
没答 —— 但那次是按 6 个一组发批请求，**一个不存在的 piid 会让整批失败**，
所以 0x16..0x40 里到底有没有真属性，其实还没被单独验证过。

本脚本走三条只读路线：
  A. GATT 层：把所有可读特征的原值 dump 出来（FE95 的 0x0004/0x0005 值得看，
     0x0004 在小米 BLE 协议里常被当作「能力/规格」读取位）。
  B. 广播层：FE95 service data 的原始字节（插着设备时会不会变）。
  C. 协议层：逐个单独探 siid=2 的 0x16..0x40，以及其它 siid（3..8）。

全程只读：只发 get_properties，不写任何特征值 / 不写任何属性。
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(ROOT / "vendor"))

try:
    sys.stdout.reconfigure(encoding="utf-8", newline="\n")
except Exception:  # noqa: BLE001
    pass

from bleak import BleakClient, BleakScanner  # noqa: E402

from ad1204u_read_props import encode_get_properties, parse_response  # noqa: E402
from cuktech_ble.xiaomi import MiAuthClient  # noqa: E402
from cuktech_ble.xiaomi.session import MiSession  # noqa: E402

ADDR = "AA:BB:CC:DD:EE:FF"
TOKEN_FILE = ROOT / "data" / "cuktech.token"
OUT = Path(os.environ.get("TEMP", ".")) / "cuk_probe_ident.txt"

lines: list[str] = []


def w(msg: str = "") -> None:
    lines.append(str(msg))
    print(msg, flush=True)


def save() -> None:
    OUT.write_text("\n".join(lines), encoding="utf-8")
    print(f"written {OUT}")


# ---------------------------------------------------------------- A. GATT 层
async def dump_gatt(client: BleakClient) -> None:
    w("== A. GATT 可读特征原值 ==")
    for svc in client.services:
        w(f"  service {svc.uuid}  ({svc.description})")
        for ch in svc.characteristics:
            props = ",".join(ch.properties)
            if "read" not in ch.properties:
                w(f"    char {ch.uuid}  [{props}]  (not readable)")
                continue
            try:
                v = await client.read_gatt_char(ch)
                w(f"    char {ch.uuid}  [{props}]  -> {bytes(v).hex()}")
            except Exception as exc:  # noqa: BLE001
                w(f"    char {ch.uuid}  [{props}]  -> ERR {type(exc).__name__}: {exc}")


# ------------------------------------------------------------- B. 广播原始字节
async def dump_adv(timeout: float = 12.0) -> dict | None:
    w("== B. 广播 / FE95 service data ==")
    want = ADDR.upper()
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        found = await BleakScanner.discover(
            timeout=min(6.0, max(2.0, deadline - time.monotonic())), return_adv=True
        )
        for dev, adv in found.values():
            if dev.address.upper() != want:
                continue
            w(f"  address   = {dev.address}")
            w(f"  name      = {dev.name}")
            w(f"  rssi      = {adv.rssi}")
            sd = getattr(adv, "service_data", {}) or {}
            for uuid, data in sd.items():
                w(f"  svc_data {uuid} = {bytes(data).hex()}")
            mfg = getattr(adv, "manufacturer_data", {}) or {}
            for cid, data in mfg.items():
                w(f"  mfg {cid:#06x} = {bytes(data).hex()}")
            if not sd and not mfg:
                w("  (no service_data / manufacturer_data)")
            w(f"  local_name= {adv.local_name}")
            return dev
    w("  (device not seen advertising)")
    return None


# ------------------------------------------------------ C. 协议层：siid/piid 探测
async def probe_piid(session: MiSession, siid: int, piid: int, timeout: float) -> str:
    seq = session.next_sequence()
    req = encode_get_properties(seq, [(siid, piid)])
    try:
        pt = await asyncio.wait_for(session.send_request(req), timeout=timeout)
    except Exception as exc:  # noqa: BLE001
        return f"NO ANSWER ({type(exc).__name__})"
    try:
        _seq, ok, items = parse_response(pt)
    except Exception as exc:  # noqa: BLE001
        return f"UNDECODABLE {pt.hex()} ({type(exc).__name__})"
    if not items:
        return f"EMPTY RESPONSE ok={ok:#04x} {pt.hex()}"
    it = items[0]
    return f"OK status={it['status']:#06x} {it['type']}={it['value']} raw={it['raw']}"


async def probe_siids(session: MiSession) -> None:
    w("== C1. siid=2 的 0x16..0x40 逐个单独探（上次是整批超时，无法区分）==")
    hits = 0
    for piid in range(0x16, 0x41):
        res = await probe_piid(session, 2, piid, 1.0)
        if res.startswith(("OK", "UNDECODABLE", "EMPTY")):
            hits += 1
            w(f"  siid=2 piid={piid:#04x} -> {res}")
        await asyncio.sleep(0.05)
    w(f"  siid=2 0x16..0x40 命中 {hits} 个（0 = 这些位置确实不存在）")

    w("== C2. 其它 siid（3..8）有没有「设备信息」服务 ==")
    for siid in range(3, 9):
        res = await probe_piid(session, siid, 1, 1.5)
        w(f"  siid={siid} piid=1 -> {res}")
        if res.startswith(("OK", "UNDECODABLE", "EMPTY")):
            for piid in (2, 3, 4):
                r2 = await probe_piid(session, siid, piid, 1.2)
                w(f"  siid={siid} piid={piid} -> {r2}")
        await asyncio.sleep(0.05)


# --------------------------------------------------------------------- main
async def main() -> None:
    token = bytes.fromhex(json.loads(TOKEN_FILE.read_text(encoding="utf-8"))["token_hex"])

    dev = await dump_adv()
    if dev is None:
        w("!! 设备没在广播，退出")
        return

    async with BleakClient(dev, timeout=40) as client:
        w(f"connected = {client.is_connected}")
        await dump_gatt(client)

        keys = None
        last_exc: Exception | None = None
        for attempt in range(4):
            auth = MiAuthClient(client, timeout=15, bluez_start_notify=False)
            try:
                await auth.subscribe(upnp=False)
                await auth.greet()
                await auth.subscribe_upnp()
                keys = await auth.login(token)
                break
            except Exception as exc:  # noqa: BLE001
                last_exc = exc
                w(f"login attempt {attempt + 1} failed: {type(exc).__name__}: {exc}")
                try:
                    await auth.unsubscribe()
                except Exception:  # noqa: BLE001
                    pass
                await asyncio.sleep(1.5)
        if keys is None:
            w(f"!! login 失败：{last_exc}")
            return
        w("login OK")

        session = MiSession(auth, keys, timeout=6.0)
        await session.subscribe()

        # 先读一次四个口，确认设备此刻有没有插东西（对照组）
        seq = session.next_sequence()
        pt = await asyncio.wait_for(
            session.send_request(encode_get_properties(seq, [(2, 1), (2, 2), (2, 3), (2, 4)])),
            timeout=8.0,
        )
        _s, ok, items = parse_response(pt)
        w("== 对照组：四个口此刻的原始字 ==")
        for it in items:
            w(f"  piid={it['piid']} raw_le={it['raw']} u32={it['value']:#010x}")

        await probe_siids(session)

        await session.unsubscribe()
        try:
            await auth.unsubscribe()
        except Exception:  # noqa: BLE001
            pass


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception as exc:  # noqa: BLE001
        w(f"fatal: {type(exc).__name__}: {exc}")
    finally:
        save()
    sys.exit(0)
