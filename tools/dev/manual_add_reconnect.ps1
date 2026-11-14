# 往「使用说明.txt」的排障一节追加「偶尔重连」的说明。
# 本文件含中文，**必须带 UTF-8 BOM**（tools\add-bom.ps1）。幂等：已存在就不动。
$path = 'C:\Users\shuan\Tools\CuktechMonitor\使用说明.txt'
$gbk = [Text.Encoding]::GetEncoding(936)
$anchor = '想清空历史：删掉 data\history.jsonl；想清空电量：删掉 data\energy.json。'
$add = @'
* 偶尔看到「链路：reconnecting → 已连接并认证」：这是正常的自我恢复，不是蓝牙坏了。
  充电头与电脑之间的米家私有协议（MIOT）给每一帧都带一个递增计数器，蓝牙链路重传
  或短暂乱序时这个计数会回退一两位；早期版本一遇到就判整条会话作废、重扫重认证
  （表现出来就是「过一会就断一下」），现在只有计数器大幅失步才重连。
  想再少一点这种重连，可以把「采样间隔」从 0.5 秒调回 1.0~1.5 秒，蓝牙通道压力小很多。
'@
$t = [IO.File]::ReadAllText($path, $gbk)
if ($t.Contains('这是正常的自我恢复，不是蓝牙坏了')) {
  "already present" | Set-Content -Encoding UTF8 "$env:TEMP\_manual3.txt"
} elseif ($t.Contains($anchor)) {
  $t2 = $t.Replace($anchor, $anchor + "`r`n" + $add.TrimEnd("`r", "`n"))
  [IO.File]::WriteAllText($path, $t2, $gbk)
  "inserted, size $($t.Length) -> $($t2.Length)" | Set-Content -Encoding UTF8 "$env:TEMP\_manual3.txt"
} else {
  "ANCHOR NOT FOUND" | Set-Content -Encoding UTF8 "$env:TEMP\_manual3.txt"
}
