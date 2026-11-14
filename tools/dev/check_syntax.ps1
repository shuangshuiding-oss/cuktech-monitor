param([string]$Out = "$env:TEMP\_syntax.txt")
# ASCII only on purpose: this file must parse under any code page.
$root = 'C:\Users\shuan\Tools\CuktechMonitor'
$py = Join-Path $root '.venv\Scripts\python.exe'
$node = 'C:\Program Files\nodejs\node.exe'
$l = @()
$l += (& $py -m py_compile (Join-Path $root 'collector.py') (Join-Path $root 'vendor\cuktech_ble\xiaomi\session.py') 2>&1 | Out-String)
$l += "py_compile exit=$LASTEXITCODE"
$l += (& $node --check (Join-Path $root 'server.js') 2>&1 | Out-String)
$l += "server.js exit=$LASTEXITCODE"
$l += (& $node (Join-Path $root 'tools\check_front.js') 2>&1 | Out-String)
$l += "front exit=$LASTEXITCODE"
$b = [IO.File]::ReadAllBytes((Join-Path $root 'tray.ps1'))
$l += "tray.ps1 BOM: " + (($b[0..2] | ForEach-Object { $_.ToString('X2') }) -join ' ')
$l | Set-Content -Encoding UTF8 $Out
Write-Output "written $Out"
