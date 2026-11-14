# 端到端实测协议开关：关 USB-A SCP -> 读回 -> 开回来 -> 读回。
# 走的是界面同一条链路：POST /api/control -> server.setProtocol -> collector set 2.21 -> read_full 回读。
$rep = @()
$base = 'http://127.0.0.1:54124'
$hdr  = @{ 'Content-Type' = 'application/json; charset=utf-8' }

function Post($body) {
  $j = $body | ConvertTo-Json -Compress
  $bytes = [Text.Encoding]::UTF8.GetBytes($j)
  Invoke-RestMethod -Uri "$base/api/control" -Method Post -Body $bytes -Headers $hdr -TimeoutSec 40
}

function Mask() {
  $s = Invoke-RestMethod "$base/api/state" -TimeoutSec 15
  return $s.latest.settings.protocol_ctl_extend
}

$rep += '=== 初始掩码 ==='
$m0 = Mask
$rep += ('  0x{0:x8}  ({1})' -f [uint32]$m0, $m0)

$rep += '=== 1) 关闭 USB-A · SCP (bit25) ==='
$r1 = Post @{ action = 'protocol'; port = 'a'; sw = 'scp'; on = $false }
$rep += ('  ok={0} readback=0x{1:x8} value=0x{2:x8} noop={3} err={4}' -f $r1.ok, [uint32]$r1.readback, [uint32]$r1.value, $r1.noop, $r1.error)
Start-Sleep -Milliseconds 1500
$m1 = Mask
$rep += ('  轮询到的最新掩码: 0x{0:x8}' -f [uint32]$m1)

$rep += '=== 2) 重复关闭（应为 noop） ==='
$r2 = Post @{ action = 'protocol'; port = 'a'; sw = 'scp'; on = $false }
$rep += ('  ok={0} noop={1} err={2}' -f $r2.ok, $r2.noop, $r2.error)

$rep += '=== 3) 开回 USB-A · SCP ==='
$r3 = Post @{ action = 'protocol'; port = 'a'; sw = 'scp'; on = $true }
$rep += ('  ok={0} readback=0x{1:x8} err={2}' -f $r3.ok, [uint32]$r3.readback, $r3.error)
Start-Sleep -Milliseconds 1500
$m3 = Mask
$rep += ('  轮询到的最新掩码: 0x{0:x8}' -f [uint32]$m3)

$rep += '=== 4) 扩展读取 2.8（ext-read） ==='
$r4 = Post @{ action = 'ext' }
$v28 = $r4.values.'2.08'
$rep += ('  ok={0} 2.8={1} (0x{2:x2}) note={3} err={4}' -f $r4.ok, $v28, [uint32]$v28, $r4.note, $r4.error)

$rep += ''
if ($m3 -eq $m0 -and $m1 -ne $m0) { $rep += 'RESULT: PASS（翻了又还原，最终与初始一致）' }
else { $rep += ('RESULT: CHECK  m0=0x{0:x8} m1=0x{1:x8} m3=0x{2:x8}' -f [uint32]$m0, [uint32]$m1, [uint32]$m3) }

$rep | Out-File -Encoding utf8 "$env:TEMP\_proto_test.txt"
