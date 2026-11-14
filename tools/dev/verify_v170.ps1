# v1.7.0 收尾验收：重启应用（带 Electron 透明窗口 + 托盘），
# 重点验证这一版新加的三件事：
#   1. 窗口大圆角 + 原生 setShape 蒙版（--win-r 2.6rem）
#   2. 温度计历史落盘（data/env-history/ + env-history-min.jsonl）
#   3. /api/env/history 与功率曲线同一套区间
# 结果落盘到 %TEMP%\_cuk_verify2.txt。
$ErrorActionPreference = 'Continue'
$log = "$env:TEMP\_cuk_verify2.txt"
$APP = 'C:\Users\shuan\Tools\CuktechMonitor'
$out = @()

Get-Process node,electron -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 1200

$node = 'C:\Program Files\nodejs\node.exe'
$out += "--- 启动（带窗口 + 托盘）---"
Remove-Item Env:CUKTECH_NO_WINDOW -ErrorAction SilentlyContinue
Remove-Item Env:CUKTECH_NO_TRAY -ErrorAction SilentlyContinue
$cmdLine = 'cmd.exe /c ""' + $node + '" server.js > "' + "$env:TEMP\cuk_out2.txt" + '" 2>&1"'
$p = Invoke-CimMethod -ClassName Win32_Process -MethodName Create `
  -Arguments @{ CommandLine = $cmdLine; CurrentDirectory = $APP }
$out += "pid = $($p.ProcessId)"

function Get-Json($url) {
  try { return Invoke-RestMethod -Uri $url -TimeoutSec 8 } catch { return $null }
}

$st = $null
for ($i = 0; $i -lt 18; $i++) {
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

$out += "--- 圆角（CSS + 主进程）---"
try {
  $css = (Invoke-WebRequest 'http://127.0.0.1:8799/style.css' -TimeoutSec 8).Content
  $m = [regex]::Match($css, '--win-r\s*:\s*([0-9.]+rem)')
  $out += "css --win-r = " + $(if ($m.Success) { $m.Groups[1].Value } else { '(没找到)' })
  $out += "css html 也裁角 = " + ($css -match 'html\.shell-electron\{[^}]*border-radius:var\(--win-r\)')
  $out += "css env-chart-box = " + ($css -match 'env-chart-box')
} catch { $out += "css 失败：$_" }
$mainJs = [IO.File]::ReadAllText((Join-Path $APP 'shell\main.js'))
$out += "main.js setShape = " + ($mainJs -match 'setShape\(') + "   cuk:radius = " + ($mainJs -match 'cuk:radius')

$out += "--- 前端新元素 ---"
try {
  $html = (Invoke-WebRequest 'http://127.0.0.1:8799/' -TimeoutSec 8).Content
  $out += "env-chart = " + ($html -match 'id="env-chart"') + "   env-ranges = " + ($html -match 'id="env-ranges"') + "   env-legend = " + ($html -match 'id="env-legend"')
} catch { $out += "html 失败：$_" }

$out += "--- /api/env/history（新接口，各区间）---"
foreach ($r in @('1m', '10m', '1h', '6h', '24h', '7d')) {
  $h = Get-Json ("http://127.0.0.1:8799/api/env/history?range=" + $r)
  if ($h) {
    $first = if ($h.rows.Count) { $h.rows[0].at } else { 0 }
    $out += ("  {0,-4} seconds={1,-9} rows={2,-4} latest={3}" -f $r, $h.seconds, $h.rows.Count, (($h.latest | ConvertTo-Json -Compress)))
  } else { $out += "  $r 读取失败" }
}

$out += "--- 温度计历史文件 ---"
foreach ($pat in @('env-history', 'env-history-min.jsonl')) {
  $pp = Join-Path $APP ('data\' + $pat)
  if (Test-Path $pp) {
    $it = Get-Item $pp
    if ($it.PSIsContainer) {
      $fs = Get-ChildItem $pp -File
      $out += ("  {0} : 目录，{1} 个文件" -f $pat, $fs.Count)
      foreach ($x in $fs) { $out += ("     " + $x.Name + "  " + $x.Length + " B") }
    } else {
      $n = (Get-Content $pp -ErrorAction SilentlyContinue | Measure-Object).Count
      $out += ("  {0} : {1} B, {2} 行" -f $pat, $it.Length, $n)
    }
  } else { $out += "  $pat : (还不存在)" }
}

$out += "--- 等温度计首次读数（最多 120s）---"
$got = $false
for ($i = 0; $i -lt 24; $i++) {
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
  $out += "120s 内没有读数："
  $s2 = Get-Json 'http://127.0.0.1:8799/api/state'
  if ($s2) { $out += ($s2.envSensor | ConvertTo-Json -Compress) }
}

$out += "--- 落盘后 /api/env/history?range=1h 复核 ---"
$h1 = Get-Json 'http://127.0.0.1:8799/api/env/history?range=1h'
if ($h1) { $out += ("rows=" + $h1.rows.Count + "  " + (($h1.rows | Select-Object -Last 3 | ConvertTo-Json -Compress))) }

$out += "--- Electron 进程 ---"
$el = Get-Process electron -ErrorAction SilentlyContinue
$out += "electron 进程数 = " + (($el | Measure-Object).Count)

$out += "--- 采集器 ---"
if ($s2) { $out += "collecting = $($s2.collecting)  link = $($s2.link.state)  total = $($s2.latest.total)" }

$out += "--- 最近日志（温度/历史相关）---"
$lg = Get-Json 'http://127.0.0.1:8799/api/log'
if ($lg) { $out += ($lg.lines | Select-Object -Last 12) }

$out -join "`r`n" | Out-File -Encoding utf8 $log
"done"
