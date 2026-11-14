$d = 'C:\Users\shuan\Tools\CuktechMonitor'
$p = Join-Path $d '使用说明.txt'
$b = [IO.File]::ReadAllBytes($p)
$s = [Text.Encoding]::GetEncoding(936).GetString($b)
$lines = $s -split "`r`n"
$out = @()
$out += 'bytes=' + $b.Length + '  crlf=' + (($s -split "`r`n").Count - 1) + '  lines=' + $lines.Count
for ($i = 0; $i -lt $lines.Count; $i++) {
  if ($lines[$i] -match '息屏|屏幕|温度|项断言|常亮|空闲') {
    $out += ('{0,4}: {1}' -f ($i + 1), $lines[$i])
  }
}
$out -join "`r`n" | Set-Content "$env:TEMP\cuk_man166.txt" -Encoding UTF8
