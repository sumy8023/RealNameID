# 后端节点

`Server` 是 RealName Simple 的 Node.js 后端节点。每个机房运行一份节点服务，负责客户端认证、教室策略、设备心跳、上机会话、故障、日志和运行参数。

## 运行环境

- Node.js 18 或更高版本
- MySQL 5.7 或更高版本
- 业务库和账号库的连接权限

## 配置

运行配置集中在 `src/config.js`：

- `nodeCode`：节点编号
- `nodeRegistrationKey`：管理接口注册密钥
- `server.port`：服务端口，示例为 `14848`
- `mysql`：业务库、账号库地址、库名、用户和密码
- `tables`：业务表名称
- `defaults`：客户端、Watchdog 和会话的初始参数

开发配置默认只允许连接 `127.0.0.1` 的 `_bfftest` 数据库。正式部署前请改为现场数据库，替换示例密钥和凭据，并为账号库授予最小权限。

## 数据库

后端启动时会幂等创建业务表和必要的迁移列。账号库中的学生、教师账号由现有账号系统维护，节点只读取约定字段。数据库结构参考见 `database/schema.sql`。

## 启动

```powershell
cd Server
npm install
npm start
```

健康检查：

```text
http://127.0.0.1:14848/api/health
```

## API

客户端主要使用：

```text
GET  /api/health
GET  /api/client-config
POST /api/client-policy
POST /api/login
POST /api/restore-session
POST /api/logout
POST /api/teacher-logout
POST /api/fault/check-student
POST /api/fault
POST /api/heartbeat
POST /api/command-result
```

管理后台使用：

```text
GET  /api/node/health
POST /api/node/admin
```

`/api/node/admin` 要求 `x-node-timestamp` 和 `x-node-signature` 请求头。签名算法为 HMAC-SHA256，密钥为 `nodeRegistrationKey`，节点仅接受 ±60 秒内的时间戳。

## 构建

```powershell
npm install
npm test
npm run build
```

生成的 `dist/server.js` 可以通过 `node dist/server.js` 启动。仓库提供的 `一键编译服务端.bat` 会同步生成 Windows 和 Linux 目录。

## Linux 部署

`deploy/linux/` 提供 `install.sh` 和 `server-manager.sh`：

```bash
sudo bash install.sh
sudo realname-server status
```

升级时请将新包解压到新目录，再执行新的 `install.sh`；脚本会备份程序并在失败时回滚，不会删除 MySQL 业务记录。

## 说明

节点不保存浏览器会话，也不把注册密钥下发给客户端。生产环境请启用 NTP、限制管理接口来源并定期备份数据库。
