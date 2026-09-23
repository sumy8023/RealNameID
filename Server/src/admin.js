import { execute, query, studentQuery, transaction } from "./db.js";
import { nodeCode, tables } from "./runtime.js";
import {
  addLog,
  getProgramFallbacks,
  getProgramMinimums,
  getServerConfig,
} from "./services.js";
import { uuid } from "./utils.js";

export class NodeAdminError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "NodeAdminError";
    this.status = status;
  }
}

const configDefinitions = {
  server: {
    table: tables.serverConfig,
    columns: [
      "heartbeat_timeout_seconds",
      "heartbeat_write_interval_seconds",
      "offline_scan_seconds",
      "server_recovery_grace_minutes",
      "session_timeout_batch_size",
      "fault_cooldown_minutes",
    ],
  },
  client: {
    table: tables.clientConfig,
    columns: [
      "heartbeat_seconds",
      "fullscreen_enabled",
      "heartbeat_fail_lock_count",
      "http_timeout_seconds",
      "config_refresh_seconds",
      "client_alive_seconds",
      "restore_session_enabled",
      "fault_enabled",
    ],
  },
  watchdog: {
    table: tables.watchdogConfig,
    columns: [
      "client_path",
      "check_seconds",
      "policy_seconds",
      "session_seconds",
      "alive_stale_seconds",
      "http_timeout_seconds",
      "retry_log_seconds",
      "session_guard",
      "alive_guard",
    ],
  },
};

export async function handleNodeAdminAction(action, payload = {}) {
  const handlers = {
    get_config: getConfig,
    save_server_config: saveServerConfig,
    save_client_config: saveClientConfig,
    save_watchdog_config: saveWatchdogConfig,
    stats,
    classroom_list: classroomList,
    classroom_building_options: classroomBuildingOptions,
    classroom_options: classroomOptions,
    classroom_get: classroomGet,
    classroom_save: classroomSave,
    classroom_toggle: classroomToggle,
    classroom_delete: classroomDelete,
    devices_list: devicesList,
    device_command: deviceCommand,
    classroom_shutdown: classroomShutdown,
    fault_list: faultList,
    logs_list: logsList,
    log_event_options: logEventOptions,
    sessions_list: sessionsList,
  };
  const handler = handlers[String(action || "").trim()];
  if (!handler) throw new NodeAdminError("不支持的节点管理操作。", 404);
  const result = await handler(payload && typeof payload === "object" ? payload : {});
  return { node_code: nodeCode, ...result };
}

async function ensureNodeConfigRows() {
  for (const definition of Object.values(configDefinitions)) {
    const columnSql = definition.columns.join(", ");
    await execute(
      `INSERT INTO ${definition.table} (node_code, ${columnSql})
       SELECT ?, ${columnSql} FROM ${definition.table} WHERE node_code = 'GLOBAL'
       ON DUPLICATE KEY UPDATE node_code = VALUES(node_code)`,
      [nodeCode],
    );
  }
}

async function configRow(definition) {
  const [row] = await query(
    `SELECT * FROM ${definition.table}
     WHERE node_code IN (?, 'GLOBAL')
     ORDER BY CASE WHEN node_code = ? THEN 0 ELSE 1 END
     LIMIT 1`,
    [nodeCode, nodeCode],
  );
  return row ?? {};
}

async function getConfig() {
  await ensureNodeConfigRows();
  const [server, client, watchdog] = await Promise.all([
    configRow(configDefinitions.server),
    configRow(configDefinitions.client),
    configRow(configDefinitions.watchdog),
  ]);
  return {
    server,
    client,
    watchdog,
    program_fallbacks: getProgramFallbacks(),
    program_minimums: getProgramMinimums(),
  };
}

async function saveServerConfig(payload) {
  await ensureNodeConfigRows();
  const timeout = intValue(payload.heartbeat_timeout_seconds, 30, 30, 3600);
  const scan = intValue(payload.offline_scan_seconds, 15, 5, 3600);
  const write = intValue(payload.heartbeat_write_interval_seconds, 15, 5, Math.max(5, timeout - scan));
  await execute(
    `UPDATE ${tables.serverConfig} SET
       heartbeat_timeout_seconds = ?, heartbeat_write_interval_seconds = ?, offline_scan_seconds = ?,
       server_recovery_grace_minutes = ?, session_timeout_batch_size = ?, fault_cooldown_minutes = ?
     WHERE node_code = ?`,
    [
      timeout,
      write,
      scan,
      intValue(payload.server_recovery_grace_minutes, 5, 0, 1440),
      intValue(payload.session_timeout_batch_size, 300, 1, 5000),
      intValue(payload.fault_cooldown_minutes, 20, 1, 1440),
      nodeCode,
    ],
  );
  await adminLog("服务端配置保存", `保存服务端配置：节点 ${nodeCode}，会话超时${timeout}秒，扫描间隔${scan}秒，心跳写库${write}秒`, payload);
  return { message: "服务端配置已保存，后端服务短缓存内会自动生效" };
}

