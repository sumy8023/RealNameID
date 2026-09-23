# Server

Node.js + Express + MySQL 后端 API。当前不内置后台页面和后台查询接口；管理端是独立的 Vue 后台（见 `../vue/README.md`），若现场还留着旧 PHP 校区后台，它通过业务库直连和 `/api/health` 探活接入，灰度期两套共用同一份节点登记表。

## 当前关键规则

- `tp_smsj_classroom` 保持单表；教师 IP 精确匹配优先于学生 IP 段。
- 学生、教师账户都可在任意已启用教室登录；学生查 `tp_student`，教师接受 `tp_teacher.teacher_num/teacher_code/tel`。
- 教师三种标识登录成功后归一为 `teacher_num`；会话用 `user_role + student_no` 表示身份和规范账号。
- 恢复与心跳必须校验会话身份、账号状态和机器绑定关系；当前机器角色不限制学生或教师身份。
- 生产授权以 socket 来源 IP 为准，不信任请求体 IP 或 `X-Forwarded-For`。
- 外部账号表只读；故障报修账号同时支持学生表和教师表。

## 目录

```text
Server/
├─ src/
│  ├─ config.js
│  ├─ db.js
│  ├─ routes.js
│  ├─ runtime.js
│  ├─ schema.js
│  ├─ server.js
│  ├─ services.js
│  └─ utils.js
├─ database/schema.sql
└─ package.json
```

`server.js` 只作为启动入口；`config.js` 是后端唯一配置；`runtime.js` 基于配置导出运行参数；`routes.js` 放 API 路由；`services.js` 放登录、心跳、会话和教室匹配等业务；`schema.js` 放建表和字段迁移；`utils.js` 放日志、IP、时间、uuid 等通用工具。

接口清单、返回包与签名的整体约定，以及实现期相对遗留后台的**有意差异表**（改接口前必读，别把这些修复当 bug 回滚），都在根 `../README.md` 的"接口与返回包"和"与遗留后台的行为差异"两节。部署、升级、灰度与下线同样在根 README 的"部署"一节。

## 配置

直接修改 `Server/src/config.js` 即可配置 Node 后端自己的端口、节点编号、注册密钥、服务端默认心跳参数、业务数据库、外部账号数据库、故障类型和表名。后端不再读取 `server.config.json` 或环境变量。修改源码配置后双击 `Server/一键编译服务端.bat`，脚本会执行 `npm run build` 并同步 `build/Server`；运行期服务端、客户端、Watchdog 参数分别来自 `tp_smsj_server_config`、`tp_smsj_client_config`、`tp_smsj_watchdog_config`，数据库配置由 Vue 后台维护时通常只需等待 Node 短缓存刷新。

客户端本地启动兜底只看 `Client/appsettings.jsonc`，Watchdog 本地启动兜底只看 `WatchdogService/watchdogsettings.jsonc`；它们不再写进 Node 的 `config.js`。

表名只支持字母、数字、下划线，并且必须以字母开头。

客户端故障报修类型来自 `fault.types`，后端通过 `GET /api/client-config` 下发给客户端，同时也用于 `POST /api/fault` 校验。

`tp_smsj_client_config.heartbeat_seconds` 是客户端请求后端 `/api/heartbeat` 的间隔秒数，初始化默认 `5`，最低按 `3` 秒处理。客户端本地 `appsettings.jsonc` 的 `HeartbeatSeconds` 只作为无法获取服务端配置时的兜底。

`tp_smsj_client_config.fullscreen_enabled` 控制客户端未登录时是否启用锁屏全屏模式，初始化默认 `0`。客户端本地 `appsettings.jsonc` 的 `FullScreen` 只作为启动初期或后端不可用时的安全兜底。

`tp_smsj_server_config.heartbeat_timeout_seconds` 是服务端判定 active 会话心跳超时的秒数；`offline_scan_seconds` 是后台扫描超时会话的频率；`server_recovery_grace_minutes` 是后端启动后暂停自动结束超时会话的恢复宽限分钟数。客户端心跳间隔和服务端会话超时是两个独立参数，不按 `*9`、`*3` 之类规则自动推导。当前源码初始化默认值见 `Server/src/config.js` 与 `Server/src/runtime.js` 的注释，已有数据库行不会被启动默认值覆盖。

`heartbeatWriteIntervalSeconds` 用于降低 `tp_smsj_devices` 心跳写库频率：客户端仍按原心跳间隔请求后端，但同一台设备状态未变化时，后端最多按该间隔更新一次设备表；状态、用户、会话、IP、教室等变化会立即写入。

`tp_smsj_classroom.enabled` 是教室实名上机开关：`1` 表示启用，`0` 表示停用。后端通过 `POST /api/client-policy` 返回当前 IP 所属教室是否启用；只有教师机的教室可将学生机起止 IP 段同时留空。匹配不到教室/IP 段时视为非法 IP，客户端显示“非法IP，请联系机房管理员”并禁用登录按钮。

`tp_smsj_classroom.out_time` 是登录界面空闲自动关机分钟数，默认 `10`：`0` 表示不自动关机，大于 `0` 时客户端登录页会显示倒计时，到点后执行系统关机。

