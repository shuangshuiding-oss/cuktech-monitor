# 直接跑 electron 的 postinstall（install.js），带上镜像与直连。
# npm install 阶段因为 ignore-scripts 或其他原因没触发它。
$ErrorActionPreference = 'Continue'
$log = "$env:TEMP\_electron_bin2.txt"
$APP = 'C:\Users\shuan\Tools\CuktechMonitor'
$out = @()

Set-Location (Join-Path $APP 'node_modules\electron')
$env:HTTP_PROXY = ''
$env:HTTPS_PROXY = ''
$env:http_proxy = ''
$env:https_proxy = ''
$env:NO_PROXY = '*'
$env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
$env:ELECTRON_CUSTOM_DIR = 'v{{ version }}'

$node = 'C:\Program Files\nodejs\node.exe'
$out += "node = $node"
$out += "cwd = $((Get-Location).Path)"
$out += "ELECTRON_MIRROR = $env:ELECTRON_MIRROR"

$sw = [Diagnostics.Stopwatch]::StartNew()
& $node 'install.js' 2>&1 | ForEach-Object { $out += $_ }
$sw.Stop()
$out += "exit=$LASTEXITCODE elapsed=$([int]$sw.Elapsed.TotalSeconds)s"

$exe = Join-Path $APP 'node_modules\electron\dist\electron.exe'
$out += "--- verify ---"
$out += "electron.exe = " + (Test-Path $exe)
if (Test-Path $exe) {
  $out += "size = " + [math]::Round((Get-Item $exe).Length/1MB,1) + " MB"
  $out += (& $exe --version) 2>&1
}
$out += "dist count = " + ((Get-ChildItem (Join-Path $APP 'node_modules\electron\dist') -ErrorAction SilentlyContinue | Measure-Object).Count)

$out -join "`r`n" | Out-File -Encoding utf8 $log
"done"
