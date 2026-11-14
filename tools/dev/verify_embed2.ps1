# verify_embed2.ps1 - find CuktechPowerPanel among taskbar CHILD windows; capture. ASCII only.
param([string]$Out = "$env:TEMP\panel_embed.png")
$ErrorActionPreference = 'Continue'
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class VE2 {
  [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern IntPtr FindWindow(string cls, string win);
  [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string cls, string win);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder sb, int max);
  [DllImport("user32.dll")] public static extern IntPtr GetParent(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
"@

$hTray = [VE2]::FindWindow('Shell_TrayWnd', $null)
if ($hTray -eq [IntPtr]::Zero) { Write-Output "no taskbar"; exit 1 }

$h = [IntPtr]::Zero
$after = [IntPtr]::Zero
while ($true) {
  $c = [VE2]::FindWindowEx($hTray, $after, $null, $null)
  if ($c -eq [IntPtr]::Zero) { break }
  $sb = New-Object System.Text.StringBuilder 256
  [void][VE2]::GetWindowText($c, $sb, 256)
  $t = $sb.ToString()
  if ($t -eq 'CuktechPowerPanel') { $h = $c; break }
  $after = $c
}
if ($h -eq [IntPtr]::Zero) { Write-Output "panel not among taskbar children"; exit 1 }

$r = New-Object VE2+RECT
[void][VE2]::GetWindowRect($h, [ref]$r)
$w = $r.Right - $r.Left; $hh = $r.Bottom - $r.Top
Write-Output ("FOUND as taskbar child. screen rect=($($r.Left),$($r.Top))-($($r.Right),$($r.Bottom)) size=${w}x${hh} visible=" + [VE2]::IsWindowVisible($h))

$bmp = New-Object System.Drawing.Bitmap $w, $hh
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
[void][VE2]::PrintWindow($h, $hdc, 2)
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
