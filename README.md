# RealName Simple 实名上机系统

RealName Simple 是一套面向机房的实名上机系统。学生或教师在指定电脑上完成身份验证后才能使用设备，管理员可以统一查看设备、会话、故障和操作日志，并向客户端下发下机、关机等指令。

项目按“一个机房一个后端节点”的方式部署。节点负责本机房的业务数据和客户端请求，管理后台通过签名接口管理一个或多个节点。示例配置全部使用 `127.0.0.1`，可直接在本机试用。

## 功能

- 学生和教师账号登录，校验账号、姓名、密码和禁用状态
- 按来源 IP 识别教室、教师机和学生机
- 会话创建、心跳保活、重复登录接管和会话恢复
- 客户端锁屏、全屏、空闲关机和动态策略下发
- 远程下机、远程关机、故障报修和执行结果回报
- Watchdog Windows 服务监测并拉起客户端
- 管理员登录、节点注册、多节点查询和节点状态探测
- 教室、设备、会话、故障、日志和运行参数管理
- HMAC-SHA256 节点管理签名，避免浏览器直接持有节点密钥

## 项目结构

```text
Client/           C# WPF + WebView2 客户端
WatchdogService/  Windows 守护服务，负责客户端存活监测和自动拉起
Server/           Node.js + Express + MySQL 后端节点
vue/web/          Vue 3 + Element Plus 管理界面
vue/server/       Node.js BFF，托管界面并代理节点管理请求
Common/           客户端与 Watchdog 共用的 C# 代码
```

## 系统流程

1. 客户端请求节点的 `/api/client-policy`，节点根据来源 IP 找到教室和设备角色。
2. 登录页提交账号、姓名和密码。节点从账号库读取学生或教师资料并创建会话。
3. 客户端按下发的间隔发送心跳，节点据此更新设备状态并处理远程命令。
4. 管理员在 BFF 界面中查看节点数据，写操作由 BFF 使用注册密钥签名后转发到节点。
5. 客户端异常退出时，Watchdog 负责重新启动；仍有效的会话可以从本机缓存恢复。

## 快速开始

### 环境要求

- Windows 10 或更高版本
- .NET 10 SDK
- MySQL 5.7 或更高版本
- Node.js 20.19+ 或 22.12+（构建前端）；运行发布包需要 Node.js 18+
- 客户端运行时需要 WebView2 Runtime

### 启动开发环境

在项目根目录执行：

```powershell
# 创建本机开发数据库、表和示例账号，可重复执行
node vue/server/scripts/init-dev-dbs.mjs

# 终端一：启动后端节点，监听 127.0.0.1:14848
cd Server
npm install
npm start

# 终端二：启动管理后台 BFF，监听 127.0.0.1:14850
cd ../vue/server
npm install
npm start
```

然后访问 <http://127.0.0.1:14850>。

初始化脚本会创建以下仅供本机测试的账号：

| 类型 | 账号 | 密码 |
|---|---|---|
| 管理员 | `demo-admin` | `DemoAdminPass2026` |
| 学生 | `STUDENT-DEMO-001` | `demo-student-password` |
| 教师 | `TEACHER-DEMO` | `demo-teacher-password` |

开发库默认名称为 `realnameauth_bfftest` 和 `xueji_bfftest`，默认连接地址为 `127.0.0.1`。这些账号和库只用于本机开发验证。

### 端口

| 端口 | 用途 |
|---:|---|
| 14848 | 后端节点 API |
| 14850 | 管理后台与 BFF |
| 14851 | 前端开发热更新 |

## 配置

配置集中在源码中，修改后需要重新编译或重新打包：

| 文件 | 作用 |
|---|---|
| `Server/src/config.js` | 节点编号、注册密钥、数据库、端口和服务端默认参数 |
| `vue/server/src/config.js` | BFF 端口、账号库、会话和节点代理参数 |
| `Client/appsettings.jsonc` | 客户端地址、心跳、超时和锁屏兜底值 |
| `WatchdogService/watchdogsettings.jsonc` | 客户端路径、检查间隔和守护开关 |
| `Server/database/schema.sql` | 初始化数据库结构参考 |

开发库护栏默认要求数据库名称带 `_bfftest` 后缀，且只允许连接本机地址。正式部署前必须改掉后缀护栏、节点编号、注册密钥、数据库地址、账号和密码。

## 数据库

系统使用两个 MySQL 数据库：

- **业务库**：每个节点一份，保存教室、设备、会话、远程命令、故障、日志和运行参数。
- **账号库**：保存学生、教师、管理员、登录失败计数和节点登记信息。学生与教师账号由现有账号系统维护，本项目只按约定字段读取。

后端启动时会幂等创建和升级业务表。正式部署前请为服务创建最小权限的数据库账号，并为数据库做好备份。

## 接口概览

客户端接口包括：

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

管理接口由节点提供，BFF 负责签名转发。签名消息为 `timestamp + "\n" + 原始 JSON`，算法为 HMAC-SHA256；节点只接受时间偏差在 ±60 秒内的请求，因此部署时需要启用 NTP 时间同步。

## 构建和打包

```powershell
# 后端
cd Server
npm install
npm run build

# 管理后台界面和 BFF
cd ../vue/web
npm install
npm run build
cd ../server
npm install
npm run build

# 客户端和 Watchdog
dotnet build .\RealNameSimple.slnx
```

也可以运行以下脚本生成现场目录：

```text
Server/一键编译服务端.bat
vue/一键编译管理后台.bat
Client/一键编译客户端.bat
WatchdogService/一键编译守护服务.bat
```

发布结果位于 `build/`，包含 Windows 后端、Linux 后端、管理后台、客户端和 Watchdog。`build/`、`dist/`、`bin/`、`obj/` 等构建目录默认不提交到仓库。

## 部署

### 后端节点

Windows 使用 `build/Server/Windows/start-server.bat` 启动；Linux 使用 `build/Server/linux/install.sh` 安装，并通过 `realname-server` 管理服务。每个机房部署一份节点程序和一份业务库。

### 管理后台

使用 `build/vue/Windows/start-admin.bat` 启动 BFF。建议将 BFF 与一台节点部署在同一内网主机，减少跨网段请求。对外提供访问时，请在前面配置 HTTPS 反向代理，并限制管理后台口的访问来源。

### 客户端和 Watchdog

将 `build/ClientLite/RealName.SimpleClient.exe` 安装到机房终端，将 `build/Watchdog` 安装为 Windows 服务。客户端需要 WebView2 Runtime；Watchdog 应使用专用服务账号并设置为自动启动。

## 测试

```powershell
cd vue/server
npm test
```

测试覆盖参数校验、签名、日期处理、BFF 请求和多节点代理流程。测试仅使用本机开发库。

## 安全建议

- 上线前替换所有示例密码、注册密钥和数据库凭据。
- 不要把管理后台口直接暴露到公网，使用防火墙和 HTTPS 反向代理。
- 为业务库和账号库分别创建最小权限账号，并定期备份。
- 生产环境启用 NTP，保证节点签名时间一致。
- 发布前检查客户端、服务端、BFF 和 Watchdog 的地址是否指向实际环境。
- 本项目没有替代专业安全审计、渗透测试和现场验收。

## 许可证

本项目采用 [MIT License](LICENSE)。

## 免责声明

本项目代码均由 AI 辅助开发，未经完整的专业安全审计或在所有目标环境中充分验证。因使用本项目产生的漏洞、安全性问题、数据丢失、服务中断或其他损失，由使用者自行评估并承担责任。本项目仅供学习和交流使用。

该项目仅供学习，如果有BUG或者不满意的地方请自行修改。
