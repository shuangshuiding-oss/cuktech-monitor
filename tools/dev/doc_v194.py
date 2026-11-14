"""v1.9.4 文档：在「连接中卡住」那段后面补一条"组合卡"排查。

锚点定位；写完整篇归一化 CRLF（GBK）。
"""

from __future__ import annotations

import io
import pathlib

ROOT = pathlib.Path(__file__).resolve().parents[2]
CRLF = "\r\n"
ENV = "gbk"

ANCHOR = "  注意：界面上下方的提示会写出「第 N 次连接没成功」和原始错误。"

NEW = [
    "    ⑤ 如果提示里写着「蓝牙适配器：Realtek 8821/8822 …」—— 那是 Wi-Fi 和蓝牙的**组合卡**，",
    "       蓝牙与 2.4G Wi-Fi 共用一副天线、分时使用。先把 Wi-Fi 关掉（或把 Wi-Fi 切到 5GHz）",
    "       再试；还不行就更新主板厂/Realtek 的蓝牙驱动。组合卡出现「扫得到、连不上」是常事。",
]

def main() -> int:
    p = ROOT / "使用说明.txt"
    text = io.open(p, encoding=ENV, newline="").read()
    lines = text.split(CRLF)
    idx = next((i for i, l in enumerate(lines) if l.startswith(ANCHOR)), None)
    if idx is None:
        print("!! 没找到锚点")
        return 1
    if any("组合卡" in l and "2.4G Wi-Fi" in l for l in lines):
        print("-- 已经写过了，跳过")
        return 0
    lines[idx:idx] = NEW
    out = CRLF.join(lines).replace("\r\n", "\n").replace("\r", "\n").replace("\n", "\r\n")
    io.open(p, "wb").write(out.encode(ENV))
    raw = open(p, "rb").read()
    print("插入 %d 行，CR=%d LF=%d" % (len(NEW), raw.count(b"\r"), raw.count(b"\n")))
    return 0 if raw.count(b"\r") == raw.count(b"\n") else 2


if __name__ == "__main__":
    raise SystemExit(main())
