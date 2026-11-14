"""把「小米电风扇（Wi-Fi / miIO）」这条新链路写进两份对外文档，并把版本号提到 1.9.0。

四份文件、两套编码 —— 一次做完，免得改到一半忘了哪份：
  · version.json          UTF-8  + CRLF   （版本唯一来源）
  · 使用说明.txt           GBK    + CRLF   （正文是 GBK，node 编不出来，所以用 Python）
  · 软件介绍.md            UTF-8  + CRLF
  · 软件介绍.html          UTF-8  + CRLF
  · 首次使用.txt           GBK    + CRLF

原则（前几版在这里翻过车，见 doc_v1823b.py 的教训）：
  · **纯插入**：只在锚点行前后插，不按"第几行"切片，不依赖旧内容的长度；
  · 锚点必须**有且只有一处**，多了少了都直接中止（别猜）；
  · 改完做三项自检：编码能原样来回、CRLF 纯（CR == LF）、锚点块都在。

用法: python tools/dev/doc_v190.py
"""
import io
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
CRLF = "\r\n"
OLD_VER = "1.8.23"
NEW_VER = "1.9.0"

problems = []


def read(name, enc):
    return io.open(ROOT / name, encoding=enc, newline="").read()


def write(name, text, enc):
    p = ROOT / name
    data = text.encode(enc)
    # 写之前先自己验一遍：CRLF 纯 + 能解回来
    if data.count(b"\r") != data.count(b"\n"):
        problems.append("%s: CR/LF 不相等（CR=%d LF=%d）" % (name, data.count(b"\r"), data.count(b"\n")))
    if data.decode(enc) != text:
        problems.append("%s: %s 来回不一致" % (name, enc))
    p.write_bytes(data)
    print("写回 %-16s %6d 行 %7d 字节 (%s)" % (name, text.count(CRLF) + 1, len(data), enc))


def once(lines, anchor, name):
    """锚点必须唯一 —— 不唯一就中止，绝不猜。"""
    hits = [i for i, l in enumerate(lines) if l == anchor]
    if len(hits) != 1:
        problems.append("%s: 锚点出现 %d 次，期望 1 次 → %r" % (name, len(hits), anchor[:40]))
        return None
    return hits[0]


def insert_after(lines, anchor, block, name):
    i = once(lines, anchor, name)
    if i is None:
        return None
    lines[i + 1:i + 1] = block
    return i + 1


def insert_before(lines, anchor, block, name):
    i = once(lines, anchor, name)
    if i is None:
        return None
    lines[i:i] = block
    return i


def once_prefix(lines, prefix, name):
    """按前缀找行 —— 长句子的后半截容易抄错，前缀更稳。"""
    hits = [i for i, l in enumerate(lines) if l.startswith(prefix)]
    if len(hits) != 1:
        problems.append("%s: 前缀锚点 %r 出现 %d 次，期望 1 次" % (name, prefix[:30], len(hits)))
        return None
    return hits[0]


def find_block(lines, anchor_lines, name):
    """连续多行的锚点 —— 用来精确定位「某张卡片的头两行」这类位置。"""
    n = len(anchor_lines)
    hits = [i for i in range(len(lines) - n + 1) if lines[i:i + n] == anchor_lines]
    if len(hits) != 1:
        problems.append("%s: 多行锚点出现 %d 次，期望 1 次 → %r" % (name, len(hits), anchor_lines[0][:36]))
        return None
    return hits[0]


def insert_before_block(lines, anchor_lines, block, name):
    i = find_block(lines, anchor_lines, name)
    if i is None:
        return None
    lines[i:i] = block
    return i


def need(lines, needle, name):
    if not any(needle in l for l in lines):
        problems.append("%s: 找不到插入内容「%s」" % (name, needle))


# ---------------------------------------------------------------- 重复运行保护
# 这个脚本是"纯插入"，跑第二遍会把内容插两遍。所以先看一眼五份是不是都已经是新版：
# 全是 → 什么都不做；部分是（上次跑到一半）→ 停下来让人去还原，不猜。
GUARD = "小米电风扇（Wi-Fi 设备）"
MARKS = {
    "version.json": NEW_VER,
    "使用说明.txt": GUARD,
    "首次使用.txt": "同一次扫码还会把",
    "软件介绍.md": GUARD,
    "软件介绍.html": GUARD,
}


def marker_enc(name):
    return "gbk" if name.endswith(".txt") else "utf-8"


