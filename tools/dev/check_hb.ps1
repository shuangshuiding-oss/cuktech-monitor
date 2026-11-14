# check_hb.ps1 - report heartbeat status. ASCII only.
$dst = "$env:TEMP\_hb2.txt"
$hb = "$env:TEMP\tray-heartbeat.txt"
$tr = "$env:TEMP\tray_err2.txt"
$lines = @()
if (Test-Path $hb) { $lines += ("HB: " + [IO.File]::ReadAllText($hb)) } else { $lines += "HB: none" }
if (Test-Path $tr) { $lines += ("ERRFILE len=" + (Get-Item $tr).Length) }
if (Test-Path "$env:TEMP\tray-last-error.txt") { $lines += "TRAY-LAST-ERROR:"; $lines += ([IO.File]::ReadAllText("$env:TEMP\tray-last-error.txt")) } else { $lines += "TRAY-LAST-ERROR: none" }
[IO.File]::WriteAllLines($dst, $lines, [System.Text.Encoding]::UTF8)