async function saveClientConfig(payload) {
  await ensureNodeConfigRows();
  const heartbeat = intValue(payload.heartbeat_seconds, 5, 3, 3600);
  await execute(
    `UPDATE ${tables.clientConfig} SET
       heartbeat_seconds = ?, fullscreen_enabled = ?, heartbeat_fail_lock_count = ?,
       http_timeout_seconds = ?, config_refresh_seconds = ?, client_alive_seconds = ?,
       restore_session_enabled = ?, fault_enabled = ?
     WHERE node_code = ?`,
    [
      heartbeat,
      boolValue(payload.fullscreen_enabled),
      intValue(payload.heartbeat_fail_lock_count, 0, 0, 100),
      intValue(payload.http_timeout_seconds, 10, 5, 120),
      intValue(payload.config_refresh_seconds, 15, 3, 86400),
      intValue(payload.client_alive_seconds, 5, 1, 3600),
      boolValue(payload.restore_session_enabled),
      boolValue(payload.fault_enabled),
      nodeCode,
    ],
  );
  await adminLog("客户端配置保存", `保存客户端配置：节点 ${nodeCode}，心跳间隔${heartbeat}秒`, payload);
  return { message: "客户端配置已保存，后端服务短缓存内会自动生效" };
}

async function saveWatchdogConfig(payload) {
  await ensureNodeConfigRows();
  const clientPath = text(payload.client_path, 500);
  if (!clientPath) throw new NodeAdminError("请填写客户端EXE路径。");
  await execute(
    `UPDATE ${tables.watchdogConfig} SET
       client_path = ?, check_seconds = ?, policy_seconds = ?, session_seconds = ?,
       alive_stale_seconds = ?, http_timeout_seconds = ?, retry_log_seconds = ?,
       session_guard = ?, alive_guard = ?
     WHERE node_code = ?`,
    [
      clientPath,
      intValue(payload.check_seconds, 3, 1, 3600),
      intValue(payload.policy_seconds, 15, 1, 86400),
      intValue(payload.session_seconds, 5, 1, 3600),
      intValue(payload.alive_stale_seconds, 0, 0, 86400),
      intValue(payload.http_timeout_seconds, 5, 1, 120),
      intValue(payload.retry_log_seconds, 30, 0, 3600),
      boolValue(payload.session_guard),
      boolValue(payload.alive_guard),
      nodeCode,
    ],
  );
  await adminLog("看门狗配置保存", `保存看门狗配置：节点 ${nodeCode}，客户端路径：${clientPath}`, payload);
  return { message: "看门狗配置已保存，客户端策略刷新后生效" };
}

async function stats() {
  const serverConfig = await getServerConfig();
  const timeout = intValue(serverConfig.heartbeatTimeoutSeconds, 30, 30, 3600);
  const [[classrooms], [devices], [sessions], [faults], [logs]] = await Promise.all([
    query(`SELECT COUNT(*) classroom_count, COALESCE(SUM(enabled = 1), 0) enabled_classroom_count FROM ${tables.classrooms} WHERE node_code = ?`, [nodeCode]),
    query(`SELECT COUNT(*) device_count, COALESCE(SUM(last_seen_at >= DATE_SUB(NOW(), INTERVAL ? SECOND)), 0) online_device_count FROM ${tables.devices}`, [timeout]),
    query(`SELECT COUNT(*) active_session_count FROM ${tables.sessions} WHERE node_code = ? AND status = 'active' AND ended_at IS NULL`, [nodeCode]),
    query(`SELECT COUNT(*) today_fault_count FROM ${tables.faults} WHERE createtime >= CURDATE()`),
    query(`SELECT COUNT(*) today_log_count FROM ${tables.logs} WHERE log_time >= CURDATE()`),
  ]);
  return { data: { ...classrooms, ...devices, ...sessions, ...faults, ...logs } };
}