hit = [n for n, m in MARKS.items() if m in read(n, marker_enc(n))]
if len(hit) == len(MARKS):
    print("五份都已经是 v%s 了，跳过（脚本可以反复跑）。" % NEW_VER)
    sys.exit(0)
if hit:
    print("!! 只改了其中几份：%s" % "、".join(hit))
    print("   先把这几份还原成 v%s，再整跑一遍 —— 否则会插两遍。" % OLD_VER)
    sys.exit(2)


# ============================================================ 1. version.json
print("=== 1. version.json ===")
vj = json.loads(read("version.json", "utf-8"))
if vj.get("version") != OLD_VER:
    print("  版本已是 %s，跳过" % vj.get("version"))
else:
    text = read("version.json", "utf-8")
    write("version.json", text.replace(OLD_VER, NEW_VER), "utf-8")

# ============================================================ 2. 使用说明.txt
print("=== 2. 使用说明.txt (GBK) ===")
DOC = "使用说明.txt"
lines = read(DOC, "gbk").split(CRLF)

# 2a. 开头「这是什么」那段（四件事）后面补一句：现在还并进来一台 Wi-Fi 设备。
insert_after(lines, "   蓝牙掉线时由任务栏图标弹气泡提醒。", [
    "",
    "（v1.9.0 起还多了一台设备：家里的**小米电风扇**。它是 Wi-Fi（miIO）设备、不占蓝牙，",
    " 和充电头、温湿度计共用同一个窗口和同一个任务栏图标 —— 详见下面「小米电风扇」一节。）",
], DOC)

# 2b. 正文新增一整节：插在「窗口外观」那一节的横线之前。
FAN_SECTION = [
    "──────────────────────────────────────────────",
    "小米电风扇（Wi-Fi 设备）",
    "──────────────────────────────────────────────",
    "v1.9.0 起界面里多了一张「小米电风扇」卡片，读的是家里的米家直流变频落地扇",
    "（dmaker.fan.p5 这一类）。它**和上面几台设备走的完全是另一条路**：",
    "",
    "* 充电头与温湿度计是**蓝牙**设备；风扇是**Wi-Fi（miIO）**设备 —— 走家里的局域网",
    "  UDP 直连（端口 54321，AES-128-CBC 加密），**不经过米家云**。",
    "* 所以风扇**不占蓝牙**：电脑连着充电头的时候，风扇照常能读能控；",
    "  手机米家也能同时控制它（不用像充电头那样「让位」）。",
    "* 它由独立的采集器进程 fan_collector.py 采集，同样是「可失败」设计：",
    "  风扇连不上只是这张卡灰掉，充电头与温湿度计一点都不受影响。",
    "",
    "怎么让它连上：**不需要单独登录**。点一次右上角「登录小米云」扫码，同一次授权",
    "会把充电头的 12 字节蓝牙密钥**和**风扇的局域网 IP + 16 字节密钥一起取回来，",
    "分别存到 data\\cuktech.token 与 data\\fan.token（风扇那份还带 IP、MAC、设备名）。",
    "",
    "卡片上有什么：",
    "",
    "* **推算功率**：这台风扇**没有任何电参量属性可读**（规格表逐项核过），所以「多少瓦」",
    "  是按「额定功率 × 档位比例 × 自然风系数」算出来的，界面上带「推算」二字。",
    "  额定功率按包装上的值填（卡片底部「风扇设置」里，默认 15 W）。",
    "* **今日 / 累计 / 本次运行**三格用电量：对推算出来的瓦数做时间积分。同样是推算值，",
    "  用来比个大概（比如「开一晚上大概多少电」），**对不上电表**。",
    "* **推算功率曲线**：区间按钮和功率、温湿度那两条共用（1 分钟 ~ 30 天）；",
    "  空档处断开连线、不补 0。注意风扇的分钟行只保留 30 天，所以它的按钮行里**没有**",
    "  「90 天 / 半年 / 1 年 / 全部」那几档（那是温度专用的）。",
    "* **风扇控制**：开关、无级调速（1~100 滑条）、档位（1~4）、风型（自然风 / 直吹风）、",
    "  左右摆风、摆风夹角（30/60/90/120/140 度）、定时（0~480 分钟）、指示灯、提示音、童锁。",
    "  **每一次写入都会回读确认** —— 界面上的开关状态是设备读回来的值，不是「我以为写成功了」。",
    "  写入期间开关会变半透明（同一时刻只发一条命令），卡片里会写一句「… → 回读 X，一致」。",
    "* **风扇设置**：轮询间隔（默认 2 秒，可调 0.5~30）、额定功率（1~100 W）、",
    "  「连接自检」（连一次、把全部属性读回来就退出，不进常态轮询）、",
    "  「局域网发现」（广播一轮看网上有哪些 miIO 设备 —— 只能确认它在不在网上，",
    "  拿不到密钥，所以它**不是**判断风扇在不在线的依据，见下面排障）。",
    "* **风扇原始属性**：值不经过任何换算，出问题时能一眼分清「设备没回」还是「界面没画」；",
    "  末尾还带通信计数（超时 / 重传次数，一直涨说明网络或设备不稳）。",
    "* 卡片标题右侧的「收起 / 展开」和温度计那张一样：用不上风扇时可以收成一行标题。",
    "",
    "它读不到什么：风扇**没有电量统计属性、没有功率传感器、也没有「已运行多久」**，",
    "上面那些推算值就是这台设备能给的全部。想知道准确耗电，得在插座上加个计量插座。",
    "",
]
insert_before(lines, "窗口外观（透明外壳 / 圆角 / 底色）", FAN_SECTION, DOC)
# 上面那节自己的分隔线要紧挨着标题的横线之前 —— 插在标题行前面之后，
# 原来的横线正好落在新块的开头之前，视觉上仍然是一节的开始。
i = once(lines, "窗口外观（透明外壳 / 圆角 / 底色）", DOC)
if i is not None and not set(lines[i - 1]) <= set("─"):
    problems.append("使用说明.txt: 窗口外观那节的横线不见了（前一行为 %r）" % lines[i - 1][:40])

