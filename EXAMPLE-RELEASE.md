# 示例发行版说明

本文件属于 RealName Simple 的本机试用示例。它用于学习、联调和功能演示，不是可直接投入生产的配置包。

## 默认地址

| 组件 | 地址 |
|---|---|
| 后端节点 | `http://127.0.0.1:14848` |
| 管理后台 | `http://127.0.0.1:14850` |
| 前端热更新 | `http://127.0.0.1:14851` |

示例数据库为本机 MySQL 的 `realnameauth_bfftest` 和 `xueji_bfftest`。示例账号、密码、节点编号和注册密钥仅用于本机测试，正式部署前必须全部替换。

## 使用顺序

1. 安装 Node.js、MySQL 和 WebView2 Runtime。
2. 在源码目录运行 `node vue/server/scripts/init-dev-dbs.mjs`。
3. 启动后端节点，再启动管理后台。
4. 使用 `demo-admin / DemoAdminPass2026` 登录管理后台。
5. 将客户端和 Watchdog 的地址改为实际节点后再分发到终端。

完整的配置、构建、部署和测试步骤请查看根目录 `README.md`、`Server/README.md`、`Client/README.md` 与 `vue/README.md`。

## 发行版免责声明

该发行版中的地址、账号、密码和密钥均为示例文件内容。使用者必须自行完成凭据更换、网络隔离、数据库备份、权限配置、安全测试和现场验收。
