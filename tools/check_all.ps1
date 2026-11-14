# Run every syntax / consistency check in one go. ASCII-only on purpose
# (PS 5.1 reads non-BOM files as GBK and eats Chinese quotes).
#
#   powershell -ExecutionPolicy Bypass -File tools\check_all.ps1
#
# Report is written to %TEMP%\_checkall.txt so it can be read back reliably.
$ErrorActionPreference = 'Continue'
# Child processes (node/python) print UTF-8; PS 5.1 decodes by default as GBK, which
# turned every Chinese line in this report into mojibake. Pin the console encoding.
try { [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false) } catch { }
$App = Split-Path -Parent $PSScriptRoot
$Out = "$env:TEMP\_checkall.txt"
$rep = New-Object System.Collections.ArrayList
function Say($m) { [void]$rep.Add([string]$m) }

$node = 'C:\Program Files\nodejs\node.exe'
$py = Join-Path $App '.venv\Scripts\python.exe'

Say '== node --check =='
foreach ($f in @('server.js', 'launcher.js', 'wallpaper.js', 'shell\main.js',
                 'web\app.js', 'web\shell.js', 'tools\check_front.js',
                 'tools\check_undef.js', 'tools\check_liquid.js', 'tools\test_chart.js', 'tools\test_server_hist.js',
                 'tools\test_kwh.js', 'tools\test_plug.js', 'tools\test_env_daily.js', 'tools\test_env_span.js', 'tools\test_env_query.js', 'tools\test_env_smooth.js', 'tools\test_singleton.js', 'tools\test_console_hide.js', 'tools\test_pack_paths.js', 'tools\test_auto_off.js', 'tools\test_fan_front.js', 'tools\uitest.js', 'tools\apitest.js', 'tools\health.js')) {
  $p = Join-Path $App $f
  if (-not (Test-Path $p)) { Say "  SKIP  $f (missing)"; continue }
  $r = & $node --check $p 2>&1
  $rc = $LASTEXITCODE
  $tag = 'FAIL'
  if ($rc -eq 0) { $tag = 'PASS' }
  Say "  $tag  $f"
  if ($rc -ne 0) { Say ('        ' + ($r | Out-String).Trim()) }
}

Say ''
Say '== py_compile =='
foreach ($f in @('collector.py', 'login.py', 'env_sensor.py', 'fan_collector.py', 'tools\test_session.py', 'vendor\ad1204u_read_props.py', 'vendor\miio_lan.py')) {
  $p = Join-Path $App $f
  if (-not (Test-Path $p)) { Say "  SKIP  $f (missing)"; continue }
  $r = & $py -m py_compile $p 2>&1
  $rc = $LASTEXITCODE
  $tag = 'FAIL'
  if ($rc -eq 0) { $tag = 'PASS' }
  Say "  $tag  $f"
  if ($rc -ne 0) { Say ('        ' + ($r | Out-String).Trim()) }
}

Say ''
Say '== PowerShell parse =='
foreach ($f in @('tray.ps1', 'tools\package.ps1', 'tools\check_all.ps1', 'tools\uitest.ps1')) {
  $p = Join-Path $App $f
  if (-not (Test-Path $p)) { Say "  SKIP  $f (missing)"; continue }
  $errs = $null
  [void][System.Management.Automation.Language.Parser]::ParseFile($p, [ref]$null, [ref]$errs)
  if ($errs -and $errs.Count -gt 0) {
    Say "  FAIL  $f ($($errs.Count) parse error(s))"
    $n = [Math]::Min(3, $errs.Count)
    for ($i = 0; $i -lt $n; $i++) { Say ('        ' + $errs[$i].Message) }
  } else {
    Say "  PASS  $f"
  }
}

