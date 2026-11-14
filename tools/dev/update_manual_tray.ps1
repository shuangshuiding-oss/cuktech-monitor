# update_manual_tray.ps1 - insert tray-icon section into GBK manual (idempotent). ASCII only.
param([string]$Path = 'C:\Users\shuan\Tools\CuktechMonitor\使用说明.txt')
$enc = [System.Text.Encoding]::GetEncoding(936)
$lines = [IO.File]::ReadAllLines($Path, $enc)

if (($lines | Where-Object { $_ -eq '任务栏功率图标' }).Count -gt 0) {
  Write-Output 'already updated, skip'
  exit 0
}

$section = @(
  '任务栏功率图标',
  '--------------',
  '启动后在屏幕右下角通知区会有一个功率图标：',
  '',
  '* 图标里实时显示当前总功率（超过 1000 W 显示 1.2k 这样的缩写）。',
  '* 悬停提示：总功率 + C1/C2/C3/USB-A 四个口的分口功率。',
  '* 右键菜单：打开窗口 / 切换显示模式 / 退出。',
  '* 显示模式两种（网页「托盘显示」下拉或右键菜单都可切换，即时生效）：',
  '  - 仅总功率：图标只显示总瓦数（默认）。',
  '  - 全部功率（轮流）：16 像素的小图标放不下 5 个数字，改为每秒轮流显示',
  '    总功率 → C1 → C2 → C3 → USB-A，每个口有自己的颜色（青/绿/黄/紫）。',
  '* 去掉「任务栏功率图标」勾选即整体关闭；图标连续 6 秒联系不上服务时',
  '  会自动消失，不会留孤儿图标。',
  '* 若图标被 Windows 收进「显示隐藏的图标」折叠区：任务栏右键 → 任务栏设置',
  '  → 其他系统托盘图标，把 Windows PowerShell 设为始终显示即可。',
  ''
)

$filesec = @(
  'tray.ps1           任务栏功率图标（由 server.js 自动启动，无需手动运行）'
)

# 1) insert section before the '注意' chapter
$i = [array]::IndexOf($lines, '注意')
if ($i -lt 0) { Write-Output 'anchor NOT found'; exit 1 }
$all = @()
$all += $lines[0..($i - 1)]
$all += $section
$all += $lines[$i..($lines.Count - 1)]

# 2) add tray.ps1 to the file list, right after launcher.js
$j = [array]::IndexOf($all, 'launcher.js        打开应用窗口')
if ($j -ge 0) {
  $all = $all[0..$j] + $filesec + $all[($j + 1)..($all.Count - 1)]
}

[IO.File]::WriteAllLines($Path, $all, $enc)
Write-Output ("updated, lines=" + $all.Count)
