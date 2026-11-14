param(
  [Parameter(Mandatory=$true)][string]$Root,
  [Parameter(Mandatory=$true)][string]$From,
  [Parameter(Mandatory=$true)][string]$To,
  [string]$From2 = '',
  [string]$To2 = '',
  [string]$Out = "$env:TEMP\_rename.txt"
)
# ASCII-only on purpose. All non-ASCII text arrives through parameters.
# Rewrites the text of every *.txt / *.bat directly under $Root using GBK
# (code page 936, no BOM, CRLF preserved), and additionally renames any file
# whose NAME contains $From.  Idempotent: a second run changes nothing.
$gbk = [Text.Encoding]::GetEncoding(936)
$res = @()

function Convert-Text([string]$t) {
  $n = $t
  if ($From -ne '' -and $n.Contains($From)) { $n = $n.Replace($From, $To) }
  if ($From2 -ne '' -and $n.Contains($From2)) { $n = $n.Replace($From2, $To2) }
  # ASCII-only fix: the `start "title" /min node ...` line in the launcher .bat
  # still carried the old ASCII name, which showed up in the taskbar. An empty
  # title makes the console inherit a sensible one.
  $n = $n.Replace('start "CuktechMonitor" /min', 'start "" /min')
  return $n
}

$files = @(Get-ChildItem -File -Path (Join-Path $Root '*') -Include '*.txt', '*.bat' -ErrorAction SilentlyContinue)
foreach ($f in $files) {
  $t = [IO.File]::ReadAllText($f.FullName, $gbk)
  $n = Convert-Text $t
  if ($n -ne $t) {
    [IO.File]::WriteAllText($f.FullName, $n, $gbk)
    $res += "rewrote: $($f.Name)  ($($t.Length) -> $($n.Length) chars)"
  } else {
    $res += "no-change: $($f.Name)"
  }
  if ($f.BaseName.Contains($From)) {
    $newName = $f.Name.Replace($From, $To)
    $dst = Join-Path $Root $newName
    [IO.File]::WriteAllText($dst, (Convert-Text ([IO.File]::ReadAllText($f.FullName, $gbk))), $gbk)
    [IO.File]::Delete($f.FullName)
    $res += "renamed: $($f.Name) -> $newName"
  }
}
$res | Set-Content -Encoding UTF8 $Out
Write-Output "done"
