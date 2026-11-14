"""miIO 局域网协议（UDP 54321）—— 只用标准库 + cryptography，无第三方依赖。

小米的 Wi-Fi 设备（包括米家直流变频落地扇 1X / dmaker.fan.p5）在局域网里
用这套协议通信。它比 BLE 那条路简单得多：

    * 明文头（32 字节） + AES-128-CBC 加密的 JSON 负载
    * 加密密钥完全由设备 token 推出，不需要握手协商会话密钥
    * 每个包都带一个 MD5 校验和，防止被别的进程误伤

包结构（全部小端）::

    偏移  长度  字段
    0     2     magic = 0x2131
    2     2     整包长度（含 32 字节头）
    4     4     固定 0x00000000
    8     4     device id      —— 握手里填 0xFFFFFFFF，之后用设备回的真实值
    12    4     stamp          —— 时长戳；握手填 0xFFFFFFFF
    16    16    MD5(头前 16 字节 + token)
    32    N     加密负载（握手时没有）

握手（hello）与命令的区别只有一个：握手的 did/stamp 都是 0xFFFFFFFF 且没有负载，
设备回的包里带着它真实的 did 和 stamp，后续命令照抄这两个值即可。

密钥推导::

    key = MD5(token)                # 16 字节
    iv  = MD5(key + token)          # 16 字节

负载用 PKCS7 补齐后 AES-128-CBC 加密。

这个文件里的实现是照着 python-miio 的行为写的，但只保留本应用需要的那部分。
"""

from __future__ import annotations

import hashlib
import json
import socket
import struct
import time
from typing import Any

from cryptography.hazmat.primitives import padding
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

MAGIC = 0x2131
PORT = 54321
HEADER_LEN = 32
MIIO_PORT = PORT


class MiioError(Exception):
    """任何 miIO 通信失败。"""


class MiioTimeout(MiioError):
    """等不到设备应答（UDP 丢了，或者 IP/token 不对）。"""


def _md5(data: bytes) -> bytes:
    return hashlib.md5(data).digest()


def _encrypt(key: bytes, iv: bytes, data: bytes) -> bytes:
    padder = padding.PKCS7(128).padder()
    padded = padder.update(data) + padder.finalize()
    enc = Cipher(algorithms.AES(key), modes.CBC(iv)).encryptor()
    return enc.update(padded) + enc.finalize()


def _decrypt(key: bytes, iv: bytes, data: bytes) -> bytes:
    if not data:
        return b""
    dec = Cipher(algorithms.AES(key), modes.CBC(iv)).decryptor()
    raw = dec.update(data) + dec.finalize()
    unpadder = padding.PKCS7(128).unpadder()
    return unpadder.update(raw) + unpadder.finalize()


