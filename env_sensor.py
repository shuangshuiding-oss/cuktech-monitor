"""环境温度计采集器：小米 LYWSD03MMC（米家蓝牙温湿度计 2）。

为什么单独一个进程、而不是并进 collector.py：
  充电头（AD1204U）走的是 MiOT over BLE 的长连接 + 会话认证，而温度计是
  「连上去读一个特征值就断开」的轮询设备。两者对蓝牙栈的要求完全不同，
  混在一个进程里会让充电头那条本来就很脆的链路多担风险。
  这块属于「旁路传感器」：挂了就只是温度卡片灰掉，功率采集毫发无伤。

两条读取通道（按代价从低到高，优先用低的）：
  1) 被动广播：刷过 pvvx/ATC 固件的设备会把温度明文放进广播里，不用连接、
     不抢手机 App、最省电。本项目原厂固件下测到过加密的 MiBeacon（58 58 帧头），
     所以默认走 2)，但代码保留 1) 的解析 —— 用户哪天刷了固件就能自动提速。
  2) 主动连接：GATT 直读，**无需 bindkey**（实测固件 2.1.1_0159）。
     service  ebe0ccb0-7a0a-4b0c-8a1a-6ff2997da3a6
     char     ebe0ccc1-7a0a-4b0c-8a1a-6ff2997da3a6  (read + notify)
     明文 5 字节：int16 LE 温度/100 ℃ + byte2 湿度% + 电量档
     ⚠️ 连接型设备与手机米家互斥，所以轮询间隔 ≥60s，且连完立刻断开。

输出：一行一个 JSON（与 collector.py 同一协议），由 server.js 收进 state.env 里。
用法：
    .venv\\Scripts\\python.exe env_sensor.py --address A4:C1:38:3C:25:A2 --interval 90
    .venv\\Scripts\\python.exe env_sensor.py --probe      # 只扫一次广播并打印原始字节
"""

import argparse
import asyncio
import json
import struct
import sys
import time

try:
    # 只为把"异常类名"统一（重试判定按 type(exc).__name__ 匹配 NotFound）。
    # bleak 缺席时也不该让整个模块 import 失败 —— 下面各函数内部才真正用它。
    from bleak.exc import BleakDeviceNotFoundError  # noqa: F401
except Exception:  # noqa: BLE001
    class BleakDeviceNotFoundError(Exception):  # type: ignore[no-redef]
        """bleak 不可用时的占位（本进程只在能 import bleak 的环境里跑）。"""

DEFAULT_ADDRESS = "A4:C1:38:3C:25:A2"

SVC_ENV = "ebe0ccb0-7a0a-4b0c-8a1a-6ff2997da3a6"
CHAR_TEMP = "ebe0ccc1-7a0a-4b0c-8a1a-6ff2997da3a6"   # read + notify：温度/湿度
CHAR_BATT = "ebe0ccb9-7a0a-4b0c-8a1a-6ff2997da3a6"   # read：电量%
CHAR_FW = "00002a26-0000-1000-8000-00805f9b34fb"     # 固件版本

# 设备**内置**历史：每满一小时存一条「该小时的最高/最低温湿度」，断电不丢。
# 特征 ebe0ccbc 是 read + notify，描述符里写着 "Last idx 152"（最新一条的序号）。
# 记录 12 字节，小端： u32 idx | u32 ts | i16 max_temp | u8 max_hum | i16 min_temp | u8 min_hum
#   · max_temp/min_temp 是「百分之一摄氏度」（÷100 得 ℃）
#   · ts 是**相对设备本次上电时刻**的秒偏移，不是 Unix 时间 —— 要靠另一端读到的
#     「设备当前时间」+「本机当前时间」把基准换算出来（见 read_clock_base）。
# ⚠️ 这条链路是原厂固件就有、**不需要刷机也不需要 bindkey** 的（pvvx 的文档也确认
#    未加密即可读）。但一条一条靠 notify 收完 152 条要 ~10 分钟，所以只能做成
#    「用户主动点一次」的动作，绝不能挂在 90s 轮询里。
CHAR_HIST = "ebe0ccbc-7a0a-4b0c-8a1a-6ff2997da3a6"
# ★ 2026-10-05 实测修正：时钟特征用 ebe0ccb7（TermCIC/afer92 口径，4 字节 u32 LE，
#   读出来是设备 RTC 累计秒数）。旧代码用的 ebe0ccbb 是 14 字节复杂结构，不是简单 u32。
CHAR_CLOCK = "ebe0ccb7-7a0a-4b0c-8a1a-6ff2997da3a6"  # read/write：设备时钟(4字节 u32 LE)
HIST_MAX_IDX = 152                                   # 每台设备固定存 152 条 = 152 小时
HIST_REC = 14                                        # 结构体长度：<IIhBhB = 4+4+2+1+2+1

