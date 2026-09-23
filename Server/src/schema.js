import { execute, query, studentQuery } from "./db.js";
import { clientDynamicConfigDefaults, faultCooldownMinutes, heartbeatTimeoutSeconds, heartbeatWriteIntervalSeconds, manageLocalStudentTable, offlineScanSeconds, serverRecoveryGraceMinutes, sessionTimeoutBatchSize, studentDatabase, tables, watchdogDynamicConfigDefaults } from "./runtime.js";

const defaultServerConfig = {
  heartbeatTimeoutSeconds,
  heartbeatWriteIntervalSeconds,
  offlineScanSeconds,
  serverRecoveryGraceMinutes,
  sessionTimeoutBatchSize,
  faultCooldownMinutes,
};
const defaultClientConfig = clientDynamicConfigDefaults;
const defaultWatchdogConfig = watchdogDynamicConfigDefaults;
const defaultWatchdogClientPath = watchdogDynamicConfigDefaults.clientPath;
const clientConfigTableComment = "客户端动态配置表，保存心跳、全屏锁屏、心跳失败锁定、请求超时、配置刷新、会话恢复和故障报修入口等运行期参数";
const clientConfigComments = {
  nodeCode: "节点编号，使用GLOBAL作为全局默认配置；其他编号对应具体后端节点",
  heartbeatSeconds: "客户端心跳间隔秒数，控制客户端多久向后端上报一次设备状态、会话状态和教室策略检查",
  fullscreenEnabled: "是否启用客户端未登录锁屏全屏模式：1启用现场锁屏，0使用普通调试窗口；后端服务不可用时客户端使用本地FullScreen兜底值",
  heartbeatFailLockCount: "心跳失败锁定次数，0表示关闭连续失败本地锁定；大于0时，已登录状态下连续失败达到该次数后客户端本地锁回登录页",
  httpTimeoutSeconds: "客户端请求后端接口的超时秒数，超过后本次请求按失败处理；登录会提示无法连接服务器，心跳会计入失败次数，配置拉取会使用默认值",
  configRefreshSeconds: "客户端配置刷新间隔秒数，控制登录页停留或运行过程中多久重新拉取本表配置",
  clientAliveSeconds: "客户端写入client.alive活性文件的间隔秒数，Watchdog通过该文件判断客户端UI是否仍在响应",
  restoreSessionEnabled: "是否允许客户端启动时根据本机session.json自动恢复未超时会话：1允许，0禁止",
  faultEnabled: "是否显示故障报修入口：1显示并允许提交，0隐藏故障报修按钮且不允许提交",
  updatedAt: "最后更新时间，数据库行被修改时自动刷新，便于确认配置最近一次调整时间",
};
const watchdogConfigTableComment = "Watchdog守护服务配置表，保存客户端拉起、策略刷新、会话兜底和无响应检测等运行期参数";
const watchdogConfigComments = {
  nodeCode: "节点编号，使用GLOBAL作为全局默认配置；其他编号对应具体后端节点",
  clientPath: "客户端EXE路径，Watchdog拉起客户端时使用；数据库值为空或格式非法时后端服务下发默认路径，后端服务不可用时Watchdog使用本地配置兜底",
  checkSeconds: "Watchdog主检查间隔秒数，控制多久执行一次守护检查，包括检测客户端进程是否存在、是否需要拉起或按策略退出",
  policySeconds: "教室策略和配置刷新间隔秒数，控制多久请求后端/api/client-policy重新获取教室启停策略和本表配置",
  sessionSeconds: "本机会话失效检查间隔秒数，客户端运行且存在session.json时，控制多久通过后端心跳确认会话是否被接管、超时或停用",
  aliveStaleSeconds: "客户端无响应判定秒数，client.alive超过该时间未更新或客户端启动后长期未生成时，Watchdog会结束客户端并重新拉起；填0表示关闭无响应检测",
  httpTimeoutSeconds: "Watchdog请求后端接口的超时秒数，影响/api/client-policy和/api/heartbeat，超时后本轮使用默认或上次有效策略",
  retryLogSeconds: "重复失败日志冷却秒数，相同错误在该时间内只写一次watchdog.log；填0表示关闭按时间冷却，同一类错误在本次Watchdog进程生命周期内只写一次",
  sessionGuard: "是否启用会话守护，1启用时Watchdog会兜底检查session.json对应会话是否已失效并结束旧客户端，0关闭",
  aliveGuard: "是否启用客户端无响应检测，1启用时Watchdog会根据client.alive判断客户端卡死并重启，0关闭",
  updatedAt: "最后更新时间，数据库行被修改时自动刷新，便于确认配置最近一次调整时间",
};
const serverConfigTableComment = "服务端运行期配置表，保存会话超时、扫描间隔、心跳写库节流、恢复宽限、批量处理和故障报修冷却等参数";
const serverConfigComments = {
  nodeCode: "节点编号，使用GLOBAL作为全局默认配置；其他编号对应具体后端节点",
  heartbeatTimeoutSeconds: "上机会话心跳超时秒数，超过该时间未收到有效心跳后自动结束active会话",
  heartbeatWriteIntervalSeconds: "同一设备状态不变时最多多久写一次设备心跳，单位秒；不能大于心跳超时减扫描间隔",
  offlineScanSeconds: "后端扫描超时会话的间隔秒数，控制多久批量处理一次心跳超时会话",
  serverRecoveryGraceMinutes: "后端服务启动后的恢复宽限分钟数，宽限期内不自动结束心跳超时的active会话，0表示关闭",
  sessionTimeoutBatchSize: "单次扫描最多处理多少条超时会话，避免一次锁定过多记录",
  faultCooldownMinutes: "同一IP两次故障报修之间的冷却分钟数",
  updatedAt: "最后更新时间，数据库行被修改时自动刷新，便于确认配置最近一次调整时间",
};