Say ''
Say '== file encoding (BOM) =='
# Any .ps1 that contains non-ASCII MUST have a UTF-8 BOM: PS 5.1 decodes BOM-less
# files as GBK, the Chinese comments turn into garbage and parsing fails outright
# (the reported error lands on a blank line, which is very confusing).
foreach ($f in @('tray.ps1', 'tools\package.ps1', 'tools\check_all.ps1', 'tools\uitest.ps1')) {
  $p = Join-Path $App $f
  if (-not (Test-Path $p)) { continue }
  $b = [IO.File]::ReadAllBytes($p)
  $has = ($b.Length -ge 3 -and $b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF)
  $asciiOnly = $true
  foreach ($x in $b) { if ($x -gt 0x7F) { $asciiOnly = $false; break } }
  if ($has) { Say "  OK        $f : UTF-8 BOM" }
  elseif ($asciiOnly) { Say "  OK        $f : pure ASCII (BOM not needed)" }
  else { Say "  FAIL      $f : non-ASCII without BOM <-- add UTF-8 BOM" }
}

Say ''
Say '== newline convention =='
# 代码文件必须 LF（文档/.bat 才是 CRLF）。为什么加这条：2026-10-08 用 python 的 write_text
# 改 server.js 时，Windows 上会把整篇换成 CRLF —— 那些按 \n 匹配的自检断言当场全挂。
# 改这类文件请用 write_bytes(s.encode('utf-8'))，别用 write_text。
$lfNeed = @('server.js','launcher.js','wallpaper.js','env_sensor.py','tray.ps1','collector.py','login.py',
            'fan_collector.py','vendor\miio_lan.py',
            'netfix.py','tools\test_tls_judge.py','tools\dev\make_ca_bundle.py','web\app.js','web\shell.js','web\index.html','web\style.css',
            'shell\main.js','shell\preload.js','tools\check_liquid.js','tools\check_front.js',
            'tools\check_undef.js','tools\verify_package.js','tools\test_env_daily.js',
            'tools\test_env_span.js','tools\test_env_query.js','tools\test_env_smooth.js','tools\test_singleton.js',
            'tools\test_console_hide.js','tools\test_auto_off.js','tools\test_fan_front.js','tools\trim_portable.js')
$nlBad = @()
foreach ($f in $lfNeed) {
  $p = Join-Path $App $f
  if (-not (Test-Path $p)) { continue }
  $bb = [IO.File]::ReadAllBytes($p)
  $crlf = 0
  for ($i = 1; $i -lt $bb.Length; $i++) { if ($bb[$i] -eq 10 -and $bb[$i - 1] -eq 13) { $crlf++ } }
  if ($crlf -gt 0) { $nlBad += ($f + '(CRLF ' + $crlf + ')') }
}
if ($nlBad.Count) { Say ('  code LF-only : FAIL ' + ($nlBad -join ', ')) } else { Say '  code LF-only : PASS' }

# CRLF 文件（文档 / .bat）里**不许出现裸 CR 或裸 LF** —— 2026-10-11 踩过：
# 启动 bat 里 `"%HERE%\data\ready.json"` 被人写成 `"%HERE%\data` + CR + `eady.json"`，
# 那个 CR 是被当转义序列写进去的（`\r`），cmd 把 CR 也当行尾 ⇒ findstr 那行被拦腰截断
# ⇒ REUSED/UPGRADE 永远不生效（"软件本来就在运行"的提示从来不出现）。
# 判据：CR 的数量必须等于 LF 的数量，且不存在"LF 后面紧跟非 CR"的组合。
$crlfNeed = @('启动酷态科10号Ultra.bat','调试启动.bat','使用说明.txt','首次使用.txt','更新日志.txt')
$crBad = @()
foreach ($f in $crlfNeed) {
  $p = Join-Path $App $f
  if (-not (Test-Path $p)) { continue }
  $bb = [IO.File]::ReadAllBytes($p)
  $cr = 0; $lf = 0; $bareLf = 0; $bareCr = 0
  for ($i = 0; $i -lt $bb.Length; $i++) {
    if ($bb[$i] -eq 13) { $cr++; if (-not ($i + 1 -lt $bb.Length -and $bb[$i + 1] -eq 10)) { $bareCr++ } }
    elseif ($bb[$i] -eq 10) { $lf++; if (-not ($i -gt 0 -and $bb[$i - 1] -eq 13)) { $bareLf++ } }
  }
  if ($cr -ne $lf -or $bareLf -gt 0 -or $bareCr -gt 0) {
    $crBad += ("$f (CR=$cr LF=$lf 裸LF=$bareLf 裸CR=$bareCr)")
  }
}
if ($crBad.Count) { Say ('  doc/bat CRLF-pure : FAIL ' + ($crBad -join ', ')) } else { Say '  doc/bat CRLF-pure : PASS' }

