实名上机后端 Windows 运行说明
==============================

1. 安装 Node.js 18 或更高版本。
2. 双击 start-server.bat 启动后端。
3. server.js 和 package.json 需要放在同一目录。
4. 后端端口来自构建 server.js 时内嵌的 Server/src/config.js；端口冲突时会显示实际配置端口。

升级时请先停止旧后端，再用新包中的 server.js 和 package.json 覆盖旧文件，然后重新运行 start-server.bat。
