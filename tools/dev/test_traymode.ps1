# test_traymode.ps1 - switch trayMode via API and read it back. ASCII only.
$out = "$env:TEMP\_traymode_test.txt"
$lines = @()
$lk = Get-Content "C:\Users\shuan\Tools\CuktechMonitor\data\running.lock" -Raw | ConvertFrom-Json
$port = $lk.port

function Post([string]$body) {
  $wc = New-Object System.Net.WebClient
  $wc.Proxy = $null
  $wc.Encoding = [System.Text.Encoding]::UTF8
  $wc.Headers.Add('Content-Type', 'application/json')
  return $wc.UploadString("http://127.0.0.1:$port/api/config", 'POST', $body)
}
function GetState([string]$path) {
  $wc = New-Object System.Net.WebClient
  $wc.Proxy = $null
  $wc.Encoding = [System.Text.Encoding]::UTF8
  return $wc.DownloadString("http://127.0.0.1:$port$path")
}

$lines += "--- switch to all ---"
$lines += (Post '{"trayMode":"all"}')
Start-Sleep -Seconds 2
$s = (GetState '/api/state') | ConvertFrom-Json
$lines += "state.trayMode=" + $s.config.trayMode

Start-Sleep -Seconds 3
$lines += "--- config.json on disk ---"
$lines += (Get-Content "C:\Users\shuan\Tools\CuktechMonitor\data\config.json" -Raw)
$lines += "--- switch back to total ---"
$lines += (Post '{"trayMode":"total"}')
Start-Sleep -Seconds 2
$s2 = (GetState '/api/state') | ConvertFrom-Json
$lines += "state.trayMode=" + $s2.config.trayMode
$lines += "--- invalid value should be forced back to total ---"
$lines += (Post '{"trayMode":"whatever"}')
Start-Sleep -Seconds 2
$s3 = (GetState '/api/state') | ConvertFrom-Json
$lines += "state.trayMode=" + $s3.config.trayMode
$lines += "--- tray still alive? ---"
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like '*tray.ps1*' -and $_.ProcessId -ne $PID } | ForEach-Object { $lines += "tray pid=$($_.ProcessId) ppid=$($_.ParentProcessId)" }
if (Test-Path "$env:TEMP\tray-last-error.txt") { $lines += "ERRFILE: " + (Get-Content "$env:TEMP\tray-last-error.txt" -Raw) } else { $lines += "no error file" }
$lines | Set-Content -Encoding UTF8 $out
Write-Output "written"
