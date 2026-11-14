"""修正 doc_v1823.py 弄乱的那一段：从 .bak-v1823 还原，改成**纯插入**。

教训（写进笔记）：
  · 用"按行切片替换"改文档时，**先数清替换块里有几行** —— 我把 8 行的块当成 6 行来切
    （`HELP_NEW[6:]`），结果块被拦腰截断、半截跑到了别处。
  · 纯**插入**（在锚点行后面插）比"替换整段"稳得多：不依赖旧内容的长度。
  · `io.open(..., encoding='gbk')` 读 .txt 必须加 `newline=''`，否则 universal newlines
    把 CRLF 折成 LF，按 CRLF split 只剩 1 段（今天在这上面白绕了两圈）。

用法: python tools/dev/doc_v1823b.py
"""
import io
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
DOC = ROOT / '使用说明.txt'
BAK = ROOT / '使用说明.txt.bak-v1823'
CRLF = chr(13) + chr(10)

if not BAK.exists():
    print('!! 没有备份 %s，中止' % BAK.name)
    sys.exit(2)

text = io.open(BAK, encoding='gbk', newline='').read()
lines = text.split(CRLF)
print('从备份读回 %d 行' % len(lines))

ANCHOR = '   · 要升级到新版：先右键任务栏图标选「退出」，再双击一次 —— 否则开着的一直是旧版。'
idx = None
for i, l in enumerate(lines):
    if l == ANCHOR:
        idx = i
        break
if idx is None:
    print('!! 找不到锚点行，中止')
    sys.exit(3)

BLOCK = [
    '· **看到过一个黑色窗口？**（标题是「酷态科10号Ultra」或什么都没有，里面只有一行',
    '  「…服务已启动：http://127.0.0.1:8799/」）：那是**服务自己的命令行窗口**。',
    '  v1.8.23 起，程序一起来就会把它**藏掉** —— 看不到、任务栏里也没有。',
    '  注意：在旧版本里它一直挂在任务栏，而且**千万别去关它** —— 关掉它等于把服务一起',
    '  杀掉（那种关闭方式不给程序任何清理机会：没有退出日志、data\\running.lock 还会残留，',
    '  之后双击就会像「打不开」）。要停请右键任务栏托盘图标选「退出」。',
    '  开机自启动那条路径（v1.8.23 起）**连命令行窗口都不会创建**：快捷方式直接指向 node，',
    '  不再经过那个 .bat。',
    '',
]

lines[idx + 1:idx + 1] = BLOCK
out = CRLF.join(lines)
DOC.write_bytes(out.encode('gbk'))

data = DOC.read_bytes()
cr = data.count(bytes([13]))
lf = data.count(bytes([10]))
print('写回完成：%d 行，%d 字节，CR=%d LF=%d' % (len(lines), len(data), cr, lf))
if cr != lf:
    print('!! CR/LF 不相等，需要人工检查')
    sys.exit(4)
