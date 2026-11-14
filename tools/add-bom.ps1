param([Parameter(Mandatory=$true)][string[]]$Path)
# ASCII-only helper: make sure a .ps1 that contains non-ASCII text has a UTF-8 BOM.
# Without the BOM, Windows PowerShell 5.1 reads the file as GBK and a multi-byte
# character can swallow the following quote -> "string is missing the terminator".
foreach ($p in $Path) {
  if (-not (Test-Path $p)) { Write-Output "MISSING: $p"; continue }
  $b = [IO.File]::ReadAllBytes($p)
  if ($b.Length -ge 3 -and $b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF) {
    Write-Output "BOM present: $p"
    continue
  }
  [IO.File]::WriteAllBytes($p, ([byte[]](0xEF, 0xBB, 0xBF)) + $b)
  Write-Output "BOM added: $p"
}
