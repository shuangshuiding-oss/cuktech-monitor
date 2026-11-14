# verify_embed.ps1 - restart tray in panel mode; verify the panel is a child of
# the taskbar; capture its content. ASCII only.
param([string]$Out = "$env:TEMP\panel_embed.png")
$ErrorActionPreference = 'Continue'
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class VE {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder sb, int max);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetParent(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern IntPtr FindWindow(string cls, string win);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
"@

# 1) kill current tray; server restarts it in ~3 s with fresh tray.ps1
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like '*tray.ps1*' -and $_.ProcessId -ne $PID } |
  ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force; Write-Output ("killed " + $_.ProcessId) } catch {} }
Start-Sleep -Seconds 9

# 2) make sure mode is panel
$lk = Get-Content "C:\Users\shuan\Tools\CuktechMonitor\data\running.lock" -Raw | ConvertFrom-Json
$wc = New-Object System.Net.WebClient
$wc.Proxy = $null
$wc.Encoding = [System.Text.Encoding]::UTF8
$wc.Headers.Add('Content-Type', 'application/json')
[void]$wc.UploadString("http://127.0.0.1:$($lk.port)/api/config", 'POST', '{"trayMode":"panel"}')
Start-Sleep -Seconds 6
$s = ($wc.DownloadString("http://127.0.0.1:$($lk.port)/api/state")) | ConvertFrom-Json
Write-Output ("trayMode=" + $s.config.trayMode + " total=" + $s.latest.total + " link=" + $s.link.state)
if (Test-Path "$env:TEMP\tray-last-error.txt") { Write-Output "ERRFILE:"; Get-Content "$env:TEMP\tray-last-error.txt" | Select-Object -First 8 }

# 3) find panel window
$target = [IntPtr]::Zero
$cb = [VE+EnumProc]{
  param($h, $l)
  if ([VE]::IsWindowVisible($h)) {
    $sb = New-Object System.Text.StringBuilder 256
    [void][VE]::GetWindowText($h, $sb, 256)
    if ($sb.ToString() -eq 'CuktechPowerPanel') { $script:target = $h; return $false }
  }
  return $true
}
[void][VE]::EnumWindows($cb, [IntPtr]::Zero)
$h = $script:target
if ($h -eq [IntPtr]::Zero) { Write-Output "PANEL NOT FOUND"; exit 1 }

$hTray = [VE]::FindWindow('Shell_TrayWnd', $null)
$par = [VE]::GetParent($h)
$r = New-Object VE+RECT
[void][VE]::GetWindowRect($h, [ref]$r)
Write-Output ("panel screen rect=($($r.Left),$($r.Top))-($($r.Right),$($r.Bottom)) size=$($r.Right - $r.Left)x$($r.Bottom - $r.Top)")
Write-Output ("parentIsTaskbar=" + ($par -eq $hTray) + "  parent=$par taskbar=$hTray")

# 4) capture content
$w = $r.Right - $r.Left; $hh = $r.Bottom - $r.Top
$bmp = New-Object System.Drawing.Bitmap $w, $hh
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
[void][VE]::PrintWindow($h, $hdc, 2)
$g.ReleaseHdc($hdc); $g.Dispose()
$zoom = 2
$big = New-Object System.Drawing.Bitmap ($w * $zoom), ($hh * $zoom)
$g2 = [System.Drawing.Graphics]::FromImage($big)
$g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
$g2.DrawImage($bmp, 0, 0, $w * $zoom, $hh * $zoom)
$g2.Dispose()
$big.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$big.Dispose(); $bmp.Dispose()
Write-Output "saved=$Out"