# ATC1441 / pvvx 广播格式（刷机固件）：UUID 0x181a，厂商数据以 0x181a 开头。
ATC_UUID = "0000181a-0000-1000-8000-00805f9b34fb"


def emit(obj) -> None:
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def note(msg: str) -> None:
    sys.stderr.write(str(msg) + "\n")
    sys.stderr.flush()


# ------------------------------------------------------------------ 广播解析

def parse_atc(payload: bytes):
    """ATC1441/pvvx 广播：temp int16 LE /100、humidity u16 LE /100、batt 三处重复取中值。

    返回 dict 或 None。原厂加密 MiBeacon 走到这里是解析不出来的（帧头 58 58），
    正好用它区分"刷过机"和"没刷过"。
    """
    if not payload or len(payload) < 13:
        return None
    if payload[0] == 0x58 and payload[1] == 0x58:      # 加密 MiBeacon，跳过
        return None
    try:
        temp = struct.unpack_from("<h", payload, 6)[0] / 100.0
        hum = struct.unpack_from("<H", payload, 8)[0] / 100.0
        b0, b1, b2 = payload[10] & 0x7F, payload[11] & 0x7F, payload[12] & 0x7F
        if abs(b0 - b1) <= 1 and abs(b1 - b2) <= 1:
            batt = (b0 + b1 + b2) // 3
        else:
            batt = int(round((b0 + b1 + b2) / 3))
        if -40 <= temp <= 85 and 0 <= hum <= 100:
            return {"temp_c": round(temp, 2), "humidity": round(hum, 1),
                    "battery": batt, "source": "adv"}
    except (struct.error, IndexError):
        pass
    return None


async def wait_for_device(address, seconds=45.0):
    """用**长扫描**等设备出现，命中即返回 (BLEDevice, 原始广播信息)。

    ★★ 2026-10-05 实测的关键教训（这是"历史永远读不到"的真正根因）★★
    `BleakScanner.discover(timeout=N)` 在 Windows 上有一条**冷启动延迟**：
    实测从 start() 到第一次回调要 **~27 秒**（蓝牙无线电要上电并完成一次扫描周期），
    期间零回调。所以 `discover(timeout=12)` 之类的短扫**永远扫不到**，
    表现为 BleakDeviceNotFoundError —— 让人误判成"设备被米家占用/停止广播"。
    实测：150 秒长监听命中 24 次（RSSI −46），设备**一直在广播**。

    正确做法 = 本函数：用 detection_callback 订阅式扫描，最多等 `seconds` 秒
    （默认 45 秒，留足 27 秒冷启动 + 一个大广播周期 ~37 秒），命中就立刻返回，
    拿到 BLEDevice 对象再去 connect。

    返回 (dev, info)；超时返回 (None, None)。
    """
    from bleak import BleakScanner

    target = address.upper()
    found = {}

    def cb(dev, adv):
        if dev.address.upper() != target or found:
            return
        info = {"address": dev.address.upper(), "rssi": adv.rssi,
                "name": dev.name or adv.local_name, "service_data": {}, "manufacturer_data": {}}
        for uuid, data in (adv.service_data or {}).items():
            info["service_data"][str(uuid).lower()] = bytes(data).hex()
        for cid, data in (adv.manufacturer_data or {}).items():
            info["manufacturer_data"][str(cid)] = bytes(data).hex()
        found["dev"] = dev
        found["info"] = info
        found["at"] = time.monotonic()

    try:
        scanner = BleakScanner(detection_callback=cb)
        await scanner.start()
    except Exception as exc:  # noqa: BLE001
        note("scan start failed: %s: %s" % (type(exc).__name__, exc))
        return None, None

    t0 = time.monotonic()
    try:
        while time.monotonic() - t0 < seconds and not found:
            await asyncio.sleep(0.25)
    finally:
        try:
            await scanner.stop()
        except Exception:  # noqa: BLE001
            pass

    if not found:
        note("长扫 %.0fs 没扫到 %s（设备不在广播：被别的中心端连着 / 没电 / 不在范围）"
             % (seconds, target))
        return None, None
    return found.get("dev"), found.get("info")


