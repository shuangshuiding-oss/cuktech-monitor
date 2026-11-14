# 一次性的改名包装脚本。本文件含中文，**必须带 UTF-8 BOM**（tools\add-bom.ps1），
# 否则 PS5.1 按 GBK 读取会吞掉引号。
$root = 'C:\Users\shuan\Tools\CuktechMonitor'
$p = @(
  '-NoProfile', '-ExecutionPolicy', 'Bypass',
  '-File', "$root\tools\rename_gbk.ps1",
  '-Root', $root,
  '-From', '酷态科充电监视器',
  '-To',   '酷态科10号Ultra',
  '-From2', 'start "CuktechMonitor" /min',
  '-To2',   'start "酷态科10号Ultra" /min'
)
& powershell.exe @p
