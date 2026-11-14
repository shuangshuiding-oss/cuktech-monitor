# verify_panel.ps1 - switch to panel mode, locate the floating panel window and
# capture its own content via PrintWindow (works even if occluded). ASCII only.
param([string]$Out = "$env:TEMP\panel_shot.png")
$ErrorActionPreference = 'Continue'
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class PW {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern IntPtr FindWindow(string cls, string win);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
"@
[void][PW]::SetProcessDPIAware()

$lk = Get-Content "C:\Users\shuan\Tools\CuktechMonitor\data\running.lock" -Raw | ConvertFrom-Json
$port = $lk.port
$wc = New-Object System.Net.WebClient
$wc.Proxy = $null
$wc.Encoding = [System.Text.Encoding]::UTF8
$wc.Headers.Add('Content-Type', 'application/json')

[void]$wc.UploadString("http://127.0.0.1:$port/api/config", 'POST', '{"trayMode":"panel"}')
Write-Output "mode -> panel"
Start-Sleep -Seconds 8

$s = ($wc.DownloadString("http://127.0.0.1:$port/api/state")) | ConvertFrom-Json
Write-Output ("state.trayMode=" + $s.config.trayMode + "  total=" + $s.latest.total)
Write-Output ("ports: " + (($s.latest.ports | ForEach-Object { $_.id + '=' + $_.w }) -join ' '))
if (Test-Path "$env:TEMP\tray-last-error.txt") { Write-Output "ERRFILE:"; Get-Content "$env:TEMP\tray-last-error.txt" } else { Write-Output "no error file" }

Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like '*tray.ps1*' -and $_.ProcessId -ne $PID } |
  ForEach-Object { Write-Output ("tray pid=" + $_.ProcessId + " ppid=" + $_.ParentProcessId) }

$h = [PW]::FindWindow($null, "CuktechPowerPanel")
if ($h -eq [IntPtr]::Zero) { Write-Output "PANEL WINDOW NOT FOUND"; exit 1 }
$r = New-Object PW+RECT
[void][PW]::GetWindowRect($h, [ref]$r)
$w = $r.Right - $r.Left; $hh = $r.Bottom - $r.Top
Write-Output ("panel rect=($($r.Left),$($r.Top))-($($r.Right),$($r.Bottom)) size=${w}x${hh} visible=" + [PW]::IsWindowVisible($h))

if ($w -le 0 -or $hh -le 0) { exit 1 }
$bmp = New-Object System.Drawing.Bitmap $w, $hh
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
$ok = [PW]::PrintWindow($h, $hdc, 2)      # PW_RENDERFULLCONTENT
$g.ReleaseHdc($hdc)
$g.Dispose()
Write-Output ("PrintWindow ok=" + $ok)
$zoom = 2
$big = New-Object System.Drawing.Bitmap ($w * $zoom), ($hh * $zoom)
$g2 = [System.Drawing.Graphics]::FromImage($big)
$g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
$g2.DrawImage($bmp, 0, 0, $w * $zoom, $hh * $zoom)
$g2.Dispose()
$big.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$big.Dispose(); $bmp.Dispose()
Write-Output "saved=$Out"