async def scan_once(address, seconds=8.0):
    """返回 (读到的读数|None, 广播原始信息)。分块短扫，命中即返回。"""
    _dev, info = await wait_for_device(address, seconds=seconds)
    hit = info or {}

    if not hit:
        return None, None

    reading = None
    for data_hex in hit.get("manufacturer_data", {}).values():
        reading = parse_atc(bytes.fromhex(data_hex))
        if reading:
            break
    if reading is None:
        for data_hex in hit.get("service_data", {}).values():
            reading = parse_atc(bytes.fromhex(data_hex))
            if reading:
                break
    if reading:
        reading["rssi"] = hit.get("rssi")
    return reading, hit


# ------------------------------------------------------------------ GATT 直读

async def read_gatt(address, timeout=20.0, scan_seconds=45.0):
    """连上去读一次就断开。返回 dict 或 None。

    ⚠️ 必须先 `wait_for_device` 拿到 BLEDevice 再连 —— 直接用地址连会在
    Windows 上撞"扫描器缓存为空"（见 wait_for_device 里的实测记录）。
    """
    from bleak import BleakClient

    dev, info = await wait_for_device(address, seconds=scan_seconds)
    if dev is None:
        note("GATT：没扫到设备，跳过本轮（下轮再试）")
        return None

    try:
        async with BleakClient(dev, timeout=timeout) as client:
            raw = None
            for attempt in range(3):
                try:
                    raw = await client.read_gatt_char(CHAR_TEMP)
                    if raw:
                        break
                except Exception:  # noqa: BLE001
                    await asyncio.sleep(0.6)
            if not raw or len(raw) < 3:
                note("GATT 温度特征读回空值（len=%s）" % (len(raw) if raw else 0))
                return None
            temp = struct.unpack_from("<h", raw, 0)[0] / 100.0
            hum = raw[2]
            batt = None
            # ⚠️ 电量特征 ebe0ccb9 的实际语义在这台固件上**不是"百分比"**：
            #    实测读回 159，而电量不可能超过 100。把它当百分比显示会直接误导用户，
            #    所以这里只在 0~100 的合理范围内才采用，否则宁可不显示。
            #    （raw 第 4 字节也常被当作电量档位，但同样没在官方文档里核过，一并保守处理。）
            try:
                b = await client.read_gatt_char(CHAR_BATT)
                if b:
                    candidate = int(b[0])
                    if 0 <= candidate <= 100:
                        batt = candidate
                    else:
                        note("电量特征读回 %d，超出 0~100 合理范围，按未知处理（raw=%s）"
                             % (candidate, bytes(b).hex()))
            except Exception:  # noqa: BLE001
                pass
            if not (-40 <= temp <= 85):
                note("GATT 温度越界，疑似解析错误：raw=%s" % raw.hex())
                return None
            out = {"temp_c": round(temp, 2), "humidity": float(hum),
                   "battery": batt, "source": "gatt", "raw": raw.hex()}
            # 连接本身读不到 RSSI，用刚才扫到它时的信号强度补上（用户关心的"信号好不好"）
            if info and info.get("rssi") is not None:
                out["rssi"] = info["rssi"]
            return out
    except Exception as exc:  # noqa: BLE001
        note("GATT 读取失败：%s: %s" % (type(exc).__name__, exc))
        return None


# ------------------------------------------------------- 设备内置历史（152 条）

def parse_hist_record(data: bytes):
    """一条 14 字节历史记录 → dict，或 None。

    `struct.unpack_from('<IIhBhB', ...)` 是 afer92/lywsd03mmc 与 pvvx 文档一致的
    口径（idx, ts, max_t, max_h, min_t, min_h），温度是**十分之一度**（÷10）。
    ⚠️ 2026-10-05 实测：温度必须 ÷10（÷100 会得到 2.25℃ 这种错值，室温 22.5℃ 才对）。
    """
    if not data or len(data) < HIST_REC:
        return None
    idx, ts, tmax, hmax, tmin, hmin = struct.unpack_from("<IIhBhB", data, 0)
    return {
        "idx": idx,
        "ts": ts,                              # 相对设备时钟起点的秒偏移
        "tmax": round(tmax / 10.0, 2),
        "hmax": float(hmax),
        "tmin": round(tmin / 10.0, 2),
        "hmin": float(hmin),
    }


