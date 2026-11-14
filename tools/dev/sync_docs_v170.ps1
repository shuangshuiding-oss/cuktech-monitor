# 把 v1.7.0 的两块新东西写进文档：
#   1) 透明窗口外壳（Electron）+ 大圆角 + 壁纸退路
#   2) 环境温度计（外挂 LYWSD03MMC）
# 使用说明.txt 是 GBK + CRLF，必须用 PowerShell 的 936 编码读写。
$ErrorActionPreference = 'Continue'
$log = "$env:TEMP\_docsync2.txt"
$APP = 'C:\Users\shuan\Tools\CuktechMonitor'
$out = @()
$gbk = [Text.Encoding]::GetEncoding(936)

# ---------------- 使用说明.txt（GBK + CRLF）----------------
$f = Join-Path $APP '使用说明.txt'
$bak = $f + '.bak-v170'
Copy-Item $f $bak -Force
$out += "备份：$bak"
$t = [IO.File]::ReadAllText($f, $gbk)
$out += "原始长度 = $($t.Length) 字符"

function Ins($text, $anchor, $block, $label) {
  if ($text.Contains($anchor)) {
    return $text.Replace($anchor, $block + $anchor)
  }
  return $null
}

$envSection = @'
──────────────────────────────────────────────
环境温度计（外挂传感器）
──────────────────────────────────────────────
UI 上有一张「环境温度」卡片，读的是家里那台小米温湿度计（LYWSD03MMC，
米家蓝牙温湿度计 2），不是充电头的温度。

· 充电头的蓝牙属性里**没有温度**（官方规格表逐项核过），所以温度只能外挂传感器。
· 温湿度计是**连接型设备**：每次读取会短暂连上它（约 1 秒），默认每 90 秒一次。
  这段时间手机米家连不上它 —— 和充电头是同样的「一个中心端」限制。
· **不需要密钥、不需要刷机**：原厂固件的 GATT 特征就是明文。
  广播里能看到的 58 58 开头那串是加密 MiBeacon，读不了，但没关系 ——
  温度走连接读取这条路（明文）。
· 卡片上「读取」一栏会写明来源：
    · 连接读取 = 走 GATT（原厂固件的正常情况）
    · 广播直读 = 如果哪天把固件刷成了 ATC/pvvx，就能免连接直接读（更省电）
· 电量显示不出来是正常的：这台固件的电量特征语义不是百分比（实测读回 159），
  宁可显示「—」也不编一个数给你。
· 数据陈旧时会明确标注「多久没更新」并把大数字变灰 —— 不会拿旧值冒充最新值。

温湿度曲线（卡片下半部分）：
· 每次读数都会**落盘**（data\env-history\env-YYYY-MM-DD.jsonl，原始；另有
  data\env-history-min.jsonl 每分钟一行），保留 30 天，重启不丢。
· 卡片上的曲线把**温度（橙，左轴）和湿度（青，右轴）**画在一起，两条线共用一条
  时间轴，量纲差得多所以分成左右两个轴，不然总有一条被压成直线。
· **时间轴和功率曲线是同一个按钮组**（1 分钟 ~ 30 天）—— 点一下两条曲线一起切，
  一个控件管到底，不用记两套。
· 图例上点「温度」「湿度」可以各自隐藏，只看其中一条。
· 和功率曲线不同，温湿度**空档处直接断开连线、不补 0**：
  温度没有「0℃ = 没数据」这种语义，补 0 会画出一条掉到冰点的假线。
· 鼠标悬停看某一点的具体温湿度。断网/退出后重开，曲线会从磁盘回填，右半张不会空白。

设置项（卡片底部「温度计设置」里展开）：
  · 设备地址：默认 A4:C1:38:3C:25:A2。换设备就填新的 MAC。
  · 轮询间隔：30~600 秒，默认 90。不建议低于 60 秒（会把蓝牙占得太久）。
  · 「探测广播」：扫 10 秒广播，确认设备在不在范围内、是不是原厂固件。
  · 「暂停温度计」：彻底停掉采集进程，不占用任何蓝牙。
  · 温度计采集跑在**独立进程**里，它挂了只是这张卡灰掉，功率采集完全不受影响。

──────────────────────────────────────────────
'@

$anchor = '──────────────────────────────────────────────' + "`r`n" + '文件说明'
if (-not $t.Contains($anchor)) {
  # 退一步：用更宽松的锚点
  $anchor = '文件说明'
}
if ($t.Contains($anchor)) {
  $t = $t.Replace($anchor, $envSection + $anchor)
  $out += "已插入「环境温度计」章节"
} else { $out += "没找到插入锚点，跳过温度计章节" }

