# 实名上机独立管理后台（vue）

从 PHP 校区后台里拆出来的实名上机管理端，不再需要 PHP 运行时：

```text
vue/server/   Node.js BFF：节点注册表、HMAC 签名转发、多节点合并、登录
vue/web/      Vue 3 + Element Plus 管理界面，构建输出直接落到 server/web
```

接口清单、返回包约定、签名规则，以及实现期相对遗留后台的**有意差异表**都在根 [`../README.md`](../README.md) 的"接口与返回包"和"与遗留后台的行为差异"两节；改这些接口前先去看，别把已经修掉的行为当 bug 回滚。

## 为什么还需要一个服务端

浏览器不能直接连各节点的后端：节点管理接口用注册密钥做 HMAC-SHA256 签名，密钥一旦下发到浏览器就等于把节点管理权限交给任何打开页面的人；后端本身也没有任何 CORS 放行。多节点的扇出、合并、分页和去重同样只能在服务端做。所以 BFF 只承担"签名代理 + 节点注册表 + 登录"，业务数据仍然全部由各节点自己的 `realnameauth` 库提供。

## 数据归属

| 数据 | 位置 | 谁读写 |
|---|---|---|
| 节点登记 `xueji.tp_smsj_nodes` | 学籍库 | 只有 BFF 读写（与 PHP 后台共用同一份，见"灰度"） |
| 管理员 `xueji.tp_admin`、`tp_login_attempts` | 学籍库 | BFF 只读校验 + 更新登录时间，与校区后台共用账号和爆破计数 |
| 教室/设备/会话/日志/故障/配置 | 各节点 `realnameauth` | 一律经 `/api/node/admin` 由节点自己读写 |

BFF 不直连任何业务库，也不持有学籍库以外的凭据。

## 开发

构建界面要 Node.js 20.19+ 或 22.12+（Vite 7 的 `engines` 要求）；BFF 服务本体在 Node.js 18+ 上就能跑，发布包同理。

本项目运行期只连两个本机开发库，不连任何真实库；先建库：

```powershell
node vue\server\scripts\init-dev-dbs.mjs
```

| 库 | 角色 | 谁建表 |
|---|---|---|
| `realnameauth_bfftest` | 业务主库 | 后端 `Server` 启动时自动建表和迁移，脚本只建空库 |
| `xueji_bfftest` | 学籍库角色：`tp_student`、`tp_teacher`、`tp_admin`、`tp_login_attempts`、`tp_smsj_nodes` | 初始化脚本建表并灌开发账号 |

脚本输出的账号只在这两个库里生效：管理后台 `demo-admin / DemoAdminPass2026`，学生 `STUDENT-DEMO-001 / demo-student-password`，教师 `TEACHER-DEMO / demo-teacher-password`。同时会往 `tp_smsj_nodes` 登记本机后端（`node01` → `http://127.0.0.1:14848`，注册密钥 `LocalDemoNodeKey2026`，与 `Server/src/config.js` 的通用示例值一致），让 BFF 能直接管到本地后端。

```powershell
# 终端 1：后端业务服务，负责建业务表
cd Server
npm install
npm run start              # 监听 14848

# 终端 2：BFF
cd vue\server
npm install
npm run start              # 监听 14850，同时托管打包后的界面

# 终端 3：界面热更新（可选，改前端时才需要）
cd vue\web
npm install
npm run dev                # 监听 14851，/api 代理到 14850
```

`src/config.js` 是 BFF 运行期唯一配置来源，不读环境变量也不读外置 json；`Server/src/config.js` 同理（那边还把现场生产库的地址、账号、口令留成了注释行，切现场部署时取消注释即可，BFF 这份要自己填）。唯一的例外是开发用的冒烟栈 `test/dev-stack.mjs`，它认 `SMSJ_SMOKE_PORT` 环境变量换端口，不设时按 14850——服务本体不读任何环境变量。

## 测试

```powershell
cd vue\server
npm test
```

31 项，覆盖两类：

