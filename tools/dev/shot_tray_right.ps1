# shot_tray_right.ps1 - capture right end of the real taskbar rect, zoom 4x. ASCII only.
param([string]$Out = "$env:TEMP\tray_right.png", [int]$Right = 480, [int]$Zoom = 4, [int]$Height = 110)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class TB2 {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern IntPtr FindWindow(string cls, string win);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
"@
[void][TB2]::SetProcessDPIAware()
$h = [TB2]::FindWindow("Shell_TrayWnd", $null)
if ($h -eq [IntPtr]::Zero) { Write-Output "no taskbar"; exit 1 }
$r = New-Object TB2+RECT
[void][TB2]::GetWindowRect($h, [ref]$r)
$w = $r.Right - $r.Left; $hh = $r.Bottom - $r.Top
$cw = [Math]::Min($Right, $w)
$ch = [Math]::Min($Height, $r.Bottom)
$bmp = New-Object System.Drawing.Bitmap $cw, $ch
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen(($r.Right - $cw), ($r.Bottom - $ch), 0, 0, (New-Object System.Drawing.Size $cw, $ch))
$g.Dispose()
$big = New-Object System.Drawing.Bitmap ($cw * $Zoom), ($ch * $Zoom)
$g2 = [System.Drawing.Graphics]::FromImage($big)
$g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
$g2.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::Half
$g2.DrawImage($bmp, 0, 0, $cw * $Zoom, $ch * $Zoom)
$g2.Dispose()
$big.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$big.Dispose(); $bmp.Dispose()
Write-Output ("saved=$Out crop_w=$cw crop_h=$ch")
