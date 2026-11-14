# restart_tray_and_set_mode.ps1 - kill tray (server auto-restarts it), set mode, wait. ASCII only.
param([string]$Mode = 'all', [int]$WaitSec = 8)
$ErrorActionPreference = 'Continue'
$lk = Get-Content "C:\Users\shuan\Tools\CuktechMonitor\data\running.lock" -Raw | ConvertFrom-Json
$port = $lk.port

# 1) kill running tray process; server.js restarts it after 3 s
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like '*tray.ps1*' -and $_.ProcessId -ne $PID } |
  ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force; Write-Output ("killed tray " + $_.ProcessId) } catch {} }

# 2) set display mode via API
$wc = New-Object System.Net.WebClient
$wc.Proxy = $null
$wc.Encoding = [System.Text.Encoding]::UTF8
$wc.Headers.Add('Content-Type', 'application/json')
[void]$wc.UploadString("http://127.0.0.1:$port/api/config", 'POST', ('{"trayMode":"' + $Mode + '"}'))
Write-Output ("mode -> " + $Mode)

# 3) wait for restart + warm-up
Start-Sleep -Seconds $WaitSec
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like '*tray.ps1*' -and $_.ProcessId -ne $PID } |
  ForEach-Object { Write-Output ("tray pid=" + $_.ProcessId + " ppid=" + $_.ParentProcessId) }
$s = ($wc.DownloadString("http://127.0.0.1:$port/api/state")) | ConvertFrom-Json
Write-Output ("trayMode=" + $s.config.trayMode + " total=" + $s.latest.total)
if (Test-Path "$env:TEMP\tray-last-error.txt") { Write-Output "ERRFILE:"; Get-Content "$env:TEMP\tray-last-error.txt" } else { Write-Output "no error file" }