// 数据库结构初始化和兼容迁移都放在这里，启动时执行一次即可。
// 这里保留旧字段/旧表迁移，方便现场从早期版本平滑升级。
export async function ensureSchema() {
  await migrateLegacyTables();

  if (manageLocalStudentTable) {
    await ensureLocalStudentTable();
  } else {
    await verifyExternalStudentTable();
  }
  await verifyExternalTeacherTable();

  // 教室/IP段表：按客户端IP判断所属教室、教师机和实名上机启停策略。
  await execute(
    `CREATE TABLE IF NOT EXISTS ${tables.classrooms} (
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
      INDEX idx_tp_smsj_classroom_enabled (enabled)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='教室/IP段配置表，用于按IP自动划分教室'`,
  );
  await migrateClassroomColumns();
  await dropIndex(tables.classrooms, "idx_areas_ip_range");
  await dropIndex(tables.classrooms, "idx_areas_teacher_ip");
  await dropColumn(tables.classrooms, "ip_start_num");
  await dropColumn(tables.classrooms, "ip_end_num");
  await dropColumn(tables.classrooms, "teacher_ip_num");
  await dropColumn(tables.classrooms, "created_at");
  await dropColumn(tables.classrooms, "updated_at");

  // 设备状态表：记录每台客户端电脑的心跳、锁定状态、当前用户和当前会话。
  await execute(
    `CREATE TABLE IF NOT EXISTS ${tables.devices} (
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
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='客户端设备表，保存每台电脑的在线状态、教室归属和当前会话'`,
  );
  await migrateDeviceColumns();

  // 上机会话表：记录学生或教师从登录到下机/超时的完整使用过程。
  await execute(
    `CREATE TABLE IF NOT EXISTS ${tables.sessions} (
      id CHAR(32) NOT NULL COMMENT '会话ID，32位随机字符串' PRIMARY KEY,
      machine_id VARCHAR(128) NOT NULL COMMENT '设备机器唯一ID，对应tp_smsj_devices.machine_id',
      node_code VARCHAR(64) NOT NULL DEFAULT 'GLOBAL' COMMENT '创建会话的后端节点编号；历史单节点会话使用GLOBAL',
      user_role VARCHAR(16) NOT NULL DEFAULT 'student' COMMENT '登录用户身份：student学生，teacher教师',
      student_no VARCHAR(64) NOT NULL COMMENT '登录账号：学生保存学号，教师统一保存teacher_num',
      name VARCHAR(100) NOT NULL COMMENT '登录用户姓名',
      started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '上机开始时间',
      ended_at DATETIME NULL COMMENT '下机结束时间',
      status VARCHAR(32) NOT NULL DEFAULT 'active' COMMENT '会话状态：active进行中，ended正常结束，timeout心跳超时结束',
      INDEX idx_tp_smsj_sessions_machine (machine_id),
      INDEX idx_tp_smsj_sessions_student (student_no),
      INDEX idx_tp_smsj_sessions_role_account_status (user_role, student_no, status),
      INDEX idx_tp_smsj_sessions_status (status),
      INDEX idx_tp_smsj_sessions_started (started_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='实名上机会话表，记录用户在哪台机器上机和下机时间'`,
  );
  await ensureColumn(tables.sessions, "node_code", `ALTER TABLE ${tables.sessions} ADD COLUMN node_code VARCHAR(64) NOT NULL DEFAULT 'GLOBAL' COMMENT '创建会话的后端节点编号；历史单节点会话使用GLOBAL' AFTER machine_id`);
  await execute(`UPDATE ${tables.sessions} SET node_code = 'GLOBAL' WHERE node_code IS NULL OR node_code = ''`);
  await ensureIndex(tables.sessions, "idx_tp_smsj_sessions_node", `ALTER TABLE ${tables.sessions} ADD INDEX idx_tp_smsj_sessions_node (node_code)`);
  await ensureColumn(tables.sessions, "user_role", `ALTER TABLE ${tables.sessions} ADD COLUMN user_role VARCHAR(16) NOT NULL DEFAULT 'student' COMMENT '登录用户身份：student学生，teacher教师' AFTER machine_id`);
  await execute(`ALTER TABLE ${tables.sessions} MODIFY COLUMN user_role VARCHAR(16) NOT NULL DEFAULT 'student' COMMENT '登录用户身份：student学生，teacher教师' AFTER machine_id`);
  await execute(`ALTER TABLE ${tables.sessions} MODIFY COLUMN student_no VARCHAR(64) NOT NULL COMMENT '登录账号：学生保存学号，教师统一保存teacher_num' AFTER user_role`);
  await ensureIndex(tables.sessions, "idx_tp_smsj_sessions_role_account_status", `ALTER TABLE ${tables.sessions} ADD INDEX idx_tp_smsj_sessions_role_account_status (user_role, student_no, status)`);
  await dropColumn(tables.sessions, "created_at");
  await dropColumn(tables.sessions, "updated_at");

  // 系统日志表：记录登录、下机、失败等事件，并保留设备和教室上下文。
  await execute(
    `CREATE TABLE IF NOT EXISTS ${tables.logs} (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '日志主键ID' PRIMARY KEY,
      event_name VARCHAR(64) NOT NULL COMMENT '事件名称，使用中文，例如 登录成功、登录失败、用户下机',
      message VARCHAR(500) NOT NULL COMMENT '日志内容',
      operator_name VARCHAR(100) NULL COMMENT '操作人名称，取值为后台登录名',
      log_level VARCHAR(16) NOT NULL DEFAULT 'info' COMMENT '日志级别：info普通，warning警告，error错误',
      log_source VARCHAR(32) NOT NULL DEFAULT 'Node' COMMENT '日志来源：Node、Vue后台、PHP后台（历史值）、客户端、Watchdog等',
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
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='系统日志表，记录登录、下机等事件'`,
  );
  await migrateLogColumns();
  await normalizeLogEventNames();
  await backfillLogDeviceContext();

  // 故障报修表：记录客户端登录页提交的故障类型、报修账号、IP和描述。
  await execute(
    `CREATE TABLE IF NOT EXISTS ${tables.faults} (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '故障报修主键ID' PRIMARY KEY,
      ip VARCHAR(64) NOT NULL DEFAULT '' COMMENT '报修客户端IP地址',
      classroom_name VARCHAR(100) NULL COMMENT '报修时所属教室名称快照',
      \`type\` VARCHAR(64) NOT NULL DEFAULT '' COMMENT '故障类型',
      student_no VARCHAR(64) NOT NULL DEFAULT '' COMMENT '报修账号，学生保存学号，教师保存teacher_num；字段名保留student_no用于兼容旧后台',
      info VARCHAR(1000) NOT NULL DEFAULT '' COMMENT '故障描述',
      createtime DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '报修时间',
      INDEX idx_tp_smsj_fault_ip (ip),
      INDEX idx_tp_smsj_fault_classroom (classroom_name),
      INDEX idx_tp_smsj_fault_type (\`type\`),
      INDEX idx_tp_smsj_fault_student (student_no),
      INDEX idx_tp_smsj_fault_createtime (createtime)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='故障报修表，记录客户端提交的故障信息'`,
  );
  await ensureColumn(tables.faults, "ip", `ALTER TABLE ${tables.faults} ADD COLUMN ip VARCHAR(64) NOT NULL DEFAULT '' COMMENT '报修客户端IP地址' AFTER id`);
  await ensureColumn(tables.faults, "classroom_name", `ALTER TABLE ${tables.faults} ADD COLUMN classroom_name VARCHAR(100) NULL COMMENT '报修时所属教室名称快照' AFTER ip`);
  await ensureColumn(tables.faults, "type", `ALTER TABLE ${tables.faults} ADD COLUMN \`type\` VARCHAR(64) NOT NULL DEFAULT '' COMMENT '故障类型' AFTER classroom_name`);
  await ensureColumn(tables.faults, "student_no", `ALTER TABLE ${tables.faults} ADD COLUMN student_no VARCHAR(64) NOT NULL DEFAULT '' COMMENT '报修账号，学生保存学号，教师保存teacher_num；字段名保留student_no用于兼容旧后台' AFTER \`type\``);
  await execute(`ALTER TABLE ${tables.faults} MODIFY COLUMN student_no VARCHAR(64) NOT NULL DEFAULT '' COMMENT '报修账号，学生保存学号，教师保存teacher_num；字段名保留student_no用于兼容旧后台'`);
  await ensureColumn(tables.faults, "info", `ALTER TABLE ${tables.faults} ADD COLUMN info VARCHAR(1000) NOT NULL DEFAULT '' COMMENT '故障描述' AFTER student_no`);
  await ensureColumn(tables.faults, "createtime", `ALTER TABLE ${tables.faults} ADD COLUMN createtime DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '报修时间' AFTER info`);
  await ensureIndex(tables.faults, "idx_tp_smsj_fault_classroom", `ALTER TABLE ${tables.faults} ADD INDEX idx_tp_smsj_fault_classroom (classroom_name)`);
  await ensureIndex(tables.faults, "idx_tp_smsj_fault_student", `ALTER TABLE ${tables.faults} ADD INDEX idx_tp_smsj_fault_student (student_no)`);
  await dropColumn(tables.faults, "created_at");
  await dropColumn(tables.faults, "updated_at");

  // 设备命令队列：Vue 后台写入远程下机/关机，Node在客户端心跳时派发。
  await ensureDeviceCommandsTable();

  // 配置表：保存服务端、客户端和守护服务可动态调整的参数，按 node_code 区分节点。
  await ensureServerConfigTable();
  await ensureClientConfigTable();
  await ensureWatchdogConfigTable();

  // 清理早期废弃命令表；新的设备命令队列使用 tp_smsj_device_commands。
  await dropTable("commands");
  await dropTable("tp_smsj_commands");
}

// 远程设备命令队列表，用短生命周期 pending 指令配合客户端心跳执行。
async function ensureDeviceCommandsTable() {
  await execute(
    `CREATE TABLE IF NOT EXISTS ${tables.deviceCommands} (
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
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='实名上机设备远程命令队列表'`,
  );

  await ensureColumn(tables.deviceCommands, "command_id", `ALTER TABLE ${tables.deviceCommands} ADD COLUMN command_id CHAR(32) NOT NULL DEFAULT '' COMMENT '命令唯一ID，32位随机字符串' AFTER id`);
  await ensureColumn(tables.deviceCommands, "node_code", `ALTER TABLE ${tables.deviceCommands} ADD COLUMN node_code VARCHAR(64) NOT NULL DEFAULT 'GLOBAL' COMMENT '目标后端节点编号' AFTER command_id`);
  await ensureColumn(tables.deviceCommands, "machine_id", `ALTER TABLE ${tables.deviceCommands} ADD COLUMN machine_id VARCHAR(128) NOT NULL DEFAULT '' COMMENT '目标设备机器唯一ID，对应tp_smsj_devices.machine_id' AFTER node_code`);
  await ensureColumn(tables.deviceCommands, "command_type", `ALTER TABLE ${tables.deviceCommands} ADD COLUMN command_type VARCHAR(32) NOT NULL DEFAULT '' COMMENT '命令类型：force_logout远程下机，shutdown远程关机' AFTER machine_id`);
  await ensureColumn(tables.deviceCommands, "payload", `ALTER TABLE ${tables.deviceCommands} ADD COLUMN payload VARCHAR(1000) NULL COMMENT '命令附加参数，当前保留' AFTER command_type`);
  await ensureColumn(tables.deviceCommands, "status", `ALTER TABLE ${tables.deviceCommands} ADD COLUMN status VARCHAR(32) NOT NULL DEFAULT 'pending' COMMENT '命令状态：pending待派发，delivered已下发，completed已完成，failed失败，expired过期' AFTER payload`);
  await ensureColumn(tables.deviceCommands, "created_by", `ALTER TABLE ${tables.deviceCommands} ADD COLUMN created_by VARCHAR(100) NULL COMMENT '创建人或来源' AFTER status`);
  await ensureColumn(tables.deviceCommands, "created_at", `ALTER TABLE ${tables.deviceCommands} ADD COLUMN created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间' AFTER created_by`);
  await ensureColumn(tables.deviceCommands, "delivered_at", `ALTER TABLE ${tables.deviceCommands} ADD COLUMN delivered_at DATETIME NULL COMMENT '下发给客户端的时间' AFTER created_at`);
  await ensureColumn(tables.deviceCommands, "completed_at", `ALTER TABLE ${tables.deviceCommands} ADD COLUMN completed_at DATETIME NULL COMMENT '客户端回报完成或失败的时间' AFTER delivered_at`);
  await ensureColumn(tables.deviceCommands, "expires_at", `ALTER TABLE ${tables.deviceCommands} ADD COLUMN expires_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '命令过期时间' AFTER completed_at`);
  await ensureColumn(tables.deviceCommands, "result_message", `ALTER TABLE ${tables.deviceCommands} ADD COLUMN result_message VARCHAR(500) NULL COMMENT '客户端执行结果说明' AFTER expires_at`);
  await ensureIndex(tables.deviceCommands, "uk_tp_smsj_device_commands_command", `ALTER TABLE ${tables.deviceCommands} ADD UNIQUE KEY uk_tp_smsj_device_commands_command (command_id)`);
  await ensureIndex(tables.deviceCommands, "idx_tp_smsj_device_commands_target", `ALTER TABLE ${tables.deviceCommands} ADD INDEX idx_tp_smsj_device_commands_target (node_code, machine_id, status, created_at)`);
  await ensureIndex(tables.deviceCommands, "idx_tp_smsj_device_commands_expires", `ALTER TABLE ${tables.deviceCommands} ADD INDEX idx_tp_smsj_device_commands_expires (expires_at)`);
  await ensureIndex(tables.deviceCommands, "idx_tp_smsj_device_commands_type", `ALTER TABLE ${tables.deviceCommands} ADD INDEX idx_tp_smsj_device_commands_type (command_type)`);
}


