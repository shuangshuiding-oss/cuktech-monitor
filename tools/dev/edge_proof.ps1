# 鐧借竟鍐冲畾鎬ч獙璇?# 1) 鎶婄獥鍙ｆ尓鍒板彸涓嬭锛堝共鍑€妗岄潰鍖猴紝鍛ㄥ洿娌℃湁鐧藉簳绐楀彛锛?# 2) 鎷嶅睆骞曪紙绐楀彛 + 鍥涘懆妗岄潰锛?# 3) 鐢ㄥ儚绱犲墫闈㈢‘璇侊細绐楀彛澶栫紭鏄?绯荤粺鐧芥弿杈? 杩樻槸 "骞插噣鍦嗚+妗岄潰"
$ErrorActionPreference = 'Continue'
$out = "$env:TEMP\_cuk_edge_proof.txt"
$log = @()
function W($s) { $script:log += $s; Write-Host $s }

$base = 8810
# 鎵炬帰閽堝彛
$port = 0
foreach ($p in $base..($base + 20)) {
  try {
    $r = Invoke-RestMethod -Uri "http://127.0.0.1:$p/probe" -TimeoutSec 2
    $port = $p; break
  } catch {}
}
if (-not $port) { W "鎺㈤拡鏈搷搴?; $log | Set-Content -Path $out -Encoding UTF8; exit 1 }
W "probePort = $port"

$st = Invoke-RestMethod -Uri "http://127.0.0.1:8799/api/state" -TimeoutSec 4
$sh = $st.shell
W "shell = $($sh.probePort)"
W "windowBefore = $($sh.window | ConvertTo-Json -Compress)"

# 鎸埌鍙充笅瑙?$mv = Invoke-RestMethod -Uri "http://127.0.0.1:$port/move?to=br" -TimeoutSec 4
W "move = $($mv | ConvertTo-Json -Compress)"
Start-Sleep -Milliseconds 900

# 鎷嶅睆骞?$sc = Invoke-RestMethod -Uri "http://127.0.0.1:$port/screen?name=proof_br" -TimeoutSec 15
W "screen = $($sc | ConvertTo-Json -Compress)"

# 鎺㈤拡锛堢‘璁?shape 鐘舵€侊級
$pr = Invoke-RestMethod -Uri "http://127.0.0.1:$port/probe" -TimeoutSec 4
W "winOpts  = $($pr.winOpts | ConvertTo-Json -Compress)"
W "radius   = $($pr.radius)  shapeNow=$($pr.shapeNow)"
W "wallpaper= $($pr.dom.wallpaperInDom)"

$log | Set-Content -Path $out -Encoding UTF8
Write-Host "--- done ---"
