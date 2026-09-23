import {clientDynamicConfigDefaults,faultCooldownMinutes,heartbeatTimeoutSeconds,heartbeatWriteIntervalSeconds,nodeCode,offlineScanSeconds,serverRecoveryGraceMinutes,sessionTimeoutBatchSize,tables,watchdogDynamicConfigDefaults,} from "./runtime.js";
import { execute, query, studentQuery, transaction } from "./db.js";
import {consoleError,consoleInfo,consoleWarn,deviceRoleText,formatDateTime,ipToNumber,normalizeHeartbeatWriteIntervalSeconds,statusText,userRoleText,uuid,writeError,} from "./utils.js";

// 设备心跳日志和写库节流需要跨请求记忆上一次快照，放在业务层集中维护。
const deviceLogSnapshots = new Map();
const deviceHeartbeatWriteSnapshots = new Map();
const invalidIpMessage = "非法IP，请联系机房管理员";
const clientConfigCacheMilliseconds = 10000;
const globalNodeCode = "GLOBAL";
const serverStartedAt = Date.now();
let recoveryGraceLogged = false;
const defaultClientConfig = { ...clientDynamicConfigDefaults };
const defaultWatchdogConfig = { ...watchdogDynamicConfigDefaults };
const defaultServerConfig = {
  heartbeatTimeoutSeconds,
  heartbeatWriteIntervalSeconds,
  offlineScanSeconds,
  serverRecoveryGraceMinutes,
  sessionTimeoutBatchSize,
  faultCooldownMinutes,
};
const programMinimums = {
  server: {
    heartbeatTimeoutSeconds: 30,
    heartbeatWriteIntervalSeconds: 5,
    offlineScanSeconds: 5,
    serverRecoveryGraceMinutes: 0,
    sessionTimeoutBatchSize: 1,
    faultCooldownMinutes: 1,
  },
  client: {
    heartbeatSeconds: 3,
    fullscreenEnabled: null,
    heartbeatFailLockCount: 0,
    httpTimeoutSeconds: 5,
    configRefreshSeconds: 3,
    clientAliveSeconds: 1,
    restoreSessionEnabled: null,
    faultEnabled: null,
  },
  watchdog: {
    clientPath: null,
    checkSeconds: 1,
    policySeconds: 2,
    sessionSeconds: 1,
    aliveStaleSeconds: 0,
    httpTimeoutSeconds: 1,
    retryLogSeconds: 0,
    sessionGuard: null,
    aliveGuard: null,
  },
};

export function getProgramFallbacks() {
  return {
    server: { ...defaultServerConfig },
  };
}

export function getProgramMinimums() {
  return {
    server: { ...programMinimums.server },
    client: { ...programMinimums.client },
    watchdog: { ...programMinimums.watchdog },
  };
}

let cachedClientConfig = null;
let cachedClientConfigAt = 0;
let cachedServerConfig = null;
let cachedServerConfigAt = 0;
let sessionTimeoutScanRunning = false;
let sessionTimeoutScannerStarted = false;

// 查询某个客户端缓存的 active 会话，并返回服务端保存的用户身份。
export async function findActiveSession(sessionId, machineId) {
  if (!sessionId || !machineId) return null;
  const [session] = await query(
    `SELECT id, machine_id, student_no, name, user_role
     FROM ${tables.sessions}
     WHERE id = ? AND machine_id = ? AND node_code = ? AND status = 'active' AND ended_at IS NULL
     LIMIT 1`,
    [sessionId, machineId, nodeCode],
  );
  return session ?? null;
}

// 校验客户端上报的会话仍为本机的 active 会话；教室机器类型不再限制学生或教师身份登录。
export async function validateActiveSessionForDevice(sessionId, machineId) {
  const session = await findActiveSession(sessionId, machineId);
  if (!session) {
    return { active: false, invalidRole: false, session: null };
  }
  if (session.user_role === "student" || session.user_role === "teacher") {
    return { active: true, invalidRole: false, session };
  }

  await transaction(async (conn) => {
    await endSessionAndLockDevice(
      session.id,
      machineId,
      "会话身份无效",
      "账号身份无效，已结束会话",
      conn,
    );
  });
  return { active: false, invalidRole: true, session };
}

// 故障报修兼容旧接口时仍会用到：判断学号是否存在于学生账号表。
export async function studentExists(studentNo) {
  return Boolean(await findStudentByNo(studentNo));
}

// 从学籍库读取学生账号。学籍库可能和业务库不在同一台 MySQL，必须走 studentPool。
export async function findStudentByNo(studentNo) {
  if (!studentNo) return null;
  const [student] = await studentQuery(
    `SELECT
       stu_num AS accountNo,
       stu_num AS studentNo,
       stu_num AS displayNo,
       stu_pass AS password,
       stu_name AS name,
       pingbi
     FROM ${tables.students}
     WHERE stu_num = ?
     LIMIT 1`,
    [studentNo],
  );
  return student ? { ...student, userRole: "student" } : null;
}

// 教师可使用身份证号、工号或手机号登录，成功后统一归一为唯一的 teacher_num。
export async function findTeacherByAccount(accountNo, expectedName = null) {
  const account = String(accountNo ?? "").trim();
  if (!account) return null;
  const name = String(expectedName ?? "").trim();
  const nameFilter = name ? "AND teacher_name = ?" : "";
  const params = [account, account, account];
  if (name) params.push(name);

  const teachers = await studentQuery(
    `SELECT
       teacher_num AS accountNo,
       NULLIF(TRIM(teacher_code), '') AS displayNo,
       teacher_pass AS password,
       teacher_name AS name,
       pingbi
     FROM ${tables.teachers}
     WHERE (
       teacher_num = ?
       OR teacher_code = ?
       OR (tel IS NOT NULL AND TRIM(tel) <> '' AND TRIM(tel) = ?)
     )
     ${nameFilter}
     ORDER BY id ASC
     LIMIT 2`,
    params,
  );

  if (teachers.length === 0) return null;
  if (teachers.length > 1) {
    return { ambiguous: true, userRole: "teacher" };
  }
  return { ...teachers[0], userRole: "teacher" };
}

