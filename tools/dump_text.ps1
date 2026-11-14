# Reads a GBK(936) text file and writes a UTF-8 copy so the agent can read it.
# ASCII-only on purpose (non-ASCII .ps1 needs a UTF-8 BOM).
# Usage: powershell -File tools\dump_text.ps1 -In <gbk file> -Out <utf8 file>
param(
  [Parameter(Mandatory=$true)][string]$In,
  [Parameter(Mandatory=$true)][string]$Out
)
$gbk = [System.Text.Encoding]::GetEncoding(936)
if (-not (Test-Path -LiteralPath $In)) { "MISSING $In"; exit 1 }
$txt = [System.IO.File]::ReadAllText($In, $gbk)
[System.IO.File]::WriteAllText($Out, $txt, (New-Object System.Text.UTF8Encoding($false)))
"ok bytes=" + $txt.Length
