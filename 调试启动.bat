@echo off
chcp 936 >nul
setlocal
set "HERE=%~dp0"
if "%HERE:~-1%"=="\" set "HERE=%HERE:~0,-1%"
title 酷态科10号Ultra - 调试模式
echo   前台运行，日志直接打在窗口里；不会自动开应用窗口。
echo   排障用：接口地址会在下面打印出来，可用浏览器直接打开。
echo   按 Ctrl+C 结束。
echo.

set "NODE="
if exist "%HERE%\runtime\node.exe" set "NODE=%HERE%\runtime\node.exe"
if not defined NODE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE for %%I in (node.exe) do if not "%%~$PATH:I"=="" set "NODE=%%~$PATH:I"
if not defined NODE goto :nonode

set "CUKTECH_VERBOSE=1"
set "CUKTECH_NO_WINDOW=1"
"%NODE%" "%HERE%\server.js"
echo.
echo   服务已退出，退出码 %ERRORLEVEL%
pause
exit /b 0

:nonode
echo   [错误] 未找到 Node.js 运行环境。
pause
exit /b 1
