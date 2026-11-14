# diag2.ps1 - check app processes, port, tray, recent app.log. ASCII only.
$lines = @()
$lines += "=== processes ==="
Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='powershell.exe' OR Name='python.exe'" -ErrorAction SilentlyContinue | ForEach-Object {
  $cl = $_.CommandLine
  if ($cl -and $cl -match 'CuktechMonitor') {
    if ($cl.Length -gt 150) { $cl = $cl.Substring(0,150) }
    $lines += "[$($_.ProcessId)] ppid=$($_.ParentProcessId) $($_.Name) :: $cl"
  }
}
$lines += "=== lock ==="
try {
  $lk = Get-Content "C:\Users\shuan\Tools\CuktechMonitor\data\running.lock" -Raw | ConvertFrom-Json
  $lines += "port=$($lk.port) pid=$($lk.pid) alive=" + [bool](Get-Process -Id $lk.pid -ErrorAction SilentlyContinue)
  $wc = New-Object System.Net.WebClient
  $wc.Encoding = [System.Text.Encoding]::UTF8
  $s = ($wc.DownloadString("http://127.0.0.1:$($lk.port)/api/state")) | ConvertFrom-Json
  $lines += "state=" + $s.link.state + " trayMode=" + $s.config.trayMode + " collecting=" + $s.collecting
} catch { $lines += "state fail: $($_.Exception.Message)" }
$lines += "=== app.log tail ==="
Get-Content "C:\Users\shuan\Tools\CuktechMonitor\data\app.log" -Tail 6 | ForEach-Object { $lines += $_ }
$lines | Set-Content -Encoding UTF8 "$env:TEMP\_diag2.txt"
Write-Output done
