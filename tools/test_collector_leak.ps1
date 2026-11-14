param([string]$Out = "$env:TEMP\_leak.txt")
function Snap($tag) {
  $r = @("--- $tag ---")
  Get-CimInstance Win32_Process -Filter "Name='python.exe'" -ErrorAction SilentlyContinue |
    ForEach-Object { $r += ("py pid={0} ppid={1}" -f $_.ProcessId, $_.ParentProcessId) }
  return $r
}
$l = @()
$l += Snap "BEFORE"
$lk = Get-Content "C:\Users\shuan\Tools\CuktechMonitor\data\running.lock" -Raw | ConvertFrom-Json
$wc = New-Object System.Net.WebClient
$wc.Encoding = [System.Text.Encoding]::UTF8
# 触发一次 stopCollector + startCollector（等价于界面点「重连」）
$null = $wc.UploadString("http://127.0.0.1:$($lk.port)/api/reconnect", "POST", "")
$l += "reconnect posted"
Start-Sleep -Seconds 4
$l += Snap "AFTER 4s"
Start-Sleep -Seconds 8
$l += Snap "AFTER 12s"
$l | Set-Content -Encoding UTF8 $Out
Write-Output "written"