async function classroomList(payload) {
  const { limit, offset } = pageSpec(payload);
  const where = ["node_code = ?"];
  const params = [nodeCode];
  addLike(where, params, ["classroom_code", "classroom_name", "building_name", "ip_start", "ip_end", "teacher_ip"], payload.keyword);
  addEqual(where, params, "building_name", payload.building_name);
  if (String(payload.enabled ?? "") !== "") addEqual(where, params, "enabled", boolValue(payload.enabled));
  const whereSql = where.join(" AND ");
  const [[countRow], list] = await Promise.all([
    query(`SELECT COUNT(*) count FROM ${tables.classrooms} WHERE ${whereSql}`, params),
    query(`SELECT * FROM ${tables.classrooms} WHERE ${whereSql} ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]),
  ]);
  return tableResult(list, countRow?.count);
}

async function classroomBuildingOptions(payload) {
  const where = ["node_code = ?", "building_name IS NOT NULL", "building_name <> ''"];
  const params = [nodeCode];
  const rows = await query(`SELECT DISTINCT building_name FROM ${tables.classrooms} WHERE ${where.join(" AND ")} ORDER BY building_name ASC`, params);
  return { data: rows };
}

async function classroomOptions(payload) {
  const serverConfig = await getServerConfig();
  const timeout = intValue(serverConfig.heartbeatTimeoutSeconds, 30, 30, 3600);
  const where = ["c.node_code = ?"];
  const params = [nodeCode];
  addEqual(where, params, "c.building_name", payload.building_name);
  const rows = await query(
    `SELECT c.id, c.node_code, c.classroom_name, c.classroom_code, c.building_name, c.enabled,
       COUNT(d.id) device_count,
       COALESCE(SUM(d.last_seen_at >= DATE_SUB(NOW(), INTERVAL ? SECOND)), 0) online_count,
       COALESCE(SUM(d.current_session_id IS NOT NULL AND d.status = 'Unlocked'), 0) using_count
     FROM ${tables.classrooms} c
     LEFT JOIN ${tables.devices} d ON d.classroom_id = c.id
     WHERE ${where.join(" AND ")}
     GROUP BY c.id, c.node_code, c.classroom_name, c.classroom_code, c.building_name, c.enabled
     ORDER BY c.enabled DESC, c.building_name ASC, c.classroom_name ASC, c.id ASC`,
    [timeout, ...params],
  );
  return { data: rows };
}

async function classroomSave(payload) {
  const id = intValue(payload.id, 0, 0);
  const classroomCode = requiredText(payload.classroom_code, "请填写教室编号。", 64);
  const classroomName = requiredText(payload.classroom_name, "请填写教室名称。", 100);
  const buildingName = nullableText(payload.building_name, 100);
  // 学生机 IP 段可以整体留空，用于只有教师机的座椅教室；起止地址必须成对填写。
  const ipStart = nullableIpv4(payload.ip_start, "学生机起始IP格式不正确。");
  const ipEnd = nullableIpv4(payload.ip_end, "学生机结束IP格式不正确。");
  const teacherIp = nullableIpv4(payload.teacher_ip, "教师机IP格式不正确。");
  if ((ipStart && !ipEnd) || (!ipStart && ipEnd)) {
    throw new NodeAdminError("学生机IP段起始和结束地址需同时填写。");
  }
  if (!ipStart && !teacherIp) {
    throw new NodeAdminError("请至少填写教师机IP或完整的学生机IP段。");
  }
  if (ipStart && ipEnd) {
    if (ipNumber(ipStart) > ipNumber(ipEnd)) throw new NodeAdminError("学生机IP段起始地址不能大于结束地址。");
    if (teacherIp && ipNumber(teacherIp) >= ipNumber(ipStart) && ipNumber(teacherIp) <= ipNumber(ipEnd)) {
      throw new NodeAdminError("教师机IP不能位于学生机IP段内。");
    }
  }
  const idFilter = id > 0 ? " AND id <> ?" : "";
  const idParams = id > 0 ? [id] : [];
  const [duplicate] = await query(`SELECT id FROM ${tables.classrooms} WHERE node_code = ? AND classroom_code = ?${idFilter} LIMIT 1`, [nodeCode, classroomCode, ...idParams]);
  if (duplicate) throw new NodeAdminError("教室编号已存在。");
  const [nameDuplicate] = await query(
    `SELECT id FROM ${tables.classrooms}
     WHERE node_code = ? AND classroom_name = ? AND COALESCE(building_name, '') = COALESCE(?, '')${idFilter} LIMIT 1`,
    [nodeCode, classroomName, buildingName, ...idParams],
  );
  if (nameDuplicate) throw new NodeAdminError("目标节点中已存在相同楼栋和教室名称。");
  if (ipStart && ipEnd) {
    const [rangeConflict] = await query(
      `SELECT classroom_name FROM ${tables.classrooms}
       WHERE node_code = ?${idFilter}
         AND ip_start <> '' AND ip_end <> ''
         AND INET_ATON(ip_start) <= INET_ATON(?) AND INET_ATON(ip_end) >= INET_ATON(?) LIMIT 1`,
      [nodeCode, ...idParams, ipEnd, ipStart],
    );
    if (rangeConflict) throw new NodeAdminError(`学生机IP段与已有教室冲突：${rangeConflict.classroom_name}`);
    const [teacherInRange] = await query(
      `SELECT classroom_name FROM ${tables.classrooms}
       WHERE node_code = ?${idFilter} AND teacher_ip IS NOT NULL AND teacher_ip <> ''
         AND INET_ATON(teacher_ip) BETWEEN INET_ATON(?) AND INET_ATON(?) LIMIT 1`,
      [nodeCode, ...idParams, ipStart, ipEnd],
    );
    if (teacherInRange) throw new NodeAdminError(`学生机IP段包含已有教师机IP：${teacherInRange.classroom_name}`);
  }
  if (teacherIp) {
    const [teacherConflict] = await query(`SELECT classroom_name FROM ${tables.classrooms} WHERE node_code = ?${idFilter} AND teacher_ip = ? LIMIT 1`, [nodeCode, ...idParams, teacherIp]);
    if (teacherConflict) throw new NodeAdminError(`教师机IP已被使用：${teacherConflict.classroom_name}`);
    const [teacherRangeConflict] = await query(
      `SELECT classroom_name FROM ${tables.classrooms}
       WHERE node_code = ?${idFilter} AND ip_start <> '' AND ip_end <> ''
         AND INET_ATON(?) BETWEEN INET_ATON(ip_start) AND INET_ATON(ip_end) LIMIT 1`,
      [nodeCode, ...idParams, teacherIp],
    );
    if (teacherRangeConflict) throw new NodeAdminError(`教师机IP落入已有学生机IP段：${teacherRangeConflict.classroom_name}`);
  }
  const values = [classroomCode, classroomName, buildingName, nodeCode, ipStart || "", ipEnd || "", teacherIp, boolValue(payload.enabled), intValue(payload.out_time, 10, 0, 1440), boolValue(payload.allow_student_shutdown)];
  return transaction(async (conn) => {
    if (id > 0) {
      const [result] = await conn.execute(
        `UPDATE ${tables.classrooms} SET classroom_code=?, classroom_name=?, building_name=?, node_code=?, ip_start=?, ip_end=?, teacher_ip=?, enabled=?, out_time=?, allow_student_shutdown=? WHERE id=? AND node_code=?`,
        [...values, id, nodeCode],
      );
      if (!result.affectedRows) throw new NodeAdminError("教室配置不存在。", 404);
      await adminLog("教室修改", `修改教室配置：${classroomName}（${classroomCode}），IP段：${ipStart}-${ipEnd}`, payload, "info", conn);
      return { classroom_id: id, message: "教室配置已保存" };
    }
    const [result] = await conn.execute(
      `INSERT INTO ${tables.classrooms} (classroom_code,classroom_name,building_name,node_code,ip_start,ip_end,teacher_ip,enabled,out_time,allow_student_shutdown) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      values,
    );
    await adminLog("教室新增", `新增教室配置：${classroomName}（${classroomCode}），IP段：${ipStart}-${ipEnd}`, payload, "info", conn);
    return { classroom_id: result.insertId, message: "教室配置已保存" };
  });
}

