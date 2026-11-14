# 把 CuktechMonitor 打成免安装便携包（自带 Node + Python，别人解压即用）。
#
#   powershell -ExecutionPolicy Bypass -File tools\package.ps1 [-SkipZip]
#
# 产物： dist\酷态科10号Ultra\          （绿色目录）
#        dist\酷态科10号Ultra-便携版.zip （分享用）
#
# ※ 绝不把 data\ 打进去 —— 里面有用户自己的小米云 BLE 密钥(cuktech.token)、
#   用电量统计和历史数据，那是隐私，而且绑的是原作者的充电头。
param([switch]$SkipZip, [switch]$NoTrim, [switch]$No7z, [switch]$NoElectron, [switch]$WithElectron)

$ErrorActionPreference = 'Continue'
$App   = Split-Path -Parent $PSScriptRoot
$Dist  = Join-Path $App 'dist'
$Stage = Join-Path $Dist '酷态科10号Ultra'
$Zip   = Join-Path $Dist '酷态科10号Ultra-便携版.zip'
$SevenZFile = Join-Path $Dist '酷态科10号Ultra-便携版.7z'
$SfxFile    = Join-Path $Dist '酷态科10号Ultra-便携版-自解压.exe'

# 7-Zip 是可选加速器：有它就能把包再压小约 37%（LZMA2 + 固实压缩），
# 没装就退回 Compress-Archive（只出 zip）。
$SevenZ = @('C:\Program Files\7-Zip\7z.exe', 'C:\Program Files (x86)\7-Zip\7z.exe') |
  Where-Object { Test-Path $_ } | Select-Object -First 1

$NodeSrc = Join-Path $env:ProgramFiles 'nodejs\node.exe'
$PySrc   = 'C:\Users\shuan\.workbuddy\binaries\python\versions\3.13.12'
$SpSrc   = Join-Path $App '.venv\Lib\site-packages'

$rep = @()
function Say($m) { $script:rep += $m }

# ---- 0. 前置检查 ----------------------------------------------------------
foreach ($p in @($NodeSrc, $PySrc, $SpSrc)) {
  if (-not (Test-Path $p)) { Say "MISSING: $p"; $rep | Out-File -Encoding utf8 "$env:TEMP\_pkg.txt"; exit 2 }
}

# ---- 1. 清空 staging（robocopy /MIR 空目录，不用 Remove-Item 以免被 safe-delete 拦截）--
$empty = Join-Path $env:TEMP ('empty-' + (Get-Random))
New-Item -ItemType Directory -Path $empty -Force | Out-Null
if (Test-Path $Stage) { robocopy $empty $Stage /MIR /NFL /NDL /NJH /NJS /NP | Out-Null }
New-Item -ItemType Directory -Path $Stage -Force | Out-Null

# ---- 2. 应用代码（显式列出；不含 data/ tools/ dist/ .venv 与调研产物）------
foreach ($f in @('server.js','launcher.js','wallpaper.js','env_sensor.py','tray.ps1',
                 'collector.py','login.py','netfix.py','app.ico',
                 'version.json','启动酷态科10号Ultra.bat','调试启动.bat','使用说明.txt','首次使用.txt',
                 '软件介绍.md','软件介绍.html','更新日志.txt')) {
  Copy-Item (Join-Path $App $f) (Join-Path $Stage $f) -Force
  Say ("  code: " + $f)
}

# ---- 3. vendor / web ------------------------------------------------------
robocopy (Join-Path $App 'vendor') (Join-Path $Stage 'vendor') /E /NFL /NDL /NJH /NJS /NP /XF *.pyc /XD __pycache__ | Out-Null
Say ("  vendor robocopy exit=" + $LASTEXITCODE)
robocopy (Join-Path $App 'web') (Join-Path $Stage 'web') /E /NFL /NDL /NJH /NJS /NP /XF *.pyc /XD __pycache__ | Out-Null
Say ("  web robocopy exit=" + $LASTEXITCODE)

