$d = 'C:\Users\shuan\Tools\CuktechMonitor'
$p = Join-Path $d '使用说明.txt'
$s = [Text.Encoding]::GetEncoding(936).GetString([IO.File]::ReadAllBytes($p))
$lines = $s -split "`r`n"
$out = @()
foreach ($r in @(@(26, 34), @(244, 264), @(304, 330))) {
  $out += ('===== lines ' + $r[0] + '..' + $r[1] + ' =====')
  for ($i = $r[0] - 1; $i -lt $r[1] -and $i -lt $lines.Count; $i++) {
    $out += ('{0,4}| {1}' -f ($i + 1), $lines[$i])
  }
}
$out -join "`r`n" | Set-Content "$env:TEMP\cuk_man166b.txt" -Encoding UTF8
