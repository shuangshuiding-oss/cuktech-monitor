# enum_tray_settings.ps1 - list HKCU NotifyIconSettings entries. ASCII only.
$base = 'HKCU:\Control Panel\NotifyIconSettings'
if (-not (Test-Path $base)) { Write-Output "key not exist"; exit 0 }
Get-ChildItem $base | ForEach-Object {
  $p = Get-ItemProperty $_.PSPath
  $exe = $p.ExecutablePath
  $prom = $p.IsPromoted
  Write-Output ("[{0}] promoted={1} exe={2}" -f $_.PSChildName, $prom, $exe)
}
