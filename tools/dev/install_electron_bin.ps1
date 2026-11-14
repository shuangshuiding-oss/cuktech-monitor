# Electron 的 npm 包装好了，但它 postinstall 下载的 electron.exe 二进制被代理拦掉了
# （install.js 走 @electron/get，会读环境代理）。这里清空代理 + 用国内镜像重跑。
$ErrorActionPreference = 'Continue'
$log = "$env:TEMP\_electron_bin.txt"
$APP = 'C:\Users\shuan\Tools\CuktechMonitor'
$out = @()

Set-Location $APP
$env:HTTP_PROXY = ''
$env:HTTPS_PROXY = ''
$env:http_proxy = ''
$env:https_proxy = ''
$env:NO_PROXY = '*'
$env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
$npm = 'C:\Program Files\nodejs\npm.cmd'

$out += "ELECTRON_MIRROR = $env:ELECTRON_MIRROR"

Remove-Item -Recurse -Force (Join-Path $APP 'node_modules\electron') -ErrorAction SilentlyContinue
$out += "--- reinstall electron (with mirror) ---"
$sw = [Diagnostics.Stopwatch]::StartNew()
& $npm install electron@latest --save-dev --no-audit --no-fund 2>&1 | ForEach-Object { $out += $_ }
$sw.Stop()
$out += "exit=$LASTEXITCODE elapsed=$([int]$sw.Elapsed.TotalSeconds)s"

$exe = Join-Path $APP 'node_modules\electron\dist\electron.exe'
$out += "--- verify ---"
$out += "electron.exe = " + (Test-Path $exe)
if (Test-Path $exe) {
  $out += "size = " + [math]::Round((Get-Item $exe).Length/1MB,1) + " MB"
  $out += (& $exe --version) 2>&1
}
$out += "dist items = " + ((Get-ChildItem (Join-Path $APP 'node_modules\electron\dist') -ErrorAction SilentlyContinue | Measure-Object).Count)

$out -join "`r`n" | Out-File -Encoding utf8 $log
"done"
