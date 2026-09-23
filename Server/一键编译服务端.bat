@echo off
setlocal

set "PROJECT_DIR=%~dp0"
set "ROOT_DIR=%PROJECT_DIR%.."
set "OUT_DIR=%ROOT_DIR%\build\Server"
set "WINDOWS_DIR=%OUT_DIR%\Windows"
set "LINUX_DIR=%OUT_DIR%\linux"

where npm >nul 2>&1
if errorlevel 1 (
    echo [ERROR] npm was not found. Install Node.js and try again.
    set "EXIT_CODE=1"
    goto end
)

pushd "%PROJECT_DIR%"

if not exist "node_modules\" (
    echo Installing Server dependencies...
    call npm install
    if errorlevel 1 (
        set "EXIT_CODE=1"
        goto leave_project
    )
)

echo Building Server...
call npm run build
if errorlevel 1 (
    set "EXIT_CODE=1"
    goto leave_project
)

if not exist "dist\index.js" (
    echo [ERROR] Build output dist\index.js was not created.
    set "EXIT_CODE=1"
    goto leave_project
)

if not exist "dist\package.json" (
    echo [ERROR] Build output dist\package.json was not created.
    set "EXIT_CODE=1"
    goto leave_project
)

if not exist "%WINDOWS_DIR%" mkdir "%WINDOWS_DIR%"
if not exist "%LINUX_DIR%" mkdir "%LINUX_DIR%"
if exist "%WINDOWS_DIR%\database" rmdir /s /q "%WINDOWS_DIR%\database"
if exist "%LINUX_DIR%\database" rmdir /s /q "%LINUX_DIR%\database"

copy /y "dist\index.js" "%WINDOWS_DIR%\server.js" >nul
if errorlevel 1 (
    set "EXIT_CODE=1"
    goto leave_project
)

copy /y "dist\package.json" "%WINDOWS_DIR%\package.json" >nul
if errorlevel 1 (
    set "EXIT_CODE=1"
    goto leave_project
)

copy /y "start-server.bat" "%WINDOWS_DIR%\start-server.bat" >nul
if errorlevel 1 goto package_failed
copy /y "deploy\windows\README.txt" "%WINDOWS_DIR%\README.txt" >nul
if errorlevel 1 goto package_failed

copy /y "dist\index.js" "%LINUX_DIR%\server.js" >nul
if errorlevel 1 goto package_failed
copy /y "dist\package.json" "%LINUX_DIR%\package.json" >nul
if errorlevel 1 goto package_failed
copy /y "deploy\linux\install.sh" "%LINUX_DIR%\install.sh" >nul
if errorlevel 1 goto package_failed
copy /y "deploy\linux\server-manager.sh" "%LINUX_DIR%\server-manager.sh" >nul
if errorlevel 1 goto package_failed
copy /y "deploy\linux\README.txt" "%LINUX_DIR%\README.txt" >nul
if errorlevel 1 goto package_failed

if exist "%OUT_DIR%\server.js" del /q "%OUT_DIR%\server.js"
if exist "%OUT_DIR%\package.json" del /q "%OUT_DIR%\package.json"
if exist "%OUT_DIR%\start-server.bat" del /q "%OUT_DIR%\start-server.bat"
if exist "%OUT_DIR%\database" rmdir /s /q "%OUT_DIR%\database"
if exist "%OUT_DIR%\nodes" rmdir /s /q "%OUT_DIR%\nodes"

echo Windows package created in:
echo %WINDOWS_DIR%
echo Linux package created in:
echo %LINUX_DIR%
set "EXIT_CODE=0"
goto leave_project

:package_failed
echo [ERROR] Failed to create one or more Server package files.
set "EXIT_CODE=1"

:leave_project
popd

:end
if not defined EXIT_CODE set "EXIT_CODE=1"
if /i not "%~1"=="nopause" (
    powershell -NoProfile -ExecutionPolicy Bypass -Command "$null=Read-Host 'Press Enter to exit'"
)
exit /b %EXIT_CODE%