学生账号读取学籍库 `tp_student`，默认是 `xueji.tp_student`，由 `mysql.student` 独立配置连接地址、端口、数据库、账号和密码；未填写的连接项会回退业务库配置。字段仍为 `stu_num`、`stu_pass`、`stu_name`、`pingbi`。`stu_pass` 存 32 位小写 MD5，客户端仍提交用户输入的原密码，后端登录时转 MD5 后比对。

教师账号读取同一账号库的 `tp_teacher`。教师机支持用 `teacher_num`、`teacher_code` 或 `tel` 查询账号，并校验 `teacher_name`、`teacher_pass`、`pingbi`；登录成功后统一把 `teacher_num` 写入会话。`tp_smsj_sessions.user_role` 区分 `student` 和 `teacher`，重复登录、恢复和心跳都按身份校验。

当前版本不插入默认测试账号，`Server/database/schema.sql` 也不在 `realnameauth` 中创建 `tp_student` 或 `tp_teacher`。账号数据由外部系统维护，后端启动时只通过 `studentPool` 校验两张表和必需字段，不做跨库 JOIN，也不修改账号库数据。

教室与设备角色授权使用服务端 socket 来源 IP；只有 Node 与客户端在同机回环调试时才回退客户端上报 IP。生产请求不能通过请求体或 `X-Forwarded-For` 覆盖机器角色。

## 接口

面向客户端与探活（无鉴权）：

```text
GET  /
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

面向 Vue 后台，不是客户端接口：

```text
GET  /api/node/health    请求头 x-node-registration-key 必须等于本节点注册密钥
POST /api/node/admin     动作 + 参数 + 带时间戳的 HMAC-SHA256 签名
```

`GET /` 只是给人工访问根路径时看的一行在线状态。`POST /api/node/admin` 的动作清单、返回包和签名算法见根 README 的"接口与返回包"。

`POST /api/teacher-logout` 用于教师下机，可按教室 `allow_student_shutdown` 策略同时给本教室在线学生机排队关机指令。`POST /api/command-result` 是客户端回报远程下机/关机执行结果的入口，结果写入系统日志。

`POST /api/restore-session` 用于客户端被 Watchdog 拉起后恢复本机 active 会话；它会校验 `sessionId`、`machineId`、规范账号状态、`user_role`、教室/IP 策略和会话最终状态。只要同机同会话仍为 active、账号未屏蔽且身份有效即可恢复；最后心跳是否超时由后台扫描器统一改状态。

同一 `user_role + 规范账号` 已在其他电脑登录时，`POST /api/login` 会先返回冲突信息，客户端弹出确认框；用户确认后，后端结束原 active 会话并在当前电脑创建新会话。

## 启动

运行需要 Node.js 18 或更高（`Server/deploy/linux/server-manager.sh` 就是按 major ≥ 18 检查的）；这里不需要构建工具链，`vue/web` 那套 Vite 7 的版本要求只约束界面构建机。

```powershell
cd <项目目录>/Server
npm install
npm run start
```

健康检查：

```text
http://localhost:<server.port>/api/health
```

现场 Windows 启动脚本是 `build/Server/Windows/start-server.bat`。脚本不检查固定端口，Node 会按发布包内嵌的 `server.port` 启动，并在实际端口冲突时报告对应端口。脚本包含中文提示，必须保留 `chcp 65001 >nul`、UTF-8 编码和 Windows `CRLF` 换行。

## 部署与升级

Linux 平台的脚本源码在 `Server/deploy/linux/`（`install.sh`、`server-manager.sh`、`README.txt`），会随一键编译同步进 `build/Server/linux`：

- 安装：`sudo bash install.sh`，默认安装目录 `/opt/realname-simple-server`，并注册 systemd 服务。
- 管理：`sudo realname-server` 提供安装、升级、启动、停止、重启、状态、日志、开关开机自启和卸载。
- 升级：把新包解压到**新目录**再执行其中的 `install.sh`。脚本按时间戳备份旧程序到 `/var/backups/realname-simple-server/<日期时间>/`，停服、替换 `server.js` 与 `package.json`、恢复原运行状态，失败自动回滚。**不要直接覆盖正在运行的安装目录。**
- 安装与升级都不删除外部 MySQL 的库或业务记录；结构迁移只在后端启动时幂等执行。

`GET /api/health` 返回 `ok`、`runtime`、`nodeCode`、`nodeVersion`、`database`、`studentDatabase`、`recoveryGraceRemainingSeconds`，用于探活和确认配置生效。管理后台探测走 `GET /api/node/health`，其中 `adminApiVersion` 应为 `2`；低于该版本的节点没有管理接口，BFF 会报错而不会回退写本地库。跨节点移动教室依赖 `classroom_get`，源节点和目标节点都要先升级。

配置里的 `mysql.devDatabaseSuffix`（默认 `_bfftest`）是防误连现网库的护栏：非空时业务库和学籍库库名必须以该后缀结尾，否则 `db.js` 在建连接池前直接抛错退出。**给现场出包前把它改成 `""`**，同时改好 `nodeCode`、`nodeRegistrationKey` 与两个库的连接信息。

灰度期与遗留 PHP 校区后台共用 `tp_smsj_nodes` 时，写入口同一时间只保留一个；下线旧入口的操作见根 README 的"部署"一节。
