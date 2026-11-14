# 可行性验证：用 .NET 的 NotifyIcon 在任务栏通知区放一个图标，并把功率数字画进图标。
# 只跑 12 秒后自动退出，结果写 %TEMP%\_tray_test.txt
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$rep = @()
try {
  $ni = New-Object System.Windows.Forms.NotifyIcon
  $ni.Visible = $true
  $rep += 'NotifyIcon created + Visible OK'

  # 画一个 16x16 的图标，把瓦数写进去
  $bmp = New-Object System.Drawing.Bitmap 16, 16
  $g   = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.Clear([System.Drawing.Color]::FromArgb(255, 10, 14, 26))
  $brush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 56, 189, 248))
  $font  = New-Object System.Drawing.Font('Segoe UI', 8, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
  $sf = New-Object System.Drawing.StringFormat
  $sf.Alignment = 'Center'; $sf.LineAlignment = 'Center'
  $g.DrawString('72', $font, $brush, (New-Object System.Drawing.RectangleF 0, 0, 16, 16), $sf)
  $g.Dispose()
  $h = $bmp.GetHicon()
  $icon = [System.Drawing.Icon]::FromHandle($h)
  $ni.Icon = $icon
  $rep += 'icon drawn from bitmap OK (hicon assigned)'

  # 反复改 tooltip + 重画图标，确认能动态刷新
  for ($i = 1; $i -le 5; $i++) {
    $w = 70 + $i
    $ni.Text = ("总功率 {0}.0 W`nC1 19.4 / C2 29.0" -f $w)
    $g2 = [System.Drawing.Graphics]::FromImage($bmp)
    $g2.Clear([System.Drawing.Color]::FromArgb(255, 10, 14, 26))
    $g2.SmoothingMode = 'AntiAlias'
    $g2.DrawString("$w", $font, $brush, (New-Object System.Drawing.RectangleF 0, 0, 16, 16), $sf)
    $g2.Dispose()
    $ni.Icon = [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
    $rep += ("update #{0}: text='{1}' -> OK" -f $i, ($ni.Text -replace "`n", ' / '))
    Start-Sleep -Milliseconds 250
  }

  # 右键菜单
  $menu = New-Object System.Windows.Forms.ContextMenuStrip
  $mi1 = $menu.Items.Add('打开窗口')
  $mi2 = $menu.Items.Add('退出')
  $ni.ContextMenuStrip = $menu
  $rep += 'context menu OK'

  Start-Sleep -Seconds 6
  $rep += 'still alive after 6s: ' + (-not $ni.IsDisposed)
  $ni.Visible = $false
  $ni.Dispose()
  $menu.Dispose()
  $rep += 'RESULT: PASS'
} catch {
  $rep += ('RESULT: FAIL -> ' + $_.Exception.GetType().Name + ': ' + $_.Exception.Message)
}
$rep | Out-File -Encoding utf8 "$env:TEMP\_tray_test.txt"
