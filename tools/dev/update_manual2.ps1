# update_manual2.ps1 - add panel-mode + background rules to GBK manual (idempotent). ASCII only.
param([string]$Path = 'C:\Users\shuan\Tools\CuktechMonitor\使用说明.txt')
$enc = [System.Text.Encoding]::GetEncoding(936)
$lines = [IO.File]::ReadAllLines($Path, $enc)
$changed = $false

if (($lines | Where-Object { $_ -like '*一行面板*' }).Count -eq 0) {
  $anchor = '  → 其他系统托盘图标，把 Windows PowerShell 设为始终显示即可。'
  $i = [array]::IndexOf($lines, $anchor)
  if ($i -ge 0) {
    $add = @(
      '* 「托盘显示」第三种模式「一行面板（四口+总）」：把一行功率文字直接嵌进',
      '  任务栏（时钟左边、垂直居中），背景完全透明，看起来像任务栏自带的部件；',
      '  文字按口配色（总=白 C1=青 C2=绿 C3=黄 A=紫），双击面板打开主窗口，',
      '  右键面板与右键托盘图标菜单相同。嵌不进任务栏的机器上会退回悬浮小条。',
      '* 面板里每个数字 1 秒刷新一次；连接断开时显示「连接中…」。',
      ''
    )
    $lines = $lines[0..$i] + $add + $lines[($i + 1)..($lines.Count - 1)]
    $changed = $true
  }
}

if (($lines | Where-Object { $_ -like '*后台常驻规则*' }).Count -eq 0) {
  $old = '* 关闭窗口后，后台服务会在 2 分钟内自动退出，不会留下幽灵进程。'
  $j = [array]::IndexOf($lines, $old)
  if ($j -ge 0) {
    $rep = @(
      '* 后台常驻规则：只要「任务栏功率图标」开着（默认开），窗口最小化甚至关闭后',
      '  服务也会一直留在后台（图标每秒轮询即保活），任务栏图标/面板照常更新；',
      '  双击启动 bat 或右键托盘图标「打开窗口」都能把窗口叫回来，不会起第二个服务。',
      '  关掉托盘图标后，2 分钟无请求服务才自动退出，不留幽灵进程。'
    )
    $lines = $lines[0..($j - 1)] + $rep + $lines[($j + 1)..($lines.Count - 1)]
    $changed = $true
  }
}

[IO.File]::WriteAllLines($Path, $lines, $enc)
Write-Output ("changed=" + $changed + " lines=" + $lines.Count)
