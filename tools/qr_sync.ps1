$src = "C:\Users\shuan\Tools\CuktechMonitor\data\qr-fw.png"
$dst = "C:\Users\shuan\Tools\CuktechMonitor\web\qr-fw.png"
$end = (Get-Date).AddMinutes(60)
while ((Get-Date) -lt $end) {
  if (Test-Path $src) {
    $a = (Get-Item $src).LastWriteTime
    $b = if (Test-Path $dst) { (Get-Item $dst).LastWriteTime } else { [datetime]::MinValue }
    if ($a -gt $b) { Copy-Item $src $dst -Force }
  }
  Start-Sleep -Seconds 3
}
