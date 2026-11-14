"""复现 aiohttp 端到端：直接用便携包自带 aiohttp 走一遍小米 QR 登录的第一步。

用法：runtime\python\python.exe tools\dev\aiohttp_tls_repro.py
"""
from __future__ import annotations

import asyncio
import ssl
import sys
import traceback

URL = "https://account.xiaomi.com/longPolling/loginUrl"
NOTES: list[str] = []


async def run(relax: bool, label: str) -> None:
    import aiohttp

    kwargs = {}
    if relax:
        ctx = ssl.create_default_context()
        ctx.verify_flags &= ~ssl.VERIFY_X509_STRICT
        kwargs["connector"] = aiohttp.TCPConnector(ssl=ctx)
    async with aiohttp.ClientSession(**kwargs) as s:
        conn = s.connector
        try:
            sc = conn._ssl  # noqa: SLF001
            flags = getattr(sc, "verify_flags", None)
            NOTES.append("%s: connector ssl ctx flags=%s (strict=%s)"
                         % (label, hex(flags) if flags is not None else None,
                            bool(flags & ssl.VERIFY_X509_STRICT) if flags is not None else "?"))
        except Exception as exc:  # noqa: BLE001
            NOTES.append("%s: introspect failed: %s" % (label, exc))
        try:
            async with s.get(URL, timeout=aiohttp.ClientTimeout(total=25)) as r:
                body = await r.text()
                NOTES.append("%s: OK HTTP %s, %d bytes" % (label, r.status, len(body)))
        except Exception as exc:  # noqa: BLE001
            NOTES.append("%s: FAIL %s: %s" % (label, type(exc).__name__, exc))
            if exc.__cause__ is not None:
                NOTES.append("    cause: %s: %s" % (type(exc.__cause__).__name__, exc.__cause__))


def main() -> int:
    sys.stderr.write("python %s / openssl %s\n" % (sys.version.split()[0], ssl.OPENSSL_VERSION))
    for relax, label in ((False, "aiohttp 默认(START)"), (True, "关闭严格模式(RELAX)")):
        try:
            asyncio.run(run(relax, label))
        except Exception:  # noqa: BLE001
            NOTES.append("%s: crashed\n%s" % (label, traceback.format_exc()))
    for line in NOTES:
        print(line)
    return 0


if __name__ == "__main__":
    sys.exit(main())
