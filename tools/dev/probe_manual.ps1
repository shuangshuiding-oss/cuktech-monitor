# Probe GBK manual for lines mentioning the port-card line / assertion counts. ASCII only.
$ErrorActionPreference = 'Continue'
$d = 'C:\Users\shuan\Tools\CuktechMonitor'
$gbk = [Text.Encoding]::GetEncoding(936)
$s = [IO.File]::ReadAllText("$d\使用说明.txt", $gbk)
$lines = $s -split "`r`n"
$res = New-Object System.Collections.ArrayList
for ($i = 0; $i -lt $lines.Count; $i++) {
  if ($lines[$i] -match '本次充电|插拔|64|65|test_plug|时长') {
    [void]$res.Add(('{0,4}: {1}' -f ($i + 1), $lines[$i]))
  }
}
[IO.File]::WriteAllLines("$env:TEMP\cuk_manual_hits.txt", $res, [Text.UTF8Encoding]::new($false))
