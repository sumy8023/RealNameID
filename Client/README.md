# Client

C# WPF + WebView2 客户端。

## 身份与账号

- 客户端不提供学生/教师身份选择，Node 后端按连接的来源 IP 判定机器角色。
- 精确命中 `tp_smsj_classroom.teacher_ip` 时为教师机，命中 `ip_start` 到 `ip_end` 时为学生机；只有教师机的教室可不配置学生机 IP 段，未命中时禁止登录。
- 登录页固定三个输入框：**账号 + 姓名 + 密码**。账号任意已启用教室均可填学生学号 `stu_num`，或教师身份证号 `teacher_num`、工号 `teacher_code`、手机号 `tel`；姓名要和账号表里的 `stu_name` / `teacher_name` 一致，只做账号匹配不够。
- 教师登录成功后，后端和客户端会话缓存统一使用唯一的 `teacher_num`，不保存工号或手机号别名。

前端登录页使用 Vue：

```text
Client/wwwroot/login.html
Client/wwwroot/login.js
Client/wwwroot/login.css
```

登录页左侧的"扫码登录"卡片是**遗留定制的版式占位，不是当前功能**：不取二维码、不轮询、不接任何接口，后端也没有对应路由（详见根 README 的"遗留系统兼容说明"）。将来按机房定制开通时才补回交互与接口。

C# 负责：

- 启动 WebView2。
- 接收 Vue 登录页发来的账号、姓名、密码。
- 请求 Node API。
- 按后端 `/api/client-config` 下发的间隔定时心跳，并按下发的全屏开关控制未登录窗口模式；服务端不可用时使用本地配置兜底。
- 登录成功后切换为右下角上机小卡片。
- 系统托盘最小化和退出上机。
- 通过 `/api/client-config` 获取动态故障报修类型、心跳间隔和锁屏全屏开关。
- 通过 `/api/client-policy` 获取当前 IP 所属教室启停、非法 IP 状态和登录页空闲关机分钟数。
- 登录成功后缓存 `session.json`，被 Watchdog 重新拉起时通过 `/api/restore-session` 恢复同一 `machineId` 下仍为 active 且未结束的会话；最后心跳是否超时由后端后台扫描器统一改状态。
- 登录成功切换时先让 WebView 登录页淡出，再隐藏大窗口切到右下角小卡片，避免 WebView2 原生窗口闪黑框。
- 当前 IP 不在 `tp_smsj_classroom.teacher_ip` 或 `ip_start` 到 `ip_end` 范围内时，登录页显示“非法IP，请联系机房管理员”并禁用登录按钮。
- 账户输入框提示“请输入学号、工号、身份证”；教师手机号也可作为账户提交，由后端识别教师账号。

客户端没有数据库配置，只配置本地启动和兜底参数：

```text
Client/appsettings.jsonc
```

`appsettings.jsonc` 支持 `//` 注释、`/* */` 注释和尾逗号；旧 `appsettings.json` 仍兼容读取。`FullScreen` 当前默认 `false`，它只是**无法取得后端配置时的本地安全兜底**：Node 正常时一律以数据库 `tp_smsj_client_config.fullscreen_enabled` 为准，需要现场锁屏就在后台打开那个开关，不要改这里当默认。`ServerUrl` 指向后端节点的 `14848` 端口；仓库里出现的是文档用示例地址，现场按真实地址填。

Debug 版从程序目录读外置 JSONC，**Release 版把它嵌进 EXE**，所以改本地兜底必须重新编译客户端。

心跳间隔最低按 `3` 秒处理，Node 请求超时最低按 `5` 秒处理，动态配置刷新最低按 `3` 秒处理。

## 运行期文件

客户端在本机固定使用一个数据目录，卸载或清理时注意：

```text
C:\ProgramData\RealNameSimple\machine.id     机器唯一标识，随首次运行生成
C:\ProgramData\RealNameSimple\session.json   当前会话缓存，供 Watchdog 拉起后恢复上机
C:\ProgramData\RealNameSimple\client.alive   活性时间戳，Watchdog 据此判断界面是否卡死
C:\ProgramData\RealNameSimple\client.log     客户端运行日志
C:\ProgramData\RealNameSimple\WebView2\       WebView2 用户数据目录
```

正常退出、会话超时或恢复失败都会清理 `session.json`；`RestoreSessionEnabled` 关闭后不再尝试恢复。

运行：

```powershell
dotnet run --project .\Client
```

当前只发布精简版：

```powershell
dotnet publish .\Client -c Release -r win-x64 --self-contained false -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -p:PublishTrimmed=false -p:DebugType=None -p:DebugSymbols=false -o .\build\ClientLite
```
