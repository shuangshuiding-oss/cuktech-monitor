# 实时透明验收：
#   1. 重启应用
#   2. 探针读窗口/圆角/拖动状态
#   3. 截一张"窗口所在屏幕"（含窗外）→ 看桌面是否透出来
#   4. 让透明判定跑一次（/api/state 的 shell 里带不出来，直接问探针口）
# 结果写 %TEMP%\_cuk_trans.txt
$ErrorActionPreference = 'Continue'
$log = "$env:TEMP\_cuk_trans.txt"
$out = @()

Get-Process node,electron -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 1500

$APP = 'C:\Users\shuan\Tools\CuktechMonitor'
$node = 'C:\Program Files\nodejs\node.exe'
$env:ELECTRON_RUN_AS_NODE = $null
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
$cmdLine = 'cmd.exe /c ""' + $node + '" server.js > "' + "$env:TEMP\cuk_trans_out.txt" + '" 2>&1"'
$p = Invoke-CimMethod -ClassName Win32_Process -MethodName Create `
  -Arguments @{ CommandLine = $cmdLine; CurrentDirectory = $APP }
$out += "server spawn rtn=$($p.ReturnValue) pid=$($p.ProcessId)"

$up = $false
for ($i = 0; $i -lt 25; $i++) {
  Start-Sleep -Seconds 2
  try { $null = Invoke-RestMethod -Uri 'http://127.0.0.1:8799/api/ping' -TimeoutSec 4; $up = $true; break } catch { }
}
$out += "server up = $up"

$pp = 0
try {
  $st0 = Invoke-RestMethod -Uri 'http://127.0.0.1:8799/api/state' -TimeoutSec 5
  $pp = [int]$st0.shell.probePort
} catch { }
$out += "probePort = $pp"

$probe = $null
for ($i = 0; $i -lt 25; $i++) {
  Start-Sleep -Seconds 2
  if ($pp -gt 0) { try { $probe = Invoke-RestMethod -Uri "http://127.0.0.1:$pp/probe" -TimeoutSec 6; break } catch { } }
  foreach ($c in 8790..8820) {
    try { $probe = Invoke-RestMethod -Uri "http://127.0.0.1:$c/probe" -TimeoutSec 2; $pp = $c; break } catch { }
  }
  if ($probe) { break }
}

$out += "--- 窗口状态 ---"
if ($probe) {
  $out += "bounds     = $($probe.bounds | ConvertTo-Json -Compress)"
  $out += "winOpts    = $($probe.winOpts | ConvertTo-Json -Compress)"
  $out += "radius     = $($probe.radius)  shapeNow=$($probe.shapeNow)  setShape=$($probe.shapeApi)"
  $out += "hasShadow  = $($probe.hasShadow)"
  $d = $probe.dom
  if ($d) {
    $out += "shellClass = $($d.shellClass)   winR=$($d.winR)"
    $out += "bodyRadius = $($d.bodyRadius)   htmlRadius=$($d.htmlRadius)"
    $out += "winGlass   = $($d.winGlassInDom)"
    $out += "wallpaper  = $($d.wallpaperInDom)   (False = 真透明，没铺兜底壁纸)"
    $out += "dragWired  = $($d.dragWired)"
    $out += "hitTopMid  = $($d.hitTopMid)"
    $out += "inner      = $($d.innerW) x $($d.innerH)"
  }
} else { $out += "探针没响应" }

$out += "--- 截图（页面内容）---"
try {
  $s1 = Invoke-RestMethod -Uri "http://127.0.0.1:$pp/shot?name=live_content" -TimeoutSec 30
  $out += ($s1 | ConvertTo-Json -Compress)
} catch { $out += "失败：$($_.Exception.Message)" }

$out += "--- 截图（窗口+窗外桌面）---"
try {
  $s2 = Invoke-RestMethod -Uri "http://127.0.0.1:$pp/screen?name=live_edges" -TimeoutSec 30
  $out += ($s2 | ConvertTo-Json -Compress)
} catch { $out += "失败：$($_.Exception.Message)" }

$out += "--- server 日志 ---"
try {
  $lg = Invoke-RestMethod -Uri 'http://127.0.0.1:8799/api/log' -TimeoutSec 5
  $out += ($lg.lines | Select-Object -Last 8)
} catch { }
try { $out += (Get-Content "$env:TEMP\cuk_trans_out.txt" -Tail 10 -ErrorAction SilentlyContinue) } catch { }

$out -join "`r`n" | Out-File -Encoding utf8 $log
"done -> $log"
