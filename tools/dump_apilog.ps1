param([int]$Tail = 200, [string]$Out = "$env:TEMP\_apilog.txt")
$l = @()
try {
  $lk = Get-Content "C:\Users\shuan\Tools\CuktechMonitor\data\running.lock" -Raw | ConvertFrom-Json
  $wc = New-Object System.Net.WebClient
  $wc.Encoding = [System.Text.Encoding]::UTF8
  $j = $wc.DownloadString("http://127.0.0.1:$($lk.port)/api/log") | ConvertFrom-Json
  $l += "total lines=" + $j.lines.Count
  $j.lines | Select-Object -Last $Tail | ForEach-Object { $l += $_ }
} catch { $l += "FAIL: " + $_.Exception.Message }
$l | Set-Content -Encoding UTF8 $Out
Write-Output "written"
