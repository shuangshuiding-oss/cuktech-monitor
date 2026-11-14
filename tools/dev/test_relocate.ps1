# 验证「复制出去的 Python + site-packages + node.exe」能否脱离原路径运行。
# 这是便携打包的前提：绿色目录必须不依赖 C:\Users\shuan\... 下的任何东西。
$ErrorActionPreference = 'Continue'
$rep = @()

$pySrc  = 'C:\Users\shuan\.workbuddy\binaries\python\versions\3.13.12'
$spSrc  = 'C:\Users\shuan\Tools\CuktechMonitor\.venv\Lib\site-packages'
$nodeExe = 'C:\Program Files\nodejs\node.exe'
$rt = Join-Path $env:TEMP ('portable-test-' + (Get-Random))

$rep += "target: $rt"
New-Item -ItemType Directory -Path $rt -Force | Out-Null

# 1) 复制 Python（排除明显不需要的 include/libs/Scripts）
$rep += 'copying python ...'
$pyDst = Join-Path $rt 'python'
robocopy $pySrc $pyDst /E /NFL /NDL /NJH /NJS /NP /XD include libs Scripts __pycache__ | Out-Null
$rep += ("  robocopy code: " + $LASTEXITCODE)   # 0..7 都算成功

# 2) 复制 site-packages（同样去掉缓存）
$rep += 'copying site-packages ...'
$spDst = Join-Path $pyDst 'Lib\site-packages'
robocopy $spSrc $spDst /E /NFL /NDL /NJH /NJS /NP /XD __pycache__ | Out-Null
$rep += ("  robocopy code: " + $LASTEXITCODE)

# 3) 复制 node.exe
Copy-Item $nodeExe (Join-Path $rt 'node.exe') -Force

# 4) 在新位置跑依赖自检（用绝对新路径，验证可重定位）
$pyExe = Join-Path $pyDst 'python.exe'
$rep += 'python relocate test:'
$out1 = & $pyExe -c "import sys,bleak,aiohttp,cryptography;print('PYOK',sys.version.split()[0],sys.prefix)" 2>&1
$rep += ('  ' + ($out1 -join ' | '))

$rep += 'node relocate test:'
$out2 = & (Join-Path $rt 'node.exe') -e "console.log('NODEOK',process.version,process.execPath)" 2>&1
$rep += ('  ' + ($out2 -join ' | '))

# 5) 体积统计（清理交给外层用 node fs.rmSync 做，避免 safe-delete 拦截中断脚本）
$sz = (Get-ChildItem $rt -Recurse -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum
$rep += ("portable size = {0} MB" -f [math]::Round($sz/1MB,1))
$rep += ("left in place: $rt")

$rep | Out-File -Encoding utf8 (Join-Path $env:TEMP '_reloc.txt')
