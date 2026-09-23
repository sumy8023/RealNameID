@echo off
chcp 65001 >nul
setlocal

set "PROJECT_DIR=%~dp0"
set "ROOT_DIR=%PROJECT_DIR%.."
set "OUT_DIR=%ROOT_DIR%\build\Watchdog"

dotnet publish "%PROJECT_DIR%RealName.SimpleWatchdogService.csproj" -c Release -r win-x64 --self-contained false -p:PublishSingleFile=true -p:DebugType=None -p:DebugSymbols=false -o "%OUT_DIR%"
set "EXIT_CODE=%ERRORLEVEL%"
if "%EXIT_CODE%"=="0" (
    rem Release 配置已嵌入 EXE，清理旧版本遗留的外置配置文件。
    if exist "%OUT_DIR%\watchdogsettings.jsonc" del /f /q "%OUT_DIR%\watchdogsettings.jsonc"
    if exist "%OUT_DIR%\watchdogsettings.json" del /f /q "%OUT_DIR%\watchdogsettings.json"

    rem 发布包同时携带服务安装和卸载脚本，方便现场直接部署。
    copy /Y "%PROJECT_DIR%install-service.bat" "%OUT_DIR%\install-service.bat" >nul
    if errorlevel 1 set "EXIT_CODE=1"
    copy /Y "%PROJECT_DIR%uninstall-service.bat" "%OUT_DIR%\uninstall-service.bat" >nul
    if errorlevel 1 set "EXIT_CODE=1"
)

if /i not "%~1"=="nopause" (
    powershell -NoProfile -ExecutionPolicy Bypass -Command "$null=Read-Host ([string]::Concat([char]25353,[char]22238,[char]36710,[char]38190,[char]36864,[char]20986))"
)
exit /b %EXIT_CODE%