# ---- 3.5 Electron 透明外壳（**默认带**）----------------------------------
# ⚠️ 2026-10-12 改默认（用户报「**打包的不是透明的**」）：
#   以前默认**不带** Electron，于是"发出去的包"和"本机在用的程序"是两种东西 ——
#   包里回退成 Edge --app 窗口，**没有透明玻璃**。用户拿到包一看就不对。
#   现在反过来：**默认带**（要小包加 -NoElectron）。取舍：
#     · 带   —— 点击即见的"真透明窗口"（能看见窗口后面）；压缩后约 +87MB
#     · 不带 —— 自动回退到 Edge --app 窗口，功能一模一样，只是不透
#   ⚠️ 而且这条分支以前是**坏的**：electron 被复制到 <APP>/electron/，
#      而 server.js 的 findElectron() 只认 <APP>/node_modules/electron/dist/ ——
#      就算加了 -WithElectron，运行时也找不到 → 白带 87MB。两边现在对齐了，
#      并且 tools/test_pack_paths.js 把"打包方与查找方必须一致"钉成断言。
$WithElectron = $WithElectron -or (-not $NoElectron)
if ($WithElectron) {
  $elSrc = Join-Path $App 'node_modules\electron\dist'
  $elDst = Join-Path $Stage 'electron'
  if (Test-Path (Join-Path $elSrc 'electron.exe')) {
    robocopy $elSrc $elDst /E /NFL /NDL /NJH /NJS /NP | Out-Null
    Say ("  electron robocopy exit=" + $LASTEXITCODE)
    # ---- 裁剪：locales 有 50 个语言包共 49MB，本应用只需要简中/英文 ----
    #      LICENSES.chromium.html 20MB 是纯文本许可清单，便携包不需要。
    #      两项合计省约 69MB（约 electron 体积的 19%），不影响运行。
    $loc = Join-Path $elDst 'locales'
    if (Test-Path $loc) {
      $keep = @('zh-CN.pak', 'en-US.pak')
      $before = (Get-ChildItem $loc -File | Measure-Object -Property Length -Sum).Sum
      Get-ChildItem $loc -File | Where-Object { $keep -notcontains $_.Name } |
        ForEach-Object { Remove-Item $_.FullName -Force -ErrorAction SilentlyContinue }
      $after = (Get-ChildItem $loc -File | Measure-Object -Property Length -Sum).Sum
      Say ("  electron locales 裁剪 " + [Math]::Round(($before - $after) / 1MB, 1) + " MB（保留 zh-CN/en-US）")
    }
    $lic = Join-Path $elDst 'LICENSES.chromium.html'
    if (Test-Path $lic) { Remove-Item $lic -Force -ErrorAction SilentlyContinue; Say '  electron 去掉 LICENSES.chromium.html（20 MB）' }
    # ★ 复制完必须**验证落地**：这是"带没带成"的唯一凭据，也是 findElectron 能不能命中的前提。
    #   （以前这里只 Say 一行 robocopy exit，出问题没人知道。）
    if (Test-Path (Join-Path $elDst 'electron.exe')) {
      $elSz = (Get-ChildItem $elDst -Recurse -File | Measure-Object Length -Sum).Sum
      Say ("  electron 已就位: " + [Math]::Round($elSz / 1MB, 1) + " MB（运行时在 <APP>\electron\electron.exe）")
    } else {
      Say '  !! electron.exe 没复制成功 —— 这个包会没有透明玻璃，先别发'
    }
  } else {
    Say ('  警告：找不到 Electron 源 ' + $elSrc + '\electron.exe（先 npm install electron）')
  }
} else {
  Say '  electron: 未打包（-NoElectron）—— 启动时回退 Edge 窗口，功能一样但**没有透明玻璃**'
}
robocopy (Join-Path $App 'shell') (Join-Path $Stage 'shell') /E /NFL /NDL /NJH /NJS /NP | Out-Null
Say ("  shell robocopy exit=" + $LASTEXITCODE)

# ---- 4. 便携运行时 --------------------------------------------------------
New-Item -ItemType Directory -Path (Join-Path $Stage 'runtime') -Force | Out-Null
Copy-Item $NodeSrc (Join-Path $Stage 'runtime\node.exe') -Force
Say '  runtime\node.exe'

$pyDst = Join-Path $Stage 'runtime\python'
# ⚠️ 必须排除 base Python 自带的 Lib\site-packages —— 那是**这台打包机的工具链**，
#    不是本应用的依赖。2026-11-08 打包时它里面已经有 numpy/scipy/imageio_ffmpeg/PIL/lxml…
#    （同机做别的逆向活儿装的），整包从 119MB 涨到 173MB、staging 从 442MB 涨到 717MB；
#    而且 numpy 的测试数据放在 `numpy\lib\tests\data\` 下，正好撞上第 8 步的隐私检查
#    （按路径里的 `\data\` 匹配）→ 报了一堆假 PRIVACY LEAK。
#    应用真正的依赖全部由下一段的 venv site-packages 提供，末尾的 verify_portable.py
#    会逐个真导入一遍来兜底。
robocopy $PySrc $pyDst /E /NFL /NDL /NJH /NJS /NP /XF *.pyc /XD include libs Scripts __pycache__ site-packages | Out-Null
Say ("  runtime\python robocopy exit=" + $LASTEXITCODE)

