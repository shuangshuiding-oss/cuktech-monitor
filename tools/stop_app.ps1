param([switch]$Quiet)
# 停掉 CuktechMonitor 的应用与托盘进程（保留当前 PowerShell 自己）
$killed = @()
Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like '*CuktechMonitor*' } |
  ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force; $killed += "node $($_.ProcessId)" } catch {} }
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like '*tray.ps1*' -and $_.ProcessId -ne $PID } |
  ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force; $killed += "tray $($_.ProcessId)" } catch {} }
Get-CimInstance Win32_Process -Filter "Name='python.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like '*collector.py*' } |
  ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force; $killed += "py $($_.ProcessId)" } catch {} }
if (-not $Quiet) { "killed: " + ($killed -join ', ') }
