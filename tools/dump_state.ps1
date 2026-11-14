param([int]$Tail = 80, [string]$Out = "$env:TEMP\_state.txt")
$l = @()
try {
  $lk = Get-Content "C:\Users\shuan\Tools\CuktechMonitor\data\running.lock" -Raw | ConvertFrom-Json
  $l += "port=$($lk.port) pid=$($lk.pid)"
  $wc = New-Object System.Net.WebClient
  $wc.Encoding = [System.Text.Encoding]::UTF8
  $raw = $wc.DownloadString("http://127.0.0.1:$($lk.port)/api/state")
  [IO.File]::WriteAllText("$env:TEMP\_state_raw.json", $raw, [System.Text.Encoding]::UTF8)
  $j = $raw | ConvertFrom-Json
  $l += "link.state=" + $j.link.state + " attempt=" + $j.link.attempt + " msg=" + $j.link.msg
  $l += "rssi=" + $j.link.rssi + " restarts=" + $j.restarts + " collecting=" + $j.collecting
  $l += "latest.total=" + $j.latest.total + " interval=" + $j.config.interval
  $l += "=== LOGS (last $Tail) ==="
  $j.logs | Select-Object -Last $Tail | ForEach-Object { $l += $_ }
} catch { $l += "FAIL: " + $_.Exception.Message }
$l | Set-Content -Encoding UTF8 $Out
Write-Output "written $Out"