async function classroomGet(payload) {
  const id = intValue(payload.id, 0, 1);
  const [room] = await query(`SELECT * FROM ${tables.classrooms} WHERE id=? AND node_code=? LIMIT 1`, [id, nodeCode]);
  if (!room) throw new NodeAdminError("源节点中的教室配置不存在。", 404);
  const serverConfig = await getServerConfig();
  const timeout = intValue(serverConfig.heartbeatTimeoutSeconds, 30, 30, 3600);
  const [[onlineRow], [activeRow]] = await Promise.all([
    query(`SELECT COUNT(*) online_count FROM ${tables.devices} WHERE classroom_id=? AND last_seen_at>=DATE_SUB(NOW(),INTERVAL ? SECOND)`, [id, timeout]),
    query(`SELECT COUNT(*) active_session_count FROM ${tables.sessions} s INNER JOIN ${tables.devices} d ON d.machine_id=s.machine_id WHERE d.classroom_id=? AND s.node_code=? AND s.status='active' AND s.ended_at IS NULL`, [id, nodeCode]),
  ]);
  return {
    classroom: room,
    online_count: Number(onlineRow?.online_count) || 0,
    active_session_count: Number(activeRow?.active_session_count) || 0,
  };
}

async function classroomToggle(payload) {
  const id = intValue(payload.id, 0, 1);
  const enabled = boolValue(payload.enabled);
  return transaction(async (conn) => {
    const [rows] = await conn.execute(`SELECT classroom_code,classroom_name FROM ${tables.classrooms} WHERE id=? AND node_code=? LIMIT 1 FOR UPDATE`, [id, nodeCode]);
    const room = rows[0];
    if (!room) throw new NodeAdminError("教室配置不存在。", 404);
    await conn.execute(`UPDATE ${tables.classrooms} SET enabled=? WHERE id=? AND node_code=?`, [enabled, id, nodeCode]);
    await adminLog("教室状态修改", `${enabled ? "启用" : "停用"}教室配置：${room.classroom_name}（${room.classroom_code}）`, payload, "warning", conn);
    return { id, enabled, message: `教室已${enabled ? "启用" : "停用"}` };
  });
}

