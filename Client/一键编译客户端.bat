@echo off
setlocal

set "PROJECT_DIR=%~dp0"
set "ROOT_DIR=%PROJECT_DIR%.."
set "OUT_DIR=%ROOT_DIR%\build\ClientLite"

dotnet publish "%PROJECT_DIR%RealName.SimpleClient.csproj" -c Release -r win-x64 --self-contained false -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -p:PublishTrimmed=false -p:DebugType=None -p:DebugSymbols=false -o "%OUT_DIR%"
set "EXIT_CODE=%ERRORLEVEL%"
if "%EXIT_CODE%"=="0" (
    rem Release 配置已嵌入 EXE，清理旧版本遗留的外置配置文件。
    if exist "%OUT_DIR%\appsettings.jsonc" del /f /q "%OUT_DIR%\appsettings.jsonc"
    if exist "%OUT_DIR%\appsettings.json" del /f /q "%OUT_DIR%\appsettings.json"
)

if /i not "%~1"=="nopause" (
    powershell -NoProfile -ExecutionPolicy Bypass -Command "$null=Read-Host ([string]::Concat([char]25353,[char]22238,[char]36710,[char]38190,[char]36864,[char]20986))"
)
exit /b %EXIT_CODE%
