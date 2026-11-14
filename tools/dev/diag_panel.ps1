# diag_panel.ps1 - enumerate top-level windows + dump tray error file + state. ASCII only.
Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class EW {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder sb, int max);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
}
"@
$found = @()
$cb = [EW+EnumProc]{
  param($h, $l)
  if ([EW]::IsWindowVisible($h)) {
    $sb = New-Object System.Text.StringBuilder 256
    [void][EW]::GetWindowText($h, $sb, 256)
    $t = $sb.ToString()
    if ($t -and ($t -like '*Cuktech*' -or $t -like '*Power*Panel*')) {
      $pid2 = 0
      [void][EW]::GetWindowThreadProcessId($h, [ref]$pid2)
      $script:found += ("hwnd={0} pid={1} title={2}" -f $h, $pid2, $t)
    }
  }
  return $true
}
[void][EW]::EnumWindows($cb, [IntPtr]::Zero)
if ($script:found.Count -eq 0) { Write-Output "no Cuktech/PowerPanel window found" }
else { $script:found | ForEach-Object { Write-Output $_ } }

if (Test-Path "$env:TEMP\tray-last-error.txt") {
  Write-Output "--- tray-last-error.txt ---"
  Get-Content "$env:TEMP\tray-last-error.txt" | Select-Object -First 12
} else { Write-Output "no tray error file" }

$lk = Get-Content "C:\Users\shuan\Tools\CuktechMonitor\data\running.lock" -Raw | ConvertFrom-Json
$wc = New-Object System.Net.WebClient
$wc.Encoding = [System.Text.Encoding]::UTF8
$s = ($wc.DownloadString("http://127.0.0.1:$($lk.port)/api/state")) | ConvertFrom-Json
Write-Output ("trayMode=" + $s.config.trayMode + " total=" + $s.latest.total + " link=" + $s.link.state)