async function classroomDelete(payload) {
  const id = intValue(payload.id, 0, 1);
  return transaction(async (conn) => {
    const [rows] = await conn.execute(`SELECT classroom_code,classroom_name FROM ${tables.classrooms} WHERE id=? AND node_code=? LIMIT 1 FOR UPDATE`, [id, nodeCode]);
    const room = rows[0];
    if (!room) throw new NodeAdminError("教室配置不存在。", 404);
    await conn.execute(`DELETE FROM ${tables.classrooms} WHERE id=? AND node_code=? LIMIT 1`, [id, nodeCode]);
    await adminLog("教室删除", `删除教室配置：${room.classroom_name}（${room.classroom_code}）`, payload, "warning", conn);
    return { message: "删除成功" };
  });
}

async function devicesList(payload) {
  const { limit, offset } = pageSpec(payload);
  const serverConfig = await getServerConfig();
  const timeout = intValue(serverConfig.heartbeatTimeoutSeconds, 30, 30, 3600);
  const where = ["c.node_code = ?"];
  const params = [nodeCode];
  addLike(where, params, ["d.machine_id", "d.machine_name", "d.ip_address", "d.current_user_name", "s.student_no", "s.name"], payload.keyword);
  addLike(where, params, ["d.classroom_name"], payload.classroom_name);
  addEqual(where, params, "c.building_name", payload.building_name);
  const classroomId = intValue(payload.classroom_id, 0, 0);
  if (classroomId > 0) addEqual(where, params, "d.classroom_id", classroomId);
  addEqual(where, params, "d.status", payload.status);
  addEqual(where, params, "d.device_role", payload.device_role);
  const overviewStatus = text(payload.overview_status, 16).toLowerCase();
  if (overviewStatus === "offline") {
    where.push("(d.last_seen_at IS NULL OR d.last_seen_at < DATE_SUB(NOW(), INTERVAL ? SECOND))");
    params.push(timeout);
  } else if (overviewStatus === "online") {
    where.push("d.last_seen_at >= DATE_SUB(NOW(), INTERVAL ? SECOND)");
    params.push(timeout);
  } else if (overviewStatus === "locked") {
    where.push("d.last_seen_at >= DATE_SUB(NOW(), INTERVAL ? SECOND)");
    where.push("(LOWER(COALESCE(d.status, '')) <> 'unlocked' OR d.current_session_id IS NULL)");
    params.push(timeout);
  } else if (overviewStatus === "using") {
    where.push("d.last_seen_at >= DATE_SUB(NOW(), INTERVAL ? SECOND)");
    where.push("LOWER(COALESCE(d.status, '')) = 'unlocked'");
    where.push("d.current_session_id IS NOT NULL");
    params.push(timeout);
  } else if (String(payload.online ?? "") === "1") {
    where.push("d.last_seen_at >= DATE_SUB(NOW(), INTERVAL ? SECOND)");
    params.push(timeout);
  } else if (String(payload.online ?? "") === "0") {
    where.push("(d.last_seen_at IS NULL OR d.last_seen_at < DATE_SUB(NOW(), INTERVAL ? SECOND))");
    params.push(timeout);
  }
  const from = ` FROM ${tables.devices} d
    LEFT JOIN ${tables.classrooms} c ON c.id=d.classroom_id
    LEFT JOIN ${tables.sessions} s ON s.id=d.current_session_id AND s.machine_id=d.machine_id`;
  const whereSql = where.join(" AND ");
  const order = classroomId > 0 ? "ISNULL(d.ip_address), INET_ATON(d.ip_address), d.id" : "d.last_seen_at DESC, d.id DESC";
  const [[countRow], list] = await Promise.all([
    query(`SELECT COUNT(*) count${from} WHERE ${whereSql}`, params),
    query(`SELECT d.*, ? node_code,
       IF(d.last_seen_at >= DATE_SUB(NOW(), INTERVAL ? SECOND), '在线', '离线') online_text,
       s.user_role current_user_role, s.student_no, COALESCE(NULLIF(s.name,''),d.current_user_name) display_name
       ${from} WHERE ${whereSql} ORDER BY ${order} LIMIT ? OFFSET ?`, [nodeCode, timeout, ...params, limit, offset]),
  ]);
  await attachTeacherAccounts(list, "current_user_role", "student_no");
  for (const row of list) row.display_account = row.current_user_role === "teacher" ? (row.teacher_code || row.student_no) : row.student_no;
  return tableResult(list, countRow?.count);
}

