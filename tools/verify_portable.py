r"""
便携包导入链穷尽测试 —— 验证精简过的运行时还跑得动。

    <staging>\runtime\python\python.exe tools\verify_portable.py <staging> [--out 报告路径]

做三件事：
  1. 静态扫描便携包里所有 .py 源码的 import 语句（含函数内的延迟 import），
     得到"这个 App 到底需要哪些模块"的完整集合；
  2. 逐个真 import，报出任何 ImportError；
  3. 对几条**真实使用路径**做构造级验证：
       - bleak 的 Windows 后端（会拉起 winrt 的那 9 个 .pyd）
       - cryptography 的 AESCCM / ECDH（BLE 握手要用）
       - ssl 建默认上下文（小米云 HTTPS 要用 libssl + libcrypto）
       - aiohttp 客户端会话

精简运行时最大的风险是"删掉了一个只在某条分支才 import 的模块"，
所以第 3 步不能省 —— 光 import 顶层包往往不会触发后端加载。
"""
import ast
import importlib
import os
import sys
from pathlib import Path

stage = Path(sys.argv[1] if len(sys.argv) > 1 else '.').resolve()
if not stage.is_dir():
    sys.stderr.write('FAIL: 目录不存在 ' + str(stage) + '\n')
    raise SystemExit(2)

# 报告同时落一份 UTF-8 文件 —— 走 PowerShell 管道时中文会被按 GBK 解码成乱码
_OUT = None
if '--out' in sys.argv:
    _OUT = Path(sys.argv[sys.argv.index('--out') + 1])
_LINES = []


def say(s=''):
    _LINES.append(str(s))
    try:
        print(s)
    except Exception:
        pass


def flush_out():
    if not _OUT:
        return
    try:
        _OUT.write_text('\n'.join(_LINES) + '\n', encoding='utf-8')
    except Exception:
        pass


sys.path.insert(0, str(stage))
sys.path.insert(0, str(stage / 'vendor'))

# ── 1. 静态收集 import ───────────────────────────────────────────────
LOCAL = {'cuktech_ble', 'ad1204u_read_props', 'collector', 'login'}
STDLIB = set(sys.stdlib_module_names)

sources = []
for pat in ('*.py', 'vendor/**/*.py'):
    sources.extend(stage.glob(pat))

mods = set()
parse_fail = []
for f in sources:
    try:
        tree = ast.parse(f.read_text('utf-8'))
    except Exception as e:
        parse_fail.append(str(f) + ' :: ' + str(e))
        continue
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for a in node.names:
                mods.add(a.name.split('.')[0])
        elif isinstance(node, ast.ImportFrom):
            if node.level:          # 相对 import，跳过
                continue
            if node.module:
                mods.add(node.module.split('.')[0])

third_party = sorted(m for m in mods if m not in LOCAL and m not in STDLIB)
stdlib_used = sorted(m for m in mods if m in STDLIB)

say('=' * 66)
say('便携包: ' + str(stage))
say('扫描源码 %d 个 .py，解析失败 %d 个' % (len(sources), len(parse_fail)))
for x in parse_fail:
    say('   PARSE-FAIL ' + x)
say('')
say('第三方依赖 (%d): %s' % (len(third_party), ', '.join(third_party)))
say('标准库依赖 (%d): %s' % (len(stdlib_used), ', '.join(stdlib_used)))
say('=' * 66)

fails = []

# ── 2. 逐个 import ───────────────────────────────────────────────────
say('\n--- 逐个 import ---')
for m in sorted(mods):
    if m in LOCAL:
        continue
    try:
        importlib.import_module(m)
        say('  OK   ' + m)
    except Exception as e:
        say('  FAIL ' + m + ' :: ' + type(e).__name__ + ': ' + str(e))
        fails.append(m + ' :: ' + type(e).__name__ + ': ' + str(e))

# 本地包也要 import（它们内部还会拉依赖）
for m in sorted(LOCAL):
    if m == 'collector' or m == 'login':
        continue
    try:
        importlib.import_module(m)
        say('  OK   ' + m + '   (本地包)')
    except Exception as e:
        say('  FAIL ' + m + ' :: ' + type(e).__name__ + ': ' + str(e))
        fails.append(m + ' :: ' + str(e))

# ── 3. 真实使用路径 ──────────────────────────────────────────────────
say('\n--- 真实使用路径 ---')