// 服务端运行期配置表，只保存不涉及端口和数据库连接的安全动态参数。
async function ensureServerConfigTable() {
  await execute(
    `CREATE TABLE IF NOT EXISTS ${tables.serverConfig} (
      node_code VARCHAR(64) NOT NULL COMMENT ${sqlString(serverConfigComments.nodeCode)} PRIMARY KEY,
      heartbeat_timeout_seconds INT UNSIGNED NOT NULL DEFAULT ${defaultServerConfig.heartbeatTimeoutSeconds} COMMENT ${sqlString(serverConfigComments.heartbeatTimeoutSeconds)},
      heartbeat_write_interval_seconds INT UNSIGNED NOT NULL DEFAULT ${defaultServerConfig.heartbeatWriteIntervalSeconds} COMMENT ${sqlString(serverConfigComments.heartbeatWriteIntervalSeconds)},
      offline_scan_seconds INT UNSIGNED NOT NULL DEFAULT ${defaultServerConfig.offlineScanSeconds} COMMENT ${sqlString(serverConfigComments.offlineScanSeconds)},
      server_recovery_grace_minutes INT UNSIGNED NOT NULL DEFAULT ${defaultServerConfig.serverRecoveryGraceMinutes} COMMENT ${sqlString(serverConfigComments.serverRecoveryGraceMinutes)},
      session_timeout_batch_size INT UNSIGNED NOT NULL DEFAULT ${defaultServerConfig.sessionTimeoutBatchSize} COMMENT ${sqlString(serverConfigComments.sessionTimeoutBatchSize)},
      fault_cooldown_minutes INT UNSIGNED NOT NULL DEFAULT ${defaultServerConfig.faultCooldownMinutes} COMMENT ${sqlString(serverConfigComments.faultCooldownMinutes)},
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT ${sqlString(serverConfigComments.updatedAt)}
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT=${sqlString(serverConfigTableComment)}`,
  );

  await migrateConfigTable(tables.serverConfig, serverConfigComments.nodeCode);
  await ensureColumn(tables.serverConfig, "heartbeat_timeout_seconds", `ALTER TABLE ${tables.serverConfig} ADD COLUMN heartbeat_timeout_seconds INT UNSIGNED NOT NULL DEFAULT ${defaultServerConfig.heartbeatTimeoutSeconds} COMMENT ${sqlString(serverConfigComments.heartbeatTimeoutSeconds)} AFTER node_code`);
  await ensureColumn(tables.serverConfig, "heartbeat_write_interval_seconds", `ALTER TABLE ${tables.serverConfig} ADD COLUMN heartbeat_write_interval_seconds INT UNSIGNED NOT NULL DEFAULT ${defaultServerConfig.heartbeatWriteIntervalSeconds} COMMENT ${sqlString(serverConfigComments.heartbeatWriteIntervalSeconds)} AFTER heartbeat_timeout_seconds`);
  await ensureColumn(tables.serverConfig, "offline_scan_seconds", `ALTER TABLE ${tables.serverConfig} ADD COLUMN offline_scan_seconds INT UNSIGNED NOT NULL DEFAULT ${defaultServerConfig.offlineScanSeconds} COMMENT ${sqlString(serverConfigComments.offlineScanSeconds)} AFTER heartbeat_write_interval_seconds`);
  await ensureColumn(tables.serverConfig, "server_recovery_grace_minutes", `ALTER TABLE ${tables.serverConfig} ADD COLUMN server_recovery_grace_minutes INT UNSIGNED NOT NULL DEFAULT ${defaultServerConfig.serverRecoveryGraceMinutes} COMMENT ${sqlString(serverConfigComments.serverRecoveryGraceMinutes)} AFTER offline_scan_seconds`);
  await ensureColumn(tables.serverConfig, "session_timeout_batch_size", `ALTER TABLE ${tables.serverConfig} ADD COLUMN session_timeout_batch_size INT UNSIGNED NOT NULL DEFAULT ${defaultServerConfig.sessionTimeoutBatchSize} COMMENT ${sqlString(serverConfigComments.sessionTimeoutBatchSize)} AFTER server_recovery_grace_minutes`);
  await ensureColumn(tables.serverConfig, "fault_cooldown_minutes", `ALTER TABLE ${tables.serverConfig} ADD COLUMN fault_cooldown_minutes INT UNSIGNED NOT NULL DEFAULT ${defaultServerConfig.faultCooldownMinutes} COMMENT ${sqlString(serverConfigComments.faultCooldownMinutes)} AFTER session_timeout_batch_size`);
  await ensureColumn(tables.serverConfig, "updated_at", `ALTER TABLE ${tables.serverConfig} ADD COLUMN updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT ${sqlString(serverConfigComments.updatedAt)} AFTER fault_cooldown_minutes`);
  await updateServerConfigComments();

  await execute(
    `INSERT INTO ${tables.serverConfig} (node_code, heartbeat_timeout_seconds, heartbeat_write_interval_seconds, offline_scan_seconds, server_recovery_grace_minutes, session_timeout_batch_size, fault_cooldown_minutes)
     VALUES ('GLOBAL', ${defaultServerConfig.heartbeatTimeoutSeconds}, ${defaultServerConfig.heartbeatWriteIntervalSeconds}, ${defaultServerConfig.offlineScanSeconds}, ${defaultServerConfig.serverRecoveryGraceMinutes}, ${defaultServerConfig.sessionTimeoutBatchSize}, ${defaultServerConfig.faultCooldownMinutes})
     ON DUPLICATE KEY UPDATE node_code = node_code`,
  );
}

// 已有数据库启动升级时，同步刷新服务端配置表和字段注释。
async function updateServerConfigComments() {
  await execute(`ALTER TABLE ${tables.serverConfig} COMMENT = ${sqlString(serverConfigTableComment)}`);
  await execute(`ALTER TABLE ${tables.serverConfig} MODIFY COLUMN node_code VARCHAR(64) NOT NULL COMMENT ${sqlString(serverConfigComments.nodeCode)}`);
  await execute(`ALTER TABLE ${tables.serverConfig} MODIFY COLUMN heartbeat_timeout_seconds INT UNSIGNED NOT NULL DEFAULT ${defaultServerConfig.heartbeatTimeoutSeconds} COMMENT ${sqlString(serverConfigComments.heartbeatTimeoutSeconds)}`);
  await execute(`ALTER TABLE ${tables.serverConfig} MODIFY COLUMN heartbeat_write_interval_seconds INT UNSIGNED NOT NULL DEFAULT ${defaultServerConfig.heartbeatWriteIntervalSeconds} COMMENT ${sqlString(serverConfigComments.heartbeatWriteIntervalSeconds)}`);
  await execute(`ALTER TABLE ${tables.serverConfig} MODIFY COLUMN offline_scan_seconds INT UNSIGNED NOT NULL DEFAULT ${defaultServerConfig.offlineScanSeconds} COMMENT ${sqlString(serverConfigComments.offlineScanSeconds)}`);
  await execute(`ALTER TABLE ${tables.serverConfig} MODIFY COLUMN server_recovery_grace_minutes INT UNSIGNED NOT NULL DEFAULT ${defaultServerConfig.serverRecoveryGraceMinutes} COMMENT ${sqlString(serverConfigComments.serverRecoveryGraceMinutes)}`);
  await execute(`ALTER TABLE ${tables.serverConfig} MODIFY COLUMN session_timeout_batch_size INT UNSIGNED NOT NULL DEFAULT ${defaultServerConfig.sessionTimeoutBatchSize} COMMENT ${sqlString(serverConfigComments.sessionTimeoutBatchSize)}`);
  await execute(`ALTER TABLE ${tables.serverConfig} MODIFY COLUMN fault_cooldown_minutes INT UNSIGNED NOT NULL DEFAULT ${defaultServerConfig.faultCooldownMinutes} COMMENT ${sqlString(serverConfigComments.faultCooldownMinutes)}`);
  await execute(`ALTER TABLE ${tables.serverConfig} MODIFY COLUMN updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT ${sqlString(serverConfigComments.updatedAt)}`);
}