async function deviceCommand(payload) {
  const machineId = requiredText(payload.machine_id, "缺少设备标识。", 128);
  const commandType = text(payload.command_type, 32);
  if (!['force_logout', 'shutdown'].includes(commandType)) throw new NodeAdminError("命令类型不正确。");
  const classroomId = intValue(payload.classroom_id, 0, 0);
  const serverConfig = await getServerConfig();
  const timeout = intValue(serverConfig.heartbeatTimeoutSeconds, 30, 30, 3600);
  return transaction(async (conn) => {
    const params = [machineId, nodeCode];
    let roomFilter = "";
    if (classroomId > 0) { roomFilter = " AND d.classroom_id=?"; params.push(classroomId); }
    const [rows] = await conn.execute(
      `SELECT d.*, s.id active_session_id FROM ${tables.devices} d
       LEFT JOIN ${tables.classrooms} c ON c.id=d.classroom_id
       LEFT JOIN ${tables.sessions} s ON s.id=d.current_session_id AND s.status='active' AND s.ended_at IS NULL
       WHERE d.machine_id=? AND c.node_code=?${roomFilter} LIMIT 1 FOR UPDATE`, params,
    );
    const device = rows[0];
    if (!device) throw new NodeAdminError("设备不存在或不属于当前节点/教室。", 404);
    if (!device.last_seen_at || (Date.now() - new Date(device.last_seen_at).getTime()) / 1000 > timeout) throw new NodeAdminError(`设备离线，不能执行${commandText(commandType)}。`);
    if (commandType === "force_logout" && !(String(device.status).toLowerCase() === "unlocked" && device.current_session_id && device.active_session_id === device.current_session_id)) {
      throw new NodeAdminError("设备当前未实名上机，不能执行下机。");
    }
    if (commandType === "force_logout") {
      await conn.execute(`UPDATE ${tables.sessions} SET status='ended',ended_at=NOW() WHERE id=? AND node_code=? AND status='active' AND ended_at IS NULL`, [device.current_session_id, nodeCode]);
      await conn.execute(`UPDATE ${tables.devices} SET status='Locked',current_user_name=NULL,current_session_id=NULL WHERE machine_id=?`, [machineId]);
    }
    const queued = await queueCommand(conn, machineId, commandType, text(payload.operator_name, 100) || ADMIN_LOG_SOURCE);
    await addLog(commandText(commandType), `发送${commandText(commandType)}指令：${deviceLabel(device)}${queued.created ? "" : "（已有同类待执行指令，本次未重复创建）"}`, machineId, conn, { level: "warning", source: ADMIN_LOG_SOURCE, operatorName: text(payload.operator_name, 100) || ADMIN_LOG_SOURCE });
    return { ...queued, message: `${commandText(commandType)}指令已发送` };
  });
}

async function classroomShutdown(payload) {
  const classroomId = intValue(payload.classroom_id, 0, 1);
  const serverConfig = await getServerConfig();
  const timeout = intValue(serverConfig.heartbeatTimeoutSeconds, 30, 30, 3600);
  return transaction(async (conn) => {
    const [rooms] = await conn.execute(`SELECT * FROM ${tables.classrooms} WHERE id=? AND node_code=? LIMIT 1 FOR UPDATE`, [classroomId, nodeCode]);
    const room = rooms[0];
    if (!room) throw new NodeAdminError("教室不存在或不属于当前节点。", 404);
    const [devices] = await conn.execute(`SELECT * FROM ${tables.devices} WHERE classroom_id=? AND last_seen_at>=DATE_SUB(NOW(),INTERVAL ? SECOND) ORDER BY ISNULL(ip_address),INET_ATON(ip_address),id`, [classroomId, timeout]);
    if (!devices.length) throw new NodeAdminError("当前教室没有在线电脑可关机。");
    let created = 0;
    for (const device of devices) {
      const queued = await queueCommand(conn, device.machine_id, "shutdown", text(payload.operator_name, 100) || ADMIN_LOG_SOURCE);
      if (queued.created) created += 1;
      await addLog("远程关机", `一键关机当前教室电脑：${deviceLabel(device)}${queued.created ? "" : "（已有同类待执行指令，本次未重复创建）"}`, device.machine_id, conn, { level: "warning", source: ADMIN_LOG_SOURCE, operatorName: text(payload.operator_name, 100) || ADMIN_LOG_SOURCE });
    }
    const duplicated = devices.length - created;
    await addLog("教室关机", `一键关机教室：${room.classroom_name}，在线电脑${devices.length}台，新增指令${created}条，已有待执行${duplicated}条`, null, conn, { level: "warning", source: ADMIN_LOG_SOURCE, operatorName: text(payload.operator_name, 100) || ADMIN_LOG_SOURCE });
    return { total: devices.length, created, duplicated, message: "已发送当前教室关机指令" };
  });
}

