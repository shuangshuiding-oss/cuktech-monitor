# dump_gbk.ps1 - read a GBK(936) text file, dump as UTF-8 for inspection. ASCII only.
param([string]$Path)
$lines = [IO.File]::ReadAllLines($Path, [System.Text.Encoding]::GetEncoding(936))
$out = "$env:TEMP\_gbk_dump.txt"
[IO.File]::WriteAllLines($out, $lines, [System.Text.Encoding]::UTF8)
Write-Output "dumped to $out, lines=" + $lines.Count