def _clock_delta(client):
    """⚠️ 已废弃（2026-10-05）：保留函数名只为历史可追溯，**没有任何调用点**。

    原实现两个错误：
      1) 用了 `client.read_gatt_char_sync()` —— bleak 的 BleakClient **没有**这个 API，
         实际永远走 else 分支返回 None（静默失效）。
      2) 拿 ebe0ccb7 当 Unix 时间戳做 1.6e9~4.1e9 范围检查 —— 但那读出来是
         设备**累计秒数**（实测 57733396），必然被判无效。

    正确的做法已在 read_device_history() 里就地实现（async read + `>0` 即可用），
    不要再复活这个函数。
    """
    return None


async def read_device_history(address, timeout=25.0, max_wait=900.0, progress=None, scan=10.0):
    """读设备内置的整段历史（最多 152 小时）。

    返回 (records, meta)。records 是升序的原始记录列表（含 idx/ts/温度上下限），
    meta 至少含 {"base_epoch": float|None, "count": n, "truncated": bool}：
      · base_epoch = 设备上电时刻对应的 Unix 秒（None 表示时间基准没读到）
      · 每条记录的真实时间 = base_epoch + ts（ts 是**该小时末尾**的偏移）

    ⚠️ 这是**慢操作**（全量 ~10 分钟）：152 条 notify 是逐条来的，设备不会把
       整块内存一次性吐出来。所以：
         · 每条都通过 progress(tag, payload) 报进度，server 侧据此推 SSE；
         · max_wait 到点就带着**已经收到的部分**正常收工（truncated=True），
           不会让用户白等十分钟最后拿到 0 条。

    ⚠️ 2026-10-05 实测（两次修正，以本次为准）：
        · **"设备被米家占用"是误判**。真实根因是 `BleakScanner.discover(timeout=N)`
          在 Windows 上有 ~27 秒冷启动延迟 → 短扫永远空手 → BleakDeviceNotFoundError。
          设备其实**一直在广播**（150s 长监听命中 24 次，RSSI −46）。
          修法：改走 `wait_for_device()` 长扫（订阅式），命中即连。
        · 连接成功后 **12 秒就收到 66 条** notify（idx=12286 起）——
          并非旧注释说的"全量要 10 分钟"，设备是**倒着快速倒出**的。
        · 仍保留 3 次重试（间隔 8 秒）覆盖真·瞬态失败。
    """
    from bleak import BleakClient

    last_exc = None
    for attempt in range(1, 4):
        recs = {}          # idx -> record（notify 可能重发，用 idx 去重）
        state = {"last_notify": time.monotonic()}
        base_epoch = None

        def on_notify(_sender, data: bytearray):
            r = parse_hist_record(bytes(data))
            if not r:
                return
            recs[r["idx"]] = r
            state["last_notify"] = time.monotonic()

        try:
            # ★ 关键：长扫拿到 BLEDevice（>=27s 冷启动），再连。
            #   直接对地址 connect 会撞"扫描器缓存为空"→ NotFound（这才是失败根因）。
            dev, _info = await wait_for_device(address, seconds=max(45.0, scan * 4.5))
            if dev is None:
                # 真·扫不到：设备被别的中心端连着 / 没电 / 不在范围
                raise BleakDeviceNotFoundError(address)

            # ★★ WinRT 的 GATT 服务缓存（2026-10-05 实测踩到）：
            #   有时连上后只看到 2~3 个通用服务（GAP/GATT），**业务服务全缺** ——
            #   表现为 BleakCharacteristicNotFoundError: ebe0ccbc was not found。
            #   这不是设备问题，是 Windows 的服务缓存没建全（首次连接/缓存被清时常见）。
            #   实测：同一台设备连续 4 轮连接，每轮都有完整 8 个服务；
            #   而"扫完立刻连"偶发会拿到空表 → 所以这里**连上后校验服务表**，
            #   缺历史特征就断开重连（最多 3 次），而不是直接失败退出。
            client = BleakClient(dev, timeout=timeout)
            for _svc_try in range(1, 4):
                if _svc_try > 1:
                    try:
                        await client.disconnect()
                    except Exception:  # noqa: BLE001
                        pass
                    await asyncio.sleep(2.0)
                    dev2, _ = await wait_for_device(address, seconds=45.0)
                    if dev2 is None:
                        raise BleakDeviceNotFoundError(address)
                    client = BleakClient(dev2, timeout=timeout)
                await client.connect()
                chars = [str(ch.uuid).lower()
                         for s in client.services for ch in s.characteristics]
                if CHAR_HIST in chars:
                    break
                note("第 %d 次连接拿到不完整服务表（%d 个特征，缺历史特征），重连…"
                     % (_svc_try, len(chars)))

            try:
                try:
                    raw = await client.read_gatt_char(CHAR_CLOCK)
                    if raw and len(raw) >= 4:
                        dev_ts = struct.unpack_from("<I", raw, 0)[0]
                        # ⚠️ 2026-10-05 实测：ebe0ccb7 读出来是设备**累计秒数**（实测 57733396），
                        #    不是 Unix 时间戳 —— 旧的范围检查 1.6e9~4.1e9 会把它当无效拒绝掉。
                        #    只要 >0 就可用：base_epoch = 本机此刻 - 设备累计秒数。
                        if dev_ts > 0:
                            base_epoch = time.time() - dev_ts
                            note("设备时钟累计 %d 秒，基准 Unix %.0f" % (dev_ts, base_epoch))
                except Exception:  # noqa: BLE001
                    note("设备时钟特征读不到，历史时间戳将按「最后一条=当前小时」估算")

                try:
                    await client.start_notify(CHAR_HIST, on_notify)
                except Exception as exc:  # noqa: BLE001
                    note("历史特征订阅失败：%s: %s" % (type(exc).__name__, exc))
                    return [], {"base_epoch": None, "count": 0, "truncated": False}

                # 订阅成功后重置 stale 计时起点（discover+连接已经耗了 20+ 秒，
                # 若用循环外的初始值，第一次循环就会误判「10 秒无数据」直接退出）。
                state["last_notify"] = time.monotonic()

                # ⚠️ 2026-10-05 实测：ebe0ccbc 只有 notify、**没有 read**（枚举确认），
                #    主动 read 会抛错 —— 直接靠 notify 收。
                t0 = time.monotonic()
                last_report = 0.0
                while True:
                    if time.monotonic() - t0 > max_wait:
                        break
                    # 结束信号：10 秒没收到新 notify 就认为读完（TermCIC 实测口径）。
                    # 不能再用「idx >= 152」—— idx 是持续递增的计数器，本机已到 12288，
                    # 用 152 判断会收到第一条就误判读完。
                    if time.monotonic() - state["last_notify"] > 10.0:
                        break
                    await asyncio.sleep(0.5)
                    # 每 2 秒报一次进度（server 拿去推 SSE，前端进度条才不会一动不动）
                    now = time.monotonic()
                    if progress and now - last_report >= 2.0:
                        last_report = now
                        progress("progress", {"got": len(recs), "cap": HIST_MAX_IDX,
                                              "elapsed": round(now - t0, 1)})

                try:
                    await client.stop_notify(CHAR_HIST)
                except Exception:  # noqa: BLE001
                    pass
            finally:
                # 手动断连：client 是自己 connect 的（为重连校验服务表），
                # 不能再套 async with（那会重复 connect）。
                try:
                    await client.disconnect()
                except Exception:  # noqa: BLE001
                    pass

            out = [recs[k] for k in sorted(recs)]
            if out:
                return out, {"base_epoch": base_epoch, "count": len(out),
                             "truncated": len(out) < HIST_MAX_IDX}
            # 连上了但 0 条 notify：连接多半被抢（米家/别的中心端）—— 当作可重试失败
            raise TimeoutError("连接成功但没收到任何历史记录（连接被抢走？）")

        except Exception as exc:  # noqa: BLE001
            transient = ("NotFound" in type(exc).__name__
                         or "Timeout" in type(exc).__name__
                         or "被抢走" in str(exc)
                         or "未发现设备" in str(exc))
            if attempt >= 3 or not transient:
                raise
            last_exc = exc
            note("第 %d 次尝试失败（%s），8 秒后自动重试" % (attempt, type(exc).__name__))
            if progress:
                progress("retry", {"attempt": attempt, "msg": type(exc).__name__})
            await asyncio.sleep(8.0)

    if last_exc:
        raise last_exc
    return [], {"base_epoch": None, "count": 0, "truncated": False}

