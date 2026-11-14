# Lists Edge/Chrome windows (id + title) so we can tell whether the app window
# actually opened. ASCII-only on purpose: non-ASCII .ps1 needs a BOM.
# Writes to %TEMP%\_cuk_windows.txt
$out = New-Object System.Text.StringBuilder
[void]$out.AppendLine("--- msedge windows ---")
foreach ($p in @(Get-Process msedge -ErrorAction SilentlyContinue)) {
  if ($p.MainWindowTitle) { [void]$out.AppendLine("" + $p.Id + "  " + $p.MainWindowTitle) }
}
[void]$out.AppendLine("--- chrome windows ---")
foreach ($p in @(Get-Process chrome -ErrorAction SilentlyContinue)) {
  if ($p.MainWindowTitle) { [void]$out.AppendLine("" + $p.Id + "  " + $p.MainWindowTitle) }
}
[void]$out.AppendLine("--- node windows ---")
foreach ($p in @(Get-Process node -ErrorAction SilentlyContinue)) {
  [void]$out.AppendLine("" + $p.Id + "  hwnd=" + $p.MainWindowHandle)
}
$out.ToString() | Out-File -FilePath "$env:TEMP\_cuk_windows.txt" -Encoding UTF8
"written"