# 2c. 文件说明：补上风扇这条链路的文件
insert_after(lines, "login.py           小米云扫码登录", [
    "fan_collector.py   风扇采集器（Wi-Fi / miIO，由 server.js 自动启动；",
    "                   --probe 只连一次做自检，不进常态轮询）",
], DOC)
insert_after(lines, "vendor\\            第三方协议库（MIT 许可，取自 zuyan9/ha-cuk-ble）", [
    "vendor\\miio_lan.py 小米 miIO 局域网协议（风扇用：UDP 54321 + AES-128-CBC，",
    "                   只用标准库与 cryptography）",
], DOC)
insert_after(lines, "tools\\test_plug.js       插拔记账离线回归（插/拔/抖动不切断/充饱不算拔出/重启恢复），", [
    "tools\\test_fan_front.js  风扇链路离线回归（曲线窗口/区间按钮/read 真读/属性表对齐），",
    "67 项断言",
], DOC)
insert_after(lines, "data\\energy.json   用电量账本（按天分桶 + 每口分解 + 充电会话）", [
    "data\\fan.token     风扇的 IP + 16 字节密钥（登录小米云时写入；只写文件，不进命令行 ——",
    "                   命令行参数在任务管理器里人人可见）",
    "data\\fan.json      风扇采集器真正读的那份配置（同样含密钥，别外传）",
    "data\\fan-energy.json  风扇用电量账本（推算值，单独一本，和上面那本互不干扰）",
    "data\\fan-history-min.jsonl  风扇每分钟一行（保留 30 天）",
], DOC)

