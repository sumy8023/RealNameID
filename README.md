# RealName Simple

学校机房"实名上机"系统的最小实现：学生要在机房电脑上登录自己的账号才能使用，未登录时整机锁定；谁在哪台机器上了多久的机、报修了什么、后台做过哪些操作，全部可查可控。

设计目标是**不依赖 PHP 运行时**：业务数据由各机房自己的后端节点持有，管理后台通过带签名的代理接口跨节点读写。一台机房一个节点，互不影响。

但它不是零外部依赖的一套东西，三处必须说清：

- 登录账号来自**外部学籍系统维护的** `tp_student`、`tp_teacher`，本系统只读，不创建也不迁移；这两张表的字段和口令格式（32 位小写 MD5）是硬约定。
- 管理后台复用同一学籍库的 `tp_admin` 与 `tp_login_attempts`，与校区后台共用账号和爆破计数，不新建管理员体系。
- 节点登记表 `tp_smsj_nodes` 也在这所学籍库里，灰度期与遗留 PHP 校区后台**共用同一份**。

```text
Client/           C# WPF + WebView2 客户端（登录页是 Vue 3）→ 详见 Client/README.md
WatchdogService/  Windows 守护服务，客户端被关掉后重新拉起
Server/           Node.js + Express + MySQL 后端节点        → 详见 Server/README.md
vue/              独立管理后台：Node BFF + Vue 3 界面        → 详见 vue/README.md
Common/           客户端与 Watchdog 共用的 C# 源文件
build/            编译产物（已 gitignore，不入库）
```

## 工作流程

1. 客户端按 `ServerUrl` 请求 `POST /api/client-policy`，后端用**服务端看到的来源 IP** 匹配教室；不在任何教室 IP 段内的机器拒绝登录。
2. 未登录时窗口可全屏置顶并拦截常见逃逸快捷键（默认关，可在后台打开）；登录页要填**账号 + 姓名 + 密码**，账号学生用 `stu_num`、教师可用身份证号 / 工号 / 手机号，后端把姓名与账号表里的 `stu_name` / `teacher_name` 对上，再按 32 位小写 MD5 比对密码并检查禁用标记。
3. 登录成功建会话，客户端按配置间隔发心跳；心跳顺带下发远程命令（下机 / 关机）并刷新教室启停策略。
4. 正常下机、心跳超时下机、异地登录接管、异常下机都写入会话表和系统日志；教师下机时可按教室策略给本教室在线学生机排队关机。
5. 客户端被强杀后由 Watchdog 拉起，并可凭本机 `C:\ProgramData\RealNameSimple\session.json` 恢复同机仍为 active 的会话；正常退出、超时或恢复失败会清理该缓存。

## 快速开始（开发环境）

前置：Windows 10+、.NET 10 SDK、本机 MySQL 5.7+、Node.js **20.19+ 或 22.12+**（Vite 7 自己声明的 `engines` 就是这个，`vue/web` 用的正是它）。

现场只跑发布包时不需要构建工具链，Node.js **18 或更高**即可——后端和 BFF 的发布包已经把依赖打进去，`Server/deploy/linux/server-manager.sh` 也是按 18 检查的。构建环境和运行环境是两回事，别拿开发机的版本号推断服务器要求。

```powershell
# 1. 建开发库、表和种子账号（幂等，可反复跑）
node vue/server/scripts/init-dev-dbs.mjs

# 2. 起后端节点（首次启动自动建业务表）
cd Server && npm install && npm start

# 3. 起管理后台 BFF（同端口托管界面）
cd vue/server && npm install && npm start
```

浏览器访问 `http://127.0.0.1:14850`。种子账号只打印在 `init-dev-dbs.mjs` 的输出里，且只在 `*_bfftest` 两个库内生效。

不想部署真后端时用内置冒烟栈：`cd vue/server && node test/dev-stack.mjs`，它会起两个 mock 节点 + 真实 BFF + 已打包的界面。改过界面要先 `cd vue/web && npx vite build`（产物直接落到 `vue/server/web`）。

