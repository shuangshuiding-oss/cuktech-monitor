# shot_panel.ps1 - capture the floating panel content via PrintWindow. ASCII only.
param([string]$Out = "$env:TEMP\panel_shot.png", [int]$Zoom = 2)
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class PW3 {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder sb, int max);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
"@
$target = [IntPtr]::Zero
$cb = [PW3+EnumProc]{
  param($h, $l)
  if ([PW3]::IsWindowVisible($h)) {
    $sb = New-Object System.Text.StringBuilder 256
    [void][PW3]::GetWindowText($h, $sb, 256)
    if ($sb.ToString() -eq 'CuktechPowerPanel') { $script:target = $h; return $false }
  }
  return $true
}
[void][PW3]::EnumWindows($cb, [IntPtr]::Zero)
$h = $script:target
if ($h -eq [IntPtr]::Zero) { Write-Output "PANEL NOT FOUND"; exit 1 }
$r = New-Object PW3+RECT
[void][PW3]::GetWindowRect($h, [ref]$r)
$w = $r.Right - $r.Left; $hh = $r.Bottom - $r.Top
Write-Output ("rect=($($r.Left),$($r.Top))-($($r.Right),$($r.Bottom)) size=${w}x${hh} visible=" + [PW3]::IsWindowVisible($h))
$bmp = New-Object System.Drawing.Bitmap $w, $hh
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
$ok = [PW3]::PrintWindow($h, $hdc, 2)
$g.ReleaseHdc($hdc); $g.Dispose()
Write-Output "PrintWindow ok=$ok"
$big = New-Object System.Drawing.Bitmap ($w * $Zoom), ($hh * $Zoom)
$g2 = [System.Drawing.Graphics]::FromImage($big)
$g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
$g2.DrawImage($bmp, 0, 0, $w * $Zoom, $hh * $Zoom)
$g2.Dispose()
$big.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$big.Dispose(); $bmp.Dispose()
Write-Output "saved=$Out"