# 2d. 排障：追加在文末（文末是天然的唯一锚点，不会插错位置）
lines = lines + [
    "",
    "* 风扇卡片一直显示「待登录」：点一次右上角「登录小米云」扫码即可 —— 同一次扫码会把",
    "  风扇的 IP 和密钥一起取回来（存 data\\fan.token）。如果充电头连上了、风扇还是「待登录」，",
    "  说明小米云返回的设备列表里没有它：确认这台风扇在**同一个小米账号**的米家 App 里，",
    "  并且它确实连着你家 Wi-Fi。",
    "* 风扇「局域网发现」一台都没扫到：这**很正常**，不是故障 —— 家里路由器一般不会转发",
    "  无线客户端之间的广播，而风扇的 Wi-Fi 为了省电还会休眠、漏掉广播。要看它在不在线，",
    "  请看卡片标题旁的链路状态；程序用的 IP 是登录时从云端设备列表取的。",
    "* 风扇控制点了没反应 / 一直写不进去：先看卡片标题旁是不是「已连接」。局域网里风扇的",
    "  Wi-Fi 会休眠，第一次连接可能要一两秒才唤醒；连续失败就点「连接自检」，它会连一次并",
    "  把**全部属性的读回值**列出来（连同超时/重传次数）—— 是「网络不通」还是「设备没这个",
    "  属性」一眼能分辨。",
    "* 风扇换了 IP（换了路由器、重装过米家）：再扫码登录一次就会拿到新 IP；",
    "  也可以直接看 data\\fan.token 里的 ip 字段。",
    "* 风扇的用电量只是个大概：这台风扇没有任何电参量属性可读，瓦数按档位推算",
    "  （额定功率可在「风扇设置」里按包装上的值改），对不上电表。",
    "* 风扇卡片收起来了、想找回来：卡片标题右侧的「收起 / 展开」按钮（收起状态会记住，",
    "  重开窗口还是收着的）。",
]
write(DOC, CRLF.join(lines), "gbk")
for probe in ["小米电风扇（Wi-Fi 设备）", "data\\fan.token", "tools\\test_fan_front.js",
              "fan_collector.py   风扇采集器", "局域网发现」一台都没扫到"]:
    need(lines, probe, DOC)

# ============================================================ 3. 首次使用.txt
print("=== 3. 首次使用.txt (GBK) ===")
NEWBIE = "首次使用.txt"
lines = read(NEWBIE, "gbk").split(CRLF)
print("  原文 %d 行，前几行：" % len(lines))
for l in lines[:6]:
    print("    " + l)
# 只在扫码那一步后面补一句：一次扫码顺手把风扇的钥匙也拿了。
anchor = None
for l in lines:
    if "登录小米云" in l:
        anchor = l
        break
if anchor is None:
    problems.append("首次使用.txt: 找不到「登录小米云」那一步")
else:
    insert_after(lines, anchor, [
        "   （同一次扫码还会把**小米电风扇**的局域网 IP 和密钥一起取回来 ——",
        "    风扇是 Wi-Fi 设备，不占蓝牙，和充电头共用一个界面，见《使用说明》"
        "「小米电风扇」一节。）",
    ], NEWBIE)
    write(NEWBIE, CRLF.join(lines), "gbk")

# ============================================================ 4. 软件介绍.md
print("=== 4. 软件介绍.md (UTF-8) ===")
INTRO = "软件介绍.md"
lines = read(INTRO, "utf-8").split(CRLF)

# 4a. 版本号
i = once(lines, "**版本 %s ｜ 便携免安装 ｜ Windows 10 / 11**" % OLD_VER, INTRO)
if i is not None:
    lines[i] = "**版本 %s ｜ 便携免安装 ｜ Windows 10 / 11**" % NEW_VER

# 4b. 「一句话说明」后面加一句：现在还并了一台风扇进来
i = once_prefix(lines, "把酷态科 10 号 Ultra（CUKTECH AD1204U）充电头的蓝牙数据完整搬到电脑上：", INTRO)
if i is not None:
    lines[i + 1:i + 1] = [
        "",
        "v1.9.0 起，家里的**小米电风扇**（Wi-Fi / miIO 设备）也并了进来 —— 同一个界面、同一个任务栏图标：",
        "看**推算**功率与用电量曲线，开关、无级调速、风型、摆风、定时、指示灯、提示音、童锁都能反向控制。",
        "它**不占蓝牙**，和充电头、温湿度计互不干扰。",
    ]

