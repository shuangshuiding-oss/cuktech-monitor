$ErrorActionPreference = 'Continue'
$log = @()
$base = 'http://127.0.0.1:8799'

function Get-Set {
  try { return (Invoke-RestMethod -Uri "$base/api/state" -TimeoutSec 8).latest.settings }
  catch { return $null }
}

$s = Get-Set
$log += 'device now: screen_save_time=' + $s.screen_save_time + '  screenoff_while_idle=' + $s.screenoff_while_idle
$log += '按钮会显示: ' + $(if ($s.screen_save_time -eq 4 -and $s.screenoff_while_idle -eq $false) {
    '看温度 · 常亮中（按一下关掉）' } else { '看温度 · 屏幕常亮' })

foreach ($w in @(@(6, 4), @(19, 0))) {
  $body = '{"action":"set","piid":' + $w[0] + ',"value":' + $w[1] + '}'
  try {
    $r = Invoke-RestMethod -Uri "$base/api/control" -Method Post -Body $body -ContentType 'application/json' -TimeoutSec 25
    $log += ('ON 路径 piid=' + $w[0] + ' value=' + $w[1] + ' -> ok=' + $r.ok + ' readback=' + $r.readback + ' err=' + $r.error)
  } catch { $log += ('ON 路径 piid=' + $w[0] + ' ERR ' + $_.Exception.Message) }
  Start-Sleep -Seconds 3
}

$s2 = Get-Set
$log += 'after: screen_save_time=' + $s2.screen_save_time + '  screenoff_while_idle=' + $s2.screenoff_while_idle
$log -join "`r`n" | Set-Content "$env:TEMP\cuk_btn166.txt" -Encoding UTF8