| 端口 | 用途 |
|---|---|
| `14848` | 后端节点 API，客户端 / Watchdog / BFF 都连它 |
| `14850` | 管理后台（界面与 BFF 同源） |
| `14851` | 仅前端热更新时（`vue/web` 的 vite dev） |

## 配置

配置一律写在源码里，改完**重新编译**才生效：后端和 BFF 不读环境变量、不读外置 json、没有 `.env`，现场只有一份配置来源。

两个例外都只在开发侧，出包后不存在：客户端和 Watchdog 的 **Debug 版**会从程序目录读外置 JSONC（Release 把 JSONC 嵌进 EXE，见下）；冒烟栈 `vue/server/test/dev-stack.mjs` 认 `SMSJ_SMOKE_PORT` 环境变量换端口，不设时按 14850。

| 文件 | 管什么 |
|---|---|
| `Server/src/config.js` | 节点编号、注册密钥、业务库与学籍库连接、后端默认参数、故障类型、表名 |
| `vue/server/src/config.js` | BFF 端口、学籍库连接、会话有效期、参数配置页的"程序兜底值 / 最小值"常量表 |
| `Client/appsettings.jsonc` | 客户端本地兜底：后端地址、锁屏、心跳、超时等；后端正常时由后台下发值覆盖 |
| `WatchdogService/watchdogsettings.jsonc` | Watchdog 本地兜底：后端地址、客户端 EXE 路径、检查间隔、守护开关 |

JSONC 支持 `//`、`/* */` 注释和尾逗号。Debug 版从程序目录读外置 JSONC（客户端还兼容旧 `appsettings.json`），**Release 版把 JSONC 嵌进 EXE**，发布目录不留外置配置——改了本地兜底必须重新编译。

运行期参数（心跳间隔、会话超时、锁屏、报修入口等）存在各节点业务库的 `tp_smsj_server_config` / `tp_smsj_client_config` / `tp_smsj_watchdog_config`，在后台"参数配置"页改，后端按短缓存自动生效，不需要重启。

### 开发库护栏

本机这套代码默认**只允许读写带 `_bfftest` 后缀的开发库**：

- `Server/src/config.js` 的 `mysql.devDatabaseSuffix`（默认 `_bfftest`）：`Server/src/db.js` 在建连接池前校验业务库与学籍库库名，不符直接抛错退出。
- `vue/server/src/config.js` 同名配置：BFF 会写节点登记表和登录计数表，同样在建池前校验。
- `vue/server/scripts/init-dev-dbs.mjs` 与 `vue/server/test/setup.mjs`：**无开关**，只允许 `127.0.0.1 / localhost / ::1` + `_bfftest` 库名，任何一项不符就在建立连接之前抛错。

原因很具体：这些脚本会 `CREATE DATABASE`、建表并 `REPLACE INTO` 种子账号口令，一旦 host 或库名被改成现网值后再跑一次，真实学生和教师的口令就被覆盖成开发口令。

### 给现场出包前必须改的四件事

1. 把两份 `config.js` 的 `mysql.devDatabaseSuffix` 改成 `""`，否则后端和 BFF 启动即拒连；同时改好两边的 `mysql.user` / `mysql.password`。
2. 改掉示例注册密钥 `LocalDemoNodeKey2026`（`Server/src/config.js` 的 `nodeRegistrationKey`，6–128 位字母数字）和示例节点编号 `node01`，并与 `tp_smsj_nodes` 里登记的编号、密钥一致——不一致时 BFF 会以"节点编号与后台登记不一致"拒管。
3. 改业务库与学籍库的地址、库名、账号口令；学籍库账号建议只授予 `tp_student`、`tp_teacher` 读取权限，BFF 那个账号需要 `tp_smsj_nodes` 读写、`tp_admin` 读取、`tp_login_attempts` 读写。
4. 示例发行版默认只连接本机 `127.0.0.1`；正式部署前必须按现场网络、数据库和客户端路径重新配置并重新编译。