Say ''
Say '== version.json =='
try {
  $vj = [IO.File]::ReadAllText((Join-Path $App 'version.json')) | ConvertFrom-Json
  Say ('  version = ' + $vj.version)
} catch { Say ('  FAIL  ' + $_.Exception.Message) }

Say ''
Say '== front-end (check_front.js) =='
$r = & $node (Join-Path $App 'tools\check_front.js') 2>&1
Say ('  exit=' + $LASTEXITCODE)
foreach ($l in ($r | Out-String).Split("`n")) { if ($l.Trim()) { Say ('  ' + $l.TrimEnd()) } }

Say ''
Say '== undefined identifiers (check_undef.js) =='
$r = & $node (Join-Path $App 'tools\check_undef.js') 2>&1
Say ('  exit=' + $LASTEXITCODE)
foreach ($l in ($r | Out-String).Split("`n")) { if ($l.Trim()) { Say ('  ' + $l.TrimEnd()) } }

Say ''
Say '== liquid-glass layout (check_liquid.js) =='
# 外观类改动没法靠截图验证（无头 Edge 在常驻 SSE 页面上会吊死在 virtual-time），
# 所以「必须是这个样子」的规则全部写成可判定的断言：无描边、有内高光/光泽/分层投影、
# 模糊预算、卡内实线换成渐隐高光、控件是玻璃片、老引擎降级兜底。
# ⚠️ 这里每次都得先把 $r 清空再收：PS 复用同一个 $l，上一段的输出会渗进下一段的标题行
#    （曾经让 check_liquid 的标题下面挂着 check_undef 的结论，非常误导）。
$r = & $node (Join-Path $App 'tools\check_liquid.js') 2>&1
Say ('  exit=' + $LASTEXITCODE)
$r = @($r); foreach ($l in ($r | Out-String).Split("`n")) { if ($l.Trim()) { Say ('  ' + $l.TrimEnd()) } }

Say ''
Say '== session-layer regression (offline) =='
$r = & $py (Join-Path $App 'tools\test_session.py') 2>&1
Say ('  exit=' + $LASTEXITCODE)
foreach ($l in ($r | Out-String).Split("`n")) { if ($l.Trim()) { Say ('  ' + $l.TrimEnd()) } }

Say ''
Say '== TLS cert judging regression (offline) =='
# 「unable to get local issuer certificate」到底是本机缺根还是被中间人解密 ——
# 判错方向有安全代价（把 MITM 说成小毛病，用户就安心把密码交出去了）。
# 判定是纯函数，这里喂合成的证书链，不需要网络也不需要真证书。
$r = & $py (Join-Path $App 'tools\test_tls_judge.py') 2>&1
Say ('  exit=' + $LASTEXITCODE)
foreach ($l in ($r | Out-String).Split("`n")) { if ($l.Trim()) { Say ('  ' + $l.TrimEnd()) } }

Say ''
Say '== chart anti-jitter regression (offline) =='
$r = & $node (Join-Path $App 'tools\test_chart.js') 2>&1
Say ('  exit=' + $LASTEXITCODE)
foreach ($l in ($r | Out-String).Split("`n")) { if ($l.Trim()) { Say ('  ' + $l.TrimEnd()) } }

Say ''
Say '== server history query regression (offline) =='
# Covers: downsample bounding every range to CHART_MAX_POINTS (the <=1h branch missed
# it until 2026-09-22) and historyMax growing with the sample interval so the 1h range
# is actually a full hour at 0.5s sampling.
$r = & $node (Join-Path $App 'tools\test_server_hist.js') 2>&1
Say ('  exit=' + $LASTEXITCODE)
foreach ($l in ($r | Out-String).Split("`n")) { if ($l.Trim()) { Say ('  ' + $l.TrimEnd()) } }