// 会话中保存的教师规范账号固定是 teacher_num，恢复时不再匹配手机号或工号别名。
async function findTeacherByNo(teacherNum) {
  const account = String(teacherNum ?? "").trim();
  if (!account) return null;
  const [teacher] = await studentQuery(
    `SELECT
       teacher_num AS accountNo,
       NULLIF(TRIM(teacher_code), '') AS displayNo,
       teacher_pass AS password,
       teacher_name AS name,
       pingbi
     FROM ${tables.teachers}
     WHERE teacher_num = ?
     LIMIT 1`,
    [account],
  );
  return teacher ? { ...teacher, userRole: "teacher" } : null;
}

// 登录账号可同时从学生、教师账号表识别；最终由姓名和密码确定唯一用户。
export async function findAccountsByLoginIdentifier(accountNo, expectedName = null) {
  const [student, teacher] = await Promise.all([
    findStudentByNo(accountNo),
    findTeacherByAccount(accountNo, expectedName),
  ]);

  if (teacher?.ambiguous) {
    return { candidates: [], ambiguous: true };
  }

  return {
    candidates: [student, teacher].filter(Boolean),
    ambiguous: false,
  };
}

// 故障报修账号可以是学生学号，也可以是教师身份证号、工号或手机号。
export async function findFaultReporterByAccount(accountNo, expectedName = null) {
  const account = String(accountNo ?? "").trim();
  if (!account) {
    return { ok: false, reason: "empty", account: null };
  }

  const name = String(expectedName ?? "").trim();
  const student = await findStudentByNo(account);
  let teacher = await findTeacherByAccount(account);

  // 手机号等教师标识可能重复；登录页如果带了姓名，就用姓名进一步消歧。
  if (teacher?.ambiguous && name) {
    teacher = await findTeacherByAccount(account, name);
  }

  if (teacher?.ambiguous) {
    return { ok: false, reason: "ambiguous", account: null };
  }

  const candidates = [student, teacher].filter(Boolean);
  if (candidates.length === 0) {
    return { ok: false, reason: "missing", account: null };
  }
  if (candidates.length > 1 && name) {
    const namedCandidates = candidates.filter((item) => item.name === name);
    if (namedCandidates.length === 1) {
      return { ok: true, reason: null, account: namedCandidates[0] };
    }
  }
  if (candidates.length > 1) {
    return { ok: false, reason: "ambiguous", account: null };
  }

  return { ok: true, reason: null, account: candidates[0] };
}

// 会话恢复只接受数据库中已经归一的账号，不再扩展查询教师登录别名。
export async function findAccountByCanonicalNo(accountNo, userRole) {
  if (userRole === "teacher") {
    return findTeacherByNo(accountNo);
  }
  if (userRole === "student") {
    return findStudentByNo(accountNo);
  }
  return null;
}

// 读取 Watchdog 动态配置；数据库异常或配置非法时回退到默认值。
export async function getWatchdogConfig() {
  try {
    const [row] = await query(
      `SELECT
         client_path,
         check_seconds,
         policy_seconds,
         session_seconds,
         alive_stale_seconds,
         http_timeout_seconds,
         retry_log_seconds,
         session_guard,
         alive_guard
       FROM ${tables.watchdogConfig}
       WHERE node_code IN (?, ?)
       ORDER BY CASE WHEN node_code = ? THEN 0 ELSE 1 END
       LIMIT 1`,
      [nodeCode, globalNodeCode, nodeCode],
    );
    return normalizeWatchdogConfig(row);
  } catch (error) {
    consoleWarn("Watchdog配置", `读取失败：${error.message}，使用默认配置`);
    return { ...defaultWatchdogConfig };
  }
}

// 读取服务端动态配置；短缓存后生效，数据库异常时回退到 config.js 默认值。
export async function getServerConfig() {
  const now = Date.now();
  if (cachedServerConfig && now - cachedServerConfigAt < clientConfigCacheMilliseconds) {
    return cachedServerConfig;
  }

  try {
    const [row] = await query(
      `SELECT
         heartbeat_timeout_seconds,
         heartbeat_write_interval_seconds,
         offline_scan_seconds,
         server_recovery_grace_minutes,
         session_timeout_batch_size,
         fault_cooldown_minutes
       FROM ${tables.serverConfig}
       WHERE node_code IN (?, ?)
       ORDER BY CASE WHEN node_code = ? THEN 0 ELSE 1 END
       LIMIT 1`,
      [nodeCode, globalNodeCode, nodeCode],
    );
    cachedServerConfig = normalizeServerConfig(row);
  } catch (error) {
    consoleWarn("服务端配置", `读取失败：${error.message}，使用默认配置`);
    cachedServerConfig = { ...defaultServerConfig };
  }

  cachedServerConfigAt = now;
  return cachedServerConfig;
}

// 统计当前Node负责的设备数量；在线判断沿用服务端心跳超时配置。
export async function getNodeClientMetrics(serverConfig = null) {
  const config = serverConfig ?? await getServerConfig();
  const timeoutSeconds = Math.max(30, Number(config?.heartbeatTimeoutSeconds) || heartbeatTimeoutSeconds);
  const classroomWhere = nodeCode === "GLOBAL" ? "(c.node_code IS NULL OR c.node_code = '')" : "c.node_code = ?";
  const classroomParams = nodeCode === "GLOBAL" ? [] : [nodeCode];
  const [row] = await query(
    `SELECT
       COUNT(DISTINCT c.id) AS classroom_count,
       COUNT(d.machine_id) AS device_count,
       COALESCE(SUM(CASE
         WHEN d.last_seen_at IS NOT NULL
          AND d.last_seen_at >= DATE_SUB(NOW(), INTERVAL ? SECOND)
         THEN 1 ELSE 0 END), 0) AS online_client_count,
       COALESCE(SUM(CASE
         WHEN d.last_seen_at IS NOT NULL
          AND d.last_seen_at >= DATE_SUB(NOW(), INTERVAL ? SECOND)
         AND d.status = 'Unlocked'
         THEN 1 ELSE 0 END), 0) AS unlocked_client_count
     FROM ${tables.classrooms} c
     LEFT JOIN ${tables.devices} d ON d.classroom_id = c.id
     WHERE ${classroomWhere}`,
    [timeoutSeconds, timeoutSeconds, ...classroomParams],
  );

  return {
    classroomCount: Number(row?.classroom_count) || 0,
    deviceCount: Number(row?.device_count) || 0,
    onlineClientCount: Number(row?.online_client_count) || 0,
    unlockedClientCount: Number(row?.unlocked_client_count) || 0,
  };
}

