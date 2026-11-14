# -*- coding: utf-8 -*-
"""v1.9.0 文档独立校验（不依赖 doc_v190.py / doc_v190_fan.py 自己的断言）。

对着已经写出来的五份文件，把"该在的东西"逐条验一遍，把"已经删掉的东西"逐条反向验一遍。
2026-10-11 追加：用户要求删掉风扇的推算功率 / 三格电量 / 推算曲线 / 额定功率设置，
   所以这里既有正向断言（状态、控制、原始属性还在），也有反向断言（推算那一套不许残留）。
"""
import pathlib
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = pathlib.Path(__file__).resolve().parent.parent.parent
NEW, OLD = "1.9.0", "1.8.23"
bad = []


def load(name, enc):
    b = (ROOT / name).read_bytes()
    if b.count(b"\r") != b.count(b"\n"):
        bad.append("%s: CR/LF 不等 (%d/%d)" % (name, b.count(b"\r"), b.count(b"\n")))
    if b[:3] == b"\xef\xbb\xbf":
        bad.append("%s: 不该有 BOM" % name)
    try:
        return b.decode(enc)
    except UnicodeDecodeError as e:
        bad.append("%s: 解不成 %s (%s)" % (name, enc, e))
        return ""


def want(name, text, *probes):
    for p in probes:
        if p not in text:
            bad.append("%s: 缺「%s」" % (name, p[:60]))


def gone(name, text, *probes):
    for p in probes:
        if p in text:
            bad.append("%s: 还剩着「%s」" % (name, p[:60]))


# ------------------------------------------------------------------ version.json
vj = load("version.json", "utf-8")
want("version.json", vj, '"version": "%s"' % NEW, "酷态科10号Ultra")

# ------------------------------------------------------------------ 使用说明.txt (GBK)
man = load("使用说明.txt", "gbk")
want("使用说明.txt", man,
     "（v1.9.0 起还多了一台设备",
     "小米电风扇（Wi-Fi 设备）",
     "fan_collector.py   风扇采集器",
     "vendor\\miio_lan.py 小米 miIO 局域网协议",
     "tools\\test_fan_front.js",
     "data\\fan.token",
     "局域网发现」一台都没扫到",
     "* **只读状态，不看功率**",                 # 新口径
     "不做功率、不做用电量、也不画曲线",
     "61 项断言")
gone("使用说明.txt", man,
     "data\\fan-history-min.jsonl",
     "data\\fan-energy.json",
     "**推算功率**",
     "三格用电量：对推算出来的瓦数做时间积分",
     "**推算功率曲线**",
     "额定功率（1~100 W）",
     "风扇的用电量只是个大概")

# ------------------------------------------------------------------ 首次使用.txt (GBK)
new1 = load("首次使用.txt", "gbk")
want("首次使用.txt", new1, "同一次扫码还会把", "小米电风扇")
gone("首次使用.txt", new1, "推算功率", "用电量曲线（风扇")

# ------------------------------------------------------------------ 软件介绍.md (UTF-8)
md = load("软件介绍.md", "utf-8").replace("\r\n", "\n")
want("软件介绍.md", md,
     "**版本 %s ｜ 便携免安装 ｜ Windows 10 / 11**" % NEW,
     "### 5. 小米电风扇（Wi-Fi 设备）",
     "### 6. 用电量统计",
     "### 7. 桌面集成",
     "### 8. 让位给手机米家",
     "| 风扇采集器 |",
     "| 风扇的功率 / 电量 |",
     "| 靠广播找风扇 |",
     "- **只读状态与开关，不做功率 / 电量**",
     "看它的**运行状态**并反向控制")
gone("软件介绍.md", md,
     "**推算功率与用电量**",
     "**推算功率曲线**",
     "| 读风扇的准确功率 / 电量 |",
     "额定功率 × 档位比例 × 自然风系数」推算出来的",
     "默认 15 W")

# ------------------------------------------------------------------ 软件介绍.html (UTF-8)
html = load("软件介绍.html", "utf-8").replace("\r\n", "\n")
want("软件介绍.html", html,
     "<span>版本 %s</span>" % NEW,
     "小米电风扇（Wi-Fi 设备）",
     "<tr><td>风扇采集器</td>",
     "<tr><td>风扇的功率 / 电量</td>",
     "<tr><td>靠广播找风扇</td>",
     "<b>只读状态与开关，不做功率 / 电量</b>",
     "看它的<strong>运行状态</strong>并反向控制")
gone("软件介绍.html", html,
     "<b>推算功率与用电量</b>",
     "<b>推算功率曲线</b>",
     "<tr><td>读风扇的准确功率 / 电量</td>",
     "默认 15 W")

# --- 顺序：风扇那一节必须夹在「环境温度」和「用电量统计」之间 ------------
order = ["### 4. 环境温度（外挂传感器）", "### 5. 小米电风扇（Wi-Fi 设备）",
         "### 6. 用电量统计", "### 7. 桌面集成", "### 8. 让位给手机米家"]
idx = [md.find(o) for o in order]
if any(i < 0 for i in idx):
    bad.append("软件介绍.md: 章节号有缺失 %r" % list(zip(order, idx)))
elif idx != sorted(idx):
    bad.append("软件介绍.md: 章节顺序错了 %r" % list(zip(order, idx)))

# --- html：风扇卡片必须在「用电量统计」卡片之前，且 div 配平 -------------
fc = html.find('小米电风扇（Wi-Fi 设备）</h4>')
ec = html.find('用电量统计</h4>')
if fc < 0 or ec < 0 or not (fc < ec):
    bad.append("软件介绍.html: 风扇卡片位置不对 (fan=%d, energy=%d)" % (fc, ec))
if html.count("<div") != html.count("</div>"):
    bad.append("软件介绍.html: div 不配平 <div=%d </div=%d"
               % (html.count("<div"), html.count("</div>")))
if html.count('<div class="card">') != 8:
    bad.append("软件介绍.html: 卡片数不是 8 → %d" % html.count('<div class="card">'))

# --- 页脚版本：只认 footer 那一行 ----------------------------------------
foot = [l for l in html.split("\n") if l.startswith("  <footer>")]
if len(foot) != 1 or ("v" + NEW) not in foot[0]:
    bad.append("软件介绍.html: 页脚版本不对 → %r" % foot)

# --- 旧的版本横幅不能还在 -----------------------------------------------
if ("**版本 %s ｜" % OLD) in md:
    bad.append("软件介绍.md: 页头还是旧版本号")
if ("<span>版本 %s</span>" % OLD) in html:
    bad.append("软件介绍.html: 徽章还是旧版本号")

print("检查对象：version.json / 使用说明.txt / 首次使用.txt / 软件介绍.md / 软件介绍.html")
print("正向断言：v1.9.0 的风扇节、工具/数据清单、已知边界都还在")
print("反向断言：推算功率 / 三格电量 / 推算曲线 / 额定功率设置 / 两份数据账本都已清干净")
if bad:
    print("!! %d 处不对：" % len(bad))
    for b in bad:
        print("   - " + b)
    sys.exit(1)
print("全部通过。")
