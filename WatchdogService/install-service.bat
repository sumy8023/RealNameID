@echo off
chcp 65001 >nul
setlocal EnableExtensions DisableDelayedExpansion
title 实名上机 - 安装守护服务
set "REALNAME_SCRIPT_PATH=%~f0"
set "REALNAME_NOPAUSE=0"
set "REALNAME_ELEVATED_ATTEMPT=0"
if /i "%~1"=="nopause" set "REALNAME_NOPAUSE=1"
if /i "%~2"=="nopause" set "REALNAME_NOPAUSE=1"
if /i "%~1"=="elevated" set "REALNAME_ELEVATED_ATTEMPT=1"
if /i "%~2"=="elevated" set "REALNAME_ELEVATED_ATTEMPT=1"
set "SERVICE_EXE=%~dp0RealName.SimpleWatchdogService.exe"
set "POWERSHELL_EXE=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"

echo 正在安装实名上机守护服务...
if /i "%PROCESSOR_ARCHITECTURE%"=="AMD64" goto ARCH_OK
if /i "%PROCESSOR_ARCHITEW6432%"=="AMD64" goto ARCH_OK
goto UNSUPPORTED_ARCH

:ARCH_OK
if not exist "%SERVICE_EXE%" goto MISSING_EXE
call :CHECK_ADMIN
if errorlevel 1 goto ELEVATE

echo [1/1] 安装并启动服务，请稍候...
"%SERVICE_EXE%" install
set "EXIT_CODE=%errorlevel%"
if not "%EXIT_CODE%"=="0" goto INSTALL_FAILED
echo 安装成功，守护服务已启动。
goto DONE

:MISSING_EXE
echo 安装失败：请将此脚本和守护服务 EXE 放在同一个目录。
set "EXIT_CODE=1"
goto DONE

:INSTALL_FAILED
echo 安装失败，错误码：%EXIT_CODE%。请根据上面的提示处理后重试。
goto DONE

:UNSUPPORTED_ARCH
echo 安装失败：当前发布包只支持 64 位 Windows 10（x64）。
set "EXIT_CODE=1"
goto DONE

:ELEVATE
if "%REALNAME_ELEVATED_ATTEMPT%"=="1" goto ELEVATE_FAILED
if not exist "%POWERSHELL_EXE%" goto ELEVATE_FAILED
echo 需要管理员权限，请在弹出的确认窗口中选择“是”。
"%POWERSHELL_EXE%" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "try { $arguments = if ($env:REALNAME_NOPAUSE -eq '1') { 'elevated nopause' } else { 'elevated' }; Start-Process -FilePath $env:REALNAME_SCRIPT_PATH -ArgumentList $arguments -Verb RunAs -ErrorAction Stop; exit 0 } catch { Write-Host ('无法取得管理员权限：' + $_.Exception.Message); exit 1 }"
if errorlevel 1 goto ELEVATE_FAILED
exit /b 0

:ELEVATE_FAILED
echo 未完成安装。也可以右键此脚本，选择“以管理员身份运行”。
set "EXIT_CODE=1"

:DONE
if "%REALNAME_NOPAUSE%"=="1" exit /b %EXIT_CODE%
echo.
echo 按任意键关闭窗口...
pause >nul
exit /b %EXIT_CODE%

:CHECK_ADMIN
if exist "%POWERSHELL_EXE%" (
    "%POWERSHELL_EXE%" -NoLogo -NoProfile -NonInteractive -Command "$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent()); if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { exit 0 }; exit 1" >nul 2>&1
    if not errorlevel 1 exit /b 0
)
if exist "%SystemRoot%\System32\fltmc.exe" (
    "%SystemRoot%\System32\fltmc.exe" >nul 2>&1
    if not errorlevel 1 exit /b 0
)
exit /b 1
