@echo off
chcp 936 >nul
setlocal
set "HERE=%~dp0"
if "%HERE:~-1%"=="\" set "HERE=%HERE:~0,-1%"
title 酷态科10号Ultra

rem bg = 后台运行（开机自启动用）：不弹应用窗口，托盘与网页照旧
set "NOARG="
if /i "%~1"=="bg" set "NOARG=--no-window"

set "NODE="
if exist "%HERE%\runtime\node.exe" set "NODE=%HERE%\runtime\node.exe"
if not defined NODE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE for %%I in (node.exe) do if not "%%~$PATH:I"=="" set "NODE=%%~$PATH:I"
if not defined NODE goto :nonode

if not exist "%HERE%\data" mkdir "%HERE%\data" >nul 2>&1
del "%HERE%\data\ready.json" >nul 2>&1
rem 启动 server。注意：node 是控制台程序，这样起会得到一个**真实存在的控制台窗口**——
rem 它会一直挂到 node 退出（几小时），而且**关掉它就等于立刻杀掉服务**
rem （CTRL_CLOSE_EVENT，无任何清理：没有退出日志、data\running.lock 还会残留）。
rem 2026-10-11 用户就是被这个黑窗口坑的。
rem 解法不在这一行，而在 node 自己：server.js 一启动就把自己的控制台窗口**隐藏**
rem （hideOwnConsole，koffi 调 user32.ShowWindow 传 SW_HIDE）—— 见 server.js 那段说明。
rem /min 只是保险：万一隐藏失败，它至少是「最小化」而不是弹在屏幕中央。
start "" /min "%NODE%" "%HERE%\server.js" %NOARG%

rem 后台档（开机自启动）：不打印任何东西、也不等 ready.json —— 没人在看这个窗口，
rem 早点退出就能让开机时那个 cmd 窗口一闪而过。服务由上面那条隐藏启动负责。
if defined NOARG exit /b 0

set /a N=0
:wait
ping -n 2 127.0.0.1 >nul 2>&1
set /a N+=1
if exist "%HERE%\data\ready.json" goto :ready
if %N% LSS 15 goto :wait
echo   [错误] 服务未能在 15 秒内启动。
echo     常见原因：8799 这一段端口被别的程序占着、或被系统保留；
echo     也可能是运行环境报错 —— 双击「调试启动.bat」可看到具体原因。
pause
exit /b 1

:ready
rem 在跑的实例已被复用 时，server.js 会把 ready.json 写回（带 reused 标记）——
rem 这时窗口是"唤出老实例的"，不是新起的服务，提示要说准。
set "REUSED="
set "UPGRADE="
findstr /c:"reused" "%HERE%\data\ready.json" >nul 2>&1 && set "REUSED=1"
findstr /c:"upgrade" "%HERE%\data\ready.json" >nul 2>&1 && set "UPGRADE=1"
if defined REUSED goto :ready_reused
if defined NOARG goto :ready_bg
echo   启动成功，正在打开应用窗口。本窗口可直接关闭。
goto :ready_done
:ready_bg
echo   已在后台运行（托盘/网页可用）。本窗口可直接关闭。
goto :ready_done
:ready_reused
if defined UPGRADE (
  echo   软件本来就在运行（是旧版本），已把它的窗口唤到前面。
  echo   要升级：先右键任务栏托盘图标选「退出」，再双击一次本文件。
) else (
  echo   软件本来就在运行，已把它的窗口唤到前面。
)
:ready_done
ping -n 4 127.0.0.1 >nul 2>&1
exit /b 0

:nonode
echo   [错误] 未找到 Node.js 运行环境。
echo   请先安装 Node.js，或把 node.exe 放到本目录的 runtime\ 子目录下。
pause
exit /b 1
