# shot_tray_live.ps1 - full-res capture, crop bottom-right tray area, zoom. ASCII only.
param(
  [string]$Out = "$env:TEMP\tray_live.png",
  [int]$CropW = 700,
  [int]$CropH = 60,
  [int]$Zoom = 3
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public static class DpiH3 { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }'
[void][DpiH3]::SetProcessDPIAware()

$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap($b.Width, $b.Height)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.X, $b.Y, 0, 0, $b.Size)
$g.Dispose()

$big = New-Object System.Drawing.Bitmap ($CropW * $Zoom), ($CropH * $Zoom)
$g2 = [System.Drawing.Graphics]::FromImage($big)
$g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
$g2.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::Half
$src = New-Object System.Drawing.Rectangle -ArgumentList (($b.Width - $CropW), ($b.Height - $CropH), $CropW, $CropH)
$dst = New-Object System.Drawing.Rectangle -ArgumentList 0, 0, ($CropW * $Zoom), ($CropH * $Zoom)
$g2.DrawImage($bmp, $dst, $src, [System.Drawing.GraphicsUnit]::Pixel)
$g2.Dispose()
$big.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$big.Dispose(); $bmp.Dispose()
Write-Output "saved=$Out"