// 学生账号表在业务主库时，后端负责创建和兼容迁移。
async function ensureLocalStudentTable() {
  await execute(
    `CREATE TABLE IF NOT EXISTS ${tables.students} (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '学生主键ID' PRIMARY KEY,
      stu_num VARCHAR(64) NOT NULL COMMENT '学号或登录账号，唯一',
      stu_pass VARCHAR(255) NOT NULL COMMENT '登录密码，32位小写MD5值',
      stu_name VARCHAR(100) NOT NULL COMMENT '学生姓名或显示名称',
      pingbi TINYINT(1) NOT NULL DEFAULT 0 COMMENT '是否屏蔽：1屏蔽禁止登录，0允许登录',
      UNIQUE KEY uk_tp_student_stu_num (stu_num),
      INDEX idx_tp_student_pingbi (pingbi)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='学生账号表，保存实名上机登录账号'`,
  );
  await ensureColumn(tables.students, "stu_num", `ALTER TABLE ${tables.students} ADD COLUMN stu_num VARCHAR(64) NOT NULL DEFAULT '' COMMENT '学号或登录账号，唯一' AFTER id`);
  await ensureColumn(tables.students, "stu_pass", `ALTER TABLE ${tables.students} ADD COLUMN stu_pass VARCHAR(255) NOT NULL DEFAULT '' COMMENT '登录密码，32位小写MD5值' AFTER stu_num`);
  await execute(`ALTER TABLE ${tables.students} MODIFY COLUMN stu_pass VARCHAR(255) NOT NULL COMMENT '登录密码，32位小写MD5值' AFTER stu_num`);
  await ensureColumn(tables.students, "stu_name", `ALTER TABLE ${tables.students} ADD COLUMN stu_name VARCHAR(100) NOT NULL DEFAULT '' COMMENT '学生姓名或显示名称' AFTER stu_pass`);
  await ensureColumn(tables.students, "pingbi", `ALTER TABLE ${tables.students} ADD COLUMN pingbi TINYINT(1) NOT NULL DEFAULT 0 COMMENT '是否屏蔽：1屏蔽禁止登录，0允许登录' AFTER stu_name`);
  await dropColumn(tables.students, "created_at");
  await dropColumn(tables.students, "updated_at");
  await migrateUsersToStudents();
  await hashPlainStudentPasswords();
}

// 学生账号表来自外部学籍库时，后端只校验表和字段，不创建、不迁移、不修改学籍库数据。
async function verifyExternalStudentTable() {
  const studentTableName = `${studentDatabase}.${tables.students}`;
  if (!(await studentTableExists(tables.students))) {
    throw new Error(`学生账号表 ${studentTableName} 不存在，请确认学籍库中已有 ${tables.students}。`);
  }

  const requiredColumns = ["stu_num", "stu_pass", "stu_name", "pingbi"];
  for (const column of requiredColumns) {
    if (!(await studentColumnExists(tables.students, column))) {
      throw new Error(`学生账号表 ${studentTableName} 缺少字段 ${column}。`);
    }
  }
}

// 教师账号表和学生账号表位于同一外部账号库，后端只校验登录所需字段。
async function verifyExternalTeacherTable() {
  const teacherTableName = `${studentDatabase}.${tables.teachers}`;
  if (!(await studentTableExists(tables.teachers))) {
    throw new Error(`教师账号表 ${teacherTableName} 不存在，请确认账号库中已有 ${tables.teachers}。`);
  }

  const requiredColumns = ["teacher_num", "teacher_code", "tel", "teacher_pass", "teacher_name", "pingbi"];
  for (const column of requiredColumns) {
    if (!(await studentColumnExists(tables.teachers, column))) {
      throw new Error(`教师账号表 ${teacherTableName} 缺少字段 ${column}。`);
    }
  }
}

// 客户端运行期配置表，只保存可以安全动态调整的客户端行为参数。
async function ensureClientConfigTable() {
  await execute(
    `CREATE TABLE IF NOT EXISTS ${tables.clientConfig} (
      node_code VARCHAR(64) NOT NULL COMMENT ${sqlString(clientConfigComments.nodeCode)} PRIMARY KEY,
      heartbeat_seconds INT UNSIGNED NOT NULL DEFAULT ${defaultClientConfig.heartbeatSeconds} COMMENT ${sqlString(clientConfigComments.heartbeatSeconds)},
      fullscreen_enabled TINYINT(1) NOT NULL DEFAULT ${defaultClientConfig.fullscreenEnabled ? 1 : 0} COMMENT ${sqlString(clientConfigComments.fullscreenEnabled)},
      heartbeat_fail_lock_count INT UNSIGNED NOT NULL DEFAULT ${defaultClientConfig.heartbeatFailLockCount} COMMENT ${sqlString(clientConfigComments.heartbeatFailLockCount)},
      http_timeout_seconds INT UNSIGNED NOT NULL DEFAULT ${defaultClientConfig.httpTimeoutSeconds} COMMENT ${sqlString(clientConfigComments.httpTimeoutSeconds)},
      config_refresh_seconds INT UNSIGNED NOT NULL DEFAULT ${defaultClientConfig.configRefreshSeconds} COMMENT ${sqlString(clientConfigComments.configRefreshSeconds)},
      client_alive_seconds INT UNSIGNED NOT NULL DEFAULT ${defaultClientConfig.clientAliveSeconds} COMMENT ${sqlString(clientConfigComments.clientAliveSeconds)},
      restore_session_enabled TINYINT(1) NOT NULL DEFAULT ${defaultClientConfig.restoreSessionEnabled ? 1 : 0} COMMENT ${sqlString(clientConfigComments.restoreSessionEnabled)},
      fault_enabled TINYINT(1) NOT NULL DEFAULT ${defaultClientConfig.faultEnabled ? 1 : 0} COMMENT ${sqlString(clientConfigComments.faultEnabled)},
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT ${sqlString(clientConfigComments.updatedAt)}
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT=${sqlString(clientConfigTableComment)}`,
  );

  await migrateConfigTable(tables.clientConfig, clientConfigComments.nodeCode);
  await ensureColumn(tables.clientConfig, "heartbeat_seconds", `ALTER TABLE ${tables.clientConfig} ADD COLUMN heartbeat_seconds INT UNSIGNED NOT NULL DEFAULT ${defaultClientConfig.heartbeatSeconds} COMMENT ${sqlString(clientConfigComments.heartbeatSeconds)} AFTER node_code`);
  await ensureColumn(tables.clientConfig, "fullscreen_enabled", `ALTER TABLE ${tables.clientConfig} ADD COLUMN fullscreen_enabled TINYINT(1) NOT NULL DEFAULT ${defaultClientConfig.fullscreenEnabled ? 1 : 0} COMMENT ${sqlString(clientConfigComments.fullscreenEnabled)} AFTER heartbeat_seconds`);
  await ensureColumn(tables.clientConfig, "heartbeat_fail_lock_count", `ALTER TABLE ${tables.clientConfig} ADD COLUMN heartbeat_fail_lock_count INT UNSIGNED NOT NULL DEFAULT ${defaultClientConfig.heartbeatFailLockCount} COMMENT ${sqlString(clientConfigComments.heartbeatFailLockCount)} AFTER fullscreen_enabled`);
  if (await columnExists(tables.clientConfig, "heartbeat_fail_limit")) {
    await execute(`UPDATE ${tables.clientConfig} SET heartbeat_fail_lock_count = heartbeat_fail_limit WHERE heartbeat_fail_lock_count = 0 AND heartbeat_fail_limit > 0`);
  }
  await dropColumn(tables.clientConfig, "heartbeat_fail_limit");
  await dropColumn(tables.clientConfig, "lock_on_heartbeat_fail");
  await dropColumn(tables.clientConfig, "login_fast_click_ms");
  await dropColumn(tables.clientConfig, "login_cooldown_seconds");
  await ensureColumn(tables.clientConfig, "http_timeout_seconds", `ALTER TABLE ${tables.clientConfig} ADD COLUMN http_timeout_seconds INT UNSIGNED NOT NULL DEFAULT ${defaultClientConfig.httpTimeoutSeconds} COMMENT ${sqlString(clientConfigComments.httpTimeoutSeconds)} AFTER heartbeat_fail_lock_count`);
  await ensureColumn(tables.clientConfig, "config_refresh_seconds", `ALTER TABLE ${tables.clientConfig} ADD COLUMN config_refresh_seconds INT UNSIGNED NOT NULL DEFAULT ${defaultClientConfig.configRefreshSeconds} COMMENT ${sqlString(clientConfigComments.configRefreshSeconds)} AFTER http_timeout_seconds`);
  await ensureColumn(tables.clientConfig, "client_alive_seconds", `ALTER TABLE ${tables.clientConfig} ADD COLUMN client_alive_seconds INT UNSIGNED NOT NULL DEFAULT ${defaultClientConfig.clientAliveSeconds} COMMENT ${sqlString(clientConfigComments.clientAliveSeconds)} AFTER config_refresh_seconds`);
  await ensureColumn(tables.clientConfig, "restore_session_enabled", `ALTER TABLE ${tables.clientConfig} ADD COLUMN restore_session_enabled TINYINT(1) NOT NULL DEFAULT ${defaultClientConfig.restoreSessionEnabled ? 1 : 0} COMMENT ${sqlString(clientConfigComments.restoreSessionEnabled)} AFTER client_alive_seconds`);
  await ensureColumn(tables.clientConfig, "fault_enabled", `ALTER TABLE ${tables.clientConfig} ADD COLUMN fault_enabled TINYINT(1) NOT NULL DEFAULT ${defaultClientConfig.faultEnabled ? 1 : 0} COMMENT ${sqlString(clientConfigComments.faultEnabled)} AFTER restore_session_enabled`);
  await ensureColumn(tables.clientConfig, "updated_at", `ALTER TABLE ${tables.clientConfig} ADD COLUMN updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT ${sqlString(clientConfigComments.updatedAt)} AFTER fault_enabled`);
  await updateClientConfigComments();

  await execute(
    `INSERT INTO ${tables.clientConfig} (node_code, heartbeat_seconds, fullscreen_enabled, heartbeat_fail_lock_count, http_timeout_seconds, config_refresh_seconds, client_alive_seconds, restore_session_enabled, fault_enabled)
     VALUES ('GLOBAL', ${defaultClientConfig.heartbeatSeconds}, ${defaultClientConfig.fullscreenEnabled ? 1 : 0}, ${defaultClientConfig.heartbeatFailLockCount}, ${defaultClientConfig.httpTimeoutSeconds}, ${defaultClientConfig.configRefreshSeconds}, ${defaultClientConfig.clientAliveSeconds}, ${defaultClientConfig.restoreSessionEnabled ? 1 : 0}, ${defaultClientConfig.faultEnabled ? 1 : 0})
     ON DUPLICATE KEY UPDATE node_code = node_code`,
  );
}