// 读取客户端动态配置；使用短缓存避免每次心跳都查询配置表。
export async function getClientConfig() {
  const now = Date.now();
  if (cachedClientConfig && now - cachedClientConfigAt < clientConfigCacheMilliseconds) {
    return cachedClientConfig;
  }

  try {
    const [row] = await query(
       `SELECT
          heartbeat_seconds,
          fullscreen_enabled,
          heartbeat_fail_lock_count,
          http_timeout_seconds,
          config_refresh_seconds,
          client_alive_seconds,
          restore_session_enabled,
          fault_enabled
       FROM ${tables.clientConfig}
       WHERE node_code IN (?, ?)
       ORDER BY CASE WHEN node_code = ? THEN 0 ELSE 1 END
       LIMIT 1`,
      [nodeCode, globalNodeCode, nodeCode],
    );
    cachedClientConfig = normalizeClientConfig(row);
  } catch (error) {
    consoleWarn("客户端配置", `读取失败：${error.message}，使用默认配置`);
    cachedClientConfig = { ...defaultClientConfig };
  }

  cachedClientConfigAt = now;
  return cachedClientConfig;
}

// 启动后台扫描器，定期把长时间无心跳的 active 会话改成 timeout。
export function startSessionTimeoutScanner() {
  if (sessionTimeoutScannerStarted) return;
  sessionTimeoutScannerStarted = true;

  getServerConfig().then((config) => {
    consoleInfo("会话超时检查", `心跳超时 ${config.heartbeatTimeoutSeconds} 秒，扫描间隔 ${config.offlineScanSeconds} 秒，启动恢复宽限 ${config.serverRecoveryGraceMinutes} 分钟`);
    consoleInfo("设备心跳写库", `相同状态最多每 ${config.heartbeatWriteIntervalSeconds} 秒写入一次，状态变化立即写入`);
  }).catch((error) => {
    consoleWarn("服务端配置", `启动时读取失败：${error.message}，使用默认扫描间隔`);
  });

  const run = async () => {
    let config = defaultServerConfig;
    try {
      config = await getServerConfig();
      await closeTimedOutSessions(config);
    } catch (error) {
      writeError(error);
      consoleError("会话超时检查失败", error);
    } finally {
      const timer = setTimeout(run, config.offlineScanSeconds * 1000);
      timer.unref?.();
    }
  };

  const timer = setTimeout(run, defaultServerConfig.offlineScanSeconds * 1000);
  timer.unref?.();
}

// 会话超时处理要同时更新 sessions、devices 和日志，保持状态一致。
export async function closeTimedOutSessions(config = null) {
  if (sessionTimeoutScanRunning) return;
  sessionTimeoutScanRunning = true;

  try {
    const serverConfig = config ?? await getServerConfig();
    if (isServerRecoveryGraceActive(serverConfig)) {
      if (!recoveryGraceLogged) {
        consoleInfo("会话超时检查", `服务端恢复宽限中，剩余约 ${serverRecoveryGraceRemainingSeconds(serverConfig)} 秒，暂不自动结束超时会话`);
        recoveryGraceLogged = true;
      }
      return;
    }
    const timedOutRows = await transaction(async (conn) => {
      const [candidates] = await conn.execute(
        `SELECT
           s.id,
           s.machine_id,
           s.student_no,
           s.user_role,
           s.name,
           COALESCE(d.last_seen_at, s.started_at) AS timeout_at
         FROM ${tables.sessions} s
         LEFT JOIN ${tables.devices} d ON d.machine_id = s.machine_id
         WHERE s.status = 'active'
           AND s.node_code = ?
           AND s.ended_at IS NULL
           AND COALESCE(d.last_seen_at, s.started_at) < DATE_SUB(NOW(), INTERVAL ? SECOND)
         ORDER BY timeout_at ASC
         LIMIT ${serverConfig.sessionTimeoutBatchSize}`,
        [nodeCode, serverConfig.heartbeatTimeoutSeconds],
      );

      if (candidates.length === 0) {
        return [];
      }

      const ids = candidates.map((row) => row.id);
      const placeholders = ids.map(() => "?").join(",");
      await conn.execute(
        `UPDATE ${tables.sessions} s
         LEFT JOIN ${tables.devices} d ON d.machine_id = s.machine_id
         SET
           s.status = 'timeout',
           s.ended_at = COALESCE(d.last_seen_at, s.started_at)
         WHERE s.id IN (${placeholders})
           AND s.status = 'active'
           AND s.node_code = ?
           AND s.ended_at IS NULL
            AND COALESCE(d.last_seen_at, s.started_at) < DATE_SUB(NOW(), INTERVAL ? SECOND)`,
        [...ids, nodeCode, serverConfig.heartbeatTimeoutSeconds],
      );

      const [rows] = await conn.execute(
        `SELECT
           s.id,
           s.machine_id,
           s.student_no,
           s.user_role,
           s.name,
           s.ended_at,
           d.machine_name,
           d.ip_address,
           d.mac_address,
           d.classroom_name
         FROM ${tables.sessions} s
         LEFT JOIN ${tables.devices} d ON d.machine_id = s.machine_id
         WHERE s.id IN (${placeholders}) AND s.status = 'timeout'`,
        ids,
      );

      await conn.execute(
        `UPDATE ${tables.devices} d
         JOIN ${tables.sessions} s ON s.id = d.current_session_id
         SET
           d.status = 'Locked',
           d.current_user_name = NULL,
           d.current_session_id = NULL
         WHERE s.id IN (${placeholders}) AND s.status = 'timeout'`,
        ids,
      );

      for (const row of rows) {
        await addLog(
          "异常下机",
          `心跳超时自动下机：${userRoleText(row.user_role)}，最后心跳：${formatDateTime(row.ended_at)}`,
          row.machine_id,
          conn,
        );
      }

      return rows;
    });

    if (timedOutRows.length > 0) {
      consoleWarn("异常下机", `已自动结束 ${timedOutRows.length} 个心跳超时会话。`);
    }
  } finally {
    sessionTimeoutScanRunning = false;
  }
}