def probe(name, fn):
    try:
        note = fn()
        say('  OK   ' + name + ('   ' + str(note) if note else ''))
    except Exception as e:
        say('  FAIL ' + name + ' :: ' + type(e).__name__ + ': ' + str(e))
        fails.append(name + ' :: ' + type(e).__name__ + ': ' + str(e))


def p_bleak_backend():
    from bleak.backends.scanner import get_platform_scanner_backend_type
    from bleak.backends.client import get_platform_client_backend_type

    def nm(x):
        if isinstance(x, tuple):
            return '(' + ', '.join(getattr(i, '__name__', repr(i)) for i in x) + ')'
        return getattr(x, '__name__', repr(x))

    return 'scanner=' + nm(get_platform_scanner_backend_type()) + '  client=' + nm(get_platform_client_backend_type())


def p_winrt_namespaces():
    """bleak 的 winrt 后端会用到这些命名空间，逐个点名确认 .pyd 还在。"""
    import importlib as il
    names = [
        'winrt.windows.devices.bluetooth',
        'winrt.windows.devices.bluetooth.advertisement',
        'winrt.windows.devices.bluetooth.genericattributeprofile',
        'winrt.windows.devices.enumeration',
        'winrt.windows.devices.radios',
        'winrt.windows.foundation',
        'winrt.windows.foundation.collections',
        'winrt.windows.storage.streams',
    ]
    for n in names:
        il.import_module(n)
    return '%d 个命名空间全部可导入' % len(names)


def p_crypto_aesccm():
    from cryptography.hazmat.primitives.ciphers.aead import AESCCM
    k = bytes(16)
    out = AESCCM(k, tag_length=4).encrypt(bytes(13), b'hello', None)
    return 'AESCCM 可用 (密文 %d 字节)' % len(out)


def p_crypto_ecdh():
    from cryptography.hazmat.primitives.asymmetric import ec
    a = ec.generate_private_key(ec.SECP256R1())
    b = ec.generate_private_key(ec.SECP256R1())
    sa = a.exchange(ec.ECDH(), b.public_key())
    sb = b.exchange(ec.ECDH(), a.public_key())
    assert sa == sb, 'ECDH 双方共享密钥不一致'
    return 'ECDH P-256 可用，双方密钥一致'


def p_crypto_hkdf_hmac():
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.kdf.hkdf import HKDF
    from cryptography.hazmat.primitives.hmac import HMAC
    k = HKDF(algorithm=hashes.SHA256(), length=16, salt=b's', info=b'i').derive(b'key')
    h = HMAC(k, hashes.SHA256())
    h.update(b'x')
    return 'HKDF+HMAC 可用 (%d 字节)' % len(h.finalize())


def p_ssl():
    import ssl
    ctx = ssl.create_default_context()
    return 'ssl 默认上下文 OK (' + ssl.OPENSSL_VERSION + ')'


def p_aiohttp():
    import asyncio

    import aiohttp

    async def main():
        # aiohttp 3.14 起 ClientSession 必须在运行中的事件循环里构造
        async with aiohttp.ClientSession() as s:
            return aiohttp.__version__ + ' / ' + s.__class__.__name__

    return 'ClientSession 可构造 (' + asyncio.run(main()) + ')'


def p_asyncio_run():
    import asyncio

    async def main():
        await asyncio.sleep(0)
        return 1

    return 'event loop 可用 (返回 %r)' % asyncio.run(main())


def p_local_vendor():
    from cuktech_ble.xiaomi import MiAuthClient
    from cuktech_ble.xiaomi.session import MiSession
    from cuktech_ble.ports import decode_port_info
    from ad1204u_read_props import encode_get_properties, parse_response
    return 'MiAuthClient / MiSession / ports / props 全部就位'


probe('bleak 平台后端解析', p_bleak_backend)
probe('winrt 8 个命名空间', p_winrt_namespaces)
probe('cryptography AESCCM', p_crypto_aesccm)
probe('cryptography ECDH', p_crypto_ecdh)
probe('cryptography HKDF/HMAC', p_crypto_hkdf_hmac)
probe('ssl / OpenSSL 动态库', p_ssl)
probe('aiohttp 客户端', p_aiohttp)
probe('asyncio 事件循环', p_asyncio_run)
probe('业务代码 (vendor)', p_local_vendor)

say('\n' + '=' * 66)
if fails:
    say('结果: 失败 %d 项' % len(fails))
    for f in fails:
        say('  - ' + f)
    flush_out()
    raise SystemExit(1)
say('结果: 全部通过')
flush_out()
raise SystemExit(0)
