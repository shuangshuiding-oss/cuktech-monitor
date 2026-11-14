# preview_tray_icons.ps1 - render 16x16 tray frames (same drawing params as tray.ps1)
# at 8x zoom to visually check legibility. ASCII only.
param([string]$Out = "$env:TEMP\tray_preview.png")

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$lk = Get-Content "C:\Users\shuan\Tools\CuktechMonitor\data\running.lock" -Raw | ConvertFrom-Json
$wc = New-Object System.Net.WebClient
$wc.Proxy = $null
$wc.Encoding = [System.Text.Encoding]::UTF8
$s = ($wc.DownloadString("http://127.0.0.1:$($lk.port)/api/state")) | ConvertFrom-Json
$total = [double]$s.latest.total
$w = @{}
foreach ($p in $s.latest.ports) { $w[[string]$p.id] = [double]$p.w }

$frames = @(
  @{ label = '';   watts = $total },
  @{ label = 'C1'; watts = $w['c1'] },
  @{ label = 'C2'; watts = $w['c2'] },
  @{ label = 'C3'; watts = $w['c3'] },
  @{ label = 'A';  watts = $w['a'] }
)

$portColor = @{
  'C1' = [System.Drawing.Color]::FromArgb(255, 56, 189, 248)
  'C2' = [System.Drawing.Color]::FromArgb(255, 52, 211, 153)
  'C3' = [System.Drawing.Color]::FromArgb(255, 251, 191, 36)
  'A'  = [System.Drawing.Color]::FromArgb(255, 167, 139, 250)
}
$sf = New-Object System.Drawing.StringFormat
$sf.Alignment = 'Center'; $sf.LineAlignment = 'Center'
$fontBig   = New-Object System.Drawing.Font('Segoe UI', 9, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$fontMid   = New-Object System.Drawing.Font('Segoe UI', 7, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$fontSmall = New-Object System.Drawing.Font('Segoe UI', 6, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$fontTag   = New-Object System.Drawing.Font('Segoe UI', 5, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)

$zoom = 8; $gap = 10
$bmp = New-Object System.Drawing.Bitmap 16, 16
$canvas = New-Object System.Drawing.Bitmap ((5 * (16 * $zoom) + 6 * $gap), (16 * $zoom + 2 * $gap + 14))
$g0 = [System.Drawing.Graphics]::FromImage($canvas)
$g0.Clear([System.Drawing.Color]::FromArgb(255, 240, 240, 240))

for ($i = 0; $i -lt $frames.Count; $i++) {
  $f = $frames[$i]
  $col = if ($f.label -eq '') { $portColor['C1'] } else { $portColor[$f.label] }
  $text = '-'; $font = $fontBig
  if ($f.watts -ge 1000) { $text = '{0:0.#}k' -f ($f.watts / 1000); $font = $fontSmall }
  elseif ($f.watts -ge 100) { $text = '{0:0}' -f $f.watts; $font = $fontSmall }
  elseif ($f.watts -gt 0) { $text = '{0:0}' -f $f.watts; $font = $fontMid }

  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
  $g.Clear([System.Drawing.Color]::FromArgb(255, 8, 12, 22))
  $pen = New-Object System.Drawing.Pen -ArgumentList ([System.Drawing.Color]::FromArgb(200, $col.R, $col.G, $col.B)), 1
  $g.DrawRectangle($pen, 0, 0, 15, 15)
  $brush = New-Object System.Drawing.SolidBrush $col
  if ($f.label -eq '') {
    $g.DrawString($text, $font, $brush, (New-Object System.Drawing.RectangleF 0, 0, 16, 16), $sf)
  } else {
    $g.DrawString($f.label, $fontTag, $brush, (New-Object System.Drawing.RectangleF 0, 0, 16, 6), $sf)
    $g.DrawString($text, $font, $brush, (New-Object System.Drawing.RectangleF 0, 5, 16, 11), $sf)
  }
  $g.Dispose(); $pen.Dispose(); $brush.Dispose()

  $x = $gap + $i * (16 * $zoom + $gap)
  $g0.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
  $g0.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::Half
  $g0.DrawImage($bmp, $x, $gap, 16 * $zoom, 16 * $zoom)
  $fnt = New-Object System.Drawing.Font('Segoe UI', 11)
  $b2 = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 30, 30, 30))
  $cap = if ($f.label -eq '') { 'total' } else { $f.label }
  $g0.DrawString(($cap + '  ' + [math]::Round($f.watts, 1) + ' W'), $fnt, $b2, $x, (16 * $zoom + $gap + 1))
  $fnt.Dispose(); $b2.Dispose()
}
$g0.Dispose()
$canvas.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$canvas.Dispose(); $bmp.Dispose()
Write-Output "saved=$Out total=$total"