export function serverRecoveryGraceRemainingSeconds(config = null) {
  const minutes = Number(config?.serverRecoveryGraceMinutes ?? defaultServerConfig.serverRecoveryGraceMinutes);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    return 0;
  }
  const deadline = serverStartedAt + minutes * 60 * 1000;
  return Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
}

export function isServerRecoveryGraceActive(config = null) {
  return serverRecoveryGraceRemainingSeconds(config) > 0;
}

// 所有登录、下机、异常事件统一写入系统日志表，并尽量补齐设备信息。
export async function addLog(eventName, message, machineId = null, conn = null, options = {}) {
  const device = await getDeviceContext(machineId, conn);
  const logLevel = normalizeLogLevel(options.level, inferLogLevel(eventName));
  const logSource = normalizeLogSource(options.source, "Node");
  const operatorName = nullableLogValue(options.operatorName);
  const sql = `INSERT INTO ${tables.logs} (event_name, message, operator_name, log_level, log_source, machine_id, machine_name, ip_address, mac_address, classroom_name, log_time) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`;
  const params = [
    eventName,
    message,
    operatorName,
    logLevel,
    logSource,
    machineId || null,
    device.machineName,
    device.ipAddress,
    device.macAddress,
    device.classroomName,
  ];
  if (conn) {
    await conn.execute(sql, params);
    return;
  }
  await execute(sql, params);
}

// 客户端每次心跳最多领取一条待执行指令，避免一次心跳触发多个危险动作。
export async function takePendingDeviceCommand(machineId) {
  const normalizedMachineId = String(machineId || "").trim();
  if (!normalizedMachineId) {
    return null;
  }

  return transaction(async (conn) => {
    const serverConfig = await getServerConfig();
    const heartbeatTimeout = Number(serverConfig.heartbeatTimeoutSeconds) || 30;
    await conn.execute(
      `UPDATE ${tables.deviceCommands}
       SET status = 'expired', completed_at = NOW(), result_message = '命令超过有效期未下发'
       WHERE node_code = ? AND status = 'pending' AND expires_at < NOW()`,
      [nodeCode],
    );
    await conn.execute(
      `UPDATE ${tables.deviceCommands}
       SET status = 'pending', delivered_at = NULL
       WHERE node_code = ? AND status = 'delivered' AND expires_at >= NOW()
         AND delivered_at IS NOT NULL AND delivered_at < DATE_SUB(NOW(), INTERVAL 120 SECOND)`,
      [nodeCode],
    );

    const [rows] = await conn.execute(
      `SELECT id, command_id, command_type, payload
       FROM ${tables.deviceCommands}
       WHERE node_code = ? AND machine_id = ? AND status = 'pending' AND expires_at >= NOW()
       ORDER BY created_at ASC, id ASC
       LIMIT 1
       FOR UPDATE`,
      [nodeCode, normalizedMachineId],
    );
    const [command] = rows;
    if (!command) {
      return null;
    }

    await conn.execute(
      `UPDATE ${tables.deviceCommands}
       SET status = 'delivered', delivered_at = NOW()
       WHERE id = ? AND status = 'pending'`,
      [command.id],
    );

    return {
      id: command.command_id,
      type: command.command_type,
      message: deviceCommandMessage(command.command_type),
      payload: command.payload ?? null,
    };
  });
}

// 记录客户端远程指令执行结果。远程关机成功后同步结束 active 会话，避免后台长期显示上机中。
export async function completeDeviceCommand(commandId, machineId, status, message) {
  const normalizedCommandId = String(commandId || "").trim();
  const normalizedMachineId = String(machineId || "").trim();
  const normalizedStatus = normalizeCommandResultStatus(status);
  const resultMessage = trimResultMessage(message);

  if (!normalizedCommandId || !normalizedMachineId || !normalizedStatus) {
    return { ok: false, message: "命令结果参数不完整。" };
  }

  return transaction(async (conn) => {
    const [rows] = await conn.execute(
      `SELECT id, command_type, status, created_by
       FROM ${tables.deviceCommands}
       WHERE command_id = ? AND node_code = ? AND machine_id = ?
       LIMIT 1
       FOR UPDATE`,
      [normalizedCommandId, nodeCode, normalizedMachineId],
    );
    const [command] = rows;
    if (!command) {
      return { ok: false, message: "命令不存在或不属于当前节点。" };
    }

    if (["completed", "failed", "expired"].includes(command.status)) {
      return { ok: true, message: "命令结果已记录。" };
    }

    await conn.execute(
      `UPDATE ${tables.deviceCommands}
       SET status = ?, completed_at = NOW(), result_message = ?
       WHERE id = ?`,
      [normalizedStatus, resultMessage, command.id],
    );

    if (command.command_type === "shutdown" && normalizedStatus === "completed") {
      await conn.execute(
        `UPDATE ${tables.sessions}
         SET status = 'ended', ended_at = NOW()
         WHERE machine_id = ? AND node_code = ? AND status = 'active' AND ended_at IS NULL`,
        [normalizedMachineId, nodeCode],
      );
      await conn.execute(
        `UPDATE ${tables.devices}
         SET status = 'Locked', current_user_name = NULL, current_session_id = NULL
         WHERE machine_id = ?`,
        [normalizedMachineId],
      );
    }

    const actionText = deviceCommandTypeText(command.command_type);
    const eventName = normalizedStatus === "completed" ? `${actionText}结果` : `${actionText}失败`;
    const logMessage = normalizedStatus === "completed"
      ? `${actionText}指令已执行：${resultMessage || "客户端已确认"}`
      : `${actionText}指令执行失败：${resultMessage || "客户端未返回原因"}`;
    await addLog(eventName, logMessage, normalizedMachineId, conn, {
      level: normalizedStatus === "completed" ? "info" : "error",
      operatorName: command.created_by,
    });

    return { ok: true, message: "命令结果已记录。" };
  });
}

