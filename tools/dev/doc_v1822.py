"""v1.8.22 文档更新（含版本号）：修「PID 被回收 → 双击打不开」+ 顺手去掉说明文档里的一段重复。

背景（2026-10-09 用户报「我电脑上的打不开了」）：
  服务（pid 17372）下午退出，Windows 把该 pid 回收给了 msedgewebview2.exe。
  于是接管判据里的 `pidAlive` 一直为真 ⇒ 每次双击都判成"已在运行" ⇒ 只弹一个指向死端口的
  空壳窗口 ⇒ 用户看到"打不开"。v1.8.22 加了心跳文件（alive.json）作为第二证据。

用法: python tools/dev/doc_v1822.py
"""
import pathlib
import shutil
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
CRLF = "\r\n"
changed = 0


def load(name, enc):
    return (ROOT / name).read_bytes().decode(enc).replace(CRLF, "\n").replace("\r", "\n")


def save(name, s, enc):
    (ROOT / name).write_bytes(s.replace("\n", CRLF).encode(enc))


def sub1(s, old, new, tag):
    if s.count(old) != 1:
        print("  !! %s 命中 %d 次，跳过" % (tag, s.count(old)))
        return s, False
    print("  ok", tag)
    return s.replace(old, new), True


# ───────────────────────────── 1) 版本号
p = ROOT / 'version.json'
s = p.read_bytes().decode('utf-8')
s2, ok = sub1(s, '"version": "1.8.21"', '"version": "1.8.22"', 'version.json')
if ok:
    p.write_bytes(s2.encode('utf-8'))
    changed += 1

# ───────────────────────────── 2) 使用说明.txt（GBK + 整篇 CRLF）
DOC = '使用说明.txt'
bak = ROOT / (DOC + '.bak-v1822')
if not bak.exists():
    shutil.copyfile(ROOT / DOC, bak)
    print('  ok 备份 →', bak.name)

s = load(DOC, 'gbk')
lines = s.split('\n')

KEY = '   · 如果软件**其实已经在跑**'
TAIL = '要升级到新版'
starts = [i for i, l in enumerate(lines) if l.startswith(KEY)]
if len(starts) != 2:
    print('  !! 「已经在跑」那段命中 %d 次（期望正好 2 段重复），跳过' % len(starts))
else:
    ends = []
    for st in starts:
        e = None
        for j in range(st, min(st + 12, len(lines))):
            if TAIL in lines[j]:
                e = j
                break
        ends.append(e)
    if None in ends or starts[1] != ends[0] + 1:
        print('  !! 两段的边界对不上（starts=%r ends=%r），跳过' % (starts, ends))
    else:
        NEW = [
            '   · 如果软件**其实已经在跑**（窗口被关了、只剩任务栏里那个功率图标），双击不会再起',
            '     第二个 —— 它会把已有窗口直接唤到前面，启动窗口里会显示「软件本来就在运行」。',
            '     （v1.8.6 起。之前这种情况下会去抢占端口、报「服务未能在 15 秒内启动」，',
            '     看着就是"双击没反应/打不开"。）',
            '   · 要升级到新版：先右键任务栏图标选「退出」，再双击一次 —— 否则开着的一直是旧版。',
            '   · 双击**完全没反应**（连启动窗口都不弹、任务栏也没有功率图标）：看 data\\app.log 最后几行。',
            '     v1.8.22 起会写清是哪一种情况 —— 出现「残留的 running.lock 指向 pid …（进程已退出或',
            '     pid 被回收）→ 按新实例启动」就说明它已认出那是**残留记录**，会照常启动。',
            '     历史坑：服务意外退出后，Windows 会把它的 pid **回收给别的程序**，于是老版本每次',
            '     双击都误判成"软件还在跑"、只弹一个空窗口 —— 2026-10-09 修掉的就是这个。',
            '     真卡住时的兜底：删掉 data\\running.lock（若 data\\alive.json 还在也一并删），再双击一次。',
        ]
        lines[starts[0]:ends[1] + 1] = NEW
        s = '\n'.join(lines)
        print('  ok 使用说明：去掉重复段并补上"打不开"的排查（%d 行 → %d 行）'
              % (ends[1] - starts[0] + 1, len(NEW)))
        changed += 1

# ───────────────────────────── 3) 软件介绍.md / .html 版本号
s2 = load('软件介绍.md', 'utf-8')
s2, o1 = sub1(s2, '**版本 1.8.21 ｜', '**版本 1.8.22 ｜', 'md 版本号')
if o1:
    save('软件介绍.md', s2, 'utf-8')
    changed += 1

s2 = load('软件介绍.html', 'utf-8')
s2, o1 = sub1(s2, '<span>版本 1.8.21</span>', '<span>版本 1.8.22</span>', 'html 版本号')
if o1:
    save('软件介绍.html', s2, 'utf-8')
    changed += 1

if changed:
    save(DOC, s, 'gbk')

print('changed =', changed)
if not changed:
    sys.exit(2)
