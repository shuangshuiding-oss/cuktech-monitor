# v1.6.5 文档更新：曲线加 2/3/4 小时档 + test_server_hist 断言数（GBK 源文件）
$enc = [Text.Encoding]::GetEncoding(936)
$p = 'C:\Users\shuan\Tools\CuktechMonitor\使用说明.txt'
$txt = $enc.GetString([IO.File]::ReadAllBytes($p))

# 1) 区间按钮清单：1/6 小时之间插入 2/3/4 小时
$old1 = '  1 分钟 / 5 分钟 / 10 分钟 / 30 分钟 / 1 小时 / 6 小时 / 24 小时 / 7 天 / 30 天'
$new1 = '  1 分钟 / 5 分钟 / 10 分钟 / 30 分钟 / 1 小时 / 2 小时 / 3 小时 / 4 小时 /' + "`r`n" +
        '  6 小时 / 24 小时 / 7 天 / 30 天（共 12 档）'
if (-not $txt.Contains($old1)) { throw '未找到区间按钮清单' }
$txt = $txt.Replace($old1, $new1)

# 2) 在「1 小时及以内走内存原始采样」那条后面补一条讲 2/3/4 小时
$old2 = '* 1 小时及以内同样走内存原始采样；更长的区间读磁盘上的每分钟降采样文件。'
$new2 = $old2 + "`r`n" +
'* 2 / 3 / 4 小时（v1.6.5 新增）读磁盘上的每分钟文件，正好是 120 / 180 / 240 个点，' + "`r`n" +
'  都在 400 点以内 —— 等于每分钟一个点不抽稀。想看"这一上午/这一下午的节奏"用它' + "`r`n" +
'  比 1 小时完整、又比 6 小时清楚（6 小时的 360 点是被压过的）。'
if (-not $txt.Contains($old2)) { throw '未找到 1 小时那条' }
$txt = $txt.Replace($old2, $new2)

# 3) test_server_hist 断言数 71 -> 89（新增 2h/3h/4h 各 6 项）
$old3 = '71 项断言'
if (-not $txt.Contains($old3)) { throw '未找到 71 项断言' }
$txt = $txt.Replace($old3, '89 项断言')

# 整篇归一化成 CRLF（verify_package 的红线）
$txt = $txt -replace "`r`n", "`n"
$txt = $txt -replace "`n", "`r`n"
[IO.File]::WriteAllBytes($p, $enc.GetBytes($txt))
'OK bytes=' + ([IO.File]::ReadAllBytes($p).Length)