## 数据库

两个库，可同机可分机：

- **业务库**（每机房一个，默认名 `realnameauth`）：`tp_smsj_classroom` 教室与 IP 段、`tp_smsj_devices` 设备与心跳、`tp_smsj_sessions` 上机会话、`tp_smsj_device_commands` 远程命令队列、`tp_smsj_fault` 报修、`tp_smsj_logs` 系统日志，外加三张运行期参数表。后端启动自建表并做幂等迁移，表名可配。
- **学籍库**（全校共用，默认名 `xueji`）：`tp_student`、`tp_teacher` 由外部学籍系统维护，本系统只读（不创建、不迁移、不改账号、不会插入测试账号）；`tp_admin` 与 `tp_login_attempts` 供管理后台登录复用；`tp_smsj_nodes` 是全系统唯一的节点登记表。

字段语义：`tp_student` 为 `stu_num` 账号/学号、`stu_pass` 32 位小写 MD5、`stu_name` 姓名、`pingbi=1` 禁止登录；`tp_teacher` 可用 `teacher_num`（身份证号）/ `teacher_code`（工号）/ `tel`（手机号）任一登录，同时校验 `teacher_name`、`teacher_pass`、`pingbi`，会话统一以唯一的 `teacher_num` 保存。重复登录按"身份 + 规范账号"判定。

机器属于哪间教室、是教师机还是学生机，由服务端来源 IP 决定：精确命中 `teacher_ip` 为教师机，命中 `ip_start`–`ip_end` 为学生机；只有教师机的教室可以把学生机 IP 段同时留空。该类型只用于设备管理和教室策略，不限制某类账号登录哪台机器。

超时扫描由 `tp_smsj_server_config` 控制：`heartbeat_timeout_seconds` 是 active 会话无有效心跳后被记为超时下机的时间，`offline_scan_seconds` 是扫描频率，`server_recovery_grace_minutes` 是节点重启后的恢复宽限期。教室的开关机策略只有 `allow_student_shutdown` 一项。

## 接口与返回包

**面向客户端**（`Server/`）：`GET /api/health`、`GET /api/client-config`、`POST /api/client-policy`、`POST /api/login`、`POST /api/restore-session`、`POST /api/logout`、`POST /api/teacher-logout`、`POST /api/fault/check-student`、`POST /api/fault`、`POST /api/heartbeat`、`POST /api/command-result`。

**面向管理后台**（`Server/`，不是公共接口）：`GET /api/node/health`（凭注册密钥探测）、`POST /api/node/admin`（动作 + 参数 + 签名）。节点支持的动作：

```text
get_config  save_server_config  save_client_config  save_watchdog_config
classroom_list  classroom_options  classroom_building_options  classroom_get
classroom_save  classroom_toggle  classroom_delete  classroom_shutdown
devices_list  device_command
sessions_list  logs_list  fault_list  log_event_options
program_fallbacks  program_minimums
```

**BFF 对浏览器**统一挂在 `/api/<action>` 下，动作名与节点侧一致，另有 `login`、`logout`、`me`、`node_options`、`node_status`、`node_save`、`node_check`、`node_set_default`、`node_delete`、`stats`。查询类动作（`*_list`、`*_options`、`get_config`、`me`、`stats`）只注册 GET，写操作（`node_save`、`classroom_save`、`device_command`、`save_*_config`、`login`、`logout` 等）只注册 POST，`node_status` 两种都收；参数走 query 还是 JSON 体都行，`readParams` 会把两者合并后再转发。

返回包：`{ "code": 0, "msg": "操作成功", ...平铺的数据, "count": 总数 }`；`code` 非 0 为失败并带对应 HTTP 状态码。列表数据**不包一层 `data`**，直接平铺，`count` 是符合条件的总行数。未登录返回 401，由界面统一跳登录页。

