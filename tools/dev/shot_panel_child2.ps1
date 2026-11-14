# shot_panel_child2.ps1 - find panel via EnumChildWindows of taskbar, capture. ASCII only.
param([string]$Out = "$env:TEMP\panel_child.png", [int]$Zoom = 2)
$ErrorActionPreference = 'Continue'
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class SPC2 {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern IntPtr FindWindow(string cls, string win);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr h, EnumProc cb, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder sb, int max);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
"@
$hTray = [SPC2]::FindWindow('Shell_TrayWnd', $null)
$script:hit = [IntPtr]::Zero
$cb = [SPC2+EnumProc]{
  param($h, $l)
  $sb = New-Object System.Text.StringBuilder 256
  [void][SPC2]::GetWindowText($h, $sb, 256)
  if ($sb.ToString() -eq 'CuktechPowerPanel') { $script:hit = $h; return $false }
  return $true
}
[void][SPC2]::EnumChildWindows($hTray, $cb, [IntPtr]::Zero)
$h = $script:hit
if ($h -eq [IntPtr]::Zero) { "PANEL NOT FOUND" | Set-Content -Encoding UTF8 "$env:TEMP\_spc2.txt"; exit 0 }
$r = New-Object SPC2+RECT
[void][SPC2]::GetWindowRect($h, [ref]$r)
$w = $r.Right - $r.Left; $hh = $r.Bottom - $r.Top
$res = "rect=($($r.Left),$($r.Top))-($($r.Right),$($r.Bottom)) size=${w}x${hh}"
$bmp = New-Object System.Drawing.Bitmap $w, $hh
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
[void][SPC2]::PrintWindow($h, $hdc, 2)
$g.ReleaseHdc($hdc); $g.Dispose()
$big = New-Object System.Drawing.Bitmap ($w * $Zoom), ($hh * $Zoom)
$g2 = [System.Drawing.Graphics]::FromImage($big)
$g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
$g2.DrawImage($bmp, 0, 0, $w * $Zoom, $hh * $Zoom)
$g2.Dispose()
$big.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$big.Dispose(); $bmp.Dispose()
$res + " saved=$Out" | Set-Content -Encoding UTF8 "$env:TEMP\_spc2.txt"
