r"""
便携包 BLE 可用性探测 —— 只扫描，不连接。

    <包>\runtime\python\python.exe tools\verify_ble_scan.py --out 报告.txt [--seconds 8] [--addr 3C:CD:...]

为什么只扫描、不连接：
  正在运行的实例可能已经占着设备的 BLE 连接，直接去连会把它挤掉（然后它要重连）。
  而扫描足以证明**便携包的 winrt 后端真的能驱动蓝牙硬件** —— 这正是精简运行时
  最容易悄悄弄坏的地方：删错一个 winrt 命名空间（比如 bleak 用来查适配器开关的
  windows.devices.radios），import 阶段往往不报错，一到真实调用才炸。

退出码：0 = 扫到目标设备；1 = 能扫描但没看到目标；2 = 蓝牙栈起不来（真问题）。
"""
import argparse
import asyncio
import sys
from pathlib import Path

ap = argparse.ArgumentParser()
ap.add_argument('--seconds', type=float, default=8)
ap.add_argument('--addr', default='')
ap.add_argument('--out', default='')
args = ap.parse_args()

L = []
TARGET_NAME = 'njcuk.fitting.ad1204'


def say(s=''):
    L.append(str(s))
    try:
        print(s)
    except Exception:
        pass


def flush(code):
    if args.out:
        try:
            Path(args.out).write_text('\n'.join(L) + '\n', encoding='utf-8')
        except Exception as e:
            sys.stderr.write('写报告失败: %s\n' % e)
    raise SystemExit(code)


def die(msg, code=2):
    say(msg)
    flush(code)


def main():
    say('便携 BLE 探测    python ' + sys.version.split()[0])
    say('解释器: ' + sys.executable)
    say('')

    # 1. 先把 winrt 后端拉起来（这一步失败 = 精简把 winrt 弄坏了）
    say('--- 1. bleak Windows 后端 ---')
    try:
        from bleak.backends.client import get_platform_client_backend_type
        from bleak.backends.scanner import get_platform_scanner_backend_type

        say('  scanner = ' + repr(get_platform_scanner_backend_type()))
        say('  client  = ' + repr(get_platform_client_backend_type()))
    except Exception as e:
        die('  FAIL ' + type(e).__name__ + ': ' + str(e))

    # 2. 真实调用蓝牙栈：扫描
    #    ⚠ bleak 3.x 的 BLEDevice 已经没有 .rssi / .local_name 了 —— 那些在
    #    AdvertisementData 里，必须 discover(return_adv=True) 才拿得到。
    say('')
    say('--- 2. 真实扫描 %.0f 秒 ---' % args.seconds)

    async def scan():
        from bleak import BleakScanner

        return await BleakScanner.discover(timeout=args.seconds, return_adv=True)

    try:
        raw = asyncio.run(scan())
    except Exception as e:
        die('  FAIL ' + type(e).__name__ + ': ' + str(e))

    # return_adv=True → {address: (BLEDevice, AdvertisementData)}
    items = []
    for v in raw.values():
        if isinstance(v, tuple) and len(v) == 2:
            dev, adv = v
        else:
            dev, adv = v, None
        rssi = getattr(adv, 'rssi', None)
        if rssi is None:
            rssi = getattr(dev, 'rssi', None)
        peer_name = getattr(adv, 'local_name', None) or getattr(dev, 'name', None)
        items.append((rssi, dev.address, peer_name, adv))
    items.sort(key=lambda t: -(t[0] if isinstance(t[0], (int, float)) else -999))

    say('  发现 %d 个 BLE 设备' % len(items))
    for rssi, addr, nm, _adv in items[:15]:
        say('    %-20s %-32s rssi=%s' % (addr, nm or '(无名)', rssi))

    # 3. 目标在不在
    say('')
    say('--- 3. 目标设备 ---')
    hit = None
    for rssi, addr, nm, adv in items:
        name_ok = (nm or '').strip() == TARGET_NAME
        addr_ok = bool(args.addr) and addr.upper() == args.addr.upper()
        if name_ok or addr_ok:
            hit = (rssi, addr, nm)
            break

    if hit:
        say('  找到：' + hit[1] + '  name=' + repr(hit[2]) + '  rssi=' + repr(hit[0]))
        say('')
        say('结果: 蓝牙栈可用，目标设备在广播')
        return 0

    say('  本轮没看到 ' + TARGET_NAME + (('  /  ' + args.addr) if args.addr else ''))
    say('  （设备可能被其它实例连着、或暂时没广播；能扫到别的设备就说明蓝牙栈是好的）')
    say('')
    if items:
        say('结果: 蓝牙栈可用（扫到 %d 个设备即是证据），但本轮未见目标' % len(items))
        return 1
    say('结果: 一个设备都没扫到 —— 蓝牙栈可能真有问题')
    return 2


if __name__ == '__main__':
    try:
        code = main()
    except SystemExit:
        raise
    except BaseException:
        import traceback

        tb = traceback.format_exc()
        say(tb)
        if args.out:
            try:
                Path(args.out).write_text('\n'.join(L) + '\n', encoding='utf-8')
            except Exception:
                pass
        raise SystemExit(2)
    flush(code)
