# 把「液态玻璃」改版写进两份对外文档。
#
# 用法: powershell -ExecutionPolicy Bypass -File tools\dev\sync_liquid_docs.ps1
#
# 为什么用 PowerShell 而不是 node：使用说明.txt 是 GBK 编码，而 node 的内置 Buffer
# 只认 utf8/latin1/utf16le，编不出 GBK（试过 ADODB.Stream 走 cscript，被沙箱拦了）。
# PowerShell 的 [Text.Encoding]::GetEncoding(936) 直接把这件事做干净。
#
# 铁律：使用说明.txt 必须 **GBK + CRLF + 无 BOM**，改完要整篇归一化（见文件末尾）。
$ErrorActionPreference = 'Stop'
$App = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$log = New-Object System.Collections.ArrayList
function Say($m) { [void]$log.Add([string]$m) }

$gbk = [Text.Encoding]::GetEncoding(936)

# ============================================================ 使用说明.txt
$p = Join-Path $App '使用说明.txt'
$before = (Get-Item $p).Length
$t = [IO.File]::ReadAllText($p, $gbk)

$uiSection = @(
  ''
  '界面外观'
  '--------'
  '整体是深色玻璃风格（Apple 液态玻璃那一路）：面板半透明 + 背景有缓慢飘动的彩色光斑，'
  '卡片没有描边线，改用「上缘 1px 内高光 + 表面斜向光泽 + 两层柔和投影」做出玻璃的厚度感，'
  '关键数字带一层白色亮晕，从模糊的背景里浮出来。'
  ''
  '* 顶栏是贴在窗口顶部的一条玻璃：页面滚动时内容会从它下面经过并被模糊。'
  '* 卡片之间的分隔不再是实线，改成一条中间亮、两头化开的高光线，看起来像玻璃接缝。'
  '* 按钮、下拉框、开关都是「玻璃片」；输入框聚焦时是一圈青色光晕而不是描边。'
  '* 「恢复出厂设置」是染红的玻璃片（不是红框），仍然需要二次确认。'
  '* 窗口宽度变化时整块界面等比缩放（根字号随宽度线性变化），窄窗口自动重排成单列。'
  '* 关掉系统动画（辅助功能里的「减少动态效果」）时，背景光斑会停住不飘。'
  ''
  '如果显卡/驱动很老、系统不支持毛玻璃效果，界面会自动退化成接近不透明的实色面板，'
  '保证文字始终看得清 —— 只是少了那层"透"。'
  ''
) -join "`r`n"

if ($t -notmatch '界面外观') {
  $t = $t.Replace("`r`n文件说明`r`n", $uiSection + "`r`n文件说明`r`n")
  Say '  使用说明.txt: 新增「界面外观」一节'
}

# tools\ 清单：补 check_liquid.js，并说明 uitest.ps1 的 -Shot
$old1 = 'tools\check_undef.js     静态检查"未声明的标识符"（''use strict'' 下会运行时炸掉的那类）'
$new1 = $old1 + "`r`n" + 'tools\check_liquid.js    界面外观（液态玻璃）规则自检：无描边/内高光/分层投影/模糊预算/降级兜底'
if ($t.Contains($old1) -and -not $t.Contains('check_liquid.js    界面外观')) { $t = $t.Replace($old1, $new1); Say '  使用说明.txt: tools 清单补 check_liquid.js' }

$old2 = 'tools\uitest.ps1         界面自检（无头 Edge 跑 ?selftest=1，结果进 data\selftest.log）'
$new2 = $old2 + "`r`n" + '                          加 -Shot 参数则只截图（%TEMP%\cuk_shot.png）看外观'
if ($t.Contains($old2) -and -not $t.Contains('加 -Shot 参数则只截图')) { $t = $t.Replace($old2, $new2); Say '  使用说明.txt: uitest 补 -Shot 说明' }

