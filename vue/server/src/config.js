// 实名上机独立管理后台（BFF）唯一配置来源，写法与 Server/src/config.js 保持一致：
// 不读环境变量、不读外置 json，改这里后重新编译即可。

export const config = {
  server: {
    // BFF 监听端口，单位：TCP 端口号。浏览器直接访问这个端口，SPA 与 API 同源。
    port: 14850,
    // SPA 静态目录，相对服务入口解析：开发时是 vue/server/web（vite 直接输出到这里），
    // 发布包里是 server.js 同级的 web 目录。留空则只提供 API，不托管界面。
    webRoot: "web",
  },
  // BFF 只需要一个 MySQL 直连库：学籍库角色的库，放节点登记表、管理员表和登录计数表。
  // 业务数据一律经节点管理接口由节点自取，BFF 不直连业务库。
  // 该账号需要的权限：tp_smsj_nodes 读写、tp_admin 读取、tp_login_attempts 读写。
  // 当前接本机开发库；先执行 vue/server/scripts/init-dev-dbs.mjs 建库建表和开发账号。
  mysql: {
    // 开发护栏：非空时要求这里连的学籍库库名必须以该后缀结尾。BFF 会写 tp_smsj_nodes 和 tp_login_attempts，连到现网库等于改动了真实节点表和登录爆破计数，所以本机代码默认拒连。给现场出包时改成 "" 关闭。
    devDatabaseSuffix: "_bfftest",
    host: "127.0.0.1",
    port: 3306,
    database: "xueji_bfftest",
    user: "root",
    password: "root",
    // 后台并发请求量小，连接数不需要像业务后端那样放大。
    connectionLimit: 10,
  },
  auth: {
    // 会话滑动有效期，单位：秒；与 PHP 后台的 10800 秒保持一致，避免两套后台体验不同。
    ttlSeconds: 10800,
    cookieName: "smsj_admin_token",
    // 同一账号连续失败达到该次数后锁定，单位：次；沿用 PHP 的 tp_login_attempts 计数。
    maxFailedAttempts: 3,
    // 锁定时长，单位：分钟；与 PHP 的 10 分钟一致。
    lockMinutes: 10,
    // 复用 tp_admin 的弱口令拦截：不满足时拒登，提示与 PHP 同文案。
    rejectWeakPassword: true,
  },
  node: {
    // 连接节点的超时，单位：毫秒。节点都在局域网内，正常只需几毫秒。
    connectTimeoutMs: 800,
    // 等响应体的超时，单位：毫秒。多节点扇出已改并发，这里比 PHP 的 2 秒略宽。
    responseTimeoutMs: 3000,
    // 健康探测的总超时，单位：毫秒。
    probeTimeoutMs: 1500,
  },
  merge: {
    // 一次表格里最多同时在多少个节点上取数，单位：个。
    concurrency: 8,
    // 多节点合并分页能翻到的最深行号，单位：行；超出直接报可读错误而不是返回空页。
    scanLimit: 5000,
  },
  tables: {
    // 节点登记表：全系统唯一一份，在学籍库，PHP 后台一直在维护，本次继续共用。
    nodes: "tp_smsj_nodes",
    // 管理员表：复用校区后台账号体系，不新建管理员。
    admins: "tp_admin",
    // 登录失败计数表：与 PHP 登录共用同一份状态，两个后台共享防爆破。
    loginAttempts: "tp_login_attempts",
  },
  // 配置页"程序兜底值 / 最小值"提示的常量来源。
  // 遗留 PHP 后台是靠读磁盘上的客户端源码取这些值的，那个目录在开发机上并不存在，
  // 所以它一直显示的是硬编码旧值。这里以 Client/appsettings.jsonc 与
  // WatchdogService/watchdogsettings.jsonc 的现状为准，改那两个文件时要同步这里。
  // server 组的兜底值由各节点自己通过 get_config 返回，不在此维护。
  // 只返回数值本身，"程序兜底值（客户端）：5 秒"这类文案由界面渲染。
  programFallbacks: {
    client: {
      heartbeat_seconds: 5,
      fullscreen_enabled: 0,
      heartbeat_fail_lock_count: 0,
      http_timeout_seconds: 10,
      config_refresh_seconds: 15,
      client_alive_seconds: 5,
      restore_session_enabled: 1,
      fault_enabled: 1,
    },
    watchdog: {
      client_path: "C:\\Program Files\\RealNameSimple\\Client\\RealName.SimpleClient.exe",
      check_seconds: 2,
      policy_seconds: 15,
      session_seconds: 5,
      alive_stale_seconds: 0,
      http_timeout_seconds: 5,
      retry_log_seconds: 30,
      session_guard: 1,
      alive_guard: 0,
    },
  },
  // 节点会返回自己那一组的最小值；这份兜底只在节点版本过旧、没返回 minimums 时使用。
  programMinimums: {
    server: {
      heartbeat_timeout_seconds: 30,
      heartbeat_write_interval_seconds: 5,
      offline_scan_seconds: 5,
      server_recovery_grace_minutes: 0,
      session_timeout_batch_size: 1,
      fault_cooldown_minutes: 1,
    },
    client: {
      heartbeat_seconds: 3,
      fullscreen_enabled: null,
      heartbeat_fail_lock_count: 0,
      http_timeout_seconds: 5,
      config_refresh_seconds: 3,
      client_alive_seconds: 1,
      restore_session_enabled: null,
      fault_enabled: null,
    },
    watchdog: {
      client_path: null,
      check_seconds: 1,
      policy_seconds: 2,
      session_seconds: 1,
      alive_stale_seconds: 0,
      http_timeout_seconds: 1,
      retry_log_seconds: 0,
      session_guard: null,
      alive_guard: null,
    },
  },
};