def to_env_rows(records, meta, now=None):
    """历史记录 → 温湿度曲线的行 {at, tmin, tmax, hmin, hmax, atEnd}。

    · `at` 取「该小时末尾」的时刻（设备的约定：这一条代表这一小时里采到的极值）。
    · 与实时读数不同，曲线上的历史点**只有上下限、没有单点值** —— 所以另给
      tmin/tmax，前端可以画成一条竖线（区间），而不是假装有一个精确值。
    · 时间基准确认不了时（base_epoch=None）：以最后一条对齐全机当前整点，
      往前每小时倒推，这样相对间隔仍然是对的，只是绝对时刻可能整体偏移。
    """
    if not records:
        return []
    now = now or time.time()
    base = meta.get("base_epoch")
    out = []
    for r in records:
        if base is not None:
            at_end = base + r["ts"]
        else:
            # 没基准：把最新那条当作"上一个整点"，再按 3600s 往前排
            newest = records[-1]
            at_end = (now - (newest["ts"] - r["ts"]))
        out.append({"at": int(at_end * 1000),
                    "tmin": r["tmin"], "tmax": r["tmax"],
                    "hmin": r["hmin"], "hmax": r["hmax"]})
    out.sort(key=lambda x: x["at"])
    return out


def hist_cmd(address, out_file=None, max_wait=900.0, scan=8.0):
    """--read-history：读回整段内置历史，按 JSON 打到 stdout。

    输出**多行**：每 2 秒一行进度（{"t":"env_hist_progress","got":..,"cap":..,"elapsed":..}），
    最后一行是 {"t":"env_history","ok":1,"rows":[...],"meta":{...}}。
    server.js 靠进度行推前端进度条，靠最后一行落盘。

    ⚠️ 进度里的 `cap`（旧名 total）是设备**保留条数上限**（HIST_MAX_IDX=152），
       不是"本次要读的条数"。实测设备会把自己内存里的历史**全部**逐条推出来，
       收够 152 条也不会停（21:39 那次收到 3000+ 条），所以 `got` 超过 `cap`
       是正常的，别拿它当分母算进度百分比。
    """

    def progress(tag, payload):
        # 进度同时打 stdout（server.js 据此推前端进度条）和 stderr（本地调试）
        emit({"t": "env_hist_" + tag, **payload})
        if tag == "progress":
            note("历史进度 %d 条（%.0fs）" % (payload["got"], payload["elapsed"]))
        else:
            note("历史 %s：%s" % (tag, payload))

    try:
        recs, meta = asyncio.run(read_device_history(address, max_wait=max_wait,
                                                     progress=progress, scan=scan))
    except Exception as exc:  # noqa: BLE001
        emit({"t": "env_history", "ok": False, "msg": "%s: %s" % (type(exc).__name__, exc)})
        return

    rows = to_env_rows(recs, meta)
    emit({"t": "env_history", "ok": True, "count": len(recs), "rows": rows,
          "meta": {"baseEpoch": meta.get("base_epoch"), "truncated": meta.get("truncated"),
                   "cap": HIST_MAX_IDX,
                   "raw": [{"idx": r["idx"], "ts": r["ts"]} for r in recs[:3]]}})
    note("历史读取完成：%d 条" % len(recs))
    if out_file:
        from pathlib import Path
        Path(out_file).write_text(json.dumps({"rows": rows, "meta": meta}, ensure_ascii=False, indent=1),
                                  encoding="utf-8")


