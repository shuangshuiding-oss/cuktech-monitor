"""v1.8.4 文档校正（第二块）：

1. 修 软件介绍.md 里的一处**串行**：v1.8.3 那次插入用的锚点只取了"覆盖"那条的第一行，
   结果把它的后半段塞进了"每小时一条"那条里（两条粘在一起）。这里把两条重新拆开。
2. 三份文档统一改成"本机采的读数一条都不留"的措辞（用户 2026-10-06 明确要求"把之前所有数据覆盖"）。
3. 版本号 1.8.3 → 1.8.4。

幂等：目标串不存在（已改过）就跳过该条，不报错。

用法: python tools/dev/doc_v184b.py
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


def sub(text: str, old: str, new: str, tag: str, must: bool = True) -> str:
    n = text.count(old)
    if n == 0 and not must:
        print('跳过（已改过）：' + tag)
        return text
    if n != 1:
        print('「%s」命中 %d 次' % (tag, n))
        sys.exit(3)
    return text.replace(old, new)


# ---------------------------------------------------------------- md
m = load('软件介绍.md', 'utf-8')
# 1) 把被吞进"每小时一条"那条的尾巴摘掉
m = sub(
    m,
    '不是一个孤点 —— 切到 30 分钟窗口也不会再"只有一两个点、其余全空白"。两种粒度混着画会让'
    '「当日最低~最高」忽宽忽窄。因此读完历史会把**设备覆盖到的那段时间**的本机采样丢掉，'
    '统一成设备一种来源（比历史更新的新读数照常保留）。',
    '不是一个孤点 —— 切到 30 分钟窗口也不会再"只有一两个点、其余全空白"。',
    'md 拆串行', must=False,
)
# 2) "覆盖"那条补全并改成彻底覆盖
m = sub(
    m,
    '- **读完历史就覆盖旧数据（v1.8.2）**：设备每小时记的是该小时的最高/最低，本应用自己采的是 90 秒瞬时值，\n',
    '- **读完历史就覆盖旧数据（v1.8.2 起，v1.8.4 彻底化）**：设备每小时记的是该小时的最高/最低，'
    '本应用自己采的是 90 秒瞬时值，\n'
    '  两种粒度混着画会让「当日最低~最高」忽宽忽窄。因此读完历史会把**本机自己采的读数全部丢掉**，'
    '只留设备内置历史这一套来源（之后新采的照常往后接）。\n',
    'md 覆盖语义', must=False,
)
if '- **读完历史就覆盖旧数据' not in m:
    # 上面那条没匹配上（说明已经被整理过），确保至少语义是新的
    m = sub(m, '（比历史更新的新读数照常保留）', '（本机采的读数一条不留，之后新采的照常往后接）',
            'md 兜底', must=False)
m = m.replace('版本 1.8.3', '版本 1.8.4')
save('软件介绍.md', m, 'utf-8')

# ---------------------------------------------------------------- html
h = load('软件介绍.html', 'utf-8')
h = sub(
    h,
    '读完历史会把设备覆盖到的那段时间的本机采样丢掉，统一成设备一种来源（更新的新读数照常保留）',
    '读完历史会把<b>本机自己采的读数全部丢掉</b>，只留设备内置历史这一套来源（之后新采的照常往后接）',
    'html 覆盖语义', must=False,
)
h = h.replace('版本 1.8.3', '版本 1.8.4')
save('软件介绍.html', h, 'utf-8')

# ---------------------------------------------------------------- 使用说明（标题补一句）
t = load('使用说明.txt', 'gbk')
t = sub(t, '**读完历史 = 用它覆盖旧数据**（v1.8.2 起，v1.8.4 改成彻底覆盖）',
        '**读完历史 = 用它覆盖旧数据**（v1.8.2 起；v1.8.4 起改成彻底覆盖）', '使用说明标题', must=False)
save('使用说明.txt', t, 'gbk')

# ---------------------------------------------------------------- version.json
vj = load('version.json', 'utf-8')
save('version.json', vj.replace('1.8.3', '1.8.4'), 'utf-8')

print('\n'.join(stats))
print('完成')
