# verify_tray.ps1 - check app state + tray process + error file. ASCII only.
$out = "$env:TEMP\_app_check3.txt"
$lines = @()
$lk = Get-Content "C:\Users\shuan\Tools\CuktechMonitor\data\running.lock" -Raw | ConvertFrom-Json
$lines += "port=$($lk.port) pid=$($lk.pid)"
$wc = New-Object System.Net.WebClient
$wc.Encoding = [System.Text.Encoding]::UTF8
$s = ($wc.DownloadString("http://127.0.0.1:$($lk.port)/api/state")) | ConvertFrom-Json
$lines += "state=" + $s.link.state + " total=" + $s.latest.total + " tray=" + $s.config.tray + " trayMode=" + $s.config.trayMode
$lines += "=== tray proc ==="
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like '*tray.ps1*' -and $_.ProcessId -ne $PID } | ForEach-Object { $lines += "tray pid=$($_.ProcessId) ppid=$($_.ParentProcessId)" }
$lines += "=== tray err ==="
if (Test-Path "$env:TEMP\tray-last-error.txt") { $lines += (Get-Content "$env:TEMP\tray-last-error.txt" -Raw) } else { $lines += "(none)" }
$lines | Set-Content -Encoding UTF8 $out
Write-Output "written"
