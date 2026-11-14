"""v1.9.5 文档：在「关于控制功能」里补一条自动断电。

锚点定位；写完整篇归一化 CRLF（GBK）。
"""

from __future__ import annotations

import io
import pathlib

ROOT = pathlib.Path(__file__).resolve().parents[2]
CRLF = "\r\n"
ENV = "gbk"

ANCHOR = "* 「恢复常用默认」会把四个口全开、场景切回 AI，分两条逐一下发。"

NEW = [
    "* 「自动断电」：某个口有电压（≥5V）但几乎没有电流（≤0.02A）并持续 60 秒，",
    "  就自动把这个口关掉 —— 治「手机充满了还一直挂着」「线插着但没接设备」这类空耗。",
    "  四个参数都能在「控制充电头 - 自动断电」里改：电压门槛 / 电流上限 / 等待秒数 /",
    "  关闭后多少分钟自动恢复（默认 15 分钟；填 0 = 不恢复，需要手动点开启）。",
    "  注意：恢复之后**不会立刻重新监听**，要等这个口拔插一次、或重新开始取电才再次生效 ——",
    "     否则会变成每 15 分钟通断一次的循环。想彻底停用就取消「启用」。",
    "  注意：USB-A 的「小电流模式」开着时，这一条不会去关 A 口（手环/耳机本来就 0A）。",
]


def main() -> int:
    p = ROOT / "使用说明.txt"
    text = io.open(p, encoding=ENV, newline="").read()
    lines = text.split(CRLF)
    idx = next((i for i, l in enumerate(lines) if l.startswith(ANCHOR)), None)
    if idx is None:
        print("!! 没找到锚点")
        return 1
    if any("自动断电" in l for l in lines):
        print("-- 已经写过了，跳过")
        return 0
    lines[idx + 1:idx + 1] = NEW
    out = CRLF.join(lines).replace("\r\n", "\n").replace("\r", "\n").replace("\n", "\r\n")
    data = out.encode(ENV)          # ⚠️ 先编码再开文件：open(...,"wb") 会**立刻截断**，
    #    编码失败时文件已经变成 0 字节了（2026-11-13 就这样把 42 KB 的说明书清空过）。
    io.open(p, "wb").write(data)
    raw = open(p, "rb").read()
    print("插入 %d 行，CR=%d LF=%d" % (len(NEW), raw.count(b"\r"), raw.count(b"\n")))
    return 0 if raw.count(b"\r") == raw.count(b"\n") else 2


if __name__ == "__main__":
    raise SystemExit(main())