# 4c. 新版号里的新节：插在「用电量统计」之前，后面几节顺延
FAN_MD = [
    "### 5. 小米电风扇（Wi-Fi 设备）",
    "",
    "界面里还有一张「小米电风扇」卡片，读的是家里的米家直流变频落地扇（`dmaker.fan.p5` 这一类）。",
    "它**和上面几台设备走的完全是另一条路**：",
    "",
    "- 充电头与温湿度计是**蓝牙**设备；风扇是 **Wi-Fi（miIO）** 设备 —— 走家里的局域网 UDP 直连",
    "  （端口 54321，AES-128-CBC 加密），**不经过米家云**。",
    "- 所以风扇**不占蓝牙**：电脑连着充电头的时候，风扇照常能读能控；手机米家也能同时控制它",
    "  （不用像充电头那样「让位」）。它由独立的采集器进程 `fan_collector.py` 采集，同样是「可失败」设计：",
    "  风扇连不上只是这张卡灰掉，蓝牙那两台一点都不受影响。",
    "- **不用单独登录**：点一次右上角「登录小米云」扫码，同一次授权会把充电头的 12 字节蓝牙密钥",
    "  **和**风扇的局域网 IP + 16 字节密钥一起取回来，分别存 `data\\cuktech.token` 与 `data\\fan.token`",
    "  （风扇那份还带 IP、MAC、设备名）。",
    "- **推算功率与用电量**：这台风扇**没有任何电参量属性可读**（规格表逐项核过），所以「多少瓦」是按",
    "  「额定功率 × 档位比例 × 自然风系数」推算出来的，界面上带「推算」二字；今日 / 累计 / 本次运行",
    "  三格电量是对它做时间积分 —— 用来比个大概（比如「开一晚上大概多少电」），**对不上电表**。",
    "  额定功率可在卡片底部「风扇设置」里按包装上的值改（默认 15 W）。",
    "- **推算功率曲线**：区间按钮和功率、温湿度那两条共用（1 分钟 ~ 30 天）；空档处断开连线、不补 0。",
    "  风扇的分钟行只保留 30 天，所以它的按钮行里**没有**「90 天 / 半年 / 1 年 / 全部」那几档（那是温度专用的）。",
    "- **反向控制**：开关、无级调速（1~100 滑条）、档位（1~4）、风型（自然风 / 直吹风）、左右摆风、",
    "  摆风夹角（30/60/90/120/140 度）、定时（0~480 分钟）、指示灯、提示音、童锁。",
    "  **每一次写入都会回读确认** —— 界面上的开关状态是设备读回来的值，不是「我以为写成功了」。",
    "  写入期间开关会变半透明（同一时刻只发一条命令），卡片里会写一句「… → 回读 X，一致」。",
    "- **设置与自检**：轮询间隔（默认 2 秒，可调 0.5~30）、额定功率、「连接自检」（连一次、把全部属性",
    "  读回来就退出，不进常态轮询）、「局域网发现」（广播一轮看网上有哪些 miIO 设备 —— 只能确认它",
    "  在不在网上，拿不到密钥，所以它**不是**判断风扇在不在线的依据，见下面排障）。",
    "- **风扇原始属性**：值不经过任何换算，出问题时能一眼分清「设备没回」还是「界面没画」；末尾还带",
    "  通信计数（超时 / 重传次数，一直涨说明网络或设备不稳）。卡片标题右侧的「收起 / 展开」和温度计",
    "  那张一样：用不上风扇时可以收成一行标题。",
    "",
    "它读不到什么：风扇**没有电量统计属性、没有功率传感器、也没有「已运行多久」**，上面那些推算值",
    "就是这台设备能给的全部。想知道准确耗电，得在插座上加个计量插座。",
    "",
]
insert_before(lines, "### 5. 用电量统计", FAN_MD, INTRO)
for old, new in [
    ("### 5. 用电量统计", "### 6. 用电量统计"),
    ("### 6. 桌面集成", "### 7. 桌面集成"),
    ("### 7. 让位给手机米家", "### 8. 让位给手机米家"),
]:
    j = once(lines, old, INTRO)
    if j is not None:
        lines[j] = new

# 4d. 技术实现表：后端行数更新 + 补风扇那条链路
i = once_prefix(lines, "| 后端 |", INTRO)
if i is not None:
    lines[i] = lines[i].replace("约 1800 行", "约 4000 行")
i = once_prefix(lines, "| 采集器 |", INTRO)
if i is not None:
    lines[i + 1:i + 1] = [
        "| 风扇采集器 | `fan_collector.py` + `vendor/miio_lan.py`：Wi-Fi 局域网（miIO / UDP 54321 + AES-128-CBC），"
        "与蓝牙链路互不影响；`--probe` 只连一次做自检，不进常态轮询 |",
    ]

# 4e. 已知边界：诚实写上风扇读不到什么
i = once_prefix(lines, "| 其他型号的充电头 |", INTRO)
if i is not None:
    lines[i + 1:i + 1] = [
        "| 读风扇的准确功率 / 电量 | 这台风扇的属性表里**没有任何电参量**（规格逐项核过：没有功率传感器、"
        "没有电量统计、也没有「已运行多久」）。界面上的瓦数与用电量是按「额定功率 × 档位比例 × 自然风系数」"
        "推算的，只能比个大概 |",
        "| 靠广播找风扇 | 家里路由器一般不转发无线客户端之间的广播，风扇的 Wi-Fi 为省电还会休眠漏包 —— "
        "「局域网发现」扫到 0 台**不代表离线**，判断在线请看卡片上的链路状态 |",
    ]

