# Dumps the autostart .lnk that belongs to this app (target contains CuktechMonitor)
# so we can confirm it points at the launcher bat with the "bg" argument.
# ASCII-only on purpose: non-ASCII .ps1 needs a UTF-8 BOM.
# Writes to %TEMP%\_cuk_lnk.txt
$d = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup'
$w = New-Object -ComObject WScript.Shell
$out = New-Object System.Text.StringBuilder
[void]$out.AppendLine('startup dir = ' + $d)
$n = 0
foreach ($f in @(Get-ChildItem -Path $d -Filter *.lnk -ErrorAction SilentlyContinue)) {
  $s = $w.CreateShortcut($f.FullName)
  if ($s.TargetPath -notlike '*CuktechMonitor*') { continue }
  $n++
  [void]$out.AppendLine('file      = ' + $f.Name)
  [void]$out.AppendLine('target    = ' + $s.TargetPath)
  [void]$out.AppendLine('arguments = [' + $s.Arguments + ']')
  [void]$out.AppendLine('workdir   = ' + $s.WorkingDirectory)
  [void]$out.AppendLine('icon      = ' + $s.IconLocation)
  [void]$out.AppendLine('window    = ' + $s.WindowStyle)
  [void]$out.AppendLine('')
}
[void]$out.AppendLine('matched = ' + $n)
$out.ToString() | Out-File -FilePath "$env:TEMP\_cuk_lnk.txt" -Encoding UTF8
"written"
