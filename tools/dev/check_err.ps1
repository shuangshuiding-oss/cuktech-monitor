# check_err.ps1 - report tray_err2.txt status. ASCII only.
$src = "$env:TEMP\tray_err2.txt"
$dst = "$env:TEMP\_terr2.txt"
if (Test-Path $src) {
  $len = (Get-Item $src).Length
  [IO.File]::WriteAllText($dst, "EXISTS len=$len`n" + ([IO.File]::ReadAllText($src)), [System.Text.Encoding]::UTF8)
} else {
  [IO.File]::WriteAllText($dst, "NO FILE`n", [System.Text.Encoding]::UTF8)
}
