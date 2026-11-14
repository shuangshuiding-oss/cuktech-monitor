param([int]$Seconds = 420, [int]$Every = 8, [string]$Out = "$env:TEMP\_watch.txt")
# 注意：本文件必须带 UTF-8 BOM（tools\add-bom.ps1），否则 PS5.1 按 GBK 读会吞引号。
# 也不要在这里用反引号续行。
$lk = Get-Content "C:\Users\shuan\Tools\CuktechMonitor\data\running.lock" -Raw | ConvertFrom-Json
$wc = New-Object System.Net.WebClient
$wc.Encoding = [System.Text.Encoding]::UTF8
$samples = @()
$hits = New-Object System.Collections.ArrayList
$end = (Get-Date).AddSeconds($Seconds)
while ((Get-Date) -lt $end) {
  $stamp = Get-Date -Format 'HH:mm:ss'
  try {
    $st = $wc.DownloadString("http://127.0.0.1:$($lk.port)/api/state") | ConvertFrom-Json
    $dup = 0
    if ($null -ne $st.latest -and $null -ne $st.latest.rxDup) { $dup = $st.latest.rxDup }
    $samples += ($stamp + " state=" + $st.link.state + " attempt=" + $st.link.attempt + " rxDup=" + $dup + " total=" + $st.latest.total + " rssi=" + $st.link.rssi)
    $j = $wc.DownloadString("http://127.0.0.1:$($lk.port)/api/log") | ConvertFrom-Json
    foreach ($l in $j.lines) {
      if ($l -match "link|read failed|moved backwards|duplicate|collector|link error|retry in") {
        if (-not $hits.Contains($l)) { [void]$hits.Add($l) }
      }
    }
  } catch {
    $samples += ($stamp + " POLL FAIL " + $_.Exception.Message)
  }
  Start-Sleep -Seconds $Every
}
$res = @()
$res += "=== SAMPLES ==="
$res += $samples
$res += "=== LOG HITS ==="
$res += $hits
$res | Set-Content -Encoding UTF8 $Out
Write-Output "watch done -> $Out"
