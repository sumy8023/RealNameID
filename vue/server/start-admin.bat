@echo off
chcp 65001 >nul
setlocal

set "DIR=%~dp0"

where node >nul 2>&1
if errorlevel 1 (
    echo [错误] 没有检测到 node 命令，请先安装 Node.js 后再运行。
    pause
    exit /b 1
)

echo 正在启动实名上机管理后台...
echo 浏览器访问地址：http://本机IP:14850
echo 端口和学籍库连接写在发布包内嵌配置里，改配置请重新执行 vue\一键编译管理后台.bat
echo 按 Ctrl + C 可以停止本窗口中的服务。
echo.

node "%DIR%server.js"
if errorlevel 1 (
    echo.
    echo [错误] 管理后台已退出，请根据上面的提示处理后再试。
    pause
)
