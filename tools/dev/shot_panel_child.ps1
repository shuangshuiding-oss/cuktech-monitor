# shot_panel_child.ps1 - capture the panel (taskbar child) content. ASCII only.
param([string]$Out = "$env:TEMP\panel_child.png", [int]$Zoom = 2)
$ErrorActionPreference = 'Continue'
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class SPC {
  [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern IntPtr FindWindow(string cls, string win);
  [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string cls, string win);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder sb, int max);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
"@
$hTray = [SPC]::FindWindow('Shell_TrayWnd', $null)
$after = [IntPtr]::Zero
$script:hit = [IntPtr]::Zero
while ($true) {
  $c = [SPC]::FindWindowEx($hTray, $after, $null, $null)
  if ($c -eq [IntPtr]::Zero) { break }
  $sb = New-Object System.Text.StringBuilder 256
  [void][SPC]::GetWindowText($c, $sb, 256)
  if ($sb.ToString() -eq 'CuktechPowerPanel') { $script:hit = $c; break }
  $after = $c
}
$h = $script:hit
if ($h -eq [IntPtr]::Zero) { "PANEL NOT FOUND" | Set-Content -Encoding UTF8 "$env:TEMP\_spc.txt"; exit 0 }
$r = New-Object SPC+RECT
[void][SPC]::GetWindowRect($h, [ref]$r)
$w = $r.Right - $r.Left; $hh = $r.Bottom - $r.Top
$res = "rect=($($r.Left),$($r.Top))-($($r.Right),$($r.Bottom)) size=${w}x${hh}"
$bmp = New-Object System.Drawing.Bitmap $w, $hh
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
[void][SPC]::PrintWindow($h, $hdc, 2)
$g.ReleaseHdc($hdc); $g.Dispose()
$big = New-Object System.Drawing.Bitmap ($w * $Zoom), ($hh * $Zoom)
$g2 = [System.Drawing.Graphics]::FromImage($big)
$g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
$g2.DrawImage($bmp, 0, 0, $w * $Zoom, $hh * $Zoom)
$g2.Dispose()
$big.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$big.Dispose(); $bmp.Dispose()
$res + " saved=$Out" | Set-Content -Encoding UTF8 "$env:TEMP\_spc.txt"
