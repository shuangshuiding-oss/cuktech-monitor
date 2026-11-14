$ErrorActionPreference = 'Continue'
$log = @()
$base = 'http://127.0.0.1:8799'

function Get-Sst {
  try { return (Invoke-RestMethod -Uri "$base/api/state" -TimeoutSec 8).latest.settings.screen_save_time }
  catch { return ('ERR ' + $_.Exception.Message) }
}

function Set-Sst([int]$v) {
  $body = '{"action":"set","piid":6,"value":' + $v + '}'
  try {
    $r = Invoke-RestMethod -Uri "$base/api/control" -Method Post -Body $body -ContentType 'application/json' -TimeoutSec 25
    return ($r | ConvertTo-Json -Compress)
  } catch {
    return ('ERR ' + $_.Exception.Message)
  }
}

$log += 'before  = ' + (Get-Sst)
foreach ($v in 5, 1, 3, 4) {
  $log += ('write ' + $v + ' -> ' + (Set-Sst $v))
  Start-Sleep -Seconds 4
  $log += ('   readback = ' + (Get-Sst))
}
$log -join "`r`n" | Set-Content "$env:TEMP\cuk_enum.txt" -Encoding UTF8
