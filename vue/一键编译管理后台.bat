@echo off
setlocal

set "ADMIN_DIR=%~dp0"
set "ROOT_DIR=%ADMIN_DIR%.."
set "SERVER_DIR=%ADMIN_DIR%server"
set "WEB_DIR=%ADMIN_DIR%web"
set "OUT_DIR=%ROOT_DIR%\build\vue\Windows"

where npm >nul 2>&1
if errorlevel 1 (
    echo [ERROR] npm was not found. Install Node.js and try again.
    set "EXIT_CODE=1"
    goto end
)

pushd "%WEB_DIR%"
if not exist "node_modules\" (
    echo Installing vue web dependencies...
    call npm install
    if errorlevel 1 (
        set "EXIT_CODE=1"
        goto leave
    )
)
echo Building vue web...
call npm run build
if errorlevel 1 (
    set "EXIT_CODE=1"
    goto leave
)
if not exist "%SERVER_DIR%\web\index.html" (
    echo [ERROR] vue web output was not created in server\web.
    set "EXIT_CODE=1"
    goto leave
)
popd

pushd "%SERVER_DIR%"
if not exist "node_modules\" (
    echo Installing vue server dependencies...
    call npm install
    if errorlevel 1 (
        set "EXIT_CODE=1"
        goto leave
    )
)
echo Building vue server...
call npm run build
if errorlevel 1 (
    set "EXIT_CODE=1"
    goto leave
)
if not exist "dist\index.js" (
    echo [ERROR] Build output dist\index.js was not created.
    set "EXIT_CODE=1"
    goto leave
)

if not exist "%OUT_DIR%" mkdir "%OUT_DIR%"
if exist "%OUT_DIR%\web" rmdir /s /q "%OUT_DIR%\web"

copy /y "dist\index.js" "%OUT_DIR%\server.js" >nul
if errorlevel 1 goto package_failed
copy /y "dist\package.json" "%OUT_DIR%\package.json" >nul
if errorlevel 1 goto package_failed
copy /y "start-admin.bat" "%OUT_DIR%\start-admin.bat" >nul
if errorlevel 1 goto package_failed
xcopy /y /e /i /q "web" "%OUT_DIR%\web" >nul
if errorlevel 1 goto package_failed

echo vue package created in:
echo %OUT_DIR%
set "EXIT_CODE=0"
goto leave

:package_failed
echo [ERROR] Failed to create one or more vue package files.
set "EXIT_CODE=1"

:leave
if "%EXIT_CODE%"=="" set "EXIT_CODE=1"
popd >nul 2>&1

:end
if not defined EXIT_CODE set "EXIT_CODE=1"
if /i not "%~1"=="nopause" (
    powershell -NoProfile -ExecutionPolicy Bypass -Command "$null=Read-Host 'Press Enter to exit'"
)
exit /b %EXIT_CODE%