签名：`HMAC-SHA256(key = register_key, message = timestamp + "\n" + 原始 JSON 字节)`，请求头 `x-node-timestamp` + `x-node-signature`。**时间窗只有 ±60 秒，BFF 与所有节点主机必须做 NTP 同步**，否则表现为"所有节点同时不可用"。`register_key` 永不下发到浏览器——这也是必须有 BFF 的原因（后端也不做 CORS 放行）。

## 与遗留后台的行为差异（有意为之，别当 bug 回滚）

| 项 | 遗留做法 | 本实现 | 原因 |
|---|---|---|---|
| 路径前缀 | `/admin.php/SmsjSystem/<action>` | `/api/<action>`，动作名一字未改 | 界面重写，没有复用旧路由的必要 |
| 兜底值/最小值 | 后端拼成中文串，且超时项要加 `clientForm.` / `watchdogForm.` 前缀 | 返回结构化 `{server,client,watchdog}` 原始值，文案与单位由界面拼 | 去掉易错的命名空间约定 |
| 兜底值内容 | 硬编码旧值 | 按客户端 / Watchdog 本地配置现状修正 | 配置页显示过期兜底值会误导运维 |
| 单节点 / 多节点口径 | 两套容错与 `limit` 上限（5000 / 500） | 统一 `limit` 夹到 `[1,500]`；多节点并发扇出 + 容错合并 | 消除两套页面表现不一致 |
| 多节点扇出 | 串行，耗时随节点数线性增长 | 并发扇出，超时见 `vue/server/src/config.js` 的 `node` 段 | 节点变多不拖死页面 |
| 日期筛选 | 只认 `- ` 分隔，波浪号与 `start_date`/`end_date` 静默失效 | 三种写法统一折成节点认识的 `date` | 修掉静默失效 |
| 删除不存在节点 | 也返回成功 | 先查存在性，返回"节点不存在" | 避免假成功 |
| 教室 `id=0` | 被夹成 `id=1`，静默改到无关记录 | 直接返回"教室ID无效" | 同上 |
| 在线状态筛选 | 同时下发 `overview_status` 与派生的 `status`/`online` | 界面只发 `overview_status` | 去掉重复条件互相打架 |
| 节点状态回写 | 每次探测顶高 `updated_at`，改变默认节点排序 | 回写显式 `updated_at = updated_at` 抑制 `ON UPDATE` | 轮询不该改排序 |
| 旧版单节点兜底探测 | 支持环境变量兜底地址 | 删除该分支 | 不再有隐式配置来源 |
| 权限模型 | 登录即全权 | 不变，另提供 `GET /api/me` | 复用 `tp_admin`，不新建管理员体系 |
| 操作人 | 空则回落 `PHP后台` | 传真实登录名，空则回落 `Vue后台`；日志来源新写入为 `Vue后台`，历史仍是 `PHP后台`，按"管理后台"筛选时两者都命中 | 灰度切换不把历史日志筛没 |
| 远程下机/关机 | 15 秒倒计时自动发送 | 普通二次确认弹窗 | 去掉容易误触的自动发送 |
| 登录验证码 | 无 | 仍不做图形验证码，靠 `tp_login_attempts` 三次锁十分钟 | 与遗留后台共享爆破计数，建议只在校园网段开放 14850 |
| 空调任务、扫码登录 | 有 | **整体移除**（单机房定制），不新增任何 DROP | 见"遗留系统兼容说明" |

## 部署

Linux 后端的完整步骤在 `Server/deploy/linux/`（`install.sh` 与 `server-manager.sh`）和 `Server/README.md`；管理后台部署见 `vue/README.md`；Watchdog 安装见下。

