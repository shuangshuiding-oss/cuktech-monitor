param([int]$WaitSec = 45, [string]$Out = "$env:TEMP\_final.txt")
# ASCII only on purpose.
Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class WinEnum3 {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
}
"@
$l = @()
Start-Sleep -Seconds $WaitSec
$lk = Get-Content "C:\Users\shuan\Tools\CuktechMonitor\data\running.lock" -Raw | ConvertFrom-Json
$wc = New-Object System.Net.WebClient
$wc.Encoding = [System.Text.Encoding]::UTF8
try {
  $s = $wc.DownloadString("http://127.0.0.1:$($lk.port)/api/state") | ConvertFrom-Json
  $l += "port=$($lk.port)"
  $l += "link=$($s.link.state) attempt=$($s.link.attempt) msg=$($s.link.msg)"
  $l += "total=$($s.latest.total) rssi=$($s.link.rssi) rxDup=$($s.latest.rxDup) rxLag=$($s.latest.rxLag)"
  $l += "config.tray=$($s.config.tray) trayMode=$($s.config.trayMode) interval=$($s.config.interval)"
  $l += "--- last 30 log lines ---"
  $j = $wc.DownloadString("http://127.0.0.1:$($lk.port)/api/log") | ConvertFrom-Json
  $j.lines | Select-Object -Last 30 | ForEach-Object { $l += $_ }
} catch { $l += "STATE FAIL: $($_.Exception.Message)" }
$l += "--- visible windows matching Ultra/Cuktech ---"
$sb = New-Object Text.StringBuilder 512
$cb = [WinEnum3+EnumProc]{
  param($h, $x)
  $null = [WinEnum3]::GetWindowTextW($h, $sb, 512)
  $t = $sb.ToString()
  if ($t -match 'Ultra|Cuktech' -and [WinEnum3]::IsWindowVisible($h)) { $script:l += "win: $t" }
  return $true
}
[void][WinEnum3]::EnumWindows($cb, [IntPtr]::Zero)
$l | Set-Content -Encoding UTF8 $Out
Write-Output "written"