// 已有数据库启动升级时，同步刷新客户端配置表和字段注释。
async function updateClientConfigComments() {
  await execute(`ALTER TABLE ${tables.clientConfig} COMMENT = ${sqlString(clientConfigTableComment)}`);
  await execute(`ALTER TABLE ${tables.clientConfig} MODIFY COLUMN node_code VARCHAR(64) NOT NULL COMMENT ${sqlString(clientConfigComments.nodeCode)}`);
  await execute(`ALTER TABLE ${tables.clientConfig} MODIFY COLUMN heartbeat_seconds INT UNSIGNED NOT NULL DEFAULT ${defaultClientConfig.heartbeatSeconds} COMMENT ${sqlString(clientConfigComments.heartbeatSeconds)}`);
  await execute(`ALTER TABLE ${tables.clientConfig} MODIFY COLUMN fullscreen_enabled TINYINT(1) NOT NULL DEFAULT ${defaultClientConfig.fullscreenEnabled ? 1 : 0} COMMENT ${sqlString(clientConfigComments.fullscreenEnabled)}`);
  await execute(`ALTER TABLE ${tables.clientConfig} MODIFY COLUMN heartbeat_fail_lock_count INT UNSIGNED NOT NULL DEFAULT ${defaultClientConfig.heartbeatFailLockCount} COMMENT ${sqlString(clientConfigComments.heartbeatFailLockCount)}`);
  await execute(`ALTER TABLE ${tables.clientConfig} MODIFY COLUMN http_timeout_seconds INT UNSIGNED NOT NULL DEFAULT ${defaultClientConfig.httpTimeoutSeconds} COMMENT ${sqlString(clientConfigComments.httpTimeoutSeconds)}`);
  await execute(`ALTER TABLE ${tables.clientConfig} MODIFY COLUMN config_refresh_seconds INT UNSIGNED NOT NULL DEFAULT ${defaultClientConfig.configRefreshSeconds} COMMENT ${sqlString(clientConfigComments.configRefreshSeconds)}`);
  await execute(`ALTER TABLE ${tables.clientConfig} MODIFY COLUMN client_alive_seconds INT UNSIGNED NOT NULL DEFAULT ${defaultClientConfig.clientAliveSeconds} COMMENT ${sqlString(clientConfigComments.clientAliveSeconds)}`);
  await execute(`ALTER TABLE ${tables.clientConfig} MODIFY COLUMN restore_session_enabled TINYINT(1) NOT NULL DEFAULT ${defaultClientConfig.restoreSessionEnabled ? 1 : 0} COMMENT ${sqlString(clientConfigComments.restoreSessionEnabled)}`);
  await execute(`ALTER TABLE ${tables.clientConfig} MODIFY COLUMN fault_enabled TINYINT(1) NOT NULL DEFAULT ${defaultClientConfig.faultEnabled ? 1 : 0} COMMENT ${sqlString(clientConfigComments.faultEnabled)}`);
  await execute(`ALTER TABLE ${tables.clientConfig} MODIFY COLUMN updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT ${sqlString(clientConfigComments.updatedAt)}`);
}

// Watchdog运行期配置表，字段保持简洁，避免把服务安装路径等部署层信息放进数据库。
async function ensureWatchdogConfigTable() {
  await execute(
    `CREATE TABLE IF NOT EXISTS ${tables.watchdogConfig} (
      node_code VARCHAR(64) NOT NULL COMMENT ${sqlString(watchdogConfigComments.nodeCode)} PRIMARY KEY,
      client_path VARCHAR(500) NOT NULL DEFAULT ${sqlString(defaultWatchdogClientPath)} COMMENT ${sqlString(watchdogConfigComments.clientPath)},
      check_seconds INT UNSIGNED NOT NULL DEFAULT ${defaultWatchdogConfig.checkSeconds} COMMENT ${sqlString(watchdogConfigComments.checkSeconds)},
      policy_seconds INT UNSIGNED NOT NULL DEFAULT ${defaultWatchdogConfig.policySeconds} COMMENT ${sqlString(watchdogConfigComments.policySeconds)},
      session_seconds INT UNSIGNED NOT NULL DEFAULT ${defaultWatchdogConfig.sessionSeconds} COMMENT ${sqlString(watchdogConfigComments.sessionSeconds)},
      alive_stale_seconds INT UNSIGNED NOT NULL DEFAULT ${defaultWatchdogConfig.aliveStaleSeconds} COMMENT ${sqlString(watchdogConfigComments.aliveStaleSeconds)},
      http_timeout_seconds INT UNSIGNED NOT NULL DEFAULT ${defaultWatchdogConfig.httpTimeoutSeconds} COMMENT ${sqlString(watchdogConfigComments.httpTimeoutSeconds)},
      retry_log_seconds INT UNSIGNED NOT NULL DEFAULT ${defaultWatchdogConfig.retryLogSeconds} COMMENT ${sqlString(watchdogConfigComments.retryLogSeconds)},
      session_guard TINYINT(1) NOT NULL DEFAULT ${defaultWatchdogConfig.sessionGuard ? 1 : 0} COMMENT ${sqlString(watchdogConfigComments.sessionGuard)},
      alive_guard TINYINT(1) NOT NULL DEFAULT ${defaultWatchdogConfig.aliveGuard ? 1 : 0} COMMENT ${sqlString(watchdogConfigComments.aliveGuard)},
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT ${sqlString(watchdogConfigComments.updatedAt)}
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT=${sqlString(watchdogConfigTableComment)}`,
  );

  await migrateConfigTable(tables.watchdogConfig, watchdogConfigComments.nodeCode);
  await ensureColumn(tables.watchdogConfig, "client_path", `ALTER TABLE ${tables.watchdogConfig} ADD COLUMN client_path VARCHAR(500) NOT NULL DEFAULT ${sqlString(defaultWatchdogClientPath)} COMMENT ${sqlString(watchdogConfigComments.clientPath)} AFTER node_code`);
  await ensureColumn(tables.watchdogConfig, "check_seconds", `ALTER TABLE ${tables.watchdogConfig} ADD COLUMN check_seconds INT UNSIGNED NOT NULL DEFAULT ${defaultWatchdogConfig.checkSeconds} COMMENT ${sqlString(watchdogConfigComments.checkSeconds)} AFTER client_path`);
  await ensureColumn(tables.watchdogConfig, "policy_seconds", `ALTER TABLE ${tables.watchdogConfig} ADD COLUMN policy_seconds INT UNSIGNED NOT NULL DEFAULT ${defaultWatchdogConfig.policySeconds} COMMENT ${sqlString(watchdogConfigComments.policySeconds)} AFTER check_seconds`);
  await ensureColumn(tables.watchdogConfig, "session_seconds", `ALTER TABLE ${tables.watchdogConfig} ADD COLUMN session_seconds INT UNSIGNED NOT NULL DEFAULT ${defaultWatchdogConfig.sessionSeconds} COMMENT ${sqlString(watchdogConfigComments.sessionSeconds)} AFTER policy_seconds`);
  await ensureColumn(tables.watchdogConfig, "alive_stale_seconds", `ALTER TABLE ${tables.watchdogConfig} ADD COLUMN alive_stale_seconds INT UNSIGNED NOT NULL DEFAULT ${defaultWatchdogConfig.aliveStaleSeconds} COMMENT ${sqlString(watchdogConfigComments.aliveStaleSeconds)} AFTER session_seconds`);
  await ensureColumn(tables.watchdogConfig, "http_timeout_seconds", `ALTER TABLE ${tables.watchdogConfig} ADD COLUMN http_timeout_seconds INT UNSIGNED NOT NULL DEFAULT ${defaultWatchdogConfig.httpTimeoutSeconds} COMMENT ${sqlString(watchdogConfigComments.httpTimeoutSeconds)} AFTER alive_stale_seconds`);
  await ensureColumn(tables.watchdogConfig, "retry_log_seconds", `ALTER TABLE ${tables.watchdogConfig} ADD COLUMN retry_log_seconds INT UNSIGNED NOT NULL DEFAULT ${defaultWatchdogConfig.retryLogSeconds} COMMENT ${sqlString(watchdogConfigComments.retryLogSeconds)} AFTER http_timeout_seconds`);
  await ensureColumn(tables.watchdogConfig, "session_guard", `ALTER TABLE ${tables.watchdogConfig} ADD COLUMN session_guard TINYINT(1) NOT NULL DEFAULT ${defaultWatchdogConfig.sessionGuard ? 1 : 0} COMMENT ${sqlString(watchdogConfigComments.sessionGuard)} AFTER retry_log_seconds`);
  await ensureColumn(tables.watchdogConfig, "alive_guard", `ALTER TABLE ${tables.watchdogConfig} ADD COLUMN alive_guard TINYINT(1) NOT NULL DEFAULT ${defaultWatchdogConfig.aliveGuard ? 1 : 0} COMMENT ${sqlString(watchdogConfigComments.aliveGuard)} AFTER session_guard`);
  await ensureColumn(tables.watchdogConfig, "updated_at", `ALTER TABLE ${tables.watchdogConfig} ADD COLUMN updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT ${sqlString(watchdogConfigComments.updatedAt)} AFTER alive_guard`);
  await updateWatchdogConfigComments();

  await execute(
    `INSERT INTO ${tables.watchdogConfig} (node_code, client_path, check_seconds, policy_seconds, session_seconds, alive_stale_seconds, http_timeout_seconds, retry_log_seconds, session_guard, alive_guard)
     VALUES ('GLOBAL', ?, ${defaultWatchdogConfig.checkSeconds}, ${defaultWatchdogConfig.policySeconds}, ${defaultWatchdogConfig.sessionSeconds}, ${defaultWatchdogConfig.aliveStaleSeconds}, ${defaultWatchdogConfig.httpTimeoutSeconds}, ${defaultWatchdogConfig.retryLogSeconds}, ${defaultWatchdogConfig.sessionGuard ? 1 : 0}, ${defaultWatchdogConfig.aliveGuard ? 1 : 0})
     ON DUPLICATE KEY UPDATE node_code = node_code`,
    [defaultWatchdogClientPath],
  );
}

