@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto node_missing

echo 正在启动实名上机后端服务...
if exist "%~dp0server.js" goto run_packaged
if exist "%~dp0src\server.js" goto run_source
goto entry_missing

:run_packaged
node "%~dp0server.js"
set "EXIT_CODE=%ERRORLEVEL%"
goto finished

:run_source
node "%~dp0src\server.js"
set "EXIT_CODE=%ERRORLEVEL%"
goto finished

:node_missing
echo 未找到运行环境，请先安装 Node.js 18 或更高版本，并检查 PATH 环境变量。
pause
exit /b 1

:entry_missing
echo 未找到后端入口文件：server.js 或 src\server.js
pause
exit /b 1

:finished
echo 后端服务已退出，请检查上方提示信息。
pause
exit /b %EXIT_CODE%