// 教师机专用下机流程：服务端校验教师会话、教师机IP和教室开关后，批量排队学生机关机。
// 该操作与普通 /api/logout 分开，避免客户端伪造一个布尔参数就获得批量关机权限。
export async function teacherLogoutAndShutdownStudents({ machineId, sessionId, sourceIp, shutdownStudents = false }) {
  const normalizedMachineId = String(machineId || "").trim();
  const normalizedSessionId = String(sessionId || "").trim();
  const normalizedSourceIp = String(sourceIp || "").trim();
  const requestStudents = normalizeBoolean(shutdownStudents, false);
  if (!normalizedMachineId || !normalizedSessionId || !normalizedSourceIp) {
    return { ok: false, status: 400, message: "下机参数不完整。" };
  }

  return transaction(async (conn) => {
    const serverConfig = await getServerConfig();
    const heartbeatTimeout = Number(serverConfig.heartbeatTimeoutSeconds) || 30;
    const [sessionRows] = await conn.execute(
      `SELECT s.id, s.user_role, s.student_no, s.name, d.classroom_id, d.device_role, d.ip_address
       FROM ${tables.sessions} s
       INNER JOIN ${tables.devices} d ON d.machine_id = s.machine_id AND d.current_session_id = s.id
       INNER JOIN ${tables.classrooms} c ON c.id = d.classroom_id AND c.node_code = s.node_code
       WHERE s.id = ? AND s.machine_id = ? AND s.node_code = ? AND s.status = 'active' AND s.ended_at IS NULL
       LIMIT 1 FOR UPDATE`,
      [normalizedSessionId, normalizedMachineId, nodeCode],
    );
    const session = sessionRows[0];
    if (!session || session.user_role !== "teacher" || session.device_role !== "teacher") {
      return { ok: false, status: 403, message: "只有教师机上的教师账号可以执行此操作。" };
    }

    const [rooms] = await conn.execute(
      `SELECT id, classroom_name, classroom_code, teacher_ip, allow_student_shutdown
       FROM ${tables.classrooms}
       WHERE id = ? AND node_code = ? AND enabled = 1
       LIMIT 1 FOR UPDATE`,
      [session.classroom_id, nodeCode],
    );
    const room = rooms[0];
    if (!room || String(room.teacher_ip || "").trim() !== normalizedSourceIp) {
      return { ok: false, status: 403, message: "当前电脑不是该教室的教师机。" };
    }
    if (requestStudents && Number(room.allow_student_shutdown) !== 1) {
      return { ok: false, status: 403, message: "当前教室未启用同时关机学生机权限。" };
    }

    const [studentDevices] = requestStudents ? await conn.execute(
      `SELECT d.machine_id, d.machine_name, d.ip_address, d.mac_address, d.classroom_name
       FROM ${tables.devices} d
       WHERE d.classroom_id = ? AND d.device_role = 'student'
         AND d.last_seen_at >= DATE_SUB(NOW(), INTERVAL ? SECOND)
       ORDER BY ISNULL(d.ip_address), INET_ATON(d.ip_address), d.id
       FOR UPDATE`,
      [session.classroom_id, heartbeatTimeout],
    ) : [[]];

    let created = 0;
    let duplicated = 0;
    for (const device of studentDevices) {
      await conn.execute(
        `UPDATE ${tables.deviceCommands}
         SET status='expired', completed_at=NOW(), result_message='命令超过有效期未执行'
         WHERE node_code=? AND machine_id=? AND command_type='shutdown'
           AND status IN ('pending','delivered') AND expires_at<NOW()`,
        [nodeCode, device.machine_id],
      );
      const [existing] = await conn.execute(
        `SELECT command_id FROM ${tables.deviceCommands}
         WHERE node_code=? AND machine_id=? AND command_type='shutdown'
           AND status IN ('pending','delivered') AND expires_at>=NOW()
         ORDER BY created_at DESC,id DESC LIMIT 1 FOR UPDATE`,
        [nodeCode, device.machine_id],
      );
      if (existing[0]) {
        duplicated += 1;
        continue;
      }
      const commandId = uuid().replaceAll("-", "");
      await conn.execute(
        `INSERT INTO ${tables.deviceCommands}
         (command_id,node_code,machine_id,command_type,payload,status,created_by,created_at,expires_at)
         VALUES (?,?,?,'shutdown',NULL,'pending',?,NOW(),DATE_ADD(NOW(),INTERVAL 10 MINUTE))`,
        [commandId, nodeCode, device.machine_id, `教师 ${session.name || session.student_no || ""}`.trim()],
      );
      created += 1;
    }

    // 日志里同时写出"本次新排队"和"已有待执行"，方便后台审计教师下机到底关了几台学生机。
    const duplicatedDetail = duplicated > 0 ? `（已有待执行${duplicated}台）` : "";
    const shutdownDetail = requestStudents ? `已排队关机学生机${created}台${duplicatedDetail}` : "未联动关机学生机";
    await endSessionAndLockDevice(
      normalizedSessionId,
      normalizedMachineId,
      "教师下机",
      `教师下机：${room.classroom_name || "当前教室"}，${shutdownDetail}`,
      conn,
    );
    return {
      ok: true,
      status: 200,
      message: created > 0 ? `已下机，并发送${created}台学生机关机指令。` : "已下机，当前没有需要关机的在线学生机。",
      classroomName: room.classroom_name,
      total: studentDevices.length,
      created,
      duplicated,
    };
  });
}

