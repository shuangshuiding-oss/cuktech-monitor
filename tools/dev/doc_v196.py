"""v1.9.6 文档：默认等待 60 秒 → 5 秒，并补「异常检查」板块说明。

锚点定位；写前先编码（open('wb') 会立刻截断文件，编码失败就等于清空 —— 11-13 踩过）。
"""

from __future__ import annotations

import io
import pathlib

ROOT = pathlib.Path(__file__).resolve().parents[2]
CRLF = "\r\n"
ENV = "gbk"

OLD = "* 「自动断电」：某个口有电压（≥5V）但几乎没有电流（≤0.02A）并持续 60 秒，"
NEW = "* 「自动断电」：某个口有电压（≥5V）但几乎没有电流（≤0.02A）并持续 5 秒（默认，可改），"

MARK = "  注意：USB-A 的「小电流模式」开着时，这一条不会去关 A 口（手环/耳机本来就 0A）。"

EXTRA = [
    "* 「异常检查」板块：**每一次**「有电压没电流」都会记一条（时间、端口、这段里的最高电压/电流、",
    "  持续多久、最后是「已自动关闭」还是「自行恢复」），落盘在 data\\auto-off.jsonl，界面可一键清空。",
    "  它和自动断电的开关**无关** —— 就算把自动断电关掉，这个板块照样记录，方便你先观察几天再决定要不要开。",
]


def main() -> int:
    p = ROOT / "使用说明.txt"
    text = io.open(p, encoding=ENV, newline="").read()
    lines = text.split(CRLF)

    hit = [i for i, l in enumerate(lines) if l.startswith(OLD)]
    if not hit:
        print("!! 没找到「自动断电」那行")
        return 1
    lines[hit[0]] = NEW

    if not any("「异常检查」板块" in l for l in lines):
        m = [i for i, l in enumerate(lines) if l.startswith(MARK)]
        if not m:
            print("!! 没找到插入锚点")
            return 1
        lines[m[0] + 1:m[0] + 1] = EXTRA

    out = CRLF.join(lines).replace("\r\n", "\n").replace("\r", "\n").replace("\n", "\r\n")
    data = out.encode(ENV)          # 先编码，后开文件
    io.open(p, "wb").write(data)
    raw = open(p, "rb").read()
    print("写完：%d 字节，CR=%d LF=%d" % (len(raw), raw.count(b"\r"), raw.count(b"\n")))
    return 0 if raw.count(b"\r") == raw.count(b"\n") else 2


if __name__ == "__main__":
    raise SystemExit(main())
