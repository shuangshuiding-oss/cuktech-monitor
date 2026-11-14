# Convert .bat / .txt in the app folder to GBK(936) + CRLF + no BOM.
#
# cmd.exe reads .bat with the system ANSI code page (936 on a Chinese Windows),
# so a UTF-8 .bat shows mojibake -- chcp 65001 does NOT reliably fix it because
# the batch parser reads the file before chcp takes effect.
#
# IDEMPOTENT BY DESIGN: a file that is already GBK is not valid UTF-8, so the
# strict UTF-8 decode below throws and we skip it.  Without this guard, running
# the script twice turns every Chinese character into '?'.
param([string]$Root = (Split-Path -Parent $PSScriptRoot))

$gbk   = [Text.Encoding]::GetEncoding(936)
$utf8  = New-Object Text.UTF8Encoding($false)
$strict = New-Object Text.UTF8Encoding($false, $true)   # throwOnInvalidBytes

$report = @()
$files = Get-ChildItem -Path $Root -Recurse -File -ErrorAction SilentlyContinue |
  Where-Object {
    ($_.Extension -eq '.bat' -or $_.Extension -eq '.txt') -and
    $_.FullName -notlike '*\.venv\*' -and
    $_.FullName -notlike '*\data\*' -and
    $_.FullName -notlike '*\vendor\*'
  }

foreach ($f in $files) {
  $bytes = [IO.File]::ReadAllBytes($f.FullName)
  $isUtf8 = $true
  try { [void]$strict.GetString($bytes) } catch { $isUtf8 = $false }

  if (-not $isUtf8) { $report += ('SKIP  already-gbk   ' + $f.Name); continue }

  $txt = $utf8.GetString($bytes)
  $txt = $txt -replace "`r`n", "`n"
  $txt = $txt -replace "`r", "`n"
  $txt = $txt -replace "`n", "`r`n"

  [IO.File]::WriteAllBytes($f.FullName, $gbk.GetBytes($txt))
  $back = $gbk.GetString([IO.File]::ReadAllBytes($f.FullName))

  if ($back -eq $txt) {
    $report += ('OK    ' + $f.Name)
  } else {
    # find the first character that GBK could not represent (becomes '?')
    $detail = ''
    $n = [Math]::Min($txt.Length, $back.Length)
    for ($i = 0; $i -lt $n; $i++) {
      if ($txt[$i] -ne $back[$i]) {
        $detail = 'first unmappable char U+{0:X4} at {1}' -f [int]$txt[$i], $i
        break
      }
    }
    if (-not $detail) { $detail = 'length changed {0} -> {1}' -f $txt.Length, $back.Length }
    $report += ('WARN  ' + $f.Name + '  ' + $detail)
  }
}

$report | ForEach-Object { Write-Host $_ }
Write-Host ('converted ' + $files.Count + ' file(s)')