async function queueCommand(conn, machineId, commandType, createdBy) {
  await conn.execute(`UPDATE ${tables.deviceCommands} SET status='expired',completed_at=NOW(),result_message='命令超过有效期未执行' WHERE node_code=? AND machine_id=? AND command_type=? AND status IN ('pending','delivered') AND expires_at<NOW()`, [nodeCode, machineId, commandType]);
  const [existingRows] = await conn.execute(`SELECT command_id FROM ${tables.deviceCommands} WHERE node_code=? AND machine_id=? AND command_type=? AND status IN ('pending','delivered') AND expires_at>=NOW() ORDER BY created_at DESC,id DESC LIMIT 1 FOR UPDATE`, [nodeCode, machineId, commandType]);
  if (existingRows[0]) return { created: false, command_id: existingRows[0].command_id };
  const commandId = uuid().replaceAll("-", "");
  await conn.execute(`INSERT INTO ${tables.deviceCommands} (command_id,node_code,machine_id,command_type,payload,status,created_by,created_at,expires_at) VALUES (?,?,?,?,NULL,'pending',?,NOW(),DATE_ADD(NOW(),INTERVAL 10 MINUTE))`, [commandId, nodeCode, machineId, commandType, createdBy]);
  return { created: true, command_id: commandId };
}

async function faultList(payload) {
  const { limit, offset } = pageSpec(payload);
  const where = ["1=1"];
  const params = [];
  addLike(where, params, ["f.ip", "f.student_no", "f.classroom_name", "f.info"], payload.keyword);
  addEqual(where, params, "f.type", payload.type);
  addDateRange(where, params, "f.createtime", payload.date);
  const from = ` FROM ${tables.faults} f`;
  const [[countRow], list] = await Promise.all([
    query(`SELECT COUNT(*) count${from} WHERE ${where.join(" AND ")}`, params),
    query(`SELECT f.*${from} WHERE ${where.join(" AND ")} ORDER BY f.createtime DESC,f.id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]),
  ]);
  await attachTeacherAccounts(list, null, "student_no");
  for (const row of list) row.display_account = row.teacher_code || row.student_no;
  return tableResult(list, countRow?.count);
}

async function logsList(payload) {
  const { limit, offset } = pageSpec(payload);
  const where = ["1=1"];
  const params = [];
  addLike(where, params, ["message", "operator_name", "machine_id", "machine_name", "ip_address", "classroom_name"], payload.keyword);
  addEqual(where, params, "event_name", payload.event_name);
  addLike(where, params, ["operator_name"], payload.operator_name);
  if (["info", "warning", "error"].includes(text(payload.log_level, 16))) addEqual(where, params, "log_level", payload.log_level);
  addLogSource(where, params, payload.log_source);
  addDateRange(where, params, "log_time", payload.date);
  const [[countRow], list] = await Promise.all([
    query(`SELECT COUNT(*) count FROM ${tables.logs} WHERE ${where.join(" AND ")}`, params),
    query(`SELECT * FROM ${tables.logs} WHERE ${where.join(" AND ")} ORDER BY log_time DESC,id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]),
  ]);
  return tableResult(list, countRow?.count);
}

async function logEventOptions() {
  const rows = await query(
    `SELECT DISTINCT event_name FROM ${tables.logs}
     WHERE event_name IS NOT NULL AND TRIM(event_name) <> ''
     ORDER BY event_name ASC`,
  );
  return {
    data: rows
      .map((row) => String(row.event_name || "").trim())
      .filter(Boolean)
      .map((eventName) => ({ event_name: eventName })),
  };
}

async function sessionsList(payload) {
  const { limit, offset } = pageSpec(payload);
  const where = ["s.node_code = ?"];
  const params = [nodeCode];
  addLike(where, params, ["s.student_no", "s.name", "s.machine_id", "d.machine_name", "d.ip_address", "d.classroom_name"], payload.keyword);
  addEqual(where, params, "s.status", payload.status);
  if (["student", "teacher"].includes(text(payload.user_role, 16))) addEqual(where, params, "s.user_role", payload.user_role);
  const classroomId = intValue(payload.classroom_id, 0, 0);
  if (classroomId > 0) addEqual(where, params, "d.classroom_id", classroomId);
  addLike(where, params, ["d.classroom_name"], payload.classroom_name);
  addDateRange(where, params, "s.started_at", payload.date);
  const from = ` FROM ${tables.sessions} s LEFT JOIN ${tables.devices} d ON d.machine_id=s.machine_id`;
  const [[countRow], list] = await Promise.all([
    query(`SELECT COUNT(*) count${from} WHERE ${where.join(" AND ")}`, params),
    query(`SELECT s.*,d.machine_name,d.ip_address,d.classroom_name,TIMESTAMPDIFF(MINUTE,s.started_at,IFNULL(s.ended_at,NOW())) use_minutes${from} WHERE ${where.join(" AND ")} ORDER BY s.started_at DESC LIMIT ? OFFSET ?`, [...params, limit, offset]),
  ]);
  await attachTeacherAccounts(list, "user_role", "student_no");
  for (const row of list) row.display_account = row.user_role === "teacher" ? (row.teacher_code || row.student_no) : row.student_no;
  return tableResult(list, countRow?.count);
}

