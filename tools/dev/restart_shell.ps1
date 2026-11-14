# 重启整应用（server + Electron 壳）并把关键状态写到 %TEMP%\_cuk_shell.txt。
# 会话里 stdout 不回传，所以一律落文件再读。
$ErrorActionPreference = 'Continue'
$log = "$env:TEMP\_cuk_shell.txt"
$APP = 'C:\Users\shuan\Tools\CuktechMonitor'
$out = @()

Get-Process node,electron -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 1500

$node = 'C:\Program Files\nodejs\node.exe'
Remove-Item Env:CUKTECH_NO_WINDOW -ErrorAction SilentlyContinue
Remove-Item Env:CUKTECH_NO_TRAY -ErrorAction SilentlyContinue
$cmdLine = 'cmd.exe /c ""' + $node + '" server.js > "' + "$env:TEMP\cuk_shell_out.txt" + '" 2>&1"'
$p = Invoke-CimMethod -ClassName Win32_Process -MethodName Create `
  -Arguments @{ CommandLine = $cmdLine; CurrentDirectory = $APP }
$out += "spawn rtn=$($p.ReturnValue) pid=$($p.ProcessId)"

$st = $null
for ($i = 0; $i -lt 20; $i++) {
  Start-Sleep -Seconds 2
  try { $st = Invoke-RestMethod -Uri 'http://127.0.0.1:8799/api/state' -TimeoutSec 5 } catch { $st = $null }
  if ($st) { break }
}
$out += "--- state ---"
if ($st) {
  $out += "version = $($st.version)"
  $out += "link    = $($st.link.state)  rssi=$($st.link.rssi)"
  $out += "env Ok  = $($st.envSensor.ok)  temp=$($st.envSensor.tempC)  sig=$($st.envSensor.rssi)  src=$($st.envSensor.source)"
} else { $out += 'state 读取失败' }

Start-Sleep -Seconds 6
$el = Get-Process electron -ErrorAction SilentlyContinue
$out += "electron 进程数 = " + (($el | Measure-Object).Count)
foreach ($e in $el) { $out += ("  pid=" + $e.Id + " title=" + $e.MainWindowTitle) }

$out += "--- 窗口几何 ---"
Add-Type -AssemblyName System.Windows.Forms
foreach ($e in $el) {
  if ($e.MainWindowHandle -ne 0) {
    $out += ("  hwnd=" + $e.MainWindowHandle + " title=" + $e.MainWindowTitle)
  }
}

$out += "--- server 日志尾部 ---"
try {
  $lg = Invoke-RestMethod -Uri 'http://127.0.0.1:8799/api/log' -TimeoutSec 5
  $out += ($lg.lines | Select-Object -Last 14)
} catch { $out += 'log 读取失败' }

$out += "--- server stderr/stdout 尾部 ---"
try { $out += (Get-Content "$env:TEMP\cuk_shell_out.txt" -Tail 20 -ErrorAction SilentlyContinue) } catch { }

$out -join "`r`n" | Out-File -Encoding utf8 $log
"done -> $log"
