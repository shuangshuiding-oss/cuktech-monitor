param([string]$Out = "$env:TEMP\_gbk_all.txt")
$root = 'C:\Users\shuan\Tools\CuktechMonitor'
$gbk = [Text.Encoding]::GetEncoding(936)
$l = @()
$targets = @()
$targets += Get-ChildItem -File $root -Filter '*.bat' -ErrorAction SilentlyContinue
$targets += Get-ChildItem -File $root -Filter '*.txt' -ErrorAction SilentlyContinue
foreach ($t in $targets) {
  $l += "===== $($t.Name) ====="
  $l += [IO.File]::ReadAllText($t.FullName, $gbk)
  $l += ""
}
$l | Set-Content -Encoding UTF8 $Out
Write-Output "written"