- 纯逻辑：响应外壳、东八区时间归一、签名编码、参数校验与日期归一。
- 集成：开发库 `xueji_bfftest` + 两个 mock 节点 + 真实 BFF，跑完整的 HTTP 请求。mock 节点里的签名校验是 `Server/src/routes.js` 的同一套算法，因此这一步同时验证了与真实后端的鉴权互操作性。

集成测试不删库也不动表结构，`tp_student`、`tp_teacher` 不受影响；但**用例需要确定的节点集合，所以测试启动时会清空 `tp_smsj_nodes` 整表**，收尾只删自己插入的 `TESTA`/`TESTB`/`BROKEN`。也就是说跑完 `npm test` 后本机开发节点登记会被清掉，重跑一次 `node vue\server\scripts\init-dev-dbs.mjs` 即可恢复。

本机没有真后端时，可以起一套可视化冒烟栈（mock 节点 + 打包后的界面）：

```powershell
node vue\server\test\dev-stack.mjs    # http://127.0.0.1:14850，账号 demo-admin / DemoAdminPass2026
```

仅用于开发验收，不是启动方式。

## 打包与部署

```text
vue/一键编译管理后台.bat
```

依次构建界面（输出到 `vue/server/web`）和 BFF（ncc 打包），产物同步到 `build/vue/Windows/`：

```text
build/vue/Windows/server.js       BFF 单文件
build/vue/Windows/package.json
build/vue/Windows/web/            界面静态文件
build/vue/Windows/start-admin.bat 现场启动脚本
```

部署位置建议与某台 Node 后端同机，省一次内网往返；`start-admin.bat` 双击即可，端口写死在内嵌配置里。编译脚本会先删除并重建发布包里的 `web` 目录，避免留下旧 chunk。

给现场出包前记得把 `vue/server/src/config.js` 的 `mysql.devDatabaseSuffix` 改成 `""`（本机默认 `_bfftest`，非空时库名不合就拒绝建连接），并把学籍库地址、账号、口令改成现场真值。`build/` 已在 `.gitignore` 里，发布包不入库。

**装机必做：开启 NTP 时间同步。** 节点对签名时间戳只容忍 ±60 秒，BFF 主机时间一漂就会表现为"所有节点同时不可用"。

## 灰度与下线

`tp_smsj_nodes` 是两套后台共享的，只读并行安全；**写入口同一时间只保留一个**，否则节点登记和配置会互相覆盖。验证稳定后，删掉遗留 PHP 后台里 `Tpl/Index/left.html` 的「实名上机系统」菜单项即可下线旧入口，PHP 代码本身不用改。

## 已知取舍

- 登录不做图形验证码，靠 `tp_login_attempts` 的三次锁十分钟兜底；建议只在校园网段开放 14850 端口。
- 沿用 `tp_admin` 的 MD5 口令比对，单方面换哈希会让现网账号全部失效。
- 界面是 Vue 重写，不是把 PHP 模板搬过来：配色和版式按 `smsj-system.css` 移植，但原来 9 个页面各复制一份的导航条已收敛成一个组件。
- 远程下机/关机改为普通二次确认弹窗，去掉了 PHP 版 15 秒倒计时自动发送的行为。
- 系统日志的来源标识：新后台写 `Vue后台`，切换前的历史行仍是 `PHP后台`。节点侧把两者当同一档匹配，界面上也都显示"管理后台"，所以灰度切换不会把旧日志筛没；库里不做任何 UPDATE 回填。

## 界面约定

- 需要跨页面保留的筛选状态（节点、楼栋、教室、页码）一律走 `sessionStorage`：切换页面和刷新都保留，关掉标签页或浏览器才丢；只有侧栏折叠这类界面偏好走 `localStorage`。
- 列表页表格统一 `class="smsj-table"` + 带下限的 `max-height="max(320px, calc(100vh - 296px))"`；少了那个下限，窗口很矮时表格会被压成 0 高。
- 参数配置页每个字段都要有"查看说明"正文与三段式浮层（标题 + 正文 + 程序兜底值/最小值），文案与字段措辞逐字对应遗留后台的页面模板；改文案先对原文再同步，凭印象重写会把它缩回成只剩底栏一行。
- 主机总览的在线台数、一键关机的确认台数都取教室选项接口给的全量值，不用已分页的主机列表行数去算。