Say ''
Say '== energy unit conversion regression (offline) =='
# Degree (kWh) = Wh/1000, mAh = Wh/3.7*1000 @3.7V cell. The conversion lives in web/app.js
# which cannot be require()d, so test_kwh.js extracts the declarations and pins them.
$r = & $node (Join-Path $App 'tools\test_kwh.js') 2>&1
Say ('  exit=' + $LASTEXITCODE)
foreach ($l in ($r | Out-String).Split("`n")) { if ($l.Trim()) { Say ('  ' + $l.TrimEnd()) } }

Say ''
Say '== port plug/unplug regression (offline) =='
# Every plug/unplug of a port gets its own Wh record. The state machine is
# server.js plugStep(); test_plug.js extracts it by brace matching and feeds it
# sample sequences -- in particular, a flaky contact must NOT split one charge
# (splitting re-bases whAtStart, which silently under-counts).
$r = & $node (Join-Path $App 'tools\test_plug.js') 2>&1
Say ('  exit=' + $LASTEXITCODE)
foreach ($l in ($r | Out-String).Split("`n")) { if ($l.Trim()) { Say ('  ' + $l.TrimEnd()) } }

Say ''
Say '== daily temp/humidity aggregation (offline) =='
# aggregateEnvDaily(): 把温湿度按"本地自然日"压成一天一个点。最容易错的两处：
#   ① 用 UTC 分组 —— 北京时间 0~8 点的读数会掉到前一天；
#   ② Number(null) === 0 —— 缺字段的坏行被当成 0℃，污染"当天最低/最高"（阴影带从 0℃ 起）。
# 返回的 at 取当天正午，画出来才落在那一天的中段。
$r = & $node (Join-Path $App 'tools\test_env_daily.js') 2>&1
Say ('  exit=' + $LASTEXITCODE)
$r = @($r); foreach ($l in ($r | Out-String).Split("`n")) { if ($l.Trim()) { Say ('  ' + $l.TrimEnd()) } }

Say ''
Say '== device hourly record span (offline) =='
# 设备历史每小时一条，画图时该铺满它覆盖的那一小时（否则短窗口里就是"一个点+一片空白"）。
# healEnvSpans() 会给老数据补 sp —— 它会重写用户的按天文件，所以测试**全程在临时副本上跑**。
$r = & $node (Join-Path $App 'tools\test_env_span.js') 2>&1
Say ('  exit=' + $LASTEXITCODE)
$r = @($r); foreach ($l in ($r | Out-String).Split("`n")) { if ($l.Trim()) { Say ('  ' + $l.TrimEnd()) } }

Say ''
Say '== env series assemble + downsample (offline) =='
# 日文件与分钟文件里各存一份同样的设备行 → 取数不去重 + 按行抽稀 = 每天的点被吃掉一半
# （2026-10-08 用户报"温度还是没覆盖"的根因）。这里钉住：去重 + 按时间分桶 + 不制造新空洞。
$r = & $node (Join-Path $App 'tools\test_env_query.js') 2>&1
Say ('  exit=' + $LASTEXITCODE)
$r = @($r); foreach ($l in ($r | Out-String).Split("`n")) { if ($l.Trim()) { Say ('  ' + $l.TrimEnd()) } }
Say ''
Say '== env curve smoothing (offline) =='
# 平滑只对**连续段**做；温度线若把"小时带"那些行全跳掉，短窗口里就没有够长的段 →
# 平滑开关对温度完全无效（2026-10-08 用户报「只平滑了湿度，温度没效果」）。这里钉住
# 取值规则（envSeries）、分段平滑（smoothSegments）、以及两条线的接线参数。
$r = & $node (Join-Path $App 'tools\test_env_smooth.js') 2>&1
Say ('  exit=' + $LASTEXITCODE)
$r = @($r); foreach ($l in ($r | Out-String).Split("`n")) { if ($l.Trim()) { Say ('  ' + $l.TrimEnd()) } }