- **Windows 后端**：`build/Server/Windows/start-server.bat`。不预检端口，按包内嵌配置的 `server.port` 启动，冲突时提示实际端口；脚本含中文，改动必须保留 `chcp 65001`、UTF-8 与 CRLF。
- **Linux 后端**：上传 `build/Server/linux` 后在包目录 `sudo bash install.sh`（默认装到 `/opt/realname-simple-server`），之后 `sudo realname-server` 管理：安装、升级、启停、重启、状态、日志、开关自启、卸载。升级**不要直接覆盖正在运行的 `/opt` 目录**，把新包解压到新目录再跑它的 `install.sh`；脚本会按时间戳备份旧程序（`/var/backups/realname-simple-server/<日期时间>/`）、停服、替换、恢复原运行状态，失败自动回滚。安装与升级都不删业务库或业务记录。
- **管理后台**：`build/vue/Windows/start-admin.bat`，建议与某台后端同机部署以省一次内网往返。
- **客户端**：分发 `build/ClientLite/RealName.SimpleClient.exe`，目标机需要 WebView2 运行时。
- **Watchdog**：服务名 `RealNameSimpleWatchdog`，运行 `build/Watchdog/install-service.bat` 后 EXE 固定安装到 `C:\Program Files\RealNameSimple\Watchdog\RealName.SimpleWatchdogService.exe`（不可删），日志在 `C:\ProgramData\RealNameSimple\Watchdog\watchdog.log`。它必须先拿到完整有效的教室策略且本机教室已启用才拉起客户端；后端不可达或策略字段不完整时不拉起，但**不会结束已在运行的客户端**。

**升级顺序**：先升级各节点，再启用新后台。旧节点没有管理接口时 BFF 会明确报错且不会回退写本地业务库；升级后应验证 `GET /api/node/health` 的 `adminApiVersion` 为 `2`。跨节点移动教室依赖节点的 `classroom_get`，源节点和目标节点都要先升级。BFF 会自动为 `tp_smsj_nodes` 补 `is_default` 字段，未设置时任选一个为默认。

**灰度与下线**：见"遗留系统兼容说明"。

## 打包发布

四个脚本都在源码目录内，双击即可（都接受 `nopause` 参数跳过结束时的回车，便于放进 CI）：

```text
Server/一键编译服务端.bat            → Server/dist + build/Server/Windows + build/Server/linux
vue/一键编译管理后台.bat              → vue/server/web（界面产物）+ vue/server/dist + build/vue/Windows
Client/一键编译客户端.bat             → build/ClientLite
WatchdogService/一键编译守护服务.bat   → build/Watchdog
```

```powershell
dotnet publish .\Client -c Release -r win-x64 --self-contained false -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -p:PublishTrimmed=false -p:DebugType=None -p:DebugSymbols=false -o .\build\ClientLite
dotnet publish .\WatchdogService -c Release -r win-x64 --self-contained false -p:PublishSingleFile=true -p:DebugType=None -p:DebugSymbols=false -o .\build\Watchdog
```

后端发布包把建表和升级逻辑一并编译进 `server.js`，发布目录不需要携带 `Server/database/schema.sql`。管理后台的发布包会删除并重建旧 `web` 目录，避免残留旧 chunk。

## 遗留系统兼容说明

**本节写的都不是当前功能**，只是历史数据和灰度期共存规则。读到"扫码登录""空调联动""PHP 后台"时不要以为系统里还有这些开关。

### 已移除的机房定制

以下两项原本是给某个机房做的定制功能，已从各层剥离：

- **空调联动**：教师下机时按教室策略调用云平台 API 逐台关内机，含后台"空调任务"页。
- **扫码登录**：登录页展示二维码、由校内小程序扫码后代学生登录，含客户端取码与轮询、后端 token 二次确认和 5 个配置项。客户端登录页目前只保留一张**不可点击的版式占位卡**，不取码、不轮询、无对应接口。

两者都**没有对数据库执行任何 DROP**：已部署库里遗留的 `tp_smsj_ac_task` 表、`tp_smsj_classroom.allow_air_conditioner_shutdown` 列、`tp_smsj_client_config` 的 5 个 `qr_*` 列和历史"扫码\*"日志行都会原样保留，只是不再被创建、读取或写入。确认没有现场在用之后可自行清理：

