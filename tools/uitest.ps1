# 界面自测：无头 Edge 打开 ?selftest=1（页面自己跑断言并 POST 回服务端），
# 然后解析 data\selftest.log 的最新一份报告。
#
#   powershell -ExecutionPolicy Bypass -File tools\uitest.ps1
#   powershell -ExecutionPolicy Bypass -File tools\uitest.ps1 -Shot     # 只截图看外观
#
# 为什么绕这么一圈：这台机器上 node 里 spawnSync 起 msedge 会被 SIGTERM 杀掉，
# 而 PowerShell 里 `& msedge --dump-dom` 又拿不到 stdout（Edge 是 GUI 子系统进程）。
# 所以让**页面自己**把结论回传，浏览器只负责打开一次。
# 顺带截一张图，方便肉眼看曲线/布局（%TEMP%\cuk_uitest.png）。
[CmdletBinding()]
param([switch]$Shot)
$ErrorActionPreference = 'Continue'
$App = Split-Path -Parent $PSScriptRoot

$edge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
if (-not (Test-Path $edge)) { $edge = 'C:\Program Files\Microsoft\Edge\Application\msedge.exe' }
if (-not (Test-Path $edge)) { Write-Output 'msedge not found'; exit 1 }

$ready = Join-Path $App 'data\ready.json'
$lock = Join-Path $App 'data\running.lock'
if (Test-Path $ready) {
  $port = (Get-Content $ready -Raw | ConvertFrom-Json).port
} elseif (Test-Path $lock) {
  # ready.json 只在进程存活期间存在（退出时会被删掉）；认领到的端口在 running.lock 里，
  # 两个都读一遍，免得因为一个小文件缺失就把整条自测判成"应用没在跑"。
  $port = (Get-Content $lock -Raw | ConvertFrom-Json).port
  Write-Output "data\ready.json missing - falling back to running.lock (port $port)"
} else {
  Write-Output 'app not running (no ready.json / running.lock)'; exit 1
}

$log = Join-Path $App 'data\selftest.log'
$before = 0
if (Test-Path $log) { $before = (Get-Item $log).Length }

$shotFile = "$env:TEMP\cuk_uitest.png"
# -Shot：只截图、不跑页面自测。给"看外观"用 —— 这台机器上无头 Edge 对常驻 SSE 的页面
# 截图会吊死在 virtual-time 上（见记忆里的坑），所以外观检查主要靠**人眼在真窗口里看**，
# 这个模式只在页面不挂 SSE 时才可信。
if ($Shot) { $shotFile = "$env:TEMP\cuk_shot.png" }
$profile = "$env:TEMP\_cuk_uitest_profile"
$url = if ($Shot) { "http://127.0.0.1:$port/" } else { "http://127.0.0.1:$port/?selftest=1" }

# --virtual-time-budget 让页面里的 setTimeout 快速走完；--screenshot 保证 Edge 真的
# 起来并且把图写进文件（也正好是"页面渲染出来了"的证据）。
& $edge @('--headless=new', '--disable-gpu', '--no-first-run',
          "--screenshot=$shotFile", '--window-size=1400,1040',
          '--virtual-time-budget=20000', "--user-data-dir=$profile", $url) 2>$null | Out-Null
Start-Sleep -Seconds 3

if ($Shot) {
  if (Test-Path $shotFile) { Write-Output "shot ok: $shotFile" } else { Write-Output 'shot failed' ; exit 1 }
  exit 0
}

if (-not (Test-Path $log)) { Write-Output 'no selftest.log - page never reported (script crashed?)'; exit 1 }
$after = (Get-Item $log).Length
if ($after -le $before) { Write-Output 'selftest.log not updated - page did not report'; exit 1 }

$node = 'C:\Program Files\nodejs\node.exe'
if (-not (Test-Path $node)) { $node = 'node' }
& $node (Join-Path $App 'tools\uitest.js')
exit $LASTEXITCODE