Say ''
Say '== fan (Wi-Fi / miIO) front-end regression (offline) =='
# 风扇这条链路做的是「只读状态 + 反向控制」：这台设备没有任何电参量属性可读
# （规格表逐项核过：无功率传感器、无电量统计、无「已运行多久」），所以界面/后端/采集器
# 里曾经那套「额定功率 × 档位比例 × 自然风系数」的**推算**功率与用电量已整体删除
# （2026-10-11 按用户要求），推算曲线与额定功率设置也一并删掉。
# 这一节因此既有正向断言也有反向断言：钉住 read 命令真的读一次并回 ack、属性表两边逐条对齐、
# miIO 协议常量、控件成套、写入一律回读确认 —— 以及「功率/电量/曲线不许长回来」。
$r = & $node (Join-Path $App 'tools\test_fan_front.js') 2>&1
Say ('  exit=' + $LASTEXITCODE)
$r = @($r); foreach ($l in ($r | Out-String).Split("`n")) { if ($l.Trim()) { Say ('  ' + $l.TrimEnd()) } }


Say ''
Say '== singleton takeover (offline) =='
# 双击桌面快捷方式打不开：老代码撞端口 -> 顺延到系统保留端口 8800 -> EACCES -> 退出，
# 而 bat 还在等 ready.json，15 秒后报「启动失败」。这里钉住：接管判据（pid 存活 / 探活）、
# 候选端口避开 netsh 排除段、EACCES 也顺延、接管后把 ready.json 写回。
$r = & $node (Join-Path $App 'tools\test_singleton.js') 2>&1
Say ('  exit=' + $LASTEXITCODE)
$r = @($r); foreach ($l in ($r | Out-String).Split("`n")) { if ($l.Trim()) { Say ('  ' + $l.TrimEnd()) } }

Say ''
Say '== pack paths consistency (offline) =='
# 用户报「打包的不是透明的」：package.ps1 -WithElectron 把 Electron 放在 <APP>/electron/，
# 而 server.js 的 findElectron() 只找 <APP>/node_modules/electron/dist/ ⇒ 运行时永远找不到
# ⇒ 回退 Edge 窗口 ⇒ 没有玻璃。这条钉的是"**打包方与查找方必须指向同一个地方**"。
$r = & $node (Join-Path $App 'tools\test_pack_paths.js') 2>&1
Say ('  exit=' + $LASTEXITCODE)
$r = @($r); foreach ($l in ($r | Out-String).Split("`n")) { if ($l.Trim()) { Say ('  ' + $l.TrimEnd()) } }

Say ''
Say '== console window hidden (offline) =='
# 用户报「开机自启动窗口打不开 / 这个窗口隐藏」：截图里那个黑窗口（#0C0C0C）就是
# server 自己的控制台 —— 一挂几小时，而且**关掉它 = 立刻杀掉服务**（无任何清理）。
# server.js 一起来就 hideOwnConsole()（koffi + ShowWindow SW_HIDE）。
# 会话沙箱里没有控制台，没法"真起一个再藏掉"，所以用替身 koffi 把四种分支都走一遍。
$r = & $node (Join-Path $App 'tools\test_console_hide.js') 2>&1
Say ('  exit=' + $LASTEXITCODE)
$r = @($r); foreach ($l in ($r | Out-String).Split("`n")) { if ($l.Trim()) { Say ('  ' + $l.TrimEnd()) } }

Say ''
Say '== auto power-off (5V idle) regression (offline) =='
# 2026-11-13 用户要求：「检查到充电口带 5V 以上电压、但没有电流，自动关闭该充电口」。
# 判定是纯函数（autoOffStep），这里喂时间+读数序列：该关的关、不该关的别关，
# 关完要能防死循环（恢复后不重新武装），阈值/参数归一化也别错。
# ⚠️ 这个功能会**真的断电**，所以它比一般 UI 改动更值得被钉住。
$r = & $node (Join-Path $App 'tools\test_auto_off.js') 2>&1
Say ('  exit=' + $LASTEXITCODE)
$r = @($r); foreach ($l in ($r | Out-String).Split("`n")) { if ($l.Trim()) { Say ('  ' + $l.TrimEnd()) } }

[IO.File]::WriteAllLines($Out, $rep, [Text.UTF8Encoding]::new($false))
