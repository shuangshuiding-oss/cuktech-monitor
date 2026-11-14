# 窗口外观验收：重启应用 → 探针读窗口/圆角/拖动状态 → 截图存盘。
# 结果写 %TEMP%\_cuk_wincheck.txt（会话里 stdout 不回传）。
$ErrorActionPreference = 'Continue'
$log = "$env:TEMP\_cuk_wincheck.txt"
$out = @()

Get-Process node,electron -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 1500

$APP = 'C:\Users\shuan\Tools\CuktechMonitor'
$node = 'C:\Program Files\nodejs\node.exe'
$cmdLine = 'cmd.exe /c ""' + $node + '" server.js > "' + "$env:TEMP\cuk_win_out.txt" + '" 2>&1"'
$p = Invoke-CimMethod -ClassName Win32_Process -MethodName Create `
  -Arguments @{ CommandLine = $cmdLine; CurrentDirectory = $APP }
$out += "server spawn rtn=$($p.ReturnValue) pid=$($p.ProcessId)"

# 等 server 起来（端口 8799）
$up = $false
for ($i = 0; $i -lt 25; $i++) {
  Start-Sleep -Seconds 2
  try { $null = Invoke-RestMethod -Uri 'http://127.0.0.1:8799/api/ping' -TimeoutSec 4; $up = $true; break } catch { }
}
$out += "server up = $up"

# 探针口从 /api/state 里读（外壳会从 8799+11 往上找可用口，本机 8800 被系统占了）
$pp = 0
try {
  $st0 = Invoke-RestMethod -Uri 'http://127.0.0.1:8799/api/state' -TimeoutSec 5
  $pp = [int]$st0.shell.probePort
  $out += "state.shell = $($st0.shell | ConvertTo-Json -Compress)"
} catch { $out += "state 读取失败" }
$out += "probePort = $pp"

$probe = $null
for ($i = 0; $i -lt 25; $i++) {
  Start-Sleep -Seconds 2
  if ($pp -gt 0) {
    try { $probe = Invoke-RestMethod -Uri "http://127.0.0.1:$pp/probe" -TimeoutSec 6; break } catch { }
  }
  # 兜底：直接扫一串候选口
  foreach ($c in 8790..8820) {
    try { $probe = Invoke-RestMethod -Uri "http://127.0.0.1:$c/probe" -TimeoutSec 2; $pp = $c; break } catch { }
  }
  if ($probe) { break }
}
$out += "--- 探针（port=$pp）---"
if ($probe) {
  $out += "bounds      = $($probe.bounds | ConvertTo-Json -Compress)"
  $out += "fullScreen  = $($probe.fullScreen)  radius=$($probe.radius)  setShape=$($probe.shapeApi)"
  $d = $probe.dom
  if ($d) {
    $out += "shellClass  = $($d.shellClass)"
    $out += "winR        = $($d.winR)   bodyRadius=$($d.bodyRadius)  htmlRadius=$($d.htmlRadius)"
    $out += "bodyOverflow= $($d.bodyOverflow)   appOverflowY=$($d.appOverflowY)"
    $out += "winGlass    = $($d.winGlassInDom)   rect=$($d.winGlassRect | ConvertTo-Json -Compress)"
    $out += "wallpaper   = $($d.wallpaperInDom)"
    $out += "bar         = $($d.bar | ConvertTo-Json -Compress)"
    $out += "dragZone    = $($d.dragZone | ConvertTo-Json -Compress)"
    $out += "dragWired   = $($d.dragWired)   info=$($d.dragInfo | ConvertTo-Json -Compress)"
    $out += "hitTopLeft  = $($d.hitTopLeft)"
    $out += "hitTopMid   = $($d.hitTopMid)"
    $out += "hitTopRight = $($d.hitTopRight)"
    $out += "inner       = $($d.innerW) x $($d.innerH)"
    if ($d.domErr) { $out += "domErr      = $($d.domErr)" }
  } else {
    $out += "dom 为空（页面可能还没加载完）"
  }
} else {
  $out += "探针口没有响应（试过 8790~8820）"
}

# 截图（走外壳自己的 capturePage：无头 Edge 在常驻 SSE 页面上截不出来）
$out += "--- 截图 ---"
try {
  $shot = Invoke-RestMethod -Uri "http://127.0.0.1:$pp/shot?name=win_v170" -TimeoutSec 30
  $out += ($shot | ConvertTo-Json -Compress)
} catch { $out += "截图失败：$($_.Exception.Message)" }

$out += "--- server 日志尾部 ---"
try {
  $lg = Invoke-RestMethod -Uri 'http://127.0.0.1:8799/api/log' -TimeoutSec 5
  $out += ($lg.lines | Select-Object -Last 10)
} catch { }

$out -join "`r`n" | Out-File -Encoding utf8 $log
"done -> $log"