// 已有数据库启动升级时，同步刷新 Watchdog 配置表和字段注释。
async function updateWatchdogConfigComments() {
  await execute(`ALTER TABLE ${tables.watchdogConfig} COMMENT = ${sqlString(watchdogConfigTableComment)}`);
  await execute(`ALTER TABLE ${tables.watchdogConfig} MODIFY COLUMN node_code VARCHAR(64) NOT NULL COMMENT ${sqlString(watchdogConfigComments.nodeCode)}`);
  await execute(`ALTER TABLE ${tables.watchdogConfig} MODIFY COLUMN client_path VARCHAR(500) NOT NULL DEFAULT ${sqlString(defaultWatchdogClientPath)} COMMENT ${sqlString(watchdogConfigComments.clientPath)}`);
  await execute(`ALTER TABLE ${tables.watchdogConfig} MODIFY COLUMN check_seconds INT UNSIGNED NOT NULL DEFAULT ${defaultWatchdogConfig.checkSeconds} COMMENT ${sqlString(watchdogConfigComments.checkSeconds)}`);
  await execute(`ALTER TABLE ${tables.watchdogConfig} MODIFY COLUMN policy_seconds INT UNSIGNED NOT NULL DEFAULT ${defaultWatchdogConfig.policySeconds} COMMENT ${sqlString(watchdogConfigComments.policySeconds)}`);
  await execute(`ALTER TABLE ${tables.watchdogConfig} MODIFY COLUMN session_seconds INT UNSIGNED NOT NULL DEFAULT ${defaultWatchdogConfig.sessionSeconds} COMMENT ${sqlString(watchdogConfigComments.sessionSeconds)}`);
  await execute(`ALTER TABLE ${tables.watchdogConfig} MODIFY COLUMN alive_stale_seconds INT UNSIGNED NOT NULL DEFAULT ${defaultWatchdogConfig.aliveStaleSeconds} COMMENT ${sqlString(watchdogConfigComments.aliveStaleSeconds)}`);
  await execute(`ALTER TABLE ${tables.watchdogConfig} MODIFY COLUMN http_timeout_seconds INT UNSIGNED NOT NULL DEFAULT ${defaultWatchdogConfig.httpTimeoutSeconds} COMMENT ${sqlString(watchdogConfigComments.httpTimeoutSeconds)}`);
  await execute(`ALTER TABLE ${tables.watchdogConfig} MODIFY COLUMN retry_log_seconds INT UNSIGNED NOT NULL DEFAULT ${defaultWatchdogConfig.retryLogSeconds} COMMENT ${sqlString(watchdogConfigComments.retryLogSeconds)}`);
  await execute(`ALTER TABLE ${tables.watchdogConfig} MODIFY COLUMN session_guard TINYINT(1) NOT NULL DEFAULT ${defaultWatchdogConfig.sessionGuard ? 1 : 0} COMMENT ${sqlString(watchdogConfigComments.sessionGuard)}`);
  await execute(`ALTER TABLE ${tables.watchdogConfig} MODIFY COLUMN alive_guard TINYINT(1) NOT NULL DEFAULT ${defaultWatchdogConfig.aliveGuard ? 1 : 0} COMMENT ${sqlString(watchdogConfigComments.aliveGuard)}`);
  await execute(`ALTER TABLE ${tables.watchdogConfig} MODIFY COLUMN updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT ${sqlString(watchdogConfigComments.updatedAt)}`);
}

// 把旧配置表的 id=1 单行结构转换成 node_code 主键结构，并保留所有已有参数。
async function migrateConfigTable(table, nodeCodeComment) {
  const hasId = await columnExists(table, "id");
  const hasNodeCode = await columnExists(table, "node_code");

  if (!hasNodeCode) {
    const position = hasId ? " AFTER id" : " FIRST";
    await execute(
      `ALTER TABLE ${table} ADD COLUMN node_code VARCHAR(64) NULL COMMENT ${sqlString(nodeCodeComment)}${position}`,
    );
  }

  if (hasId) {
    await execute(
      `UPDATE ${table}
       SET node_code = CASE
         WHEN node_code IS NOT NULL AND node_code <> '' THEN node_code
         WHEN id = 1 THEN 'GLOBAL'
         ELSE CONCAT('LEGACY_', id)
       END
       WHERE node_code IS NULL OR node_code = ''`,
    );
  } else {
    await execute(`UPDATE ${table} SET node_code = 'GLOBAL' WHERE node_code IS NULL OR node_code = ''`);
  }

  if (!(await primaryKeyOn(table, "node_code"))) {
    if (await primaryKeyExists(table)) {
      await execute(`ALTER TABLE ${table} DROP PRIMARY KEY`);
    }
    await execute(`ALTER TABLE ${table} MODIFY COLUMN node_code VARCHAR(64) NOT NULL COMMENT ${sqlString(nodeCodeComment)}`);
    await execute(`ALTER TABLE ${table} ADD PRIMARY KEY (node_code)`);
  }

  if (hasId && (await columnExists(table, "id"))) {
    await execute(`ALTER TABLE ${table} DROP COLUMN id`);
  }
}

// 兼容早期最小版遗留表名，只有新表不存在时才改名。
async function migrateLegacyTables() {
  // 节点登记统一保存在PHP所在的xueji库；业务库中的同名表是旧架构冗余副本。
  await dropTable("tp_smsj_nodes");
  if (manageLocalStudentTable) {
    await renameTableIfNeeded("tp_smsj_student", tables.students);
  }
  await renameTableIfNeeded("areas", tables.classrooms);
  await renameTableIfNeeded("devices", tables.devices);
  await renameTableIfNeeded("sessions", tables.sessions);
  await renameTableIfNeeded("logs", tables.logs);
}