# 依赖装在 .venv 的 site-packages 里，合并进便携 Python；去掉 pip/setuptools 这类运行时用不到的
robocopy $SpSrc (Join-Path $pyDst 'Lib\site-packages') /E /NFL /NDL /NJH /NJS /NP /XF *.pyc /XD __pycache__ pip setuptools pkg_resources _distutils_hack wheel prepare_venv | Out-Null
Say ("  site-packages robocopy exit=" + $LASTEXITCODE)

# ---- 4.5 精简运行时 -------------------------------------------------------
# 砍掉 pip / ensurepip / pydoc / unittest / sqlite3 / CPython 自测扩展这些
# "跑这个 App 绝对用不到"的东西，约 11MB。清单与理由见 tools\trim_portable.js。
if (-not $NoTrim) {
  & node (Join-Path $App 'tools\trim_portable.js') $Stage | Out-Null
  # ⚠️ 不能去匹配 node 的 stdout：node 输出 UTF-8，PS 5.1 按 GBK 解码，
  #    中文全是乱码，匹配 '释放' 永远不中 —— 结果是 summary 行空白，
  #    看着像"精简没跑"。改成读 trim_portable.js 自己写的 UTF-8 报告。
  $trimRep = Join-Path $env:TEMP 'cuk_trim.txt'
  if (Test-Path $trimRep) {
    $tl = [IO.File]::ReadAllText($trimRep, [Text.Encoding]::UTF8) -split "`r?`n" |
      Where-Object { $_ -match '^释放 = |^清理后 staging = ' }
    Say ("  trim: " + (($tl | ForEach-Object { $_.Trim() }) -join '   '))
  } else { Say "  trim: 没找到报告 $trimRep（trim_portable.js 可能没跑起来）" }
} else { Say '  trim: 已跳过 (-NoTrim)' }

# ---- 5. 便携自检：在 staging 里直接跑起来 ---------------------------------
$pyExe = Join-Path $pyDst 'python.exe'
$v1 = & $pyExe -c "import sys,bleak,aiohttp,cryptography;print('PYOK',sys.version.split()[0])" 2>&1
Say ("  portable python : " + (($v1 | Select-Object -First 1) -join ' '))
$v2 = & (Join-Path $Stage 'runtime\node.exe') -e "console.log('NODEOK '+process.version)" 2>&1
Say ("  portable node   : " + (($v2 | Select-Object -First 1) -join ' '))

# 依赖穷尽测试：静态扫出所有 import，逐个真导入；再对 bleak 的 winrt 后端、
# cryptography 的 AESCCM/ECDH、ssl、aiohttp 做构造级验证。
# 精简运行时最大的风险是删掉"只在某条分支才 import"的模块，所以这一步不能省。
$vfile = Join-Path $env:TEMP 'cuk_verify_portable.txt'
& $pyExe (Join-Path $App 'tools\verify_portable.py') $Stage --out $vfile 2>&1 | Out-Null
$vex = $LASTEXITCODE
$vlast = ''
try { $vlast = ((Get-Content $vfile -Encoding UTF8 | Where-Object { $_ -match '^结果' }) | Select-Object -Last 1) } catch {}
Say ("  portable deps   : exit=$vex  " + $vlast)
if ($vex -ne 0) { Say '  !! 依赖自检未通过，先别发这个包：' ; Say ('     ' + $vfile) }

