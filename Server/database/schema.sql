CREATE DATABASE IF NOT EXISTS realnameauth
  DEFAULT CHARACTER SET utf8mb4
  DEFAULT COLLATE utf8mb4_unicode_ci;

USE realnameauth;

-- 学生和教师账号表不在 realnameauth 中创建；后端通过 mysql.student 独立连接只读账号库。
-- 默认账号库为 xueji；tp_student 需要 stu_num、stu_pass、stu_name、pingbi 字段。
-- tp_teacher 需要 teacher_num、teacher_code、tel、teacher_pass、teacher_name、pingbi 字段。

CREATE TABLE IF NOT EXISTS tp_smsj_classroom (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '教室主键ID' PRIMARY KEY,
  classroom_code VARCHAR(64) NOT NULL COMMENT '教室编码，例如 room-101' UNIQUE,
  classroom_name VARCHAR(100) NOT NULL COMMENT '教室名称，例如 XXX教室',
  building_name VARCHAR(100) NULL COMMENT '楼栋名称，例如 A楼',
  node_code VARCHAR(64) NULL COMMENT '所属后端节点编号；空值表示GLOBAL兼容教室',
  ip_start VARCHAR(64) NOT NULL COMMENT '学生机IP段起始地址',
  ip_end VARCHAR(64) NOT NULL COMMENT '学生机IP段结束地址',
  teacher_ip VARCHAR(64) NULL COMMENT '教师机单独IP地址，可为空',
  enabled TINYINT(1) NOT NULL DEFAULT 1 COMMENT '是否启用实名上机系统：1启用，0停用',
  out_time INT UNSIGNED NOT NULL DEFAULT 10 COMMENT '登录界面空闲自动关机分钟数，0表示不自动关机',
  allow_student_shutdown TINYINT(1) NOT NULL DEFAULT 0 COMMENT '是否允许教师下机时同时关机本教室学生机：1允许，0禁止',
  INDEX idx_tp_smsj_classroom_building (building_name),
  INDEX idx_tp_smsj_classroom_node (node_code),
  INDEX idx_tp_smsj_classroom_enabled (enabled)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='教室/IP段配置表，用于按IP自动划分教室';

CREATE TABLE IF NOT EXISTS tp_smsj_devices (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '设备主键ID' PRIMARY KEY,
  machine_id VARCHAR(128) NOT NULL COMMENT '客户端机器唯一ID，优先使用BIOS/系统UUID，无效时使用物理MAC地址' UNIQUE,
  machine_name VARCHAR(128) NOT NULL COMMENT 'Windows 主机名',
  ip_address VARCHAR(64) NULL COMMENT '客户端上报的IPv4地址',
  mac_address VARCHAR(64) NULL COMMENT '客户端上报的MAC地址',
  classroom_id BIGINT UNSIGNED NULL COMMENT '所属教室ID，来源于tp_smsj_classroom表',
  classroom_name VARCHAR(100) NULL COMMENT '所属教室名称，心跳时根据IP段自动匹配',
  device_role VARCHAR(32) NOT NULL DEFAULT 'student' COMMENT '设备角色：student学生机，teacher教师机，unknown未知',
  status VARCHAR(32) NOT NULL DEFAULT 'Locked' COMMENT '设备状态：Locked锁定，Unlocked已解锁等',
  current_user_name VARCHAR(100) NULL COMMENT '当前登录用户姓名',
  current_session_id CHAR(32) NULL COMMENT '当前上机会话ID，对应tp_smsj_sessions.id',
  last_seen_at DATETIME NULL COMMENT '最后一次心跳时间',
  INDEX idx_tp_smsj_devices_classroom (classroom_id),
  INDEX idx_tp_smsj_devices_role (device_role),
  INDEX idx_tp_smsj_devices_status (status),
  INDEX idx_tp_smsj_devices_last_seen (last_seen_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='客户端设备表，保存每台电脑的在线状态、教室归属和当前会话';

CREATE TABLE IF NOT EXISTS tp_smsj_sessions (
  id CHAR(32) NOT NULL COMMENT '会话ID，32位随机字符串' PRIMARY KEY,
  machine_id VARCHAR(128) NOT NULL COMMENT '设备机器唯一ID，对应tp_smsj_devices.machine_id',
  node_code VARCHAR(64) NOT NULL DEFAULT 'GLOBAL' COMMENT '创建会话的后端节点编号；历史单节点会话使用GLOBAL',
  user_role VARCHAR(16) NOT NULL DEFAULT 'student' COMMENT '登录用户身份：student学生，teacher教师',
  student_no VARCHAR(64) NOT NULL COMMENT '登录账号：学生保存学号，教师统一保存teacher_num',
  name VARCHAR(100) NOT NULL COMMENT '登录用户姓名',
  started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '上机开始时间',
  ended_at DATETIME NULL COMMENT '下机结束时间',
  status VARCHAR(32) NOT NULL DEFAULT 'active' COMMENT '会话状态：active进行中，ended正常结束，timeout心跳超时结束',
  INDEX idx_tp_smsj_sessions_node (node_code),
  INDEX idx_tp_smsj_sessions_machine (machine_id),
  INDEX idx_tp_smsj_sessions_student (student_no),
  INDEX idx_tp_smsj_sessions_role_account_status (user_role, student_no, status),
  INDEX idx_tp_smsj_sessions_status (status),
  INDEX idx_tp_smsj_sessions_started (started_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='实名上机会话表，记录用户在哪台机器上机和下机时间';

CREATE TABLE IF NOT EXISTS tp_smsj_device_commands (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '命令主键ID' PRIMARY KEY,
  command_id CHAR(32) NOT NULL COMMENT '命令唯一ID，32位随机字符串',
  node_code VARCHAR(64) NOT NULL DEFAULT 'GLOBAL' COMMENT '目标后端节点编号',
  machine_id VARCHAR(128) NOT NULL COMMENT '目标设备机器唯一ID，对应tp_smsj_devices.machine_id',
  command_type VARCHAR(32) NOT NULL COMMENT '命令类型：force_logout远程下机，shutdown远程关机',
  payload VARCHAR(1000) NULL COMMENT '命令附加参数，当前保留',
  status VARCHAR(32) NOT NULL DEFAULT 'pending' COMMENT '命令状态：pending待派发，delivered已下发，completed已完成，failed失败，expired过期',
  created_by VARCHAR(100) NULL COMMENT '创建人或来源',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  delivered_at DATETIME NULL COMMENT '下发给客户端的时间',
  completed_at DATETIME NULL COMMENT '客户端回报完成或失败的时间',
  expires_at DATETIME NOT NULL COMMENT '命令过期时间',
  result_message VARCHAR(500) NULL COMMENT '客户端执行结果说明',
  UNIQUE KEY uk_tp_smsj_device_commands_command (command_id),
  INDEX idx_tp_smsj_device_commands_target (node_code, machine_id, status, created_at),
  INDEX idx_tp_smsj_device_commands_expires (expires_at),
  INDEX idx_tp_smsj_device_commands_type (command_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='实名上机设备远程命令队列表';

CREATE TABLE IF NOT EXISTS tp_smsj_logs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '日志主键ID' PRIMARY KEY,
  event_name VARCHAR(64) NOT NULL COMMENT '事件名称，使用中文，例如 登录成功、登录失败、用户下机',
  message VARCHAR(500) NOT NULL COMMENT '日志内容',
  operator_name VARCHAR(100) NULL COMMENT '操作人名称，例如PHP后台当前登录账户',
  log_level VARCHAR(16) NOT NULL DEFAULT 'info' COMMENT '日志级别：info普通，warning警告，error错误',
  log_source VARCHAR(32) NOT NULL DEFAULT 'Node' COMMENT '日志来源：Node、PHP后台、客户端、Watchdog等',
  machine_id VARCHAR(128) NULL COMMENT '关联设备机器唯一ID，可为空',
  machine_name VARCHAR(128) NULL COMMENT '关联设备主机名',
  ip_address VARCHAR(64) NULL COMMENT '关联设备IP地址',
  mac_address VARCHAR(64) NULL COMMENT '关联设备MAC地址',
  classroom_name VARCHAR(100) NULL COMMENT '所属教室名称',
  log_time DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '日志时间',
  INDEX idx_tp_smsj_logs_event (event_name),
  INDEX idx_tp_smsj_logs_level (log_level),
  INDEX idx_tp_smsj_logs_source (log_source),
  INDEX idx_tp_smsj_logs_operator (operator_name),
  INDEX idx_tp_smsj_logs_machine (machine_id),
  INDEX idx_tp_smsj_logs_time (log_time)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='系统日志表，记录登录、下机等事件';

CREATE TABLE IF NOT EXISTS tp_smsj_fault (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '故障报修主键ID' PRIMARY KEY,
  ip VARCHAR(64) NOT NULL DEFAULT '' COMMENT '报修客户端IP地址',
  classroom_name VARCHAR(100) NULL COMMENT '报修时所属教室名称快照',
  `type` VARCHAR(64) NOT NULL DEFAULT '' COMMENT '故障类型',
  student_no VARCHAR(64) NOT NULL DEFAULT '' COMMENT '报修账号，学生保存学号，教师保存teacher_num；字段名保留student_no用于兼容旧后台',
  info VARCHAR(1000) NOT NULL DEFAULT '' COMMENT '故障描述',
  createtime DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '报修时间',
  INDEX idx_tp_smsj_fault_ip (ip),
  INDEX idx_tp_smsj_fault_classroom (classroom_name),
  INDEX idx_tp_smsj_fault_type (`type`),
  INDEX idx_tp_smsj_fault_student (student_no),
  INDEX idx_tp_smsj_fault_createtime (createtime)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='故障报修表，记录客户端提交的故障信息';

CREATE TABLE IF NOT EXISTS tp_smsj_server_config (
  node_code VARCHAR(64) NOT NULL COMMENT '节点编号，使用GLOBAL作为全局默认配置；其他编号对应具体后端节点' PRIMARY KEY,
  heartbeat_timeout_seconds INT UNSIGNED NOT NULL DEFAULT 30 COMMENT '上机会话心跳超时秒数，超过该时间未收到有效心跳后自动结束active会话',
  heartbeat_write_interval_seconds INT UNSIGNED NOT NULL DEFAULT 15 COMMENT '同一设备状态不变时最多多久写一次设备心跳，单位秒；不能大于心跳超时减扫描间隔',
  offline_scan_seconds INT UNSIGNED NOT NULL DEFAULT 15 COMMENT '后端扫描超时会话的间隔秒数，控制多久批量处理一次心跳超时会话',
  server_recovery_grace_minutes INT UNSIGNED NOT NULL DEFAULT 5 COMMENT '后端服务启动后的恢复宽限分钟数，宽限期内不自动结束心跳超时的active会话，0表示关闭',
  session_timeout_batch_size INT UNSIGNED NOT NULL DEFAULT 300 COMMENT '单次扫描最多处理多少条超时会话，避免一次锁定过多记录',
  fault_cooldown_minutes INT UNSIGNED NOT NULL DEFAULT 20 COMMENT '同一IP两次故障报修之间的冷却分钟数',
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '最后更新时间，数据库行被修改时自动刷新，便于确认配置最近一次调整时间'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='服务端运行期配置表，保存会话超时、扫描间隔、心跳写库节流、恢复宽限、批量处理和故障报修冷却等参数';

INSERT INTO tp_smsj_server_config (
  node_code,
  heartbeat_timeout_seconds,
  heartbeat_write_interval_seconds,
  offline_scan_seconds,
  server_recovery_grace_minutes,
  session_timeout_batch_size,
  fault_cooldown_minutes
)
VALUES (
  'GLOBAL',
  30,
  15,
  15,
  5,
  300,
  20
)
ON DUPLICATE KEY UPDATE node_code = node_code;

CREATE TABLE IF NOT EXISTS tp_smsj_client_config (
  node_code VARCHAR(64) NOT NULL COMMENT '节点编号，使用GLOBAL作为全局默认配置；其他编号对应具体后端节点' PRIMARY KEY,
  heartbeat_seconds INT UNSIGNED NOT NULL DEFAULT 5 COMMENT '客户端心跳间隔秒数，控制客户端多久向后端上报一次设备状态、会话状态和教室策略检查；最小值3秒',
  fullscreen_enabled TINYINT(1) NOT NULL DEFAULT 0 COMMENT '是否启用客户端未登录锁屏全屏模式：1启用现场锁屏，0使用普通调试窗口；后端服务不可用时客户端使用本地FullScreen兜底值',
  heartbeat_fail_lock_count INT UNSIGNED NOT NULL DEFAULT 0 COMMENT '心跳失败锁定次数，0表示关闭连续失败本地锁定；大于0时，已登录状态下连续失败达到该次数后客户端本地锁回登录页',
  http_timeout_seconds INT UNSIGNED NOT NULL DEFAULT 10 COMMENT '客户端请求后端接口的超时秒数，超过后本次请求按失败处理；最小值5秒',
  config_refresh_seconds INT UNSIGNED NOT NULL DEFAULT 15 COMMENT '客户端配置刷新间隔秒数，控制登录页停留或运行过程中多久重新拉取本表配置；最小值3秒',
  client_alive_seconds INT UNSIGNED NOT NULL DEFAULT 5 COMMENT '客户端写入client.alive活性文件的间隔秒数，Watchdog通过该文件判断客户端UI是否仍在响应',
  restore_session_enabled TINYINT(1) NOT NULL DEFAULT 1 COMMENT '是否允许客户端启动时根据本机session.json自动恢复未超时会话：1允许，0禁止',
  fault_enabled TINYINT(1) NOT NULL DEFAULT 1 COMMENT '是否显示故障报修入口：1显示并允许提交，0隐藏故障报修按钮且不允许提交',
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '最后更新时间，数据库行被修改时自动刷新，便于确认配置最近一次调整时间'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='客户端动态配置表，保存心跳、全屏锁屏、失败锁定、请求超时、配置刷新、会话恢复和故障报修入口等运行期参数';

INSERT INTO tp_smsj_client_config (
  node_code,
  heartbeat_seconds,
  fullscreen_enabled,
  heartbeat_fail_lock_count,
  http_timeout_seconds,
  config_refresh_seconds,
  client_alive_seconds,
  restore_session_enabled,
  fault_enabled
)
VALUES (
  'GLOBAL',
  5,
  0,
  0,
  10,
  15,
  5,
  1,
  1
)
ON DUPLICATE KEY UPDATE
  node_code = node_code;

CREATE TABLE IF NOT EXISTS tp_smsj_watchdog_config (
  node_code VARCHAR(64) NOT NULL COMMENT '节点编号，使用GLOBAL作为全局默认配置；其他编号对应具体后端节点' PRIMARY KEY,
  client_path VARCHAR(500) NOT NULL DEFAULT 'C:\\Program Files\\RealNameSimple\\Client\\RealName.SimpleClient.exe' COMMENT '客户端EXE路径，Watchdog拉起客户端时使用；数据库值为空或格式非法时后端服务下发默认路径，后端服务不可用时Watchdog使用本地配置兜底',
  check_seconds INT UNSIGNED NOT NULL DEFAULT 3 COMMENT 'Watchdog主检查间隔秒数，控制多久执行一次守护检查，包括检测客户端进程是否存在、是否需要拉起或按策略退出',
  policy_seconds INT UNSIGNED NOT NULL DEFAULT 15 COMMENT '教室策略和配置刷新间隔秒数，控制多久请求后端/api/client-policy重新获取教室启停策略和本表配置',
  session_seconds INT UNSIGNED NOT NULL DEFAULT 5 COMMENT '本机会话失效检查间隔秒数，客户端运行且存在session.json时，控制多久通过后端心跳确认会话是否被接管、超时或停用',
  alive_stale_seconds INT UNSIGNED NOT NULL DEFAULT 0 COMMENT '客户端无响应判定秒数，client.alive超过该时间未更新或客户端启动后长期未生成时，Watchdog会结束客户端并重新拉起；0表示关闭无响应检测',
  http_timeout_seconds INT UNSIGNED NOT NULL DEFAULT 5 COMMENT 'Watchdog请求后端接口的超时秒数，影响/api/client-policy和/api/heartbeat，超时后本轮使用默认或上次有效策略',
  retry_log_seconds INT UNSIGNED NOT NULL DEFAULT 30 COMMENT '重复失败日志冷却秒数，相同错误在该时间内只写一次watchdog.log；0表示同一类错误在本次Watchdog进程生命周期内只写一次',
  session_guard TINYINT(1) NOT NULL DEFAULT 1 COMMENT '是否启用会话守护，1启用时Watchdog会兜底检查session.json对应会话是否已失效并结束旧客户端，0关闭',
  alive_guard TINYINT(1) NOT NULL DEFAULT 0 COMMENT '是否启用客户端无响应检测，1启用时Watchdog会根据client.alive判断客户端卡死并重启，0关闭',
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '最后更新时间，数据库行被修改时自动刷新，便于确认配置最近一次调整时间'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Watchdog守护服务配置表，保存客户端拉起、策略刷新、会话兜底和无响应检测等运行期参数';

INSERT INTO tp_smsj_watchdog_config (
  node_code,
  client_path,
  check_seconds,
  policy_seconds,
  session_seconds,
  alive_stale_seconds,
  http_timeout_seconds,
  retry_log_seconds,
  session_guard,
  alive_guard
)
VALUES (
  'GLOBAL',
  'C:\\Program Files\\RealNameSimple\\Client\\RealName.SimpleClient.exe',
  3,
  15,
  5,
  0,
  5,
  30,
  1,
  0
)
ON DUPLICATE KEY UPDATE
  node_code = node_code;