// 设备表字段迁移，重点保留 machine_id 作为客户端稳定唯一标识。
async function migrateDeviceColumns() {
  if ((await columnExists(tables.devices, "hostname")) && !(await columnExists(tables.devices, "machine_name"))) {
    await execute(`ALTER TABLE ${tables.devices} CHANGE COLUMN hostname machine_name VARCHAR(128) NOT NULL COMMENT 'Windows 主机名'`);
  }
  await ensureColumn(tables.devices, "machine_name", `ALTER TABLE ${tables.devices} ADD COLUMN machine_name VARCHAR(128) NOT NULL DEFAULT '' COMMENT 'Windows 主机名' AFTER machine_id`);
  await ensureColumn(tables.devices, "ip_address", `ALTER TABLE ${tables.devices} ADD COLUMN ip_address VARCHAR(64) NULL COMMENT '客户端上报的IPv4地址' AFTER machine_name`);
  await ensureColumn(tables.devices, "mac_address", `ALTER TABLE ${tables.devices} ADD COLUMN mac_address VARCHAR(64) NULL COMMENT '客户端上报的MAC地址' AFTER ip_address`);

  if ((await columnExists(tables.devices, "area_id")) && !(await columnExists(tables.devices, "classroom_id"))) {
    await execute(`ALTER TABLE ${tables.devices} CHANGE COLUMN area_id classroom_id BIGINT UNSIGNED NULL COMMENT '所属教室ID，来源于tp_smsj_classroom表'`);
  }
  if ((await columnExists(tables.devices, "area_name")) && !(await columnExists(tables.devices, "classroom_name"))) {
    await execute(`ALTER TABLE ${tables.devices} CHANGE COLUMN area_name classroom_name VARCHAR(100) NULL COMMENT '所属教室名称，心跳时根据IP段自动匹配'`);
  }

  await ensureColumn(tables.devices, "classroom_id", `ALTER TABLE ${tables.devices} ADD COLUMN classroom_id BIGINT UNSIGNED NULL COMMENT '所属教室ID，来源于tp_smsj_classroom表' AFTER mac_address`);
  await ensureColumn(tables.devices, "classroom_name", `ALTER TABLE ${tables.devices} ADD COLUMN classroom_name VARCHAR(100) NULL COMMENT '所属教室名称，心跳时根据IP段自动匹配' AFTER classroom_id`);
  await ensureColumn(tables.devices, "device_role", `ALTER TABLE ${tables.devices} ADD COLUMN device_role VARCHAR(32) NOT NULL DEFAULT 'student' COMMENT '设备角色：student学生机，teacher教师机，unknown未知' AFTER classroom_name`);
  await ensureColumn(tables.devices, "status", `ALTER TABLE ${tables.devices} ADD COLUMN status VARCHAR(32) NOT NULL DEFAULT 'Locked' COMMENT '设备状态：Locked锁定，Unlocked已解锁等' AFTER device_role`);
  await ensureColumn(tables.devices, "current_user_name", `ALTER TABLE ${tables.devices} ADD COLUMN current_user_name VARCHAR(100) NULL COMMENT '当前登录用户姓名' AFTER status`);
  await ensureColumn(tables.devices, "current_session_id", `ALTER TABLE ${tables.devices} ADD COLUMN current_session_id CHAR(32) NULL COMMENT '当前上机会话ID，对应tp_smsj_sessions.id' AFTER current_user_name`);
  await ensureColumn(tables.devices, "last_seen_at", `ALTER TABLE ${tables.devices} ADD COLUMN last_seen_at DATETIME NULL COMMENT '最后一次心跳时间' AFTER current_session_id`);
  await dropIndex(tables.devices, "idx_tp_smsj_devices_room");
  await dropColumn(tables.devices, "room_code");
  await dropColumn(tables.devices, "created_at");
  await dropColumn(tables.devices, "updated_at");
}

// 教室表字段迁移，enabled 和 out_time 的含义在这里统一兜底。
async function migrateClassroomColumns() {
  if ((await columnExists(tables.classrooms, "area_code")) && !(await columnExists(tables.classrooms, "classroom_code"))) {
    await execute(`ALTER TABLE ${tables.classrooms} CHANGE COLUMN area_code classroom_code VARCHAR(64) NOT NULL COMMENT '教室编码，例如 room-101'`);
  }
  if ((await columnExists(tables.classrooms, "area_name")) && !(await columnExists(tables.classrooms, "classroom_name"))) {
    await execute(`ALTER TABLE ${tables.classrooms} CHANGE COLUMN area_name classroom_name VARCHAR(100) NOT NULL COMMENT '教室名称，例如 XXX教室'`);
  }
  await ensureColumn(tables.classrooms, "classroom_code", `ALTER TABLE ${tables.classrooms} ADD COLUMN classroom_code VARCHAR(64) NOT NULL DEFAULT '' COMMENT '教室编码，例如 room-101' AFTER id`);
  await ensureColumn(tables.classrooms, "classroom_name", `ALTER TABLE ${tables.classrooms} ADD COLUMN classroom_name VARCHAR(100) NOT NULL DEFAULT '' COMMENT '教室名称，例如 XXX教室' AFTER classroom_code`);
  await ensureColumn(tables.classrooms, "building_name", `ALTER TABLE ${tables.classrooms} ADD COLUMN building_name VARCHAR(100) NULL COMMENT '楼栋名称，例如 A楼' AFTER classroom_name`);
  await ensureColumn(tables.classrooms, "node_code", `ALTER TABLE ${tables.classrooms} ADD COLUMN node_code VARCHAR(64) NULL COMMENT '所属后端节点编号；空值表示GLOBAL兼容教室' AFTER building_name`);
  await ensureColumn(tables.classrooms, "ip_start", `ALTER TABLE ${tables.classrooms} ADD COLUMN ip_start VARCHAR(64) NOT NULL DEFAULT '' COMMENT '学生机IP段起始地址' AFTER node_code`);
  await ensureColumn(tables.classrooms, "ip_end", `ALTER TABLE ${tables.classrooms} ADD COLUMN ip_end VARCHAR(64) NOT NULL DEFAULT '' COMMENT '学生机IP段结束地址' AFTER ip_start`);
  await ensureColumn(tables.classrooms, "teacher_ip", `ALTER TABLE ${tables.classrooms} ADD COLUMN teacher_ip VARCHAR(64) NULL COMMENT '教师机单独IP地址，可为空' AFTER ip_end`);
  await ensureColumn(tables.classrooms, "enabled", `ALTER TABLE ${tables.classrooms} ADD COLUMN enabled TINYINT(1) NOT NULL DEFAULT 1 COMMENT '是否启用实名上机系统：1启用，0停用' AFTER teacher_ip`);
  if ((await columnExists(tables.classrooms, "idle_shutdown_minutes")) && !(await columnExists(tables.classrooms, "out_time"))) {
    await execute(`ALTER TABLE ${tables.classrooms} CHANGE COLUMN idle_shutdown_minutes out_time INT UNSIGNED NOT NULL DEFAULT 10 COMMENT '登录界面空闲自动关机分钟数，0表示不自动关机'`);
  }
  await ensureColumn(tables.classrooms, "out_time", `ALTER TABLE ${tables.classrooms} ADD COLUMN out_time INT UNSIGNED NOT NULL DEFAULT 10 COMMENT '登录界面空闲自动关机分钟数，0表示不自动关机' AFTER enabled`);
  await execute(`ALTER TABLE ${tables.classrooms} MODIFY COLUMN out_time INT UNSIGNED NOT NULL DEFAULT 10 COMMENT '登录界面空闲自动关机分钟数，0表示不自动关机' AFTER enabled`);
  await ensureColumn(tables.classrooms, "allow_student_shutdown", `ALTER TABLE ${tables.classrooms} ADD COLUMN allow_student_shutdown TINYINT(1) NOT NULL DEFAULT 0 COMMENT '是否允许教师下机时同时关机本教室学生机：1允许，0禁止' AFTER out_time`);
  await ensureIndex(tables.classrooms, "idx_tp_smsj_classroom_building", `ALTER TABLE ${tables.classrooms} ADD INDEX idx_tp_smsj_classroom_building (building_name)`);
  await ensureIndex(tables.classrooms, "idx_tp_smsj_classroom_node", `ALTER TABLE ${tables.classrooms} ADD INDEX idx_tp_smsj_classroom_node (node_code)`);
  if (await columnExists(tables.classrooms, "idle_shutdown_minutes")) {
    await execute(`UPDATE ${tables.classrooms} SET out_time = idle_shutdown_minutes WHERE out_time = 10 AND idle_shutdown_minutes <> 10`);
  }
  await dropColumn(tables.classrooms, "area_code");
  await dropColumn(tables.classrooms, "area_name");
  await dropColumn(tables.classrooms, "idle_shutdown_minutes");
}

