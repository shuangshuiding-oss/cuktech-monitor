# 重启应用（带 Electron 透明窗口）并做完整验收。
# 结果落盘到 %TEMP%\_cuk_verify.txt。
$ErrorActionPreference = 'Continue'
$log = "$env:TEMP\_cuk_verify.txt"
$APP = 'C:\Users\shuan\Tools\CuktechMonitor'
$out = @()

Get-Process node,electron -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 900

$node = 'C:\Program Files\nodejs\node.exe'
$out += "--- 启动（带窗口 + 托盘）---"
Remove-Item Env:CUKTECH_NO_WINDOW -ErrorAction SilentlyContinue
Remove-Item Env:CUKTECH_NO_TRAY -ErrorAction SilentlyContinue
$cmdLine = 'cmd.exe /c ""' + $node + '" server.js > "' + "$env:TEMP\cuk_out.txt" + '" 2>&1"'
$p = Invoke-CimMethod -ClassName Win32_Process -MethodName Create `
  -Arguments @{ CommandLine = $cmdLine; CurrentDirectory = $APP }
$out += "pid = $($p.ProcessId)"

function Get-Json($url) {
  try { return Invoke-RestMethod -Uri $url -TimeoutSec 8 } catch { return $null }
}

# 等端口起来
$st = $null
for ($i = 0; $i -lt 15; $i++) {
  Start-Sleep -Seconds 2
  $st = Get-Json 'http://127.0.0.1:8799/api/state'
  if ($st) { break }
}
$out += "--- /api/state ---"
if ($st) {
  $out += "version   = $($st.version)"
  $out += "link      = $($st.link | ConvertTo-Json -Compress)"
  $out += "shell     = $($st.shell | ConvertTo-Json -Compress)"
  $out += "envSensor = $($st.envSensor | ConvertTo-Json -Compress)"
} else { $out += "state 读取失败" }

$out += "--- /api/wallpaper ---"
$wp = Get-Json 'http://127.0.0.1:8799/api/wallpaper'
if ($wp) { $out += ($wp | ConvertTo-Json -Compress) } else { $out += "壁纸接口失败" }

$out += "--- 静态资源 ---"
try {
  $css = (Invoke-WebRequest 'http://127.0.0.1:8799/style.css' -TimeoutSec 8).Content
  $out += "css win-glass = " + ($css -match 'win-glass') + "   shell-electron = " + ($css -match 'shell-electron') + "   env-card = " + ($css -match 'env-card')
} catch { $out += "css 失败：$_" }
try {
  $html = (Invoke-WebRequest 'http://127.0.0.1:8799/' -TimeoutSec 8).Content
  $out += "html winbar = " + ($html -match 'winbar') + "   env-card = " + ($html -match 'env-card') + "   shell.js = " + ($html -match 'shell\.js')
  $out += "html 外挂声明 = " + ($html -match '外挂传感器')
} catch { $out += "html 失败：$_" }
$out += "shell.js 可取 = " + (Test-Path (Join-Path $APP 'web\shell.js'))

$out += "--- Electron 进程 ---"
$el = Get-Process electron -ErrorAction SilentlyContinue
$out += "electron 进程数 = " + (($el | Measure-Object).Count)

$out += "--- 等温度计首次读数（最多 90s）---"
$got = $false
for ($i = 0; $i -lt 18; $i++) {
  Start-Sleep -Seconds 5
  $s2 = Get-Json 'http://127.0.0.1:8799/api/state'
  if ($s2 -and $s2.envSensor -and $s2.envSensor.tempC -ne $null) {
    $out += "第 $((($i+1)*5)) 秒："
    $out += ($s2.envSensor | ConvertTo-Json -Compress)
    $got = $true
    break
  }
}
if (-not $got) {
  $out += "90s 内没有读数："
  $s2 = Get-Json 'http://127.0.0.1:8799/api/state'
  if ($s2) { $out += ($s2.envSensor | ConvertTo-Json -Compress) }
}

$out += "--- 采集器状态 ---"
if ($s2) { $out += "collecting = $($s2.collecting)  link = $($s2.link.state)  latest.total = $($s2.latest.total)" }

$out -join "`r`n" | Out-File -Encoding utf8 $log
"done"
