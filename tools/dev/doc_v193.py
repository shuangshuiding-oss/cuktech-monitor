"""v1.9.3 文档：在「一直停在搜索中」前面插入一段"连接中卡住"的排障。

锚点定位（不按行号）；写完整篇归一化 CRLF。
"""

from __future__ import annotations

import io
import pathlib

ROOT = pathlib.Path(__file__).resolve().parents[2]
CRLF = "\r\n"
ENV = "gbk"

ANCHOR = "* 一直停在「搜索中」：确认充电头已通电、米家 App 已断开它、离电脑近一些。"

NEW = [
    "* 一直停在「连接中 · 已发现，正在建立 BLE 连接」，功率一直是 0.0 W：",
    "  这是**扫到了设备、但连接建立不起来**。采集器的循环是「搜索 2~8 秒 → 连接（最多等 60 秒）",
    "  → 失败 → 等几秒 → 再来一轮」，所以界面上大部分时间都停在「连接中」。",
    "  按这个顺序试（从最省事的开始）：",
    "    ① 手机上打开米家，退出充电头那一页（或直接关掉手机蓝牙）。",
    "       BLE 同一时刻只允许一个中心端连着它 —— 手机连着，电脑就永远连不上。",
    "    ② 如果还有另一台电脑在跑这个软件，也关掉它（两台抢同一条蓝牙，会互相踢）。",
    "    ③ 把充电头的电源拔掉，等 10 秒再插上。设备异常断开后可能还「记着」上一个连接，",
    "       这时它会照常广播、但拒绝新的连接，看起来就是「扫得到、连不上」。",
    "    ④ 换一台电脑试。若别的电脑能连上，说明这台机器的蓝牙适配器做不了 BLE 连接",
    "       （台式机外接的廉价 USB 蓝牙棒最常见），或驱动太旧 —— 更新蓝牙驱动，或换适配器。",
    "  注意：界面上下方的提示会写出「第 N 次连接没成功」和原始错误。",
    "  把 data\\app.log 里 `link error:` 那一行发回来，能直接区分是超时（被占用）还是",
    "  WinRT 报错（适配器问题）。",
]

def main() -> int:
    p = ROOT / "使用说明.txt"
    text = io.open(p, encoding=ENV, newline="").read()
    lines = text.split(CRLF)
    idx = next((i for i, l in enumerate(lines) if l.startswith(ANCHOR)), None)
    if idx is None:
        print("!! 没找到锚点")
        return 1
    if any("连接中 · 已发现" in l for l in lines):
        print("-- 已经写过了，跳过")
        return 0
    lines[idx:idx] = NEW
    out = CRLF.join(lines).replace("\r\n", "\n").replace("\r", "\n").replace("\n", "\r\n")
    io.open(p, "wb").write(out.encode(ENV))
    raw = open(p, "rb").read()
    print("插入 %d 行 → 全文 %d 行，CR=%d LF=%d"
          % (len(NEW), len(lines), raw.count(b"\r"), raw.count(b"\n")))
    return 0 if raw.count(b"\r") == raw.count(b"\n") else 2


if __name__ == "__main__":
    raise SystemExit(main())
