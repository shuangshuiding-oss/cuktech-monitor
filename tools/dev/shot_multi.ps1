# 在多个窗口宽度下给界面截图，用来核对自适应效果。
# 用法: powershell -File tools\shot_multi.ps1 [-Port 56871]
param([int]$Port = 0)

$edge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
if (-not (Test-Path $edge)) { $edge = 'C:\Program Files\Microsoft\Edge\Application\msedge.exe' }

$app = Split-Path -Parent $PSScriptRoot
if ($Port -le 0) {
  $rd = Get-Content (Join-Path $app 'data\ready.json') -Raw | ConvertFrom-Json
  $Port = $rd.port
}
$url = "http://127.0.0.1:$Port/"
$report = @("url=$url")

$sizes = @(
  @{ n = 'narrow'; w = 1020; h = 2500 },
  @{ n = 'mid';    w = 1480; h = 2150 },
  @{ n = 'wide';   w = 2160; h = 1900 }
)

foreach ($s in $sizes) {
  $shot = Join-Path $env:TEMP ("cm-" + $s.n + ".png")
  $ud   = Join-Path $env:TEMP ("cmprof-" + $s.n + "-" + (Get-Random))
  Remove-Item $shot -Force -ErrorAction SilentlyContinue
  $opts = @(
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
    '--no-default-browser-check', '--disable-extensions',
    "--screenshot=$shot",
    "--window-size=$($s.w),$($s.h)",
    '--virtual-time-budget=9000',
    "--user-data-dir=$ud",
    $url
  )
  & $edge @opts 2>&1 | Out-Null
  $ok = Test-Path $shot
  $len = 0
  if ($ok) { $len = (Get-Item $shot).Length }
  $report += ("{0,-7} {1}x{2}  ->  {3}  {4} bytes" -f $s.n, $s.w, $s.h, $ok, $len)
  $report += ("        path: $shot")
  if (Test-Path $ud) { Remove-Item $ud -Recurse -Force -ErrorAction SilentlyContinue }
}

$report | Out-File -Encoding utf8 (Join-Path $env:TEMP '_shots.txt')
