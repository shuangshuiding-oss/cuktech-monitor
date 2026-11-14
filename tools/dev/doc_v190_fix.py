"""修 doc_v190.py 这次插入留下的三处版式问题（+ 一处 v1.7.0 起就有的既有损坏）。

现象与原因：
  1. 使用说明.txt 里「小米电风扇」那节上面的分隔线是 92 字（本该属于下一节
     「窗口外观」），而「窗口外观」自己反而没了上边线。
     → 原因：doc_v190.py 把新节插在「窗口外观」标题之前，正好卡在它原有的分隔线后面。
     本节约定是 46 字（见文件里其它各节）。
  2. 工具清单里 tools\\test_fan_front.js 被插到了 tools\\test_plug.js 的说明和它的
     「90 项断言」续行之间，而且续行没缩进 —— 读起来两行都串了。
  3. 首次使用.txt 里用了 ** 加粗，但那份文件通篇是纯文本、没有 markdown 记号。
  4. 【既有，非本次】「tools\\check_liquid.js    界面外观（液态玻璃）…」被 v1.7.0 的
     sync_docs_v170.ps1 从中间劈成两行（那脚本拿 'tools\\check_liquid.js' 当前缀替换，
     结果 env_probe 那条插进了说明文字前面）。顺手恢复成两条完整的。

铁律：使用说明.txt / 首次使用.txt = GBK + CRLF + 无 BOM。只做整段替换，不按行号切。
四处修改都带"已经改过就跳过"的判断，可以反复跑。

用法: python tools/dev/doc_v190_fix.py
"""
import io
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
CRLF = "\r\n"
SEP46 = "─" * 46
ROWS = "─" * 92
ENV_PROBE_DESC = "探温度计广播（env_sensor.py --probe）"
LIQUID_DESC = "界面外观（液态玻璃）规则自检：无描边/内高光/分层投影/模糊预算/降级兜底"
problems = []


def rd(name, enc):
    return io.open(ROOT / name, encoding=enc, newline="").read()


def wr(name, text, enc):
    data = text.encode(enc)
    if data.count(b"\r") != data.count(b"\n"):
        problems.append("%s: CR/LF 不等" % name)
    if data[:3] == b"\xef\xbb\xbf":
        problems.append("%s: 不该有 BOM" % name)
    if data.decode(enc) != text:
        problems.append("%s: %s 来回不一致" % (name, enc))
    (ROOT / name).write_bytes(data)
    print("写回 %-14s %4d 行 %6d 字节 (%s)" % (name, text.count(CRLF) + 1, len(data), enc))


def idx_of(lines, pred, what, quiet=False):
    hits = [i for i, l in enumerate(lines) if pred(l)]
    if len(hits) != 1:
        if not quiet:
            problems.append("找不到唯一锚点「%s」（命中 %d 处）" % (what, len(hits)))
        return None
    return hits[0]


def is_sep(l):
    return bool(l) and set(l) <= set("─")


def head_ws(l):
    return l[:len(l) - len(l.lstrip())]


# ============================================================ 使用说明.txt
DOC = "使用说明.txt"
lines = rd(DOC, "gbk").split(CRLF)
n0 = len(lines)
print("=== %s（原文 %d 行） ===" % (DOC, n0))

# ---- 1. 风扇节的分隔线：92 字的还给「窗口外观」，风扇节自己用 46 字 ----
k = idx_of(lines, lambda l: l == "小米电风扇（Wi-Fi 设备）", "小米电风扇标题")
if k is not None:
    a, b = lines[k - 2], lines[k - 1]
    if a == SEP46 and b == SEP46:
        del lines[k - 2]
        print("  → 风扇节上方两条 46 字分隔线合并成一条")
    elif b == SEP46:
        # 正常版式就是「空行 / 46 字分隔线 / 标题」，a 是空行也算对
        print("  风扇节上方 = %r（%d 字）+ 46 字分隔线，已正常，跳过" % (a[:8], len(a)))
    elif is_sep(a) and is_sep(b):
        lines[k - 2:k] = [SEP46]
        print("  → 风扇节上方两条分隔线（%d/%d 字）合成一条 46 字" % (len(a), len(b)))
    else:
        problems.append("%s: 风扇标题上面两行不对 → %r / %r" % (DOC, a[:20], b[:20]))

# ---- 2. 「窗口外观」补回上边线 ----
j = idx_of(lines, lambda l: l == "窗口外观（透明外壳 / 圆角 / 底色）", "窗口外观标题")
if j is not None:
    if lines[j - 1] == SEP46:
        print("  「窗口外观」上边线已就位，跳过")
    else:
        lines[j:j] = [SEP46]
        print("  → 给「窗口外观」补了一条 46 字上边线")

