# 独立启动服务并做一轮接口验证。结果落盘，因为会话里 stdout 不回传。
$ErrorActionPreference = 'Continue'
$log = "$env:TEMP\_cuk_verify.txt"
$APP = 'C:\Users\shuan\Tools\CuktechMonitor'
$out = @()

# 先停掉旧的（含残留的 python 采集器）
Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 800

$node = 'C:\Program Files\nodejs\node.exe'
$out += "--- 启动服务（无窗口/无托盘，只验后端）---"
$env:CUKTECH_NO_WINDOW = '1'
$env:CUKTECH_NO_TRAY = '1'
# 用 WMI 起进程：它直接继承父进程环境（不做 .NET 环境块的键规范化），
# 绕开 Start-Process 在本机把 "Path"/"PATH" 撞死的问题。
$cmdLine = 'cmd.exe /c ""' + $node + '" server.js > "' + "$env:TEMP\cuk_out.txt" + '" 2>&1"'
$p = Invoke-CimMethod -ClassName Win32_Process -MethodName Create `
  -Arguments @{ CommandLine = $cmdLine; CurrentDirectory = $APP }
$out += "pid = $($p.ProcessId)  rtn = $($p.ReturnValue)"
Start-Sleep -Seconds 5
$out += "alive = " + ([bool](Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue))

function Get-Json($url) {
  try { return Invoke-RestMethod -Uri $url -TimeoutSec 6 } catch { return $null }
}

$out += "--- /api/ping ---"
$out += (Get-Json 'http://127.0.0.1:8799/api/ping' | ConvertTo-Json -Compress)

$out += "--- /api/state (关键字段) ---"
$st = Get-Json 'http://127.0.0.1:8799/api/state'
if ($st) {
  $out += "version   = $($st.version)"
  $out += "link      = $($st.link | ConvertTo-Json -Compress)"
  $out += "shell     = $($st.shell | ConvertTo-Json -Compress)"
  $out += "envSensor = $($st.envSensor | ConvertTo-Json -Compress)"
} else { $out += "state 读取失败" }

$out += "--- /api/wallpaper ---"
$wp = Get-Json 'http://127.0.0.1:8799/api/wallpaper'
if ($wp) { $out += ($wp | ConvertTo-Json -Compress) } else { $out += "壁纸接口失败" }

$out += "--- 静态资源是否带新东西 ---"
try {
  $css = (Invoke-WebRequest 'http://127.0.0.1:8799/style.css' -TimeoutSec 6).Content
  $out += "style.css 含 win-glass/shell-electron = " + (($css -match 'win-glass') -and ($css -match 'shell-electron'))
  $out += "style.css 含 env-card = " + ($css -match 'env-card')
} catch { $out += "css 读取失败：$_" }
try {
  $html = (Invoke-WebRequest 'http://127.0.0.1:8799/' -TimeoutSec 6).Content
  $out += "index.html 含 winbar = " + ($html -match 'winbar')
  $out += "index.html 含 env-card = " + ($html -match 'env-card')
  $out += "index.html 含 shell.js = " + ($html -match 'shell\.js')
} catch { $out += "html 读取失败：$_" }

$out += "--- 等第一次温度读数（最多 60s）---"
$envOk = $false
for ($i = 0; $i -lt 12; $i++) {
  Start-Sleep -Seconds 5
  $s2 = Get-Json 'http://127.0.0.1:8799/api/state'
  if ($s2 -and $s2.envSensor -and $s2.envSensor.tempC -ne $null) {
    $out += "第 $((($i+1)*5)) 秒拿到读数："
    $out += ($s2.envSensor | ConvertTo-Json -Compress)
    $envOk = $true
    break
  }
}
if (-not $envOk) {
  $out += "60 秒内没拿到读数。最后状态："
  $s2 = Get-Json 'http://127.0.0.1:8799/api/state'
  if ($s2) { $out += ($s2.envSensor | ConvertTo-Json -Compress) }
}

$out += "--- 最近日志（温度计相关）---"
$ap = Join-Path $APP 'data\app.log'
if (Test-Path $ap) {
  $out += (Get-Content $ap -Tail 30 | Where-Object { $_ -match '温度计|env|外壳|shell' }) -join "`r`n"
}
$out -join "`r`n" | Out-File -Encoding utf8 $log
"done"
