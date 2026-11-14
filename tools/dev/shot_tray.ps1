param(
  [string]$Out = "$env:TEMP\tray_shot.png",
  [int]$Zoom = 3
)
# Capture the Windows taskbar notification area and zoom it up so the tiny
# 16x16 tray icon becomes readable. ASCII only (avoid BOM/encoding issues).

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

Add-Type -TypeDefinition @"
using System.Runtime.InteropServices;
public static class DpiHelper {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
"@
[void][DpiHelper]::SetProcessDPIAware()

$vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
$screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds

# Taskbar strip: full width of primary screen, last 140 px
$stripH = 140
$sx = $screen.X
$sy = $screen.Y + $screen.Height - $stripH
$sw = $screen.Width
$sh = $stripH

$bmp = New-Object System.Drawing.Bitmap($sw, $sh)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($sx, $sy, 0, 0, (New-Object System.Drawing.Size($sw, $sh)))
$g.Dispose()

# Crop the right-hand notification area (right 520 px) and zoom it
$cropW = [Math]::Min(520, $sw)
$crop = New-Object System.Drawing.Bitmap($cropW, $sh)
$g2 = [System.Drawing.Graphics]::FromImage($crop)
$g2.DrawImage($bmp, (New-Object System.Drawing.Rectangle(0, 0, $cropW, $sh)),
              (New-Object System.Drawing.Rectangle(($sw - $cropW), 0, $cropW, $sh)),
              [System.Drawing.GraphicsUnit]::Pixel)
$g2.Dispose()

$zw = $cropW * $Zoom
$zh = $sh * $Zoom
$big = New-Object System.Drawing.Bitmap($zw, $zh)
$g3 = [System.Drawing.Graphics]::FromImage($big)
$g3.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
$g3.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::Half
$g3.DrawImage($crop, 0, 0, $zw, $zh)
$g3.Dispose()

$big.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose(); $crop.Dispose(); $big.Dispose()

Write-Output "screen=$($screen.Width)x$($screen.Height) strip=$sw x $sh"
Write-Output "saved=$Out"