write(INTRO, CRLF.join(lines), "utf-8")
for probe in ["### 5. 小米电风扇（Wi-Fi 设备）", "### 6. 用电量统计", "### 7. 桌面集成",
              "### 8. 让位给手机米家", "风扇采集器", "读风扇的准确功率 / 电量", NEW_VER]:
    need(lines, probe, INTRO)
# 正文里还有「v1.8.23 起…」这种历史陈述，不能按"出现旧版本号"来判 —— 只认页头那一行。
if not any(l.startswith("**版本 %s ｜" % NEW_VER) for l in lines):
    problems.append("%s: 页头版本号没改成 %s" % (INTRO, NEW_VER))

# ============================================================ 5. 软件介绍.html
print("=== 5. 软件介绍.html (UTF-8) ===")
HTML = "软件介绍.html"
lines = read(HTML, "utf-8").split(CRLF)

# 5a. 版本号（页头徽章 + 页脚那句一直没跟着升，顺手对齐）
i = once_prefix(lines, "      <span>版本 ", HTML)
if i is not None:
    lines[i] = "      <span>版本 %s</span>" % NEW_VER
i = once_prefix(lines, "  <footer>酷态科 10 号 Ultra", HTML)
if i is not None:
    lines[i] = lines[i].replace("v1.5.2", "v" + NEW_VER)

# 5b. 「一句话说明」后面补一段
i = find_block(lines, ["    开关端口、逐口开关快充协议、切场景模式、改息屏设置。", "  </p>"], HTML)
if i is not None:
    lines[i + 2:i + 2] = [
        "  <p class=\"muted\">",
        "    v1.9.0 起，家里的<strong>小米电风扇</strong>（Wi-Fi / miIO 设备）也并了进来 —— 同一个界面、同一个任务栏图标：",
        "    看<strong>推算</strong>功率与用电量曲线，开关、无级调速、风型、摆风、定时、指示灯、提示音、童锁都能反向控制。",
        "    它<strong>不占蓝牙</strong>，和充电头、温湿度计互不干扰。",
        "  </p>",
    ]

# 5c. 功能总览里插一张风扇卡：放在「用电量统计」那张卡之前（即环境温度卡之后）
FAN_CARD = [
    "    <div class=\"card\">",
    "      <h4><span class=\"dot\"></span>小米电风扇（Wi-Fi 设备）</h4>",
    "      <ul>",
    "        <li>读的是家里的米家直流变频落地扇（<code>dmaker.fan.p5</code> 这一类）。它走<b>另一条路</b>：充电头与温湿度计是<b>蓝牙</b>，风扇是 <b>Wi-Fi（miIO）</b> —— 局域网 UDP 直连（端口 54321，AES-128-CBC 加密），<b>不经过米家云</b></li>",
    "        <li><b>不占蓝牙</b>：电脑连着充电头时风扇照常能读能控，手机米家也能同时控制它（不用像充电头那样「让位」）。由独立的 <code>fan_collector.py</code> 采集，同样是「可失败」设计 —— 风扇连不上只是这张卡灰掉，蓝牙那两台一点不受影响</li>",
    "        <li><b>不用单独登录</b>：点一次右上角「登录小米云」扫码，同一次授权会把充电头的 12 字节蓝牙密钥<b>和</b>风扇的局域网 IP + 16 字节密钥一起取回来，分别存 <code>data\\cuktech.token</code> 与 <code>data\\fan.token</code></li>",
    "        <li><b>推算功率与用电量</b>：这台风扇<b>没有任何电参量属性可读</b>（规格表逐项核过），所以「多少瓦」是按「额定功率 × 档位比例 × 自然风系数」推算的，界面上标明「推算」二字；今日 / 累计 / 本次运行三格电量是对它做时间积分 —— 用来比个大概（「开一晚上大概多少电」），<b>对不上电表</b>。额定功率可在卡片底部「风扇设置」里按包装上的值改（默认 15 W）</li>",
    "        <li><b>推算功率曲线</b>：区间按钮与功率、温湿度那两条共用（1 分钟 ~ 30 天）；空档处断开连线、不补 0。风扇的分钟行只保留 30 天，所以它的按钮行里<b>没有</b>「90 天 / 半年 / 1 年 / 全部」那几档（那是温度专用的）</li>",
    "        <li><b>反向控制</b>：开关、无级调速（1~100 滑条）、档位（1~4）、风型（自然风 / 直吹风）、左右摆风、摆风夹角（30 / 60 / 90 / 120 / 140 度）、定时（0~480 分钟）、指示灯、提示音、童锁。<b>每一次写入都会回读确认</b> —— 界面上的开关状态是设备读回来的值，不是「我以为写成功了」；写入期间开关变半透明（同一时刻只发一条命令），卡片里会写一句「… → 回读 X，一致」</li>",
    "        <li><b>设置与自检</b>：轮询间隔（默认 2 秒，可调 0.5~30）、额定功率、<b>「连接自检」</b>（连一次、把全部属性读回来就退出，不进常态轮询）、<b>「局域网发现」</b>（广播一轮看网上有哪些 miIO 设备 —— 只能确认它在不在网上，拿不到密钥，所以它<b>不是</b>判断在线与否的依据）</li>",
    "        <li><b>风扇原始属性</b>：值不经过任何换算，出问题时能一眼分清「设备没回」还是「界面没画」；末尾带通信计数（超时 / 重传，一直涨说明网络或设备不稳）。卡片标题右侧的<b>「收起 / 展开」</b>和温度计那张一样，用不上时可以收成一行标题</li>",
    "        <li>它读不到什么：风扇<b>没有电量统计属性、没有功率传感器、也没有「已运行多久」</b>，上面这些推算值就是这台设备能给的全部。想知道准确耗电，得在插座上加个计量插座</li>",
    "      </ul>",
    "    </div>",
    "",
]
insert_before_block(lines, ["    <div class=\"card\">",
                            "      <h4><span class=\"dot\"></span>用电量统计</h4>"], FAN_CARD, HTML)