# ---- 3. 工具清单：把 test_fan_front 那两条移到 test_plug 的续行之后 ----
p = idx_of(lines, lambda l: l.startswith("tools\\test_plug.js"), "test_plug.js 行")
f = idx_of(lines, lambda l: l.startswith("tools\\test_fan_front.js"), "test_fan_front.js 行")
if p is not None and f is not None:
    if (f == p + 2 and lines[p + 1].strip() == "90 项断言"
            and lines[p + 3].strip() == "67 项断言"):
        print("  test_fan_front 已在 test_plug 的续行之后，跳过")
    elif f == p + 1:
        # 现状：p=plug 说明, p+1=fan 说明, p+2='67 项断言', p+3='90 项断言'
        if lines[p + 2].strip() != "67 项断言" or lines[p + 3].strip() != "90 项断言":
            problems.append("%s: 期望 p+2='67 项断言'、p+3='90 项断言'，实际 %r / %r"
                            % (DOC, lines[p + 2], lines[p + 3]))
        else:
            fan_desc = lines[p + 1]
            indent = head_ws(lines[p + 3])
            del lines[p + 1:p + 3]
            lines[p + 2:p + 2] = [fan_desc, indent + "67 项断言"]
            print("  → test_fan_front 那两条移到 test_plug 的「90 项断言」之后，续行缩进 %d 空格" % len(indent))
    else:
        problems.append("%s: test_plug 在 %d、test_fan_front 在 %d，位置不是预期的两种之一" % (DOC, p, f))

# ---- 4. 既有损坏：check_liquid.js 那行被劈开了，恢复成两条 ----
m = idx_of(lines, lambda l: ENV_PROBE_DESC in l, "env_probe 那条")
if m is not None:
    if lines[m].startswith("tools\\env_probe") and lines[m - 1].startswith("tools\\check_liquid.js"):
        print("  check_liquid / env_probe 已是两条完整行，跳过")
    elif lines[m - 1] != "tools\\check_liquid.js":
        problems.append("%s: env_probe 那条的上一行不是 tools\\check_liquid.js → %r" % (DOC, lines[m - 1]))
    elif LIQUID_DESC not in lines[m]:
        problems.append("%s: 劈开的说明文字不是液态玻璃那条 → %r" % (DOC, lines[m][:40]))
    else:
        lines[m - 1:m + 1] = [
            "tools\\check_liquid.js    " + LIQUID_DESC,
            "tools\\env_probe          " + ENV_PROBE_DESC,
        ]
        print("  → check_liquid.js / env_probe 两条恢复成完整行")

wr(DOC, CRLF.join(lines), "gbk")
print("  %d 行 → %d 行" % (n0, len(lines)))

# ---- 验收 ----
for probe in ["小米电风扇（Wi-Fi 设备）", "窗口外观（透明外壳 / 圆角 / 底色）",
              "tools\\check_liquid.js    " + LIQUID_DESC,
              "tools\\env_probe          " + ENV_PROBE_DESC,
              "tools\\test_fan_front.js  风扇链路离线回归"]:
    if not any(probe in l for l in lines):
        problems.append("%s: 缺「%s」" % (DOC, probe[:40]))
if any(l == ROWS for l in lines):
    problems.append("%s: 还剩着 92 字的旧分隔线" % DOC)
for i, l in enumerate(lines):
    if is_sep(l) and i + 1 < len(lines) and is_sep(lines[i + 1]):
        problems.append("%s: 第 %d/%d 行出现连续两条分隔线" % (DOC, i + 1, i + 2))
# 风扇节应当是 sep(46) / 标题 / sep(46) / 正文
if k is not None:
    kk = idx_of(lines, lambda l: l == "小米电风扇（Wi-Fi 设备）", "小米电风扇标题", quiet=True)
    if kk is not None:
        shape = (len(lines[kk - 1]), len(lines[kk]), len(lines[kk + 1]))
        print("  风扇节版式：上边线 %d 字 / 标题 %d 字 / 下边线 %d 字" % shape)
        if lines[kk - 1] != SEP46 or lines[kk + 1] != SEP46:
            problems.append("%s: 风扇节上下边线不是 46 字" % DOC)

# ============================================================ 首次使用.txt
NEWBIE = "首次使用.txt"
print("=== %s ===" % NEWBIE)
t = rd(NEWBIE, "gbk")
if "**小米电风扇**" in t:
    t = t.replace("**小米电风扇**", "小米电风扇")
    wr(NEWBIE, t, "gbk")
    print("  → 去掉了 markdown 加粗记号（这份是纯文本）")
else:
    print("  没有 ** 记号，跳过")
if "**" in t:
    problems.append("%s: 还留着 markdown 加粗记号" % NEWBIE)

print()
if problems:
    print("!! %d 处问题：" % len(problems))
    for x in problems:
        print("   - " + x)
    sys.exit(1)
print("检查完毕，两份都是 GBK + CRLF + 无 BOM。")
