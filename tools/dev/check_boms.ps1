param([string]$Out = "$env:TEMP\_boms.txt")
# ASCII only on purpose: this file must parse under any code page.
$root = 'C:\Users\shuan\Tools\CuktechMonitor'
$l = @()
$all = @()
$all += Get-ChildItem -File $root -ErrorAction SilentlyContinue
$all += Get-ChildItem -File (Join-Path $root 'tools') -ErrorAction SilentlyContinue
foreach ($f in $all) {
  if ($f.Extension -notin @('.js', '.ps1', '.bat', '.txt', '.html', '.json', '.py')) { continue }
  $b = [IO.File]::ReadAllBytes($f.FullName)
  $bom = 'no-bom'
  if ($b.Length -ge 3 -and $b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF) { $bom = 'UTF8-BOM' }
  # Which encoding does it look like? Decode as UTF-8 strictly; failure => not UTF-8 => likely GBK.
  $kind = 'utf8'
  try {
    $u8 = New-Object Text.UTF8Encoding($false, $true)
    $null = $u8.GetString($b)
  } catch { $kind = 'NOT-utf8(likely-GBK)' }
  $l += ("{0,-34} {1,-10} {2,-18} {3}" -f $f.Name, $bom, $kind, $b.Length)
}
$l | Set-Content -Encoding UTF8 $Out
Write-Output "written"
