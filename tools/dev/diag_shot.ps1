# 诊断：本会话里能否用 Edge headless 截图（结果写 %TEMP%\_shot_diag.txt）
$rep = @()
$rep += '=== find edge ==='
$cands = @(
  'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',
  'C:\Program Files\Microsoft\Edge\Application\msedge.exe',
  "$env:LOCALAPPDATA\Microsoft\Edge\Application\msedge.exe"
)
$edge = $null
foreach ($c in $cands) {
  $ok = Test-Path $c
  $rep += "  $c -> $ok"
  if ($ok -and -not $edge) { $edge = $c }
}
$rep += "chosen: $edge"
$rep += ''

$rep += '=== version probe ==='
if ($edge) {
  $v = & $edge --version 2>&1
  $rep += "  exit=$LASTEXITCODE out=$v"
}
$rep += ''

$rep += '=== screenshot probe ==='
$shot = "$env:TEMP\cm-shot.png"
$ud   = "$env:TEMP\cmprof1"
Remove-Item $shot -Force -ErrorAction SilentlyContinue
if (Test-Path $ud) { Remove-Item $ud -Recurse -Force -ErrorAction SilentlyContinue }
$args1 = @(
  '--headless=new',
  '--disable-gpu',
  '--hide-scrollbars',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  "--screenshot=$shot",
  '--window-size=1420,1750',
  '--virtual-time-budget=9000',
  "--user-data-dir=$ud",
  'http://127.0.0.1:54124/'
)
$rep += '  args: ' + ($args1 -join ' ')
& $edge @args1 2>&1 | ForEach-Object { $rep += '  [out] ' + $_ }
$rep += "  exit=$LASTEXITCODE"
$rep += "  exists=$(Test-Path $shot)"
if (Test-Path $shot) { $rep += "  size=$((Get-Item $shot).Length)" }
$rep += ''
$rep += '=== also: is anything listening on 54124 ==='
try {
  $r = Invoke-WebRequest 'http://127.0.0.1:54124/' -TimeoutSec 8 -UseBasicParsing
  $rep += "  HTTP $($r.StatusCode), $($r.Content.Length) bytes, title=$(if ($r.Content -match '<title>(.*?)</title>') { $Matches[1] })"
} catch { $rep += "  ERROR: $($_.Exception.Message)" }

$rep | Out-File -Encoding utf8 "$env:TEMP\_shot_diag.txt"
