# 管理后台

`vue` 是 RealName Simple 的独立管理后台，由 Vue 3 界面和 Node.js BFF 两部分组成：

```text
vue/web/     Vue 3 + Element Plus，构建后输出到 vue/server/web
vue/server/  BFF，负责管理员登录、节点登记和签名代理
```

浏览器只连接 BFF，不直接持有节点注册密钥。BFF 将管理操作签名后转发到选定节点，并把多节点查询结果合并给界面。

## 开发环境

- 构建界面：Node.js 20.19+ 或 22.12+
- 运行 BFF：Node.js 18+
- MySQL 5.7+

初始化本机开发库：

```powershell
node vue\server\scripts\init-dev-dbs.mjs
```

脚本创建 `realnameauth_bfftest` 和 `xueji_bfftest`，并登记本机节点 `http://127.0.0.1:14848`。示例管理员为 `demo-admin / DemoAdminPass2026`。

启动三个进程：

```powershell
# 终端一
cd Server
npm install
npm start

# 终端二
cd vue\server
npm install
npm start

# 终端三，可选：界面热更新
cd vue\web
npm install
npm run dev
```

开发地址为 `http://127.0.0.1:14850`，界面热更新地址为 `http://127.0.0.1:14851`。

## 配置

`vue/server/src/config.js` 是 BFF 配置入口，包含端口、账号库、会话有效期、节点请求超时和表名。开发环境的 `_bfftest` 后缀护栏会阻止误连现网数据库；正式部署前请改掉护栏、数据库凭据和会话密钥。

## 测试

```powershell
cd vue\server
npm test
```

测试覆盖参数校验、签名编码、日期处理、登录、节点代理和多节点结果合并。测试只使用本机开发库。

## 构建与部署

```powershell
cd vue\web
npm install
npm run build

cd ..\server
npm install
npm run build
```

运行 `vue/一键编译管理后台.bat` 会生成：

```text
build/vue/Windows/server.js
build/vue/Windows/package.json
build/vue/Windows/web/
build/vue/Windows/start-admin.bat
```

管理后台建议与一台节点部署在同一内网主机。对外开放时应使用 HTTPS 反向代理、限制访问来源，并保证 BFF 与节点主机的时钟同步。

## 界面约定

- 跨页面筛选状态使用 `sessionStorage`，界面偏好使用 `localStorage`。
- 列表页统一使用项目表格样式和滚动高度约定。
- 参数页为每个字段提供说明、程序兜底值和最小值。
- 所有写操作都显示明确的确认或错误提示，避免误操作。
