@echo off
chcp 65001 >nul
setlocal EnableExtensions DisableDelayedExpansion
title 实名上机 - 卸载守护服务
set "REALNAME_SCRIPT_PATH=%~f0"
set "REALNAME_NOPAUSE=0"
set "REALNAME_ELEVATED_ATTEMPT=0"
if /i "%~1"=="nopause" set "REALNAME_NOPAUSE=1"
if /i "%~2"=="nopause" set "REALNAME_NOPAUSE=1"
if /i "%~1"=="elevated" set "REALNAME_ELEVATED_ATTEMPT=1"
if /i "%~2"=="elevated" set "REALNAME_ELEVATED_ATTEMPT=1"
set "SERVICE_EXE=%~dp0RealName.SimpleWatchdogService.exe"
set "DATA_DIR=C:\ProgramData\RealNameSimple"
set "PROGRAM_FILES_64=%ProgramFiles%"
if defined ProgramW6432 set "PROGRAM_FILES_64=%ProgramW6432%"
set "POWERSHELL_EXE=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
set "TASKKILL_EXE=%SystemRoot%\System32\taskkill.exe"
set "FSUTIL_EXE=%SystemRoot%\System32\fsutil.exe"
set "TIMEOUT_EXE=%SystemRoot%\System32\timeout.exe"
set "PING_EXE=%SystemRoot%\System32\ping.exe"

echo 正在卸载实名上机守护服务...
if /i "%PROCESSOR_ARCHITECTURE%"=="AMD64" goto ARCH_OK
if /i "%PROCESSOR_ARCHITEW6432%"=="AMD64" goto ARCH_OK
goto UNSUPPORTED_ARCH

:ARCH_OK
if not exist "%SERVICE_EXE%" set "SERVICE_EXE=%PROGRAM_FILES_64%\RealNameSimple\Watchdog\RealName.SimpleWatchdogService.exe"
if not exist "%SERVICE_EXE%" goto MISSING_EXE
call :CHECK_ADMIN
if errorlevel 1 goto ELEVATE

echo [1/3] 停止并卸载服务，请稍候...
"%SERVICE_EXE%" uninstall
set "EXIT_CODE=%errorlevel%"
if not "%EXIT_CODE%"=="0" goto UNINSTALL_FAILED

echo [2/3] 关闭实名上机客户端...
if exist "%TASKKILL_EXE%" "%TASKKILL_EXE%" /F /T /IM RealName.SimpleClient.exe >nul 2>&1

echo [3/3] 清理 C:\ProgramData\RealNameSimple...
if /i not "%DATA_DIR%"=="C:\ProgramData\RealNameSimple" goto CLEANUP_FAILED
if not exist "%DATA_DIR%\" goto CLEANUP_OK
if not exist "%FSUTIL_EXE%" goto CLEANUP_UNSAFE
"%FSUTIL_EXE%" reparsepoint query "%DATA_DIR%" >nul 2>&1
if not errorlevel 1 goto CLEANUP_UNSAFE
for /l %%I in (1,1,3) do (
    rmdir /s /q "%DATA_DIR%" >nul 2>&1
    if not exist "%DATA_DIR%\" goto CLEANUP_OK
    if exist "%TIMEOUT_EXE%" (
        "%TIMEOUT_EXE%" /t 1 /nobreak >nul
    ) else if exist "%PING_EXE%" (
        "%PING_EXE%" 127.0.0.1 -n 2 >nul
    )
)
set "EXIT_CODE=1"
goto CLEANUP_FAILED

:CLEANUP_OK
echo 卸载完成，客户端数据目录已清理。
set "EXIT_CODE=0"
goto DONE

:MISSING_EXE
echo 卸载失败：未找到守护服务 EXE，请使用完整的守护服务发布包。
set "EXIT_CODE=1"
goto DONE

:UNSUPPORTED_ARCH
echo 卸载失败：当前发布包只支持 64 位 Windows 10（x64）。
set "EXIT_CODE=1"
goto DONE

:UNINSTALL_FAILED
echo 服务卸载失败，错误码：%EXIT_CODE%。未执行数据目录清理。
goto DONE

:CLEANUP_FAILED
echo 服务已卸载，但数据目录未完全清理。请关闭仍在使用的客户端后重试。
goto DONE

:CLEANUP_UNSAFE
echo 服务已卸载，但数据目录不是普通目录，已取消清理。
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
echo 未完成卸载。也可以右键此脚本，选择“以管理员身份运行”。
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
