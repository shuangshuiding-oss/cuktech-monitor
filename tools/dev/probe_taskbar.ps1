# probe_taskbar.ps1 - locate Shell_TrayWnd, report rect/visibility, capture it. ASCII only.
param([string]$Out = "$env:TEMP\tray_probe.png")
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class TB {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern IntPtr FindWindow(string cls, string win);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
"@
[void][TB]::SetProcessDPIAware()

$h = [TB]::FindWindow("Shell_TrayWnd", $null)
if ($h -eq [IntPtr]::Zero) { Write-Output "taskbar window NOT FOUND"; exit 1 }
$r = New-Object TB+RECT
[void][TB]::GetWindowRect($h, [ref]$r)
$vis = [TB]::IsWindowVisible($h)
Write-Output ("taskbar rect L={0} T={1} R={2} B={3} visible={4}" -f $r.Left, $r.Top, $r.Right, $r.Bottom, $vis)

# nudge mouse to bottom-center to wake an auto-hidden taskbar, then re-probe
[void][TB]::SetCursorPos([int](($r.Left + $r.Right) / 2), ($r.Bottom - 2))
Start-Sleep -Milliseconds 900
[void][TB]::GetWindowRect($h, [ref]$r)
$vis = [TB]::IsWindowVisible($h)
Write-Output ("after hover rect L={0} T={1} R={2} B={3} visible={4}" -f $r.Left, $r.Top, $r.Right, $r.Bottom, $vis)

$w = $r.Right - $r.Left; $hh = $r.Bottom - $r.Top
if ($w -le 0 -or $hh -le 0) { Write-Output "zero-size taskbar"; exit 1 }
$bmp = New-Object System.Drawing.Bitmap $w, $hh
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($r.Left, $r.Top, 0, 0, (New-Object System.Drawing.Size $w, $hh))
$g.Dispose()
$zoom = 2
$big = New-Object System.Drawing.Bitmap ($w * $zoom), ($hh * $zoom)
$g2 = [System.Drawing.Graphics]::FromImage($big)
$g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
$g2.DrawImage($bmp, 0, 0, $w * $zoom, $hh * $zoom)
$g2.Dispose()
$big.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$big.Dispose(); $bmp.Dispose()
Write-Output "saved=$Out"
