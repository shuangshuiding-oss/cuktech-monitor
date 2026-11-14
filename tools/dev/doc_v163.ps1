# Update GBK manual for v1.6.3 (duration next to the per-port charge line).
# MUST keep UTF-8 BOM (contains Chinese); writes back GBK + CRLF + no BOM.
$ErrorActionPreference = 'Stop'
$d = 'C:\Users\shuan\Tools\CuktechMonitor'
$gbk = [Text.Encoding]::GetEncoding(936)
$p = "$d\使用说明.txt"
$s = [IO.File]::ReadAllText($p, $gbk)

$old1 = '* 4 个端口卡里也有一行「本次充电」：正在充显示实时值（带绿色「充电中」），拔掉后固定成' + "`r`n" +
        '  结算值，一直挂到这一口**下次充电**才刷新 —— 不用进用电量卡片就能看到每口这次充了多少。'
$new1 = '* 4 个端口卡里也有一行「本次充电」：正在充显示实时值（带绿色「充电中」），电量旁边同时给' + "`r`n" +
        '  **这次充了多久**（1 小时内到分，超过 1 小时给「N 小时 M 分」，刚插上不到 1 分钟给秒）；' + "`r`n" +
        '  拔掉后固定成结算值（时长也定格），一直挂到这一口**下次充电**才刷新 —— 不用进用电量卡片' + "`r`n" +
        '  就能看到每口这次充了多少、充了多久。'

$old2 = '                          64 项断言'
$new2 = '                          78 项断言'

$rep = New-Object System.Collections.ArrayList
if ($s.Contains($old1)) { $s = $s.Replace($old1, $new1); [void]$rep.Add('ok1') } else { [void]$rep.Add('MISS old1') }
if ($s.Contains($old2)) { $s = $s.Replace($old2, $new2); [void]$rep.Add('ok2') } else { [void]$rep.Add('MISS old2') }

# 归一化成纯 CRLF（verify_package 的红线）
$s = $s -replace "`r`n", "`n"
$s = $s -replace "`n", "`r`n"
[IO.File]::WriteAllText($p, $s, $gbk)
$bytes = [IO.File]::ReadAllBytes($p)
$crlf = ([Text.Encoding]::GetEncoding(936).GetString($bytes) -split "`r`n").Count
[void]$rep.Add('bytes=' + $bytes.Length)
[IO.File]::WriteAllLines("$env:TEMP\cuk_doc11.txt", $rep, [Text.UTF8Encoding]::new($false))