// 心跳写设备表用 upsert，首次上线新增，后续只更新当前状态。
export async function upsertHeartbeatDevice(device, conn = null) {
  const sql =
    `INSERT INTO ${tables.devices}
       (machine_id, machine_name, ip_address, mac_address, classroom_id, classroom_name, device_role, status, current_user_name, current_session_id, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
     ON DUPLICATE KEY UPDATE
       machine_name = VALUES(machine_name),
       ip_address = VALUES(ip_address),
       mac_address = VALUES(mac_address),
       classroom_id = VALUES(classroom_id),
       classroom_name = VALUES(classroom_name),
       device_role = VALUES(device_role),
       status = VALUES(status),
       current_user_name = VALUES(current_user_name),
       current_session_id = VALUES(current_session_id),
       last_seen_at = NOW()`;
  const params = [
    device.machineId,
    device.machineName,
    device.ipAddress,
    device.macAddress,
    device.classroomId,
    device.classroomName,
    device.deviceRole,
    device.status,
    device.currentUserName,
    device.currentSessionId,
  ];

  if (conn) {
    await conn.execute(sql, params);
    return;
  }

  await execute(sql, params);
}

export async function touchDeviceLastSeen(machineId) {
  const normalizedMachineId = String(machineId || "").trim();
  if (!normalizedMachineId) {
    return;
  }

  await execute(
    `UPDATE ${tables.devices}
     SET last_seen_at = NOW()
     WHERE machine_id = ?`,
    [normalizedMachineId],
  );
}

// 教室停用时客户端会退出，这里先把会话结束并把设备标记成 Disabled。
export async function markClientDisabled(device, conn) {
  if (device.sessionId) {
    await conn.execute(
      `UPDATE ${tables.sessions}
       SET status = 'ended', ended_at = NOW()
       WHERE id = ? AND node_code = ? AND status = 'active' AND ended_at IS NULL`,
      [device.sessionId, nodeCode],
    );
  }

  await upsertHeartbeatDevice(
    {
      machineId: device.machineId,
      machineName: device.machineName || device.machineId || "unknown",
      ipAddress: device.ipAddress,
      macAddress: device.macAddress,
      classroomId: device.classroom.classroomId,
      classroomName: device.classroom.classroomName,
      deviceRole: device.classroom.deviceRole,
      status: "Disabled",
      currentUserName: null,
      currentSessionId: null,
    },
    conn,
  );

  await addLog("教室停用", disabledClassroomMessage(device.classroom), device.machineId, conn);
}

// 结束指定 active 会话、清空设备当前用户，并记录原因；调用方负责提供事务连接。
export async function endSessionAndLockDevice(sessionId, machineId, eventName, message, conn) {
  await conn.execute(
    `UPDATE ${tables.sessions}
     SET status = 'ended', ended_at = NOW()
     WHERE id = ? AND node_code = ? AND status = 'active' AND ended_at IS NULL`,
    [sessionId, nodeCode],
  );
  await conn.execute(
    `UPDATE ${tables.devices}
     SET status = 'Locked', current_user_name = NULL, current_session_id = NULL
     WHERE machine_id = ? AND current_session_id = ?`,
    [machineId, sessionId],
  );
  await addLog(eventName, message, machineId, conn);
}

// 相同状态的完整快照不必每次写库，状态变化或超过节流间隔才写；在线时间由心跳接口每次单独刷新。
export function shouldWriteDeviceHeartbeat(device, force = false, config = null) {
  if (force) return true;

  const key = deviceHeartbeatKey(device);
  const snapshot = deviceHeartbeatSnapshot(device);
  const previous = deviceHeartbeatWriteSnapshots.get(key);
  if (!previous || previous.snapshot !== snapshot) return true;

  const writeIntervalSeconds = config?.heartbeatWriteIntervalSeconds ?? defaultServerConfig.heartbeatWriteIntervalSeconds;
  return Date.now() - previous.writtenAt >= writeIntervalSeconds * 1000;
}

// 记录本次设备心跳已经写库的快照和时间，供下一次心跳判断是否需要再写。
export function rememberDeviceHeartbeatWrite(device) {
  deviceHeartbeatWriteSnapshots.set(deviceHeartbeatKey(device), {
    snapshot: deviceHeartbeatSnapshot(device),
    writtenAt: Date.now(),
  });
}

// 生成设备心跳节流用的唯一键，优先使用稳定的 machineId。
function deviceHeartbeatKey(device) {
  return device.machineId || device.machineName || device.ipAddress || "unknown";
}

// 生成设备关键状态快照，只有这些字段变化才认为需要立即写库。
function deviceHeartbeatSnapshot(device) {
  return JSON.stringify({
    machineName: device.machineName,
    ipAddress: device.ipAddress,
    macAddress: device.macAddress,
    classroomId: device.classroomId,
    classroomName: device.classroomName,
    deviceRole: device.deviceRole,
    status: device.status,
    currentUserName: device.currentUserName,
    currentSessionId: device.currentSessionId,
  });
}

// 查询设备上下文，给日志表补充机器名、IP、MAC 和教室名称。
async function getDeviceContext(machineId, conn = null) {
  if (!machineId) {
    return { machineName: null, ipAddress: null, macAddress: null, classroomName: null };
  }
  const sql = `SELECT machine_name, ip_address, mac_address, classroom_name FROM ${tables.devices} WHERE machine_id = ? LIMIT 1`;
  const rows = conn ? (await conn.execute(sql, [machineId]))[0] : await query(sql, [machineId]);
  const [device] = rows;
  return {
    machineName: device?.machine_name ?? null,
    ipAddress: device?.ip_address ?? null,
    macAddress: device?.mac_address ?? null,
    classroomName: device?.classroom_name ?? null,
  };
}

function normalizeCommandResultStatus(status) {
  const text = String(status || "").trim().toLowerCase();
  if (text === "completed" || text === "ok" || text === "success") return "completed";
  if (text === "failed" || text === "error") return "failed";
  return null;
}

function trimResultMessage(message) {
  const text = String(message ?? "").trim();
  return text.length > 500 ? text.slice(0, 500) : text;
}

function deviceCommandTypeText(type) {
  if (type === "force_logout") return "远程下机";
  if (type === "shutdown") return "远程关机";
  return "远程指令";
}

