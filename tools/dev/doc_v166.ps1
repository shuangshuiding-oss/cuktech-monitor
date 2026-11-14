$d = 'C:\Users\shuan\Tools\CuktechMonitor'
$p = Join-Path $d '使用说明.txt'
$enc = [Text.Encoding]::GetEncoding(936)
$s = $enc.GetString([IO.File]::ReadAllBytes($p))

$log = @()
$log += 'BEFORE bytes=' + ([IO.File]::ReadAllBytes($p)).Length

# --- 1. 控制功能清单里加一条「看温度 · 屏幕常亮」 ---------------------------
$old1 = '  USB-A 小电流、空闲自动熄屏、锁定屏幕方向 —— 这些都实测可写、可回读。'
$new1 = '  USB-A 小电流、空闲自动熄屏、锁定屏幕方向 —— 这些都实测可写、可回读。' + "`r`n" +
        '* 「看温度 · 屏幕常亮」：温度只在充电头自己的屏幕上显示（触摸键切到「界面二 ·' + "`r`n" +
        '  核心温度」，40℃绿 / 60℃黄 / 80℃红）。这颗按钮把息屏时间设成常亮、并关掉空闲' + "`r`n" +
        '  自动熄屏，让温度页不会自己黑掉；再按一次还原。蓝牙侧没有温度属性，按钮不涉及' + "`r`n" +
        '  温度数值 —— 详见下面「它读不到什么」第 2 条。'

# --- 2. 温度那节的证据补两条（2026-09-23 复核） ----------------------------
$old2 = '   - 蓝牙 GATT 全表只有 3 个服务，厂商服务 0xAF00 下只有一个只写特征和一个' + "`r`n" +
        '     只通知特征，订阅 10 秒收不到任何数据。'
$new2 = $old2 + "`r`n" +
        '   - 2026-09-23 复核：整台设备蓝牙侧只有 **1 个服务（siid=2）、21 个属性**，' + "`r`n" +
        '     不存在第二个可以藏东西的服务；四个口的端口字 4 个字节也全用满了' + "`r`n" +
        '     （电压/电流/协议码/在用位），没有富余位；' + "`r`n" +
        '   - 规格表里唯一没试过的 `2.14 enter`（只写，1~5）也实测完了：依次写 1~5，' + "`r`n" +
        '     可读属性一个都没变，判定为本机固件没有下发该属性。'

# --- 3. 结论段：把「看屏幕」这条路写实 -------------------------------------
$old3 = '   想拿温度只能读它的屏幕（摄像头/OCR），或者拆机飞线 SWD。' + "`r`n" +
        '   界面「控制充电头 - 高级 - 扫描隐藏属性 / 温度」可以随时重跑这套实测，' + "`r`n" +
        '   固件升级后如果有新属性会在这里冒出来。'
$new3 = '   结论：温度只能**看充电头自己的屏幕**（App 读不到、也推不上去），或者外接测温' + "`r`n" +
        '   （红外测温枪 / 带温度记录的 USB-C 功率计），再或者拆机飞线 SWD。' + "`r`n" +
        '   界面「控制充电头 - 设备设置 - 看温度 · 屏幕常亮」可一键把屏幕固定成常亮，' + "`r`n" +
        '   好读它自己的温度页；「高级 - 扫描隐藏属性 / 温度」可以随时重跑上面这套实测，' + "`r`n" +
        '   固件升级后如果有新属性会在这里冒出来。'

foreach ($pair in @(@($old1, $new1, '清单'), @($old2, $new2, '证据'), @($old3, $new3, '结论'))) {
  if ($s.Contains($pair[0])) {
    $s = $s.Replace($pair[0], $pair[1])
    $log += ('OK   ' + $pair[2])
  } else {
    $log += ('MISS ' + $pair[2])
  }
}

# CRLF 归一（GBK 文件混进 LF 会被包校验红线判 FAIL）
$s = $s.Replace("`r`n", "`n").Replace("`n", "`r`n")

[IO.File]::WriteAllBytes($p, $enc.GetBytes($s))

$s2 = $enc.GetString([IO.File]::ReadAllBytes($p))
$log += 'AFTER bytes=' + ([IO.File]::ReadAllBytes($p)).Length
$log += 'CRLF count=' + (($s2 -split "`r`n").Count - 1) + '  LF-only count=' + (($s2 -split "(?<!`r)`n").Count - 1)
$log += 'contains 看温度 常亮: ' + $s2.Contains('看温度 · 屏幕常亮')
$log += 'contains 2.14 enter: ' + $s2.Contains('2.14 enter')
$log -join "`r`n" | Set-Content "$env:TEMP\cuk_doc166.txt" -Encoding UTF8