```sql
-- 可选，确认无历史价值后手工执行
DROP TABLE IF EXISTS realnameauth.tp_smsj_ac_task;
ALTER TABLE realnameauth.tp_smsj_classroom DROP COLUMN allow_air_conditioner_shutdown;
ALTER TABLE realnameauth.tp_smsj_client_config
  DROP COLUMN qr_cooldown_seconds, DROP COLUMN qr_api_url, DROP COLUMN qr_login_api_url,
  DROP COLUMN qr_login_poll_seconds, DROP COLUMN qr_auto_refresh_seconds;
```

学籍库里的 `tp_xxzx_kongtiao_config`、`tp_xxzx_kongtiao` 属于原 PHP 侧的空调模块，本项目已不再引用，也不再写入。

### 历史数据的读取口径

- `tp_smsj_logs.log_source` 的历史行仍是 `PHP后台`，新写入为 `Vue后台`；后台按"管理后台"筛选时两者都命中，别把历史值刷成新值。
- `POST /api/teacher-logout` 对不带 `shutdownStudents` 的旧客户端保持旧语义（默认按策略给学生机排队关机），这是兼容而不是缺陷。

### 与遗留 PHP 校区后台共存

新旧后台共用 `tp_smsj_nodes`，只读并行安全，但**同一时间只保留一个写入口**，否则节点登记和配置互相覆盖。验证稳定后删掉遗留 PHP 后台 `Tpl/Index/left.html` 的「实名上机系统」菜单项即可下线旧入口，PHP 代码本身不用改。

## 公开仓库前必查清单

1. 两份 `config.js` 里的 `mysql.user` / `mysql.password` 是本机开发环境的通用默认值（`root` / `root`，只在 `127.0.0.1` 的 `*_bfftest` 库生效），这是有意保留的开发默认，不是泄漏；但**给现场或别人出包前必须换成收件人自己的凭据**，并同步关掉 `devDatabaseSuffix` 护栏。
2. 全文搜真实学校名、内网地址、机房名；示例配置使用 `127.0.0.1`，正式部署前请按现场环境替换。
3. `build/`、`bin/`、`obj/`、`dist/`、`node_modules/`、`vue/server/web/`（vite 界面产物）、`runtime/`（错误日志）都已在 `.gitignore` 中——**别直接压缩整个文件夹外发**。`Client` 与 `WatchdogService` 的 `bin|obj` 里，PDB、`project.assets.json`、`FileListAbsolute.txt` 都带本机绝对路径和 Windows 用户名，提交或外发前删掉这几个目录，`dotnet build` 会重建（改过 `ServerUrl` 之类兜底值后，旧中间产物里还会残留上一版地址）。`Server/dist`、`build/**` 里能搜到的 `192.168.0.0/16` 是依赖内置的 RFC1918 判定常量，不是现场地址。
4. 仓库已附带 MIT `LICENSE`；发布前仍应按项目实际依赖和部署环境完成自己的审核。

## 开发说明

```powershell
dotnet build RealNameSimple.slnx      # 客户端 + Watchdog
cd vue/server && npm test             # BFF 单元与集成测试
cd vue/web && npx vite                # 界面热更新
```

约定：跨页面保留的筛选状态走 `sessionStorage`（切页和刷新保留、关标签页清空），界面偏好走 `localStorage`；列表页表格统一 `class="smsj-table"` 配带下限的 `max-height`；参数配置页每个字段都要有"查看说明"正文，其原始文案来自遗留后台的页面模板，改文案先对原文再同步，别凭印象重写。

## 许可证

本项目采用 [MIT License](LICENSE)。示例配置、演示账号和示例发行包仅用于本机学习与功能验证，正式部署前必须替换为使用者自己的配置和凭据。

## 免责声明

本项目代码均由 AI 辅助开发，未经完整的专业安全审计或在所有目标环境中充分验证。因使用本项目产生的漏洞、安全性问题、数据丢失、服务中断或其他损失，由使用者自行评估并承担责任。本项目仅供学习和交流使用。
