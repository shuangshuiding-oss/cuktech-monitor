$ErrorActionPreference = 'Continue'
$app = 'C:\Users\shuan\Tools\CuktechMonitor'
$py  = Join-Path $app '.venv\Scripts\python.exe'
$log = Join-Path $app 'tools\dev\enter_probe.log'
$out = Join-Path $app 'tools\dev\enter_probe.json'

# The charger accepts only one BLE peer, so the running app (server + collector)
# has to go down before the probe can authenticate.
Get-CimInstance Win32_Process -Filter "name='python.exe'" |
  Where-Object { $_.CommandLine -like '*CuktechMonitor*collector.py*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Get-CimInstance Win32_Process -Filter "name='node.exe'" |
  Where-Object { $_.CommandLine -like '*CuktechMonitor*server.js*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 3

if (Test-Path $out) { Remove-Item $out -Force -ErrorAction SilentlyContinue }

& $py (Join-Path $app 'collector.py') `
  --address 3C:CD:73:18:2E:97 `
  --token-file (Join-Path $app 'data\cuktech.token') `
  --enter-probe --probe-out $out *> $log
"exit=$LASTEXITCODE" | Out-File $log -Append -Encoding utf8
"json exists=" + (Test-Path $out) | Out-File $log -Append -Encoding utf8