# ------------------------------------------------------------------ 主循环

async def main_async(args):
    address = args.address.upper()
    emit({"t": "env_hello", "address": address, "interval": args.interval,
          "ts": int(time.time() * 1000)})

    last_ok = None
    warned_no_adv = False
    while True:
        t0 = time.monotonic()
        reading = None
        adv_info = None
        err = None

        # 先看广播（零代价），拿不到再连
        try:
            reading, adv_info = await scan_once(address, seconds=args.scan)
        except Exception as exc:  # noqa: BLE001
            err = "扫描异常：%s" % exc

        if reading is None and not args.adv_only:
            # 连接前的那次扫描如果看到了设备，就把 RSSI 记下来 ——
            # GATT 连接本身读不到信号强度，但"刚才扫到它时的信号"仍然有意义
            # （用户问的就是"温度计信号好不好"）。
            try:
                reading = await read_gatt(address)
            except Exception as exc:  # noqa: BLE001
                err = "连接读取异常：%s" % exc
            if reading is not None and reading.get("rssi") is None and adv_info:
                reading["rssi"] = adv_info.get("rssi")

        if reading is not None:
            last_ok = reading
            warned_no_adv = False
            emit({"t": "env", "at": int(time.time() * 1000), "ok": True,
                  "temp_c": reading["temp_c"], "humidity": reading["humidity"],
                  "battery": reading.get("battery"), "source": reading["source"],
                  "rssi": reading.get("rssi"), "raw": reading.get("raw")})
        else:
            # 广播里读不到原厂固件的读数是很正常的（加密 MiBeacon），
            # 只在第一次和连接也失败时才提示，避免每轮刷同一句话。
            if not adv_info and not warned_no_adv:
                warned_no_adv = True
                note("广播里没扫到这台设备（可能被手机米家连着，或不在范围内）")
            emit({"t": "env", "at": int(time.time() * 1000), "ok": False,
                  "msg": err or "本轮没读到（广播无明文 / 连接被占用）",
                  "last": last_ok})

        if args.once:
            return

        spent = time.monotonic() - t0
        await asyncio.sleep(max(5.0, args.interval - spent))