async function attachTeacherAccounts(rows, roleField, accountField) {
  const ids = [...new Set(rows.filter((row) => !roleField || row[roleField] === "teacher").map((row) => text(row[accountField], 64)).filter(Boolean))];
  if (!ids.length) return;
  const teachers = await studentQuery(`SELECT teacher_num,teacher_code FROM ${tables.teachers} WHERE teacher_num IN (${ids.map(() => "?").join(",")})`, ids);
  const codes = new Map(teachers.map((row) => [String(row.teacher_num), row.teacher_code]));
  for (const row of rows) row.teacher_code = codes.get(String(row[accountField])) || null;
}

async function adminLog(eventName, message, payload, level = "info", conn = null) {
  await addLog(eventName, message, null, conn, {
    level,
    source: ADMIN_LOG_SOURCE,
    operatorName: text(payload.operator_name, 100) || ADMIN_LOG_SOURCE,
  });
}

function tableResult(data, count) { return { data, count: Number(count) || 0 }; }
function text(value, max = 1000) { return String(value ?? "").trim().slice(0, max); }
function nullableText(value, max) { const valueText = text(value, max); return valueText || null; }
function requiredText(value, message, max) { const valueText = text(value, max); if (!valueText) throw new NodeAdminError(message); return valueText; }
function boolValue(value) { return value === true || value === 1 || value === "1" || value === "true" || value === "on" ? 1 : 0; }
function intValue(value, fallback, min = null, max = null) {
  let number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) number = fallback;
  if (min !== null) number = Math.max(min, number);
  if (max !== null) number = Math.min(max, number);
  return number;
}
function pageSpec(payload) {
  const page = intValue(payload.page, 1, 1, 1000000);
  const limit = intValue(payload.limit, 20, 1, 5000);
  return { page, limit, offset: (page - 1) * limit };
}
// 管理后台写日志的来源标识。
const ADMIN_LOG_SOURCE = "Vue后台";

function addEqual(where, params, column, value) { const valueText = text(value); if (valueText !== "") { where.push(`${column} = ?`); params.push(value); } }
function addLogSource(where, params, value) {
  const valueText = text(value);
  if (!valueText) return;
  addEqual(where, params, "log_source", valueText);
}
function addLike(where, params, columns, value) { const valueText = text(value); if (!valueText) return; where.push(`(${columns.map((column) => `${column} LIKE ?`).join(" OR ")})`); for (let index = 0; index < columns.length; index += 1) params.push(`%${valueText}%`); }
function addDateRange(where, params, column, value) {
  const parts = text(value, 64).split(/\s+-\s+/);
  if (/^\d{4}-\d{2}-\d{2}$/.test(parts[0] || "")) { where.push(`${column} >= ?`); params.push(`${parts[0]} 00:00:00`); }
  if (/^\d{4}-\d{2}-\d{2}$/.test(parts[1] || "")) { where.push(`${column} <= ?`); params.push(`${parts[1]} 23:59:59`); }
}
function ipv4(value, message) { const valueText = text(value, 64); if (!isIpv4(valueText)) throw new NodeAdminError(message); return valueText; }
function nullableIpv4(value, message) { const valueText = text(value, 64); if (!valueText) return null; if (!isIpv4(valueText)) throw new NodeAdminError(message); return valueText; }
function isIpv4(value) { const parts = String(value).split("."); return parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) >= 0 && Number(part) <= 255); }
function ipNumber(value) { return String(value).split(".").reduce((sum, part) => sum * 256 + Number(part), 0); }
function commandText(type) { return type === "force_logout" ? "远程下机" : type === "shutdown" ? "远程关机" : "远程指令"; }
function deviceLabel(device) { return [device.machine_name || device.machine_id, device.ip_address ? `IP ${device.ip_address}` : "", device.classroom_name ? `教室 ${device.classroom_name}` : "", device.current_user_name ? `当前用户 ${device.current_user_name}` : ""].filter(Boolean).join("，"); }