class MiioDevice:
    """一台局域网 miIO 设备（同步实现，够用且好排查）。"""

    def __init__(self, ip: str, token: str, *, timeout: float = 4.0,
                 retries: int = 3, log=None):
        tok = (token or "").strip().replace(" ", "")
        if len(tok) != 32:
            raise MiioError("token 必须是 32 位十六进制（16 字节），当前 %d 位" % len(tok))
        try:
            self.token = bytes.fromhex(tok)
        except ValueError as exc:
            raise MiioError("token 不是合法十六进制：%s" % exc) from None
        self.ip = ip
        self.timeout = timeout
        self.retries = retries
        self.key = _md5(self.token)
        self.iv = _md5(self.key + self.token)
        self.device_id = 0
        self.stamp = 0
        self._stamp_at = 0.0          # 本地记录的「上次对齐 stamp 的时刻」
        self._id = 0                  # 请求序号
        self._log = log or (lambda *_a, **_k: None)
        self.handshook = False
        # 诊断计数：和 BLE 那边的 rxDup/rxLag 一个用途 —— 看链路质量
        self.timeouts = 0
        self.retransmits = 0

    # ---------------------------------------------------------------- 底层

    def _header(self, did: int, stamp: int, payload_len: int) -> bytes:
        total = HEADER_LEN + payload_len
        head16 = struct.pack("<HH", MAGIC, total) + struct.pack("<I", 0) \
            + struct.pack("<I", did) + struct.pack("<I", stamp)
        assert len(head16) == 16, len(head16)
        return head16 + _md5(head16 + self.token)

    def _build(self, payload: bytes = b"", *, did: int | None = None,
               stamp: int | None = None) -> bytes:
        header = self._header(
            self.device_id if did is None else did,
            self._stamp() if stamp is None else stamp,
            len(payload),
        )
        return header + payload

    def _stamp(self) -> int:
        """命令包用的 stamp：设备 stamp + 从对齐那刻起的秒数。

        有些固件会检查 stamp 是否单调；简单照抄设备回的 stamp 也能用，
        但按 python-miio 的做法滚动更稳（长时间挂机也不会被判成重放）。
        """
        return int(self.stamp + (time.monotonic() - self._stamp_at))

    def _exchange_raw(self, packet: bytes) -> bytes:
        """发一个包并等一个应答，返回原始数据报。UDP 会丢包，这里自己做重传。

        返回的可能是「没有负载的头」（握手就是这种），调用方自己判断长度。
        """
        last: Exception | None = None
        for attempt in range(self.retries):
            if attempt:
                self.retransmits += 1
            try:
                return self._exchange_once(packet)
            except MiioTimeout as exc:
                last = exc
                self._log("miio 重传 %d/%d：%s" % (attempt + 1, self.retries, exc))
        self.timeouts += 1
        raise last or MiioTimeout("无应答")

    def _exchange_once(self, packet: bytes) -> bytes:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            sock.settimeout(self.timeout)
            sock.sendto(packet, (self.ip, PORT))
            deadline = time.monotonic() + self.timeout * max(1, self.retries)
            while True:
                left = deadline - time.monotonic()
                if left <= 0:
                    raise MiioTimeout("等 %s:%d 应答超时" % (self.ip, PORT))
                sock.settimeout(left)
                try:
                    data, addr = sock.recvfrom(4096)
                except socket.timeout:
                    raise MiioTimeout("等 %s:%d 应答超时" % (self.ip, PORT)) from None
                except OSError as exc:
                    raise MiioError("收包失败：%s" % exc) from exc
                if len(data) < HEADER_LEN:
                    self._log("miio 收到过短的包 %d 字节，丢弃" % len(data))
                    continue
                magic = struct.unpack("<H", data[:2])[0]
                if magic != MAGIC:
                    # 局域网里别的设备 / 别的进程发的包，不是给我们的
                    self._log("miio 忽略非 miIO 包（magic=0x%04x，来自 %s）"
                              % (magic, addr[0]))
                    continue
                return data
        finally:
            try:
                sock.close()
            except Exception:  # noqa: BLE001
                pass

    def _exchange(self, packet: bytes) -> dict | None:
        """发命令包并解析应答；没有负载（握手）时返回 None。"""
        data = self._exchange_raw(packet)
        total = struct.unpack("<H", data[2:4])[0]
        body = data[HEADER_LEN:total] if total > HEADER_LEN else b""
        if not body:
            return None
        try:
            plain = _decrypt(self.key, self.iv, body)
        except Exception as exc:  # noqa: BLE001
            # token 不对时最常见的就是这里
            raise MiioError("解密失败（多半是 token 不对）：%s" % exc) from exc
        try:
            return json.loads(plain.decode("utf-8"))
        except Exception as exc:  # noqa: BLE001
            raise MiioError("负载不是 JSON：%r" % plain[:200]) from exc

    # ---------------------------------------------------------------- 公开

    def handshake(self) -> dict:
        """拿到设备的 did / stamp。必须先做这一步，否则命令包会被忽略。"""
        packet = self._build(b"", did=0xFFFFFFFF, stamp=0xFFFFFFFF)
        data = self._exchange_raw(packet)
        did, stamp = struct.unpack("<II", data[8:16])
        if did == 0xFFFFFFFF:
            raise MiioError("设备拒绝握手（did 仍是 0xFFFFFFFF），token 可能不对")
        self.device_id = did
        self.stamp = stamp
        self._stamp_at = time.monotonic()
        self.handshook = True
        return {"device_id": did, "stamp": stamp}

    def send(self, method: str, params: Any = None, *, timeout: float | None = None) -> Any:
        """发一条命令，返回应答的 result（失败抛 MiioError）。"""
        if not self.handshook:
            self.handshake()
        self._id = (self._id % 9999) + 1
        req: dict[str, Any] = {"id": self._id, "method": method}
        if params is not None:
            req["params"] = params
        payload = _encrypt(self.key, self.iv, json.dumps(req).encode("utf-8"))
        old_timeout = self.timeout
        if timeout:
            self.timeout = timeout
        try:
            resp = self._exchange(self._build(payload))
        finally:
            self.timeout = old_timeout
        if resp is None:
            raise MiioError("空应答")
        if "error" in resp:
            raise MiioError("设备返回错误：%s" % json.dumps(resp["error"], ensure_ascii=False))
        return resp.get("result")

    # 便捷封装 -----------------------------------------------------------

    def get_properties(self, props: list[tuple[int, int]], *, with_did: bool = True) -> list:
        params = [_prop(p, with_did=with_did) for p in props]
        return self.send("get_properties", params)

    def set_properties(self, entries: list[tuple[int, int, Any]], *, with_did: bool = True) -> list:
        params = [dict(_prop((s, p), with_did=with_did), value=v) for s, p, v in entries]
        return self.send("set_properties", params)


def _prop(siid_piid: tuple[int, int], *, with_did: bool) -> dict:
    siid, piid = siid_piid
    if with_did:
        return {"did": "prop", "siid": siid, "piid": piid}
    return {"siid": siid, "piid": piid}


def discover(timeout: float = 4.0) -> list[dict]:
    """局域网广播发现 miIO 设备（拿 IP 用；云端的 localip 通常已经够用）。

    发一个握手包到 255.255.255.255:54321，在线设备会各自回一个头。
    """
    found: dict[str, dict] = {}
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
        sock.settimeout(1.0)
        # 握手的 checksum 需要 token，而没有 token 就没法算；不过设备对
        # 「长度 32、magic 对」的包也会回一个头 —— 这里用一个全 0 token 探测，
        # 只取 IP 和设备 ID，不解析负载。
        head16 = struct.pack("<HH", MAGIC, HEADER_LEN) + struct.pack("<I", 0) \
            + struct.pack("<I", 0xFFFFFFFF) + struct.pack("<I", 0xFFFFFFFF)
        probe = head16 + _md5(head16 + b"\x00" * 16)
        sock.sendto(probe, ("255.255.255.255", PORT))
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                data, addr = sock.recvfrom(4096)
            except socket.timeout:
                break
            if len(data) < HEADER_LEN:
                continue
            magic = struct.unpack("<H", data[:2])[0]
            if magic != MAGIC:
                continue
            did, stamp = struct.unpack("<II", data[8:16])
            found[addr[0]] = {"ip": addr[0], "device_id": did, "stamp": stamp}
    finally:
        try:
            sock.close()
        except Exception:  # noqa: BLE001
            pass
    return list(found.values())