# 排障：样式不对怎么办
$old3 = '* 想清空历史：删掉 data\history\ 整个目录和 data\history-min.jsonl；'
$new3 = @(
  '* 界面样式看起来不对（没毛玻璃、像纯色块）：说明系统或显卡驱动不支持 backdrop-filter，'
  '  程序会自动降级成实色面板，功能不受影响；想看正常效果请更新 Edge/显卡驱动。'
  '* 想清空历史：删掉 data\history\ 整个目录和 data\history-min.jsonl；'
) -join "`r`n"
if ($t.Contains($old3) -and -not $t.Contains('没毛玻璃')) { $t = $t.Replace($old3, $new3); Say '  使用说明.txt: 排障补「样式降级」一条' }

# ---- 归一化：GBK + CRLF + 无 BOM（打包校验会逐项红检）----
$t = $t.Replace("`r`n", "`n").Replace("`r", "`n").Replace("`n", "`r`n")
[IO.File]::WriteAllText($p, $t, $gbk)
Say ("  使用说明.txt: {0} -> {1} B" -f $before, (Get-Item $p).Length)

# ============================================================ 软件介绍.md
$p = Join-Path $App '软件介绍.md'
$m = [IO.File]::ReadAllText($p, [Text.Encoding]::UTF8)
if ($m -match '\*\*版本 1\.5\.2 ｜') { $m = $m -replace '\*\*版本 1\.5\.2 ｜', '**版本 1.6.6 ｜'; Say '  软件介绍.md: 版本 -> 1.6.6' }

$uiMd = @(
  '## 界面'
  ''
  '深色**液态玻璃**风格：面板半透明，底图有几团缓慢飘动的彩色氛围光，于是玻璃"透"过去时颜色是会流动的。'
  '卡片**没有描边线** —— 边缘靠一层上缘 1px 内高光 + 表面斜向光泽 + 两层柔和投影切出来，'
  '这是它在"去掉边框"之后仍然有形的原因；关键数字再叠一层白色亮晕，从模糊的背景里浮出来。'
  ''
  '- 顶栏是贴边的一条真玻璃，页面内容会从它下面滚过去并被模糊（全页只有这一处大模糊 —— 同屏几十块毛玻璃会掉帧）。'
  '- 卡片之间的分隔不是实线，是一条中间亮、两头化开的高光线，像玻璃的接缝。'
  '- 按钮、下拉框、开关都是玻璃片；输入框聚焦是一圈青色光晕，不是描边。'
  '- 「恢复出厂设置」是染红的玻璃片（不是红框），二次确认照旧。'
  '- 窗口宽度变化时整块界面等比缩放；窄窗口自动重排成单列。'
  '- 系统开了"减少动态效果"时背景光斑会停住；不支持毛玻璃的老引擎自动退化成实色面板，文字照样清楚。'
  ''
  '---'
  ''
) -join "`n"
if ($m -notmatch '(?m)^## 界面$') {
  $m = $m.Replace("## 功能总览`n", $uiMd + "## 功能总览`n")
  Say '  软件介绍.md: 新增「界面」一节'
}
[IO.File]::WriteAllText($p, $m, [Text.UTF8Encoding]::new($false))

# ============================================================ 软件介绍.html
$p = Join-Path $App '软件介绍.html'
$h = [IO.File]::ReadAllText($p, [Text.Encoding]::UTF8)
if ($h.Contains('<span>版本 1.5.2</span>')) {
  $h = $h.Replace('<span>版本 1.5.2</span>', '<span>版本 1.6.6</span>')
  [IO.File]::WriteAllText($p, $h, [Text.UTF8Encoding]::new($false))
  Say '  软件介绍.html: 版本 -> 1.6.6'
}

# ---- 落盘报告（PowerShell 工具 stdout 不回传，一律写文件后读）----
[IO.File]::WriteAllLines("$env:TEMP\_docsync.txt", $log, [Text.UTF8Encoding]::new($false))
Say 'done'