# 透明窗口章节：插在温度计章节前面
$winSection = @'
──────────────────────────────────────────────
窗口外观（透明外壳 / 圆角 / 玻璃）
──────────────────────────────────────────────
本版本起，窗口由 Electron 打开，会「透」出后面的桌面和其它程序：

· 窗口**没有系统标题栏**，整块是一块**大圆角**的玻璃（圆角 2.6rem，比以前大一圈）。
  圆角不只是 CSS 画的：主进程还会把窗口形状本身用 setShape 切成同一弧度 ——
  否则透明窗口的四角会残留一圈方形的材质/阴影「毛刺」（就是之前看到的「边框」）。
· 顶栏右侧是自绘的窗口按钮：玻璃材质切换 / 尺寸档位 / 最小化 / 全屏 / 关闭。
  拖动：按住顶栏空白处拖。双击顶栏 = 全屏。F11 = 全屏，Ctrl+W = 关窗。
· **玻璃材质**四档循环（点了才知道效果，显卡不同观感有差异）：
    亚克力 acrylic —— 把窗口后面的东西模糊出来（最像苹果的那种「透」）
    云母 mica       —— 只取桌面壁纸的色调，更安静
    云母 tabbed     —— 同上，对比更强
    关闭            —— 纯深色，最省 GPU，远程桌面/虚拟机里建议用这档
· **尺寸**三档小/中/大：透明窗口在 Windows 上不能拖边缩放（系统限制），
  所以改成这几个预设 + 全屏。全屏时圆角自动归零（铺满屏幕不留缺口）。
· 打开 DevTools（F12）会让窗口暂时不透明，这是 Chromium 的限制，属正常。

⚠️ 如果打开后是一片纯黑 / 没有玻璃效果：多半是显卡驱动或「透明效果」被系统关了。
   两个办法：① 点「玻璃」按钮切到「关闭」；② 以 --glass=none 启动。
   界面功能不受任何影响，只是不透。

📦 便携包与透明效果：
   给别人打包时默认**不带** Electron（那个运行时约 230MB）。
   没有 Electron 时窗口会自动回退成 Edge 的 --app 窗口 —— 功能一模一样，
   只是少了「透」这一层。要连玻璃一起打包：
        powershell -ExecutionPolicy Bypass -File tools\package.ps1 -WithElectron

──────────────────────────────────────────────
'@

if ($t.Contains($anchor)) {
  $t = $t.Replace($anchor, $winSection + $anchor)
  $out += "已插入「窗口外观」章节"
} else { $out += "没找到窗口章节锚点" }

# tools 清单补新工具
$toolAnchor = 'tools\check_liquid.js'
if ($t.Contains($toolAnchor)) {
  $t = $t.Replace($toolAnchor, $toolAnchor + "`r`n" + '  tools\env_probe 探温度计广播（env_sensor.py --probe）')
  $out += "已补 tools 清单"
}

# 整篇归一化 CRLF（GBK 文档的老坑：混进 LF 会让打包校验判 FAIL）
$t = $t.Replace("`r`n", "`n").Replace("`n", "`r`n")
[IO.File]::WriteAllText($f, $t, $gbk)
$bytes = [IO.File]::ReadAllBytes($f)
$crlf = 0; $lf = 0
for ($i = 0; $i -lt $bytes.Length; $i++) {
  if ($bytes[$i] -eq 10) { if ($i -gt 0 -and $bytes[$i-1] -eq 13) { $crlf++ } else { $lf++ } }
}
$out += "使用说明.txt 写回：$($bytes.Length) 字节，CRLF=$crlf，裸LF=$lf，BOM=$($bytes[0] -eq 0xEF)"

# ---------------- 软件介绍.md / .html（UTF-8）----------------
foreach ($name in @('软件介绍.md', '软件介绍.html')) {
  $p = Join-Path $APP $name
  if (-not (Test-Path $p)) { continue }
  $s = [IO.File]::ReadAllText($p, [Text.Encoding]::UTF8)
  $s = $s.Replace('1.6.6', '1.7.0')
  [IO.File]::WriteAllText($p, $s, (New-Object Text.UTF8Encoding $false))
  $out += "$name 版本号 -> 1.7.0"
}

$out -join "`r`n" | Out-File -Encoding utf8 $log
"done"
