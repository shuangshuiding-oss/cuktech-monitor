# -*- coding: utf-8 -*-
"""v1.8.6 文档与版本号更新：单实例接管（双击快捷方式打不开的修复）。

可重复执行（幂等）：找得到锚点就改，改过就跳过。
用法: python tools/dev/doc_v186.py
"""
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
CRLF = '\r\n'


def load(name, enc, force_crlf=False):
    p = ROOT / name
    b = p.read_bytes()
    s = b.decode(enc)
    if force_crlf:
        s = s.replace('\r\n', '\n').replace('\n', '\r\n')
    return p, s


def save(p, s, enc):
    p.write_bytes(s.encode(enc))


def sub1(s, old, new, tag):
    n = s.count(old)
    if n != 1:
        print('  !! %s 锚点命中 %d 次，跳过' % (tag, n))
        return s, False
    print('  ok %s' % tag)
    return s.replace(old, new), True


changed = 0

# ---------------------------------------------------------------- version.json
p, s = load('version.json', 'utf-8')
s2, ok = sub1(s, '"version": "1.8.5"', '"version": "1.8.6"', 'version.json 1.8.6')
if ok:
    save(p, s2, 'utf-8')
    changed += 1

# ------------------------------------------------------- 使用说明.txt（GBK+CRLF）
p, s = load('使用说明.txt', 'gbk', force_crlf=True)
old = CRLF.join([
    '1. 双击「启动酷态科10号Ultra.bat」。',
    '   首次会打开应用窗口（浏览器 app 模式：无地址栏、无标签页，观感等同原生程序）。',
]) 
new = CRLF.join([
    '1. 双击「启动酷态科10号Ultra.bat」。',
    '   首次会打开应用窗口（浏览器 app 模式：无地址栏、无标签页，观感等同原生程序）。',
    '   · 如果软件**其实已经在跑**（窗口被关了、只剩任务栏里那个功率图标），双击不会再起',
    '     第二个 —— 它会把已有窗口直接唤到前面，启动窗口里会显示「软件本来就在运行」。',
    '     （v1.8.6 起。之前这种情况下会去抢占端口、报「服务未能在 15 秒内启动」，',
    '     看着就是"双击没反应/打不开"。）',
    '   · 要升级到新版：先右键任务栏图标选「退出」，再双击一次 —— 否则开着的一直是旧版。',
]) 
s2, ok = sub1(s, old, new, '使用说明 怎么用')
if ok:
    save(p, s2, 'gbk')
    changed += 1

# ------------------------------------------------------------ 软件介绍.md
# ⚠️ md/html 都是 CRLF 存盘，锚点里必须用 CRLF，否则一行都匹配不上（踩过）。
p, s = load('软件介绍.md', 'utf-8', force_crlf=True)
s2, ok1 = sub1(s, '**版本 1.8.5 ｜ 便携免安装 ｜ Windows 10 / 11**',
               '**版本 1.8.6 ｜ 便携免安装 ｜ Windows 10 / 11**', 'md 版本号')
anchor = ('- **开机自启动**（可选，默认关闭）：往当前用户的「启动」文件夹放一个快捷方式，'
          '不改注册表、不需要管理员权限，界面上选回「关闭」即可撤销。' + CRLF)
add = ('- **双击就是启动，也是"唤回"**：如果软件其实已经在跑（窗口被关了、只剩任务栏里的功率图标），'
       '双击不会另起一个实例 —— 它把已有窗口唤到前面，启动窗口里写明「软件本来就在运行」。'
       '要从旧版升级，先右键任务栏图标选「退出」再双击。' + CRLF)
s3, ok2 = sub1(s2, anchor, anchor + add, 'md 桌面集成补一条')
if ok1 or ok2:
    save(p, s3, 'utf-8')
    changed += 1

# ------------------------------------------------------------ 软件介绍.html
p, s = load('软件介绍.html', 'utf-8', force_crlf=True)
s2, ok1 = sub1(s, '<span>版本 1.8.5</span>', '<span>版本 1.8.6</span>', 'html 版本号')
anchor = '        <li>开机自启动可选，放启动文件夹，不改注册表</li>' + CRLF
add = ('        <li><b>双击就是启动</b>：软件已经在跑时（窗口被关了、只剩任务栏图标），'
       '双击不会另起一个实例，而是把已有窗口<b>唤到前面</b>；要升级先右键任务栏图标选「退出」</li>' + CRLF)
s3, ok2 = sub1(s2, anchor, anchor + add, 'html 桌面集成补一条')
if ok1 or ok2:
    save(p, s3, 'utf-8')
    changed += 1

print('完成，改了 %d 处文件' % changed)