function deviceCommandMessage(type) {
  if (type === "force_logout") return "管理员已远程下机，请重新登录。";
  if (type === "shutdown") return "管理员已发送远程关机指令。";
  return "管理员已发送远程指令。";
}

// 按 IP 匹配教室：教师机精确匹配，学生机走 ip_start 到 ip_end。
export async function matchClassroomByIp(ipAddress, options = {}) {
  const ipNum = ipToNumber(ipAddress);
  if (ipNum == null) return unmatchedClassroom();

  const enabledFilter = options.includeDisabled ? "" : "enabled = 1 AND ";

  const [teacher] = await query(
    `SELECT id, node_code, classroom_name, enabled, out_time, allow_student_shutdown
     FROM ${tables.classrooms}
     WHERE ${enabledFilter}teacher_ip = ?${nodeScopedClassroomSql()}
     ORDER BY id ASC
     LIMIT 1`,
    [ipAddress, ...nodeScopedClassroomParams()],
  );
  if (teacher) return classroomMatch(teacher, "teacher");

  const [student] = await query(
    `SELECT id, node_code, classroom_name, enabled, out_time, allow_student_shutdown
     FROM ${tables.classrooms}
     WHERE ${enabledFilter}ip_start <> '' AND ip_end <> ''
       AND ? BETWEEN INET_ATON(ip_start) AND INET_ATON(ip_end)${nodeScopedClassroomSql()}
     ORDER BY id ASC
     LIMIT 1`,
    [ipNum, ...nodeScopedClassroomParams()],
  );
  if (student) return classroomMatch(student, "student");

  return unmatchedClassroom();
}

// 把数据库查到的教室行转换成业务层统一使用的教室对象。
function classroomMatch(row, deviceRole) {
  const enabled = Number(row.enabled) !== 0;
  return {
    classroomId: row.id,
    nodeCode: row.node_code || globalNodeCode,
    classroomName: row.classroom_name,
    deviceRole,
    ipAllowed: true,
    enabled,
    systemEnabled: enabled,
    allowStudentShutdown: Number(row.allow_student_shutdown) === 1,
    idleShutdownMinutes: normalizeIdleShutdownMinutes(row.out_time),
  };
}

// IP 未命中任何教室时的默认策略：标记为非法 IP，但不让 Watchdog 直接退出，方便客户端展示提示。
function unmatchedClassroom() {
  return {
    classroomId: null,
    nodeCode,
    classroomName: null,
    deviceRole: "unknown",
    ipAllowed: false,
    enabled: null,
    systemEnabled: true,
    idleShutdownMinutes: 0,
    allowStudentShutdown: false,
  };
}

// GLOBAL 节点用于初始化兼容；配置了具体节点后，只匹配该节点，避免多个Node争用未分配教室。
function nodeScopedClassroomSql() {
  if (nodeCode === globalNodeCode) {
    return "";
  }
  return " AND node_code = ?";
}

function nodeScopedClassroomParams() {
  return nodeCode === globalNodeCode ? [] : [nodeCode];
}

// 统一判断客户端 IP 是否命中教室配置；未命中时不允许登录。
export function isClassroomIpAllowed(classroom) {
  return classroom.ipAllowed !== false;
}

// 统一判断教室实名上机系统是否启用，只把明确 systemEnabled=false 当作停用。
export function isClassroomSystemEnabled(classroom) {
  return classroom.systemEnabled !== false;
}

function normalizeWatchdogConfig(row) {
  if (!row) return { ...defaultWatchdogConfig };

  return {
    clientPath: normalizeWatchdogClientPath(row.client_path),
    checkSeconds: normalizeIntegerRange(row.check_seconds, defaultWatchdogConfig.checkSeconds, 1, 60),
    policySeconds: normalizeIntegerRange(row.policy_seconds, defaultWatchdogConfig.policySeconds, 2, 300),
    sessionSeconds: normalizeIntegerRange(row.session_seconds, defaultWatchdogConfig.sessionSeconds, 1, 60),
    aliveStaleSeconds: normalizeIntegerRange(row.alive_stale_seconds, defaultWatchdogConfig.aliveStaleSeconds, 0, 600),
    httpTimeoutSeconds: normalizeIntegerRange(row.http_timeout_seconds, defaultWatchdogConfig.httpTimeoutSeconds, 1, 30),
    retryLogSeconds: normalizeIntegerRange(row.retry_log_seconds, defaultWatchdogConfig.retryLogSeconds, 0, 300),
    sessionGuard: normalizeBoolean(row.session_guard, defaultWatchdogConfig.sessionGuard),
    aliveGuard: normalizeBoolean(row.alive_guard, defaultWatchdogConfig.aliveGuard),
  };
}

function normalizeClientConfig(row) {
  if (!row) return { ...defaultClientConfig };

  return {
    heartbeatSeconds: normalizeIntegerRange(row.heartbeat_seconds, defaultClientConfig.heartbeatSeconds, 3, 60),
    fullscreenEnabled: normalizeBoolean(row.fullscreen_enabled, defaultClientConfig.fullscreenEnabled),
    heartbeatFailLockCount: normalizeIntegerRange(row.heartbeat_fail_lock_count, defaultClientConfig.heartbeatFailLockCount, 0, 20),
    httpTimeoutSeconds: normalizeIntegerRange(row.http_timeout_seconds, defaultClientConfig.httpTimeoutSeconds, 5, 60),
    configRefreshSeconds: normalizeIntegerRange(row.config_refresh_seconds, defaultClientConfig.configRefreshSeconds, 3, 3600),
    clientAliveSeconds: normalizeIntegerRange(row.client_alive_seconds, defaultClientConfig.clientAliveSeconds, 1, 20),
    restoreSessionEnabled: normalizeBoolean(row.restore_session_enabled, defaultClientConfig.restoreSessionEnabled),
    faultEnabled: normalizeBoolean(row.fault_enabled, defaultClientConfig.faultEnabled),
  };
}

