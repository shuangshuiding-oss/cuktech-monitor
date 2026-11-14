param([string]$Out = "$env:TEMP\full_shot.png")
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public static class DpiH2 { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }'
[void][DpiH2]::SetProcessDPIAware()
$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap($b.Width, $b.Height)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.X, $b.Y, 0, 0, $b.Size)
$g.Dispose()
$small = New-Object System.Drawing.Bitmap(1720, 720)
$g2 = [System.Drawing.Graphics]::FromImage($small)
$g2.DrawImage($bmp, 0, 0, 1720, 720)
$g2.Dispose()
$small.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose(); $small.Dispose()
Write-Output "bounds=$($b.Width)x$($b.Height) saved=$Out"
