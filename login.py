"""Xiaomi-cloud QR login for the CUKTECH AD1204U **and** the Mijia fan.

    login.py qr    [--address MAC]                  -> data/qr.png + data/qr-state.json
    login.py poll  [--address MAC] [--wait 280]     -> data/cuktech.token + data/fan.token

Both subcommands print ONE json object on stdout so server.js can parse the
result without screen-scraping.  Everything else goes to stderr.

Only the QR path is implemented: no password, no 2FA.  Two very different keys
come out of the same scan, because they both live in the same cloud device list:

    charger  CUKTECH AD1204U   BLE   -> 12-byte bind key   data/cuktech.token
    fan      dmaker.fan.*      Wi-Fi -> 16-byte miIO token  data/fan.token
                                       (+ its LAN IP, which the cloud also has)

⚠️ 2026-10-11：原来是"只找充电头"，现在同一个会话里顺手把风扇也认出来 ——
   风扇走 miIO，必须有「IP + token」两样才能发一条命令，而这两样都只在云端设备列表里。
   一次扫码同时取两把钥匙，用户不用登两次。
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE / "vendor"))
sys.path.insert(0, str(HERE))          # netfix.py 就放在本项目根目录

import netfix  # noqa: E402  （TLS 口径 + 证书错误翻译，见 netfix.py）

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", newline="\n")
    except Exception:  # noqa: BLE001
        pass

DATA = HERE / "data"
STATE_FILE = DATA / "qr-state.json"
TOKEN_FILE = DATA / "cuktech.token"
FAN_TOKEN_FILE = DATA / "fan.token"
QR_PNG = DATA / "qr.png"

REGIONS = ["cn", "sg", "i2", "de", "us", "tw", "ru", "in"]

# Errors that mean "stop", everything else is retried until the deadline.
# HTTP 403 shows up once Xiaomi has invalidated the ticket; retrying it just
# produces hundreds of identical log lines.
TERMINAL = ("code=", "missing location", "serviceToken", "redirect failed",
            "HTTP 400", "HTTP 403", "HTTP 404")

# 便携包要发给别人的时候，对方不可能先知道充电头的 MAC，所以支持「auto」：
# 直接在账号设备列表里凭型号/名字认出 AD1204U。
AD1204_HINTS = ("njcuk.fitting.ad1204", "njcuk.fitting.1204e")

# 认风扇用的模型前缀（dmaker.fan.p5 / dmaker.fan.1m 都是米家落地扇那一族；
# zhimi.fan.* 是更早的几代，属性表略有差异但主体一致）。
FAN_HINTS = ("dmaker.fan", "zhimi.fan", "dmaker-fan", "zhimi-fan")


def _valid_token(raw: str) -> str | None:
    """设备列表里的 token 字段可能是 12 或 16 字节；BLE 只用前 12 字节。"""
    t = (raw or "").strip().lower()
    if len(t) not in (24, 32):
        return None
    try:
        bytes.fromhex(t)
    except ValueError:
        return None
    return t[:24]


def _miio_token(raw: str) -> str | None:
    """Wi-Fi（miIO）设备的 token 是 16 字节 = 32 个十六进制字符。

    24 位的是 BLE bindkey（充电头那种），**这里不接受** —— 免得把 12 字节的
    BLE 密钥当成 miIO token 用，那样只会得到"解密失败"这种极难查的报错。
    """
    t = (raw or "").strip().lower()
    if len(t) != 32:
        return None
    try:
        bytes.fromhex(t)
    except ValueError:
        return None
    return t


def _looks_like_ad1204(dev: dict) -> bool:
    model = str(dev.get("model", "")).lower()
    name = str(dev.get("name", "")).lower()
    if any(h in model for h in AD1204_HINTS):
        return True
    return "ad1204" in model or "ad1204" in name


def _is_fan(dev: dict) -> bool:
    model = str(dev.get("model", "")).lower()
    name = str(dev.get("name", "")).lower()
    return any(h in model for h in FAN_HINTS) or "风扇" in name or "fan" in name


def out(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def note(msg: str) -> None:
    sys.stderr.write(msg + "\n")
    sys.stderr.flush()


def _err_text(exc: BaseException) -> str:
    """证书类错误换成人话 —— server.js 会把这段原样显示在登录弹层里。"""
    raw = str(exc)
    if netfix.is_cert_error(exc):
        return netfix.friendly_error(exc) + "（原始错误：" + raw + "）"
    return raw


async def cmd_qr(args) -> int:
    import aiohttp
    from cuktech_ble.xiaomi_cloud import _fresh_user_agent, start_qr_login

    DATA.mkdir(parents=True, exist_ok=True)
    note(netfix.describe())
    # 会话用统一的 TLS 口径建（netfix）——Python 3.13 的严格模式会误杀小米证书链，
    # 详见 netfix.py 顶部说明。
    async with aiohttp.ClientSession(**netfix.connector_kwargs()) as session:
        qr = await start_qr_login(session)
        png_ok = False
        try:
            async with session.get(
                qr.qr_image_url,
                headers={"User-Agent": _fresh_user_agent()},
                cookies=qr.cookies,
                timeout=aiohttp.ClientTimeout(total=30),
            ) as r:
                blob = await r.read()
                if r.status == 200 and len(blob) > 200:
                    QR_PNG.write_bytes(blob)
                    png_ok = True
                else:
                    note("qr png fetch: HTTP %s, %d bytes" % (r.status, len(blob)))
        except Exception as exc:  # noqa: BLE001
            note("qr png fetch failed: %s: %s" % (type(exc).__name__, exc))

    STATE_FILE.write_text(json.dumps({
        "qr_image_url": qr.qr_image_url,
        "login_url": qr.login_url,
        "lp_url": qr.lp_url,
        "timeout_seconds": qr.timeout_seconds,
        "device_id": qr.device_id,
        "cookies": qr.cookies,
        "created_at": time.time(),
    }, indent=2), encoding="utf-8")

    out({"ok": True, "png": str(QR_PNG) if png_ok else None,
         "timeout": qr.timeout_seconds, "stateFile": str(STATE_FILE)})
    return 0


async def _wait_for_scan(session, qr, max_wait: float, verbose: bool):
    from cuktech_ble.xiaomi_cloud import CloudError, QRLoginPending, poll_qr_login

    deadline = time.monotonic() + max_wait
    rounds = 0
    while True:
        rounds += 1
        try:
            return await poll_qr_login(session, qr)
        except QRLoginPending:
            if time.monotonic() >= deadline:
                raise CloudError("二维码登录超时（%ss）" % int(max_wait)) from None
            if verbose:
                note("  round %d: 尚未扫码，剩余 %ds"
                     % (rounds, int(deadline - time.monotonic())))
            await asyncio.sleep(1.0)
        except CloudError as exc:
            msg = str(exc)
            # ⚠️ 证书类错误要**立刻**终止，不能当"网络抖一下"重试：重试 280 秒也不会好，
            #    最后还会把报错变成误导人的"二维码登录超时"（曾经就是这样）。
            if netfix.is_cert_error(exc) or any(m in msg for m in TERMINAL):
                raise
            if time.monotonic() >= deadline:
                raise CloudError("二维码登录超时（%ss，最后错误：%s）" % (int(max_wait), msg)) from exc
            note("  transient: %s" % msg)
            await asyncio.sleep(2.0)


def _probe_lan(did: str) -> list[dict]:
    """云端没给 IP（或给了错的）时，扫一遍局域网，按设备 ID 把 IP 找回来。

    Xiaomi 的 did 就是 miIO 的设备 ID（十进制字符串），两边能对上。
    注意：广播**只能拿到"谁在线"**，拿不到 token —— 所以这一步只是补 IP 的退路。
    """
    try:
        from miio_lan import discover
        found = discover(timeout=5.0)
    except Exception as exc:  # noqa: BLE001
        note("局域网发现失败：%s" % exc)
        return []
    note("局域网发现到 %d 台 miIO 设备" % len(found))
    want = None
    try:
        want = int(did)
    except (TypeError, ValueError):
        pass
    rows = []
    for f in found:
        f = dict(f)
        f["match"] = (want is not None and f.get("device_id") == want)
        rows.append(f)
    return rows


def _dev_row(dev: dict) -> dict:
    """给界面/日志看的设备摘要（**不含 token**，别把密钥写进日志）。"""
    raw_tok = str(dev.get("token", "")).strip()
    return {
        "did": str(dev.get("did", "")),
        "name": dev.get("name"),
        "model": dev.get("model"),
        "mac": dev.get("mac"),
        "ip": dev.get("localip") or "",
        "online": bool(dev.get("isOnline")),
        "tokenLen": len(raw_tok),
        "hasMiioToken": _miio_token(raw_tok) is not None,
        "isFan": _is_fan(dev),
        "isCharger": _looks_like_ad1204(dev),
    }


async def cmd_poll(args) -> int:
    import aiohttp
    from cuktech_ble.xiaomi_cloud import (
        QRLogin, CloudError, find_token_by_mac, list_devices,
    )

    if not STATE_FILE.exists():
        out({"ok": False, "error": "还没有生成二维码，请先执行 qr"})
        return 2
    st = json.loads(STATE_FILE.read_text(encoding="utf-8"))
    age = int(time.time() - float(st.get("created_at", time.time())))
    note("ticket age %ss" % age)

    qr = QRLogin(
        qr_image_url=st["qr_image_url"],
        login_url=st["login_url"],
        lp_url=st["lp_url"],
        timeout_seconds=st["timeout_seconds"],
        device_id=st["device_id"],
        cookies=st["cookies"],
    )

    note(netfix.describe())
    devices: list[dict] = []
    region_hit = ""
    async with aiohttp.ClientSession(**netfix.connector_kwargs()) as session:
        try:
            auth = await _wait_for_scan(session, qr, float(args.wait), args.verbose)
        except CloudError as exc:
            out({"ok": False, "error": _err_text(exc)})
            return 1
        note("login OK user_id=%s" % auth.user_id)

        # ---- 找设备 -------------------------------------------------------
        # 一个账号只属于一个区，所以**第一个返回非空设备列表的区就是它**：
        # 认到充电头或风扇就停，不必把 8 个区全问一遍（换区每多问一次就多一次
        # 几十秒级的等待，对用户来说是白等）。
        # ⚠️ hit 的判据里有充电头也有风扇 —— 只有风扇、没有充电头的账号也该能登成功。
        want = str(args.address or "").strip()
        auto = (not want) or want.lower() == "auto"
        regions = [r.strip() for r in args.regions.split(",")] if args.regions else REGIONS
        for region in regions:
            try:
                got = await list_devices(session, auth, region)
            except Exception as exc:  # noqa: BLE001
                note("  [%s] list failed: %s" % (region, exc))
                continue
            note("  [%s] %d device(s)" % (region, len(got)))
            if not got:
                continue
            devices = got
            region_hit = region
            break

    if not devices:
        out({"ok": False,
             "error": "在账号里没有读到任何设备。请确认手机上的米家 App 已添加这台充电头 / 电风扇，"
                      "并且设备通电在线；如果是别人分享给你的，需要先在米家里接受共享。"})
        return 1

    # ---- 充电头（BLE，12 字节 bind key）---------------------------------
    charger = None
    charger_candidates = []
    for dev in devices:
        if not _looks_like_ad1204(dev):
            continue
        mac = str(dev.get("mac", "")).strip()
        token = _valid_token(str(dev.get("token", "")))
        note("  charger candidate: %s %s mac=%s token_ok=%s"
             % (dev.get("name"), dev.get("model"), mac, bool(token)))
        if not token:
            continue
        charger_candidates.append({"name": dev.get("name"), "model": dev.get("model"), "mac": mac})
        if charger is None:
            charger = (mac, token)
    if not auto:
        # 指定了 MAC：按老口径只认那台（find_token_by_mac 的报错文案保持原样）
        try:
            token = find_token_by_mac(devices, want)
        except CloudError as exc:
            note("token problem: %s" % exc)
            token = None
        if token:
            charger = (want, token)

    if charger:
        mac, token = charger
        TOKEN_FILE.write_text(json.dumps({
            "address": mac, "token_hex": token, "region": region_hit,
        }), encoding="utf-8")

    # ---- 风扇（Wi-Fi / miIO，16 字节 token + 局域网 IP）------------------
    fan_pick = None
    fan_rows = [_dev_row(d) for d in devices if _is_fan(d)]
    want_did = str(args.fan_did or "").strip()
    want_model = str(args.fan_model or "").strip().lower()
    for dev in devices:
        if want_did and str(dev.get("did", "")) != want_did:
            continue
        if want_model and want_model not in str(dev.get("model", "")).lower():
            continue
        if not (want_did or want_model) and not _is_fan(dev):
            continue
        if not _miio_token(str(dev.get("token", ""))):
            continue
        fan_pick = dev
        break

    fan_out = None
    fan_err = ''
    if not fan_rows:
        fan_err = ("账号里没有找到电风扇（认模型 dmaker.fan.* / zhimi.fan.*）。"
                   "型号不在这个前缀里的话，用 --fan-did 指定。")
    elif fan_pick is None:
        fan_err = ("认出了风扇，但它没有 16 字节的 miIO token（可能这台是蓝牙款，"
                   "或者云端没下发 token）。")
    else:
        token = _miio_token(str(fan_pick.get("token", "")))
        ip = str(fan_pick.get("localip") or "").strip()
        ip_from_lan = False
        if not ip:
            note("云端没有该设备的局域网 IP，改用局域网扫描")
            for r in _probe_lan(str(fan_pick.get("did", ""))):
                if r.get("match"):
                    ip = r["ip"]
                    ip_from_lan = True
                    note("按 did 配到 IP = %s" % ip)
                    break
        FAN_TOKEN_FILE.write_text(json.dumps({
            "ip": ip,
            "token": token,
            "model": fan_pick.get("model"),
            "name": fan_pick.get("name"),
            "mac": fan_pick.get("mac"),
            "did": str(fan_pick.get("did", "")),
            "region": region_hit,
            "online": bool(fan_pick.get("isOnline")),
            "ip_from_lan": ip_from_lan,
            "saved_at": time.time(),
        }, ensure_ascii=False, indent=2), encoding="utf-8")
        fan_out = {
            "name": fan_pick.get("name"), "model": fan_pick.get("model"),
            "ip": ip, "mac": fan_pick.get("mac"), "did": str(fan_pick.get("did", "")),
            "online": bool(fan_pick.get("isOnline")), "ipFromLanScan": ip_from_lan,
        }
        note("fan saved: %s" % json.dumps(fan_out, ensure_ascii=False))

    # ---- 结论 -----------------------------------------------------------
    if not charger and not fan_out:
        out({"ok": False, "region": region_hit, "devices": [_dev_row(d) for d in devices],
             "fanRows": fan_rows, "fanError": fan_err,
             "error": "账号里没有找到酷态科 AD1204U —— 请确认已用米家 App 添加这台充电头、"
                      "并且它插着电在线；如果设备是别人分享给你的，需要先在米家里接受共享"})
        return 1

    res = {
        "ok": True,
        "region": region_hit,
        "devices": len(devices),
        "candidates": charger_candidates,
        "tokenFile": str(TOKEN_FILE),
        "charger": ({"mac": charger[0], "tokenLen": len(charger[1])} if charger else None),
        "fan": fan_out,
        "fanRows": fan_rows,
        "fanError": fan_err if fan_out is None else "",
    }
    # 老字段保持原样（server.js / 文档都按这几个名字读）
    if charger:
        res["mac"] = charger[0]
        res["tokenLen"] = len(charger[1])
    out(res)
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("qr")
    p.set_defaults(fn=cmd_qr)

    p = sub.add_parser("poll")
    p.add_argument("--address", default="",
                   help="设备 MAC；留空或 auto 则在账号设备列表里自动认出 AD1204U")
    p.add_argument("--wait", type=int, default=280)
    p.add_argument("--regions", default="")
    p.add_argument("--fan-did", default="", help="账号里有多台电风扇时指定 did")
    p.add_argument("--fan-model", default="", help="按模型前缀挑风扇（如 dmaker.fan.）")
    p.add_argument("--verbose", action="store_true")
    p.set_defaults(fn=cmd_poll)

    args = ap.parse_args()
    try:
        return asyncio.run(args.fn(args))
    except Exception as exc:  # noqa: BLE001
        note("FATAL: %s: %s" % (type(exc).__name__, exc))
        if netfix.is_cert_error(exc):
            note("提示：" + netfix.friendly_error(exc))
            out({"ok": False, "error": _err_text(exc), "certError": True})
            return 1
        out({"ok": False, "error": "%s: %s" % (type(exc).__name__, exc)})
        return 1


if __name__ == "__main__":
    sys.exit(main())
