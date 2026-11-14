"""v1.8.4 文档更新：覆盖语义从"覆盖区间内的本机采样"改成"本机的旧数据一条都不留"。

用户 2026-10-06 两次说明："读取历史数据之后，把之前所有数据覆盖"。
三份文档里凡是解释这条语义的地方都要改，并把版本号 1.8.3 → 1.8.4。

用法: python tools/dev/doc_v184.py
"""
from __future__ import annotations

import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
CRLF = '\r\n'
stats = []


def load(name: str, enc: str) -> str:
    s = (ROOT / name).read_bytes().decode(enc)
    if s.count('\n') - s.count(CRLF):
        print('%s 里有裸 LF' % name)
        sys.exit(2)
    return s.replace(CRLF, '\n')


def save(name: str, s: str, enc: str) -> None:
    out = s.replace('\r\n', '\n').replace('\n', CRLF)
    data = out.encode(enc)
    (ROOT / name).write_bytes(data)
    stats.append('%-15s %6d 字节  CRLF %d' % (name, len(data), out.count(CRLF)))


def sub(text: str, old: str, new: str, tag: str) -> str:
    n = text.count(old)
    if n != 1:
        print('「%s」命中 %d 次：%s' % (tag, n, old[:56]))
        sys.exit(3)
    return text.replace(old, new)


# ------------------------------------------------------------ 使用说明.txt
t = load('使用说明.txt', 'gbk')
t = sub(
    t,
    '    **设备历史覆盖到的那段时间**里的本机采样丢掉，统一成设备这一种来源；比历史更新\n'
    '    的那些新读数（当前小时之后采的）照常保留。覆盖多少天、丢了多少条会写进提示和日志。',
    '    **本机自己采的读数一条都不留**（不管它落在哪个时间段），读完只剩设备内置历史这一套\n'
    '    来源；之后再采的新读数照常往后接。清掉多少条、重写/删除多少个按天文件都会写进日志。\n'
    '    注意：这是**不可逆**的 —— 本机 90 秒粒度的旧数据没了就是没了（想保住就先导出 CSV）。',
    '覆盖语义',
)
t = sub(t, '**读完历史 = 用它覆盖旧数据**（v1.8.2）', '**读完历史 = 用它覆盖旧数据**（v1.8.2 起，v1.8.4 改成彻底覆盖）', '标题')
save('使用说明.txt', t, 'gbk')

# ------------------------------------------------------------ 软件介绍.md
m = load('软件介绍.md', 'utf-8')
m = sub(
    m,
    '- **读完历史就覆盖旧数据（v1.8.2）**：设备每小时记的是该小时的最高/最低，本应用自己采的是 90 秒瞬时值，\n'
    '  两种粒度混着画会让「当日最低~最高」忽宽忽窄。因此读完历史会把**设备覆盖到的那段时间**的本机采样丢掉，\n'
    '  统一成设备一种来源（比历史更新的新读数照常保留）。',
    '- **读完历史就覆盖旧数据（v1.8.2 起，v1.8.4 彻底化）**：设备每小时记的是该小时的最高/最低，本应用自己采的是\n'
    '  90 秒瞬时值，两种粒度混着画会让「当日最低~最高」忽宽忽窄。因此读完历史会把**本机自己采的读数全部丢掉**，\n'
    '  只留设备内置历史这一套来源（之后新采的照常往后接）。',
    'md-覆盖',
)
m = m.replace('版本 1.8.3', '版本 1.8.4')
save('软件介绍.md', m, 'utf-8')

# ------------------------------------------------------------ 软件介绍.html
h = load('软件介绍.html', 'utf-8')
h = sub(
    h,
    '读完历史会把设备覆盖到的那段时间的本机采样丢掉，统一成设备一种来源（更新的新读数照常保留）</li>',
    '读完历史会把<b>本机自己采的读数全部丢掉</b>，只留设备内置历史这一套来源（之后新采的照常往后接）</li>',
    'html-覆盖',
)
h = h.replace('版本 1.8.3', '版本 1.8.4')
save('软件介绍.html', h, 'utf-8')

# ------------------------------------------------------------ version.json
vj = load('version.json', 'utf-8')
save('version.json', vj.replace('1.8.3', '1.8.4'), 'utf-8')

print('\n'.join(stats))
print('完成')
