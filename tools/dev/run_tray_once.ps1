# run_tray_once.ps1 - run tray.ps1 in-process and capture all output to a file.
$ErrorActionPreference = 'Continue'
$out = "$env:TEMP\tray_err2.txt"
try {
  & 'C:\Users\shuan\Tools\CuktechMonitor\tray.ps1' -Port 49685 *>&1 | Out-File -Encoding UTF8 $out
  "script returned, exit=$LASTEXITCODE" | Out-File -Encoding UTF8 -Append $out
} catch {
  ("THROWN: " + $_.Exception.ToString()) | Out-File -Encoding UTF8 -Append $out
}