def probe(address, seconds):
    """只扫广播并把原始字节打出来，用于判断这台设备是不是刷过机。"""
    reading, info = asyncio.run(scan_once(address, seconds=seconds))
    out = []
    out.append("探测 %s，扫描 %.0fs" % (address, seconds))
    out.append("=" * 70)
    if not info:
        out.append("没扫到该地址的广播。")
        out.append("  · 设备可能被其它中心端连着（手机米家 / 本应用）—— 被连上后设备会停止广播。")
        out.append("  · 也可能不在蓝牙范围内或电量耗尽。")
    else:
        out.append("address : %s" % info["address"])
        out.append("rssi    : %s" % info["rssi"])
        out.append("name    : %s" % info["name"])
        for cid, val in info.get("manufacturer_data", {}).items():
            out.append("manuf [%s] : %s" % (cid, val))
        for uuid, val in info.get("service_data", {}).items():
            out.append("svcdata [%s] : %s" % (uuid, val))
        out.append("-" * 70)
        if reading:
            out.append("→ 广播里能直接解出读数：%.2f ℃ / %.1f%% / 电量 %s"
                       % (reading["temp_c"], reading["humidity"], reading.get("battery")))
            out.append("  说明固件已刷成 ATC/pvvx 明文广播 —— 可以不连接直接读。")
        else:
            first = None
            for val in list(info.get("manufacturer_data", {}).values()) + \
                    list(info.get("service_data", {}).values()):
                first = val
                break
            if first and first.startswith("5858"):
                out.append("→ 广播是加密 MiBeacon（帧头 58 58），原厂固件。")
            else:
                out.append("→ 广播里没有可解的读数（原厂固件的常见情况）。")
            out.append("  这很正常：温度要走 GATT 连接去读（明文，无需密钥）。")
    text = "\n".join(out)
    print(text)
    return text


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--address", default=DEFAULT_ADDRESS)
    ap.add_argument("--interval", type=float, default=90.0, help="轮询间隔秒（连接型设备建议 ≥60）")
    ap.add_argument("--scan", type=float, default=8.0, help="每轮扫广播的秒数")
    ap.add_argument("--probe", action="store_true", help="只扫描广播并打印原始字节")
    ap.add_argument("--adv-only", action="store_true", help="只用广播，不建立连接")
    ap.add_argument("--once", action="store_true", help="只读一轮就退出")
    ap.add_argument("--read-history", action="store_true",
                    help="读设备内置历史（152 小时，慢，约 10 分钟）后退出")
    ap.add_argument("--max-wait", type=float, default=900.0,
                    help="--read-history 的最长等待秒数，到点就交出已收到的部分")
    ap.add_argument("--out", default=None, help="附加：把探测报告写入文件")
    args = ap.parse_args()

    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:  # noqa: BLE001
        pass

    if args.read_history:
        hist_cmd(args.address, out_file=args.out, max_wait=args.max_wait, scan=args.scan)
        return

    if args.probe:
        text = probe(args.address, args.scan)
        if args.out:
            from pathlib import Path
            Path(args.out).parent.mkdir(parents=True, exist_ok=True)
            Path(args.out).write_text(text + "\n", encoding="utf-8")
        return

    try:
        asyncio.run(main_async(args))
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