# 5d. 技术实现表：后端行数更新 + 补风扇那条链路
i = once_prefix(lines, "      <tr><td>后端</td>", HTML)
if i is not None:
    lines[i] = lines[i].replace("约 1800 行", "约 4000 行")
i = once_prefix(lines, "      <tr><td>采集器</td>", HTML)
if i is not None:
    lines[i + 1:i + 1] = [
        "      <tr><td>风扇采集器</td><td><code>fan_collector.py</code> + <code>vendor/miio_lan.py</code>：走 Wi-Fi 局域网（miIO / UDP 54321 + AES-128-CBC），与蓝牙链路互不影响；<code>--probe</code> 只连一次做自检，不进常态轮询</td></tr>",
    ]

# 5e. 已知边界：补两行
i = once_prefix(lines, "      <tr><td>其他型号的充电头</td>", HTML)
if i is not None:
    lines[i + 1:i + 1] = [
        "      <tr><td>读风扇的准确功率 / 电量</td><td>这台风扇的属性表里<strong>没有任何电参量</strong>（规格逐项核过：没有功率传感器、没有电量统计、也没有「已运行多久」）。界面上的瓦数与用电量是按「额定功率 × 档位比例 × 自然风系数」推算的，只能比个大概</td></tr>",
        "      <tr><td>靠广播找风扇</td><td>家里路由器一般不转发无线客户端之间的广播，风扇的 Wi-Fi 为省电还会休眠漏包 —— 「局域网发现」扫到 0 台<strong>不代表离线</strong>，判断在线请看卡片上的链路状态</td></tr>",
    ]

write(HTML, CRLF.join(lines), "utf-8")
for probe in ["小米电风扇（Wi-Fi 设备）", "风扇采集器", "读风扇的准确功率 / 电量", NEW_VER]:
    need(lines, probe, HTML)
# 同上：正文里有「v1.8.23 起…」的历史陈述，只认徽章那一行 + 页脚。
if not any(l.strip() == "<span>版本 %s</span>" % NEW_VER for l in lines):
    problems.append("%s: 页头徽章版本号没改成 %s" % (HTML, NEW_VER))
if not any(("v%s" % NEW_VER) in l for l in lines if l.startswith("  <footer>")):
    problems.append("%s: 页脚版本号没跟着改" % HTML)

# ============================================================ 收尾
print()
if problems:
    print("!! %d 处问题：" % len(problems))
    for p in problems:
        print("   - " + p)
    sys.exit(1)
print("全部完成，四份文件都没问题。")
sys.exit(0)
