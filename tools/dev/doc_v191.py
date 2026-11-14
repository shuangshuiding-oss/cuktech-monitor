"""v1.9.1：便携包默认带 Electron（透明的），并修掉"带了也找不到"的路径错位。

背景（2026-10-12 用户报「**打包的不是透明的**」）：
  ① 打包默认 `-WithElectron` 关着 → 包里没 Electron → 回退 Edge --app 窗口 → 不透；
  ② 而且就算加了 `-WithElectron` 也**依然不透**：package.ps1 把 Electron 放在
     `<APP>/electron/`，server.js 的 `findElectron()` 只找
     `<APP>/node_modules/electron/dist/` —— 两边对不上，运行时永远找不到。
  现在：默认带（`-NoElectron` 才不带），findElectron 多路查找，并加断言钉住"两边一致"。

用法: python tools/dev/doc_v191.py
"""
import io
import pathlib
import shutil
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
CRLF = chr(13) + chr(10)
changed = 0


def load(name, enc):
    s = io.open(ROOT / name, encoding=enc, newline='').read()
    return s.replace(CRLF, "\n").replace("\r", "\n")


def save(name, s, enc):
    """写回前**先试编码**：编不出来就把"是哪些字符"直接报出来，别丢一串裸 Traceback。
    （GBK 编不出 emoji —— ⚠️/✅ 这类一律不能用在这份 txt 里，改用中文，如「注意」。）"""
    body = s.replace("\n", CRLF)
    try:
        data = body.encode(enc)
    except UnicodeEncodeError as e:
        bad = sorted({c for c in body if _cannot(c, enc)})
        print('  !! %s 编不进 %s：%s' % (name, enc, ' '.join('%s(U+%04X)' % (c, ord(c)) for c in bad)))
        raise SystemExit(3)
    (ROOT / name).write_bytes(data)


def _cannot(c, enc):
    try:
        c.encode(enc)
        return False
    except UnicodeEncodeError:
        return True


def sub1(s, old, new, tag):
    if s.count(old) != 1:
        print("  !! %s 命中 %d 次，跳过" % (tag, s.count(old)))
        return s, False
    print("  ok", tag)
    return s.replace(old, new), True


# ───────────────────────────── 1) 版本号
p = ROOT / 'version.json'
s = p.read_bytes().decode('utf-8')
s2, ok = sub1(s, '"version": "1.9.0"', '"version": "1.9.1"', 'version.json')
if ok:
    p.write_bytes(s2.encode('utf-8'))
    changed += 1

# ───────────────────────────── 2) 使用说明.txt：便携包那段（GBK + 整篇 CRLF）
DOC = '使用说明.txt'
bak = ROOT / (DOC + '.bak-v191')
if not bak.exists():
    shutil.copyfile(ROOT / DOC, bak)
    print('  ok 备份 →', bak.name)

s = load(DOC, 'gbk')
OLD = (
    '· 便携包与透明效果：\n'
    '  给别人打包时默认**不带** Electron（那个运行时约 230MB）。\n'
    '  没有 Electron 时窗口会自动回退成 Edge 的 --app 窗口 —— 功能一模一样，\n'
    '  只是少了「透」这一层。要连透明外壳一起打包：\n'
    '       powershell -ExecutionPolicy Bypass -File tools\\package.ps1 -WithElectron\n'
)
NEW = (
    '· 便携包与透明效果（v1.9.1 起**默认就是透明的**）：\n'
    '  打包时**默认带上** Electron 透明外壳，所以"发出去的包"和"本机在用的程序"\n'
    '  外观一致 —— 窗口能透出后面的桌面。\n'
    '  注意：以前默认不带：包里没有 Electron，窗口会自动回退成 Edge 的 --app 窗口，\n'
    '     **功能一模一样，只是少了「透」这一层** —— 拿到包的人会以为界面坏了。\n'
    '  注意：另有一个更隐蔽的坑（v1.9.1 修）：即使加了 -WithElectron，Electron 被放在\n'
    '     `<程序目录>\\electron\\`，而程序只去 `<程序目录>\\node_modules\\electron\\dist\\`\n'
    '     找它 —— 两边对不上，运行时照样找不到，那 87MB 白带。\n'
    '     现在按多个位置查找，并且自检里有一条断言钉住"打包方与查找方指向同一个地方"。\n'
    '  想打一个**小体积、但没有透明玻璃**的包（约 32MB，透明版约 119MB）：\n'
    '       powershell -ExecutionPolicy Bypass -File tools\\package.ps1 -NoElectron\n'
    '  想知道当前跑的是不是透明外壳：看 data\\app.log —— 出现「未发现 Electron，\n'
    '  回退到浏览器窗口」就是非透明模式。\n'
)
s, ok = sub1(s, OLD, NEW, '使用说明：便携包与透明效果')
if ok:
    save(DOC, s, 'gbk')
    changed += 1

# ───────────────────────────── 3) 软件介绍.md / .html 版本号
s = load('软件介绍.md', 'utf-8')
s, o1 = sub1(s, '**版本 1.9.0 ｜', '**版本 1.9.1 ｜', 'md 版本号')
if o1:
    save('软件介绍.md', s, 'utf-8')
    changed += 1

s = load('软件介绍.html', 'utf-8')
n0 = s.count('<span>版本 1.9.0</span>') + s.count('v1.9.0 &nbsp;|')
s = s.replace('<span>版本 1.9.0</span>', '<span>版本 1.9.1</span>')
s = s.replace('v1.9.0 &nbsp;|', 'v1.9.1 &nbsp;|')
if n0:
    save('软件介绍.html', s, 'utf-8')
    print('  ok html 版本号（%d 处）' % n0)
    changed += 1

print('changed =', changed)
if not changed:
    sys.exit(2)
