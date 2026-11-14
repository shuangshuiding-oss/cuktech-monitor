function Add-Line($m) { [void]$script:rep.Add([string]$m) }
$ErrorActionPreference = 'Stop'
$App = Split-Path -Parent $PSScriptRoot
$App = Split-Path -Parent $App          # tools/dev -> app root
$script:rep = New-Object System.Collections.ArrayList
try {
  $gbk = [Text.Encoding]::GetEncoding(936)
  foreach ($fi in (Get-ChildItem -LiteralPath $App -Filter *.txt -File)) {
    $txt = $gbk.GetString([IO.File]::ReadAllBytes($fi.FullName))
    Add-Line ("================ " + $fi.Name + " ================")
    foreach ($l in ($txt -split "`r?`n")) { Add-Line $l }
    Add-Line ""
  }
} catch { Add-Line ("ERR " + $_.Exception.Message) }
[IO.File]::WriteAllLines("$env:TEMP\_gbkdump_utf8.txt", $script:rep, [Text.UTF8Encoding]::new($false))
