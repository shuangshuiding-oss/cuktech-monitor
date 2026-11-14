"""Turn a collector --probe log into a short human-readable summary.

The probe writes one JSON object per line, but the redirect PowerShell does
lands as UTF-16 and the payload is far too long to eyeball, so this pulls the
single {"t":"probe"} object out and prints just the parts that answer the
question.

Usage:  python tools/probe_summary.py <logfile>
"""

from __future__ import annotations

import json
import sys


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: probe_summary.py <logfile> [outfile]")
        return 2
    # Windows 上控制台编码会把中文搞成乱码，所以支持直接写文件（UTF-8）。
    out_path = sys.argv[2] if len(sys.argv) > 2 else None
    buf: list[str] = []

    def say(text: str = "") -> None:
        if out_path:
            buf.append(text)
        else:
            print(text)

    probe = None
    notes = []
    # PowerShell 的 `*>` 重定向落盘是 UTF-16LE（带 BOM），所以先按 BOM 判编码，
    # 否则整行都会被 NUL 撑成"二进制"而认不出 JSON。
    with open(sys.argv[1], "rb") as fh:
        raw = fh.read()
    if raw[:2] in (b"\xff\xfe", b"\xfe\xff"):
        text = raw.decode("utf-16", errors="replace")
    else:
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError:
            text = raw.decode("utf-16", errors="replace")

    for line in text.splitlines():
        line = line.strip().lstrip("\ufeff")
        if not line:
            continue
        if not line.startswith("{"):
            notes.append(line)
            continue
        try:
            obj = json.loads(line)
        except Exception:  # noqa: BLE001
            continue
        if obj.get("t") == "probe":
            probe = obj

    if probe is None:
        say("!! 日志里没有找到 probe 对象；原始进度行如下：")
        for n in notes[-40:]:
            say("   " + n)
        if out_path:
            open(out_path, "w", encoding="utf-8").write("\n".join(buf))
        return 1

    say("== 基线（标准 15 项）==")
    for piid in sorted(probe.get("current", {})):
        say("  2.%02x = %s" % (piid, probe["current"][piid]))

    say("\n== GET 形状矩阵 ==")
    for g in probe.get("gets", []):
        if g.get("ok"):
            say("  OK   发出 %2d 项  %s  -> 回 %d 项"
                % (g["sent"], g["label"], g["got"]))
        else:
            say("  FAIL 发出 %2d 项  %s  -> %s"
                % (g["sent"], g["label"], g.get("error")))

    say("\n== 写入验证 ==")
    for w in probe.get("writes", []):
        say("  " + json.dumps(w, ensure_ascii=False))

    pushes = probe.get("pushes") or []
    say("\n== 采集期间的主动推送 ==  %d 帧" % len(pushes))
    for p in pushes[:12]:
        say("  " + json.dumps(p, ensure_ascii=False))

    if out_path:
        with open(out_path, "w", encoding="utf-8") as fh:
            fh.write("\n".join(buf) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