function normalizeServerConfig(row) {
  if (!row) return { ...defaultServerConfig };

  const normalizedTimeout = normalizeIntegerRange(row.heartbeat_timeout_seconds, defaultServerConfig.heartbeatTimeoutSeconds, 30, 3600);
  const normalizedScan = normalizeIntegerRange(row.offline_scan_seconds, defaultServerConfig.offlineScanSeconds, 5, 3600);

  return {
    heartbeatTimeoutSeconds: normalizedTimeout,
    heartbeatWriteIntervalSeconds: normalizeHeartbeatWriteIntervalSeconds(
      row.heartbeat_write_interval_seconds,
      normalizedTimeout,
      normalizedScan,
    ),
    offlineScanSeconds: normalizedScan,
    serverRecoveryGraceMinutes: normalizeIntegerRange(row.server_recovery_grace_minutes, defaultServerConfig.serverRecoveryGraceMinutes, 0, 1440),
    sessionTimeoutBatchSize: normalizeIntegerRange(row.session_timeout_batch_size, defaultServerConfig.sessionTimeoutBatchSize, 1, 5000),
    faultCooldownMinutes: normalizeIntegerRange(row.fault_cooldown_minutes, defaultServerConfig.faultCooldownMinutes, 1, 1440),
  };
}

function normalizeWatchdogClientPath(value) {
  const text = String(value ?? "").trim();
  if (!text || text.length > 500) return defaultWatchdogConfig.clientPath;
  if (/[\r\n"<>|]/.test(text)) return defaultWatchdogConfig.clientPath;
  if (!text.toLowerCase().endsWith(".exe")) return defaultWatchdogConfig.clientPath;
  if (!text.startsWith("\\\\") && !/^[A-Za-z]:[\\/]/.test(text)) return defaultWatchdogConfig.clientPath;
  return text;
}

function normalizeIntegerRange(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(number)));
}

function nullableLogValue(value) {
  const text = String(value ?? "").trim();
  return text === "" ? null : text.slice(0, 100);
}

function normalizeLogLevel(value, fallback = "info") {
  const text = String(value ?? "").trim().toLowerCase();
  return ["info", "warning", "error"].includes(text) ? text : fallback;
}

function normalizeLogSource(value, fallback = "Node") {
  const text = String(value ?? "").trim();
  return text === "" ? fallback : text.slice(0, 32);
}

function inferLogLevel(eventName) {
  const text = String(eventName ?? "");
  if (text.includes("错误") || text.includes("失败") || text.includes("异常") || text.includes("非法")) {
    return "error";
  }
  if (text.includes("超时") || text.includes("冲突") || text.includes("屏蔽") || text.includes("停用") || text.includes("远程")) {
    return "warning";
  }
  return "info";
}

function normalizeBoolean(value, fallback) {
  if (value === true || value === false) return value;
  if (value === 1 || value === 0) return Boolean(value);
  const text = String(value ?? "").trim().toLowerCase();
  if (text === "1" || text === "true" || text === "yes") return true;
  if (text === "0" || text === "false" || text === "no") return false;
  return fallback;
}

// 返回给客户端/Watchdog 的统一策略对象。
export function clientPolicyResponse(classroom) {
  const ipAllowed = isClassroomIpAllowed(classroom);
  const systemEnabled = isClassroomSystemEnabled(classroom);
  return {
    ok: true,
    ipAllowed,
    systemEnabled,
    shouldExit: !systemEnabled,
    message: !ipAllowed ? invalidIpMessage : systemEnabled ? null : disabledClassroomMessage(classroom),
    classroomId: classroom.classroomId,
    nodeCode: classroom.nodeCode,
    classroomName: classroom.classroomName,
    deviceRole: classroom.deviceRole,
    idleShutdownMinutes: classroom.idleShutdownMinutes,
    allowStudentShutdown: classroom.allowStudentShutdown === true,
  };
}

// 标准化 out_time：空值、非法值和小于等于 0 都表示不自动关机。
function normalizeIdleShutdownMinutes(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return Math.floor(number);
}

// 生成教室停用时返回给客户端和写入日志的统一提示文案。
function disabledClassroomMessage(classroom) {
  return `当前教室${classroom.classroomName ? `（${classroom.classroomName}）` : ""}未启用实名上机系统，客户端将退出。`;
}

// 心跳日志只在设备快照变化时打印，避免控制台被 10 秒心跳刷屏。
export function logDeviceHeartbeat({ machineId, machineName, ipAddress, macAddress, status, currentUserName, classroom }) {
  const key = machineId || machineName || ipAddress || "unknown";
  const snapshot = JSON.stringify({
    ipAddress,
    macAddress,
    status,
    currentUserName,
    classroomName: classroom.classroomName,
    deviceRole: classroom.deviceRole,
  });

  if (deviceLogSnapshots.get(key) === snapshot) {
    return;
  }

  deviceLogSnapshots.set(key, snapshot);

  const classroomText = classroom.classroomName || "未匹配教室";
  const roleText = deviceRoleText(classroom.deviceRole);
  const configTip = !classroom.classroomName && ipAddress ? "，请检查教室 IP 配置" : "";

  consoleInfo(
    "设备心跳",
    `主机：${machineName || "未上报"}，教室：${classroomText}，角色：${roleText}，状态：${statusText(status)}${configTip}`,
  );
}

// 登录或恢复会话时先刷新设备基础信息，保证后续日志能带出教室/IP。
export async function touchLoginDevice({ machineId, machineName, ipAddress, macAddress, classroom }, conn) {
  if (!machineId) return;

  await conn.execute(
    `INSERT INTO ${tables.devices}
       (machine_id, machine_name, ip_address, mac_address, classroom_id, classroom_name, device_role, status, current_user_name, current_session_id, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NOW())
     ON DUPLICATE KEY UPDATE
       machine_name = VALUES(machine_name),
       ip_address = VALUES(ip_address),
       mac_address = VALUES(mac_address),
       classroom_id = VALUES(classroom_id),
       classroom_name = VALUES(classroom_name),
       device_role = VALUES(device_role),
       last_seen_at = NOW()`,
    [
      machineId,
      machineName || machineId || "unknown",
      ipAddress,
      macAddress,
      classroom.classroomId,
      classroom.classroomName,
      classroom.deviceRole,
      "Locked",
    ],
  );
}