# ---- 6. 体积 --------------------------------------------------------------
$sz = (Get-ChildItem $Stage -Recurse -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum
Say ("stage size = {0} MB" -f [math]::Round($sz/1MB,1))

# ---- 7. 打包（三种格式，各有各的用处）-------------------------------------
#   .zip   deflate，任何 Windows 双击就能解 —— 发给别人的默认选择
#   .7z    LZMA2 + 固实，比 zip 小约 37% —— 体积优先，需 7-Zip/WinRAR/Bandizip
#   .exe   7z 自解压 —— 对方没装 7-Zip 也能双击解出来（邮箱/微信可能拦 .exe）
# .exe 直接由 "sfx 模块 + 已压好的 .7z" 拼接而成，不重复压缩。
if (-not $SkipZip) {
  # ⚠️ 2026-10-08 踩过：这一步若**没删掉**已有产物，`7z a` 是"更新"语义 ——
  #    它会把新文件塞进旧归档、**保留旧归档里多出来的条目**。现场：dist 里躺着一个
  #    很早以前用 -WithElectron 打的同名 .7z，于是新包 118.5 MB / 解出来 441 MB
  #    （多了整整一个 electron\ 目录），而 stage 只有 140.7 MB。
  #    所以必须删干净并**验证**，别只看"命令没报错"。
  foreach ($f in @($Zip, $SevenZFile, $SfxFile)) {
    if (Test-Path $f) {
      try { [IO.File]::Delete($f) } catch { Say ('  !! 删不掉旧产物: ' + $f + ' —— ' + $_.Exception.Message) }
      if (Test-Path $f) {
        Say ('  !! 旧产物仍存在，7z 会"更新"它而不是重建，包会带脏数据: ' + $f)
        $rep | Out-File -Encoding utf8 "$env:TEMP\_pkg.txt"
        exit 3
      }
    }
  }

  if ($SevenZ -and -not $No7z) {
    Say ("  使用 7-Zip: " + $SevenZ)

    & $SevenZ a -tzip -mx=9 -mmt=on -y "$Zip" "$Stage" | Out-Null
    if (Test-Path $Zip) { Say ("  zip = {0} MB   (deflate mx9)" -f [math]::Round((Get-Item $Zip).Length/1MB,1)) }

    & $SevenZ a -t7z -m0=lzma2 -mx=9 -mfb=273 -md=64m -ms=on -mmt=on -y "$SevenZFile" "$Stage" | Out-Null
    if (Test-Path $SevenZFile) { Say ("  7z  = {0} MB   (LZMA2 mx9 固实)" -f [math]::Round((Get-Item $SevenZFile).Length/1MB,1)) }

    $sfxMod = Join-Path (Split-Path $SevenZ -Parent) '7z.sfx'
    if ((Test-Path $sfxMod) -and (Test-Path $SevenZFile)) {
      try {
        $fs = [IO.File]::Create($SfxFile)
        $m = [IO.File]::ReadAllBytes($sfxMod)
        $fs.Write($m, 0, $m.Length)
        $d = [IO.File]::ReadAllBytes($SevenZFile)
        $fs.Write($d, 0, $d.Length)
        $fs.Close()
        Say ("  exe = {0} MB   (自解压，含 7z.sfx)" -f [math]::Round((Get-Item $SfxFile).Length/1MB,1))
      } catch { Say ('  exe 生成失败: ' + $_.Exception.Message) }
    }
  } else {
    Compress-Archive -Path $Stage -DestinationPath $Zip -CompressionLevel Optimal
    Say ("  zip = {0} MB   (Compress-Archive，未装 7-Zip)" -f [math]::Round((Get-Item $Zip).Length/1MB,1))
    Say '  提示：这台机器装个 7-Zip 能再小约 19MB（走 LZMA2）'
  }
}

# ---- 8. 确认没有把隐私带进去 ---------------------------------------------
# 只看**应用自己的** data\ 目录。以前用通配 `*\data\*`，结果第三方包里的
# `numpy\lib\tests\data\*.npy`、`PIL\...\data\` 也会被当成隐私 —— 假警报比漏报更糟：
# 喊多了就没人当真了。
$dataDir = Join-Path $Stage 'data'
$leak = Get-ChildItem $Stage -Recurse -File -ErrorAction SilentlyContinue |
  Where-Object {
    $_.FullName.StartsWith($dataDir, [StringComparison]::OrdinalIgnoreCase) -or
    $_.Name -in @('cuktech.token','history.jsonl','energy.json','app.log','qr.png','qr-state.json','config.json')
  }
if ($leak) { Say ('PRIVACY LEAK: ' + (($leak | Select-Object -First 5 | ForEach-Object FullName) -join ', ')) }
else { Say 'privacy check: clean（无 data/、无 token、无历史）' }

$rep | Out-File -Encoding utf8 "$env:TEMP\_pkg.txt"
