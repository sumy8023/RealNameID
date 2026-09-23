# Windows 客户端

`Client` 是面向机房终端的 C# WPF + WebView2 客户端。它提供登录页、锁屏界面、上机状态卡片、报修入口和远程指令执行能力。

## 工作方式

- 客户端把账号、姓名和密码提交给后端节点；机器角色由节点根据来源 IP 判定。
- 登录成功后保存会话并按服务端配置发送心跳。
- 未登录时可按策略启用全屏锁定；后端不可用时使用本地配置兜底。
- 心跳会接收下机和关机命令，执行结果通过 `/api/command-result` 回报。
- Watchdog 重新拉起客户端时，客户端可以从本机 `session.json` 恢复仍有效的会话。

登录页面文件位于：

```text
Client/wwwroot/login.html
Client/wwwroot/login.js
Client/wwwroot/login.css
```

## 本地配置

配置文件为 `Client/appsettings.jsonc`，包含：

- `ServerUrl`：后端节点地址，示例为 `http://127.0.0.1:14848`
- `HeartbeatSeconds`：心跳间隔兜底值
- `HttpTimeoutSeconds`：请求超时兜底值
- `FullScreen`：无法取得服务端策略时的锁屏兜底值
- `RestoreSessionEnabled`：是否允许恢复本机有效会话

Debug 版本从程序目录读取 JSONC；Release 版本将配置嵌入程序。修改兜底配置后需要重新编译。

## 运行期文件

```text
C:\ProgramData\RealNameSimple\machine.id     机器标识
C:\ProgramData\RealNameSimple\session.json   会话恢复缓存
C:\ProgramData\RealNameSimple\client.alive   Watchdog 使用的活性时间戳
C:\ProgramData\RealNameSimple\client.log     客户端日志
C:\ProgramData\RealNameSimple\WebView2\       WebView2 用户数据
```

正常下机、超时或恢复失败后会清理 `session.json`。

## 开发和构建

```powershell
dotnet run --project .\Client
dotnet build .\RealNameSimple.slnx
dotnet publish .\Client -c Release -r win-x64 --self-contained false `
  -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true `
  -p:PublishTrimmed=false -p:DebugType=None -p:DebugSymbols=false `
  -o .\build\ClientLite
```

也可以运行 `一键编译客户端.bat`。目标电脑需要 WebView2 Runtime，运行账号需要具备显示桌面窗口和执行关机命令的权限。