// 日志表早期字段比较少，这里补齐设备上下文，便于后台系统查询。
async function migrateLogColumns() {
  await ensureColumn(tables.logs, "operator_name", `ALTER TABLE ${tables.logs} ADD COLUMN operator_name VARCHAR(100) NULL COMMENT '操作人名称，取值为后台登录名' AFTER message`);
  await ensureColumn(tables.logs, "log_level", `ALTER TABLE ${tables.logs} ADD COLUMN log_level VARCHAR(16) NOT NULL DEFAULT 'info' COMMENT '日志级别：info普通，warning警告，error错误' AFTER operator_name`);
  await ensureColumn(tables.logs, "log_source", `ALTER TABLE ${tables.logs} ADD COLUMN log_source VARCHAR(32) NOT NULL DEFAULT 'Node' COMMENT '日志来源：Node、Vue后台、PHP后台（历史值）、客户端、Watchdog等' AFTER log_level`);
  await ensureColumn(tables.logs, "machine_name", `ALTER TABLE ${tables.logs} ADD COLUMN machine_name VARCHAR(128) NULL COMMENT '关联设备主机名' AFTER machine_id`);
  await ensureColumn(tables.logs, "ip_address", `ALTER TABLE ${tables.logs} ADD COLUMN ip_address VARCHAR(64) NULL COMMENT '关联设备IP地址' AFTER machine_name`);
  await ensureColumn(tables.logs, "mac_address", `ALTER TABLE ${tables.logs} ADD COLUMN mac_address VARCHAR(64) NULL COMMENT '关联设备MAC地址' AFTER ip_address`);
  await ensureColumn(tables.logs, "classroom_name", `ALTER TABLE ${tables.logs} ADD COLUMN classroom_name VARCHAR(100) NULL COMMENT '所属教室名称' AFTER mac_address`);
  await ensureColumn(tables.logs, "log_time", `ALTER TABLE ${tables.logs} ADD COLUMN log_time DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '日志时间' AFTER classroom_name`);

  if (await columnExists(tables.logs, "created_at")) {
    await execute(`UPDATE ${tables.logs} SET log_time = created_at WHERE created_at IS NOT NULL`);
    await dropIndex(tables.logs, "idx_logs_created");
    await dropColumn(tables.logs, "created_at");
  }
  await dropColumn(tables.logs, "updated_at");
  await execute(`UPDATE ${tables.logs} SET log_level = 'info' WHERE log_level IS NULL OR log_level = ''`);
  await execute(`UPDATE ${tables.logs} SET log_source = 'Node' WHERE log_source IS NULL OR log_source = ''`);
  await ensureIndex(tables.logs, "idx_tp_smsj_logs_level", `ALTER TABLE ${tables.logs} ADD INDEX idx_tp_smsj_logs_level (log_level)`);
  await ensureIndex(tables.logs, "idx_tp_smsj_logs_source", `ALTER TABLE ${tables.logs} ADD INDEX idx_tp_smsj_logs_source (log_source)`);
  await ensureIndex(tables.logs, "idx_tp_smsj_logs_operator", `ALTER TABLE ${tables.logs} ADD INDEX idx_tp_smsj_logs_operator (operator_name)`);
}

// 统一旧版本英文事件名到现在使用的中文事件名，保证历史日志查询一致。
async function normalizeLogEventNames() {
  await execute(
    `UPDATE ${tables.logs}
     SET event_name = CASE event_name
       WHEN 'login.ok' THEN '登录成功'
       WHEN 'login.denied' THEN '登录失败'
       WHEN 'logout' THEN '用户下机'
       WHEN 'command.create' THEN '命令创建'
       WHEN 'command.result' THEN '命令结果'
       ELSE event_name
     END`,
  );
}

// 用设备表回填旧日志缺失的机器名、IP、MAC 和教室名称。
async function backfillLogDeviceContext() {
  await execute(
    `UPDATE ${tables.logs} l
     JOIN ${tables.devices} d ON l.machine_id = d.machine_id
     SET
       l.machine_name = COALESCE(l.machine_name, d.machine_name),
       l.ip_address = COALESCE(l.ip_address, d.ip_address),
       l.mac_address = COALESCE(l.mac_address, d.mac_address),
       l.classroom_name = COALESCE(l.classroom_name, d.classroom_name)`,
  );
}

// 兼容旧 users 表，把旧账号数据迁移到当前 tp_student 学生账号表。
async function migrateUsersToStudents() {
  if (!(await tableExists("users"))) return;
  const requiredColumns = ["student_no", "password", "name", "enabled"];
  for (const column of requiredColumns) {
    if (!(await columnExists("users", column))) return;
  }

  await execute(
    `INSERT INTO ${tables.students} (stu_num, stu_pass, stu_name, pingbi)
     SELECT student_no, password, name, CASE WHEN enabled = 1 THEN 0 ELSE 1 END
     FROM users
     WHERE student_no IS NOT NULL AND student_no <> ''
     ON DUPLICATE KEY UPDATE stu_num = VALUES(stu_num)`,
  );
}

// 把历史明文密码升级成 32 位小写 MD5；已经是 MD5 的记录只统一成小写。
async function hashPlainStudentPasswords() {
  await execute(
    `UPDATE ${tables.students}
     SET stu_pass = CASE
       WHEN stu_pass REGEXP '^[0-9a-fA-F]{32}$' THEN LOWER(stu_pass)
       ELSE MD5(stu_pass)
     END
     WHERE stu_pass IS NOT NULL AND stu_pass <> ''`,
  );
}

// 旧表存在且新表不存在时才改名，避免误动已经升级完成的环境。
async function renameTableIfNeeded(oldTable, newTable) {
  if ((await tableExists(oldTable)) && !(await tableExists(newTable))) {
    await execute(`RENAME TABLE ${oldTable} TO ${newTable}`);
  }
}

// 删除已经废弃的旧表；不存在时直接跳过，保证启动迁移可重复执行。
async function dropTable(table) {
  if (await tableExists(table)) {
    await execute(`DROP TABLE ${table}`);
  }
}

// 字段不存在时才执行传入的 ALTER SQL，避免重复启动时报字段已存在。
async function ensureColumn(table, column, sql) {
  if (!(await columnExists(table, column))) await execute(sql);
}

// 查询当前数据库中某张表是否存在，用于迁移前判断旧表/新表状态。
async function tableExists(table) {
  return tableExistsInDatabase(null, table);
}

// 查询指定数据库中某张表是否存在；database 为空时使用当前连接默认库。
async function tableExistsInDatabase(database, table) {
  const [row] = await query(
    `SELECT COUNT(*) AS total FROM information_schema.tables
     WHERE table_schema = COALESCE(?, DATABASE()) AND table_name = ?`,
    [database, table],
  );
  return Number(row.total) > 0;
}

// 查询当前数据库中某个字段是否存在，用于补字段、改字段和删字段前判断。
async function columnExists(table, column) {
  return columnExistsInDatabase(null, table, column);
}

// 查询指定数据库中某个字段是否存在；database 为空时使用当前连接默认库。
async function columnExistsInDatabase(database, table, column) {
  const [row] = await query(
    `SELECT COUNT(*) AS total FROM information_schema.columns
     WHERE table_schema = COALESCE(?, DATABASE()) AND table_name = ? AND column_name = ?`,
    [database, table, column],
  );
  return Number(row.total) > 0;
}

// 查询学籍库连接默认数据库中某张表是否存在；学生库可能在另一台 MySQL，不能走业务库 information_schema。
async function studentTableExists(table) {
  const [row] = await studentQuery(
    `SELECT COUNT(*) AS total FROM information_schema.tables
     WHERE table_schema = DATABASE() AND table_name = ?`,
    [table],
  );
  return Number(row.total) > 0;
}

// 查询学籍库连接默认数据库中某个字段是否存在。
async function studentColumnExists(table, column) {
  const [row] = await studentQuery(
    `SELECT COUNT(*) AS total FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
    [table, column],
  );
  return Number(row.total) > 0;
}

// 字段存在时才删除，兼容不同历史版本留下的旧字段。
async function dropColumn(table, column) {
  if (await columnExists(table, column)) {
    await execute(`ALTER TABLE ${table} DROP COLUMN ${column}`);
  }
}

// 索引存在时才删除，避免旧索引已经清理后再次启动报错。
async function dropIndex(table, index) {
  const [row] = await query(
    `SELECT COUNT(*) AS total FROM information_schema.statistics
     WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?`,
    [table, index],
  );
  if (Number(row.total) > 0) {
    await execute(`ALTER TABLE ${table} DROP INDEX ${index}`);
  }
}

// 索引不存在时才创建，保证数据库初始化和迁移脚本可以重复执行。
async function ensureIndex(table, index, sql) {
  const [row] = await query(
    `SELECT COUNT(*) AS total FROM information_schema.statistics
     WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?`,
    [table, index],
  );
  if (Number(row.total) === 0) {
    await execute(sql);
  }
}

// 查询表是否已有主键，配置表从 id 主键迁移为 node_code 主键时使用。
async function primaryKeyExists(table) {
  const [row] = await query(
    `SELECT COUNT(*) AS total FROM information_schema.statistics
     WHERE table_schema = DATABASE() AND table_name = ? AND index_name = 'PRIMARY'`,
    [table],
  );
  return Number(row.total) > 0;
}

// 判断某张表的主键是否已经是指定字段，避免重复迁移时报错。
async function primaryKeyOn(table, column) {
  const rows = await query(
    `SELECT column_name
     FROM information_schema.statistics
     WHERE table_schema = DATABASE() AND table_name = ? AND index_name = 'PRIMARY'
     ORDER BY seq_in_index ASC`,
    [table],
  );
  return rows.length === 1 && rows[0].column_name === column;
}

// 生成 DDL 里的字符串字面量，只用于固定默认值。
function sqlString(value) {
  return `'${String(value).replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;
}
