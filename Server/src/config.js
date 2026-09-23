// 后端配置中心：
// 这是后端唯一配置来源，不再读取 server.config.json 或环境变量。
// runtime.js 会基于这里的值做最小值限制和表名校验。

// 注意：这里的配置也相当于配置文档，新增配置项时要同步写清楚用途。
export const config = {
  server: {
    // 后端监听端口，单位：TCP 端口号；客户端和 Watchdog 的 ServerUrl 要指向这个端口。
    port: 14848,
    // 当前 Node 节点编号；为空时使用 GLOBAL 配置并兼容初始化阶段，正式区域部署必须填写唯一编号，仅允许数字下划线字母。
    // 这里是通用示例值：每个现场要改成自己机房的编号，并与 xueji.tp_smsj_nodes 里登记的编号一致，否则 BFF 会判定"节点编号与后台登记不一致"而拒管。
    nodeCode: "node01",
    // Vue 后台管理 Node 时使用的注册密钥；由字母和数字组成6位起步。上线前改成现场自己的密钥，并同步到节点登记表。
    nodeRegistrationKey: "LocalDemoNodeKey2026",
    // active 会话多久没有心跳后判定为超时下机，单位：秒；建议不能低于 30 秒。
    heartbeatTimeoutSeconds: 30,
    // 相同设备状态多久最多写一次 tp_smsj_devices 表的心跳时间，单位：秒，用来降低心跳写库压力。
    heartbeatWriteIntervalSeconds: 15,
    // 后台扫描超时会话的间隔，单位：秒；越短越及时，但数据库扫描也越频繁。
    offlineScanSeconds: 15,
    // Node 后端刚启动后的恢复宽限时间，单位：分钟；宽限期内不自动结束超时 active 会话，给仍在运行的客户端恢复心跳。
    serverRecoveryGraceMinutes: 5,
    // 单次最多处理多少条超时会话，单位：条，避免一次扫描锁太多记录。
    sessionTimeoutBatchSize: 300,
  },
  mysql: {
    // 开发护栏：非空时要求业务库和学籍库的库名必须以该后缀结尾，用来拦住"把 host 或库名改成现场值之后才想起来这是开发机"这类误操作——本脚本区里的建库、种子账号和 REPLACE INTO 打到现网会直接覆盖真实口令。给现场出包时改成 "" 关闭。
    devDatabaseSuffix: "_bfftest",
    // 业务库 MySQL 地址，单位：IP 或域名；保存实名上机业务表，例如设备、会话、日志、配置。
    // 当前接的是本机开发库；恢复现场部署时改回下面注释里的生产值。
    host: "127.0.0.1",
    //host: "改成现场业务库地址",
    // 业务库 MySQL 服务端口，单位：TCP 端口号。
    port: 3306,
    // 业务数据库名，无单位；开发用 realnameauth_bfftest，现场用 realnameauth。
    database: "realnameauth_bfftest",
    //database: "realnameauth",
    // 兼容旧配置字段：未配置 mysql.student.database 时，学生库数据库名从这里读取。
    studentDatabase: "xueji_bfftest",
    //studentDatabase: "xueji",
    // 业务库 MySQL 登录用户名，无单位。
    user: "root",
    //user: "realnameauth",
    // 业务库 MySQL 登录密码，无单位。
    password: "root",
    //password: "改成现场业务库口令",
    // 业务库连接池最大连接数，单位：个连接。
    connectionLimit: 80,
    // 业务库等待连接的排队上限，单位：个请求；0 表示不限制。
    queueLimit: 0,

    student: {
      // 学籍库 MySQL 地址，单位：IP 或域名；生产环境可与业务库不同。
      host: "127.0.0.1",
      //host: "改成现场学籍库地址",
      // 学籍库 MySQL 服务端口，单位：TCP 端口号。
      port: 3306,
      // 学籍数据库名，无单位；后端只读取其中的 tp_student 和 tp_teacher 表。
      database: "xueji_bfftest",
      //database: "xueji",
      // 学籍库 MySQL 登录用户名，无单位；建议只授予 tp_student、tp_teacher 读取权限。
      user: "root",
      //user: "改成现场学籍库账号",
      // 学籍库 MySQL 登录密码，无单位。
      password: "root",
      //password: "改成现场学籍库口令",
      // 学籍库连接池最大连接数，单位：个连接。
      connectionLimit: 80,
      // 学籍库等待连接的排队上限，单位：个请求；0 表示不限制。
      queueLimit: 0,
    },
  },
  fault: {
    // 客户端故障报修下拉框选项，同时也是后端允许提交的类型白名单。
    types: ["键盘鼠标", "显示器", "主机", "其他"],
    // 同一 IP 在冷却时间内只能提交一次故障报修，单位：分钟，避免学生重复刷提交。
    cooldownMinutes: 20,
  },
  tables: {
    // 数据库表名配置，运行时会校验为安全的 SQL 标识符。
    // 学生账号表：位于学籍库，保存登录账号、姓名、MD5密码和屏蔽状态；后端只读取，不创建、不修改。
    students: "tp_student",
    // 教师账号表：位于学籍库，支持身份证号、工号或手机号登录；后端只读取，不创建、不修改。
    teachers: "tp_teacher",
    // 教室/IP段配置表：位于业务库，用于按客户端IP匹配教室、教师机、启停状态和登录页空闲关机时间。
    classrooms: "tp_smsj_classroom",
    // 客户端设备表：位于业务库，保存每台电脑的machine_id、主机名、IP、MAC、教室、锁定状态、当前用户和最后心跳时间。
    devices: "tp_smsj_devices",
    // 上机会话表：位于业务库，记录学生或教师从登录到正常下机或心跳超时下机的完整会话。
    sessions: "tp_smsj_sessions",
    // 设备命令队列表：位于业务库，Vue 后台写入远程下机/关机指令，Node在客户端心跳时派发。
    deviceCommands: "tp_smsj_device_commands",
    // 系统日志表：位于业务库，记录登录成功、登录失败、异地登录、用户下机、异常下机、故障报修等事件。
    logs: "tp_smsj_logs",
    // 故障报修表：位于业务库，记录客户端提交的故障类型、报修账号、IP、描述和报修时间。
    faults: "tp_smsj_fault",
    // 客户端动态配置表：位于业务库，保存心跳间隔、失败锁定、请求超时、配置刷新、会话恢复和故障报修入口开关。
    clientConfig: "tp_smsj_client_config",
    // Watchdog动态配置表：位于业务库，保存客户端路径、主检查间隔、策略刷新、会话守护和无响应检测等守护参数。
    watchdogConfig: "tp_smsj_watchdog_config",
    // 服务端运行期配置表：位于业务库，保存会话超时、扫描间隔、写库节流和故障冷却等后端运行参数。
    serverConfig: "tp_smsj_server_config",
  },
};
