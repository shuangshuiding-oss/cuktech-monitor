# Create the app-local Python venv that runs the BLE collector.
# Run once (or again if .venv was deleted).  Prints DEPS_OK on success.
$ErrorActionPreference = 'Continue'

$App  = Split-Path -Parent $PSScriptRoot
$Venv = Join-Path $App '.venv'
$Py   = Join-Path $Venv 'Scripts\python.exe'

$candidates = @(
  (Join-Path $App 'pyembed\python.exe'),
  'C:\Users\shuan\.workbuddy\binaries\python\versions\3.13.12\python.exe',
  "$env:LOCALAPPDATA\Programs\Python\Python313\python.exe",
  "$env:LOCALAPPDATA\Programs\Python\Python312\python.exe",
  'C:\Program Files\Python313\python.exe',
  'C:\Program Files\Python312\python.exe'
)

$base = $null
foreach ($c in $candidates) { if ($c -and (Test-Path $c)) { $base = $c; break } }
if (-not $base) {
  $w = & where.exe python 2>$null
  if ($LASTEXITCODE -eq 0) { $base = ($w | Select-Object -First 1) }
}
if (-not $base) { Write-Host 'NO_PYTHON_FOUND'; exit 2 }
Write-Host ('base python : ' + $base)

if (-not (Test-Path $Py)) {
  Write-Host 'creating venv ...'
  & $base -m venv $Venv
  if (-not (Test-Path $Py)) { Write-Host 'VENV_CREATE_FAILED'; exit 3 }
}

& $Py -m pip install --disable-pip-version-check --quiet --upgrade pip
& $Py -m pip install --disable-pip-version-check --quiet bleak aiohttp cryptography
$code = $LASTEXITCODE
Write-Host ('pip exit=' + $code)

& $Py -c "import bleak,aiohttp,cryptography,sys;print('DEPS_OK bleak',bleak.__version__,'python',sys.version.split()[0])"
Write-Host ('verify exit=' + $LASTEXITCODE)
