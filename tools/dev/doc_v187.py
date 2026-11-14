# -*- coding: utf-8 -*-
"""v1.8.7 文档与版本号更新：页头（登录/蓝牙信号那栏）也改成圆角玻璃条。

可重复执行（幂等）。
用法: python tools/dev/doc_v187.py
"""
import pathlib

ROOT = pathlib.Path(__file__).resolve().parents[2]
CRLF = '\r\n'


def load(name, enc):
    p = ROOT / name
    s = p.read_bytes().decode(enc).replace('\r\n', '\n').replace('\n', '\r\n')
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
s2, ok = sub1(s, '"version": "1.8.6"', '"version": "1.8.7"', 'version.json 1.8.7')
if ok:
    save(p, s2, 'utf-8')
    changed += 1

# ------------------------------------------------------- 使用说明.txt（GBK）
p, s = load('使用说明.txt', 'gbk')
old = CRLF.join([
    '* 顶栏是贴在窗口顶部的一条**圆角玻璃条**（v1.8.5 起下两角也是圆的）：页面滚动时内容',
    '  会从它下面经过并被模糊；按住空白处可以拖动窗口。',
])
new = CRLF.join([
    '* 窗口顶部有**两条贴边的圆角玻璃条**（v1.8.5 起；v1.8.7 把下面那条也补成圆角）：',
    '  最上面的是拖动条（标题 + 透明度/主题/尺寸/最小化/全屏/关闭），它下面的是页头',
    '  （设备名 + 连接状态 + 蓝牙信号 + 登录小米云/重连/让位给手机/退出）。',
    '  页面滚动时内容会从它们下面经过并被模糊；按住拖动条的空白处可以拖动窗口。',
])
s2, ok = sub1(s, old, new, '使用说明 界面外观')
if ok:
    save(p, s2, 'gbk')
    changed += 1

# ------------------------------------------------------------ 软件介绍.md
p, s = load('软件介绍.md', 'utf-8')
s2, ok1 = sub1(s, '**版本 1.8.6 ｜ 便携免安装 ｜ Windows 10 / 11**',
               '**版本 1.8.7 ｜ 便携免安装 ｜ Windows 10 / 11**', 'md 版本号')
old = ('- 顶栏是贴边的一条**圆角玻璃条**（v1.8.5 起下两角也是圆的），'
       '页面内容会从它下面滚过去并被模糊（全页只有这一处大模糊 —— 同屏几十块毛玻璃会掉帧）。' + CRLF)
new = ('- 窗口顶部有**两条贴边的圆角玻璃条**（v1.8.5 起；v1.8.7 把页头那条也补上了）：'
       '最上面是拖动条（标题 + 透明度/主题/尺寸/最小化等），下面是页头'
       '（设备名 + 连接状态 + 信号 + 登录/重连/让位/退出）；'
       '页面内容会从它们下面滚过去并被模糊（全页只有这一处大模糊 —— 同屏几十块毛玻璃会掉帧）。' + CRLF)
s3, ok2 = sub1(s2, old, new, 'md 圆角条文案')
if ok1 or ok2:
    save(p, s3, 'utf-8')
    changed += 1

# ------------------------------------------------------------ 软件介绍.html
p, s = load('软件介绍.html', 'utf-8')
s2, ok1 = sub1(s, '<span>版本 1.8.6</span>', '<span>版本 1.8.7</span>', 'html 版本号')
anchor = ('        <li><b>磨砂固定开</b>（v1.8.2 删掉了开关）：'
          '窗外糊成柔和底色 + 系统圆角；观感强弱用右上角<b>透明度滑块</b>调（往左更透、往右更实）</li>' + CRLF)
add = ('        <li>窗口顶部<b>两条贴边的圆角玻璃条</b>（拖动条 + 页头），'
       '页面内容从它们下面滚过时被模糊</li>' + CRLF)
s3, ok2 = sub1(s2, anchor, anchor + add, 'html 圆角条补一条')
if ok1 or ok2:
    save(p, s3, 'utf-8')
    changed += 1

print('完成，改了 %d 处文件' % changed)
