实名上机后端 Linux 安装说明
============================

系统要求：
1. 使用支持 systemd 的 Linux 发行版。
2. Node.js 18 或更高版本。未安装时，安装脚本可尝试通过系统软件源安装。
3. Linux 服务器能够连接配置中的业务数据库和账号数据库。

首次安装：
1. 把整个 Linux 文件夹上传到服务器并解压。
2. 进入该目录。
3. 执行：sudo bash install.sh
4. 按提示设置安装路径、开机自启和立即启动。

默认安装路径：/opt/realname-simple-server
安装后的管理命令：sudo realname-server

管理面板支持：
- 安装、升级、启动、停止、重启服务
- 查看服务状态和最近日志
- 开启开机自启
- 关闭服务并取消开机自启
- 卸载服务

升级方法：
1. 不要直接覆盖 /opt 下正在运行的文件。
2. 把新的 Linux 包解压到一个新目录，例如 /tmp/realname-server-new。
3. 在新包目录执行：sudo bash install.sh
4. 脚本检测到旧服务后会进入升级引导，先备份旧程序，再停止、覆盖和恢复服务。
5. 外部 MySQL 业务数据不会被删除。后端启动时会自动执行兼容的新字段和表结构迁移。

注意：
- server.js 已包含 Server/src/config.js 中的节点编号、注册密钥和数据库连接配置。
- 每个后端节点升级前，应先在源码 config.js 中填好该节点的配置，再生成对应安装包。
- 升级脚本替换 server.js 后，新包内的配置会生效，不会自动保留旧 server.js 内嵌的配置。
- 升级备份保存在 /var/backups/realname-simple-server。
