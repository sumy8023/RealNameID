import crypto from "node:crypto";

// 模拟一个实名上机后端节点，用于验证 BFF 的签名转发与多节点合并。
// 签名校验逻辑逐字照抄 Server/src/routes.js 的 validNodeAdminSignature，
// 这样测试通过就意味着和真实后端的鉴权真的互通，而不是两边各自写了一套"看起来一样"的实现。

const ADMIN_ACTIONS = new Set([
  "get_config",
  "save_server_config",
  "save_client_config",
  "save_watchdog_config",
  "stats",
  "classroom_list",
  "classroom_building_options",
  "classroom_options",
  "classroom_get",
  "classroom_save",
  "classroom_toggle",
  "classroom_delete",
  "devices_list",
  "device_command",
  "classroom_shutdown",
  "fault_list",
  "logs_list",
  "log_event_options",
  "sessions_list",
]);

function hasRawBody(req) {
  return Object.prototype.hasOwnProperty.call(req, "rawBody");
}

export function createMockNode({ nodeCode, registrationKey, seed, log }) {
  const state = structuredClone(seed);

  const handlers = {
    stats: () => ({
      data: {
        classroom_count: state.classrooms.length,
        enabled_classroom_count: state.classrooms.filter((r) => Number(r.enabled) === 1).length,
        device_count: state.devices.length,
        online_device_count: state.devices.filter((r) => r.online).length,
        active_session_count: state.sessions.filter((r) => r.status === "active").length,
        today_fault_count: state.faults.length,
        today_log_count: state.logs.length,
      },
    }),
    classroom_list: (payload) => {
      let rows = state.classrooms.filter((r) => !payload.keyword || `${r.classroom_code} ${r.classroom_name}`.includes(payload.keyword));
      if (payload.building_name) rows = rows.filter((r) => r.building_name === payload.building_name);
      if (payload.enabled === "1") rows = rows.filter((r) => Number(r.enabled) === 1);
      return page(rows, payload, (a, b) => b.id - a.id);
    },
    classroom_building_options: () => ({
      data: [...new Set(state.classrooms.map((r) => r.building_name).filter(Boolean))].sort().map((building_name) => ({ building_name })),
    }),
    classroom_options: () => ({
      data: state.classrooms.map((r) => ({
        id: r.id,
        node_code: nodeCode,
        classroom_name: r.classroom_name,
        classroom_code: r.classroom_code,
        building_name: r.building_name,
        enabled: r.enabled,
        device_count: state.devices.length,
        online_count: state.devices.filter((d) => d.online).length,
        using_count: 0,
      })),
    }),
    classroom_get: (payload) => {
      const room = state.classrooms.find((r) => String(r.id) === String(payload.id));
      if (!room) throw error("教室配置不存在。", 404);
      // 真实节点会统计该教室的在线台数和进行中会话，跨节点搬迁就靠这两个值把关。
      const devices = state.devices.filter((d) => String(d.classroom_id) === String(room.id));
      const machines = new Set(devices.map((d) => d.machine_id));
      return {
        ...room,
        online_count: devices.filter((d) => d.online).length,
        active_session_count: state.sessions.filter((s) => s.status === "active" && machines.has(s.machine_id)).length,
      };
    },
    classroom_save: (payload) => {
      if (!payload.classroom_code) throw error("请填写教室编号。", 400);
      if (!payload.classroom_name) throw error("请填写教室名称。", 400);
      if (payload.ip_start && !payload.ip_end) throw error("学生机IP段起始和结束地址需同时填写。", 400);
      const id = Number(payload.id) > 0 ? Number(payload.id) : nextId(state.classrooms);
      const row = {
        id,
        node_code: nodeCode,
        classroom_code: payload.classroom_code,
        classroom_name: payload.classroom_name,
        building_name: payload.building_name || null,
        ip_start: payload.ip_start || "",
        ip_end: payload.ip_end || "",
        teacher_ip: payload.teacher_ip || null,
        enabled: Number(payload.enabled) === 1 ? 1 : 0,
        out_time: Number(payload.out_time) || 10,
        allow_student_shutdown: Number(payload.allow_student_shutdown) === 1 ? 1 : 0,
      };
      const index = state.classrooms.findIndex((r) => r.id === id);
      if (index >= 0) state.classrooms[index] = row;
      else state.classrooms.push(row);
      log?.push({ nodeCode, action: "classroom_save", payload });
      return { classroom_id: id, message: "教室配置已保存" };
    },
    classroom_delete: (payload) => {
      const index = state.classrooms.findIndex((r) => String(r.id) === String(payload.id));
      if (index < 0) throw error("教室配置不存在。", 404);
      state.classrooms.splice(index, 1);
      log?.push({ nodeCode, action: "classroom_delete", payload });
      return { message: "删除成功" };
    },
    classroom_toggle: (payload) => {
      const room = state.classrooms.find((r) => String(r.id) === String(payload.id));
      if (!room) throw error("教室配置不存在。", 404);
      room.enabled = Number(payload.enabled) === 1 ? 1 : 0;
      log?.push({ nodeCode, action: "classroom_toggle", payload });
      return { id: room.id, enabled: room.enabled, message: room.enabled ? "教室已启用" : "教室已停用" };
    },
    devices_list: (payload) => {
      let rows = state.devices;
      if (payload.overview_status === "online") rows = rows.filter((r) => r.online);
      if (payload.overview_status === "offline") rows = rows.filter((r) => !r.online);
      if (payload.classroom_id && Number(payload.classroom_id) > 0) {
        rows = rows.filter((r) => String(r.classroom_id) === String(payload.classroom_id));
      }
      if (payload.keyword) rows = rows.filter((r) => `${r.machine_id} ${r.machine_name} ${r.ip_address}`.includes(payload.keyword));
      // 真实节点是 SELECT d.* 再左连会话，并补上 online_text / display_account，这里保持一致。
      const enriched = rows.map((row) => {
        const session = state.sessions.find((s) => s.id === row.current_session_id && s.machine_id === row.machine_id);
        const copy = {
          ...row,
          node_code: nodeCode,
          online_text: row.online ? "在线" : "离线",
          current_user_role: session?.user_role ?? null,
          student_no: session?.student_no ?? null,
          display_name: session?.name || row.current_user_name || null,
          teacher_code: null,
        };
        copy.display_account = copy.current_user_role === "teacher" ? copy.teacher_code || copy.student_no : copy.student_no;
        return copy;
      });
      return page(enriched, payload, (x, y) => String(y.last_seen_at).localeCompare(String(x.last_seen_at)));
    },
    device_command: (payload) => {
      if (payload.command_type !== "force_logout" && payload.command_type !== "shutdown") throw error("命令类型不正确。", 400);
      const device = state.devices.find((r) => r.machine_id === payload.machine_id);
      if (!device) throw error("设备不存在或不属于当前节点/教室。", 404);
      if (!device.online) {
        throw error(payload.command_type === "shutdown" ? "设备离线，不能执行远程关机。" : "设备离线，不能执行远程下机。", 400);
      }
      if (payload.command_type === "force_logout" && !device.using) throw error("设备当前未实名上机，不能执行下机。", 400);
      log?.push({ nodeCode, action: "device_command", payload });
      return { created: true, command_id: crypto.randomUUID().replaceAll("-", ""), message: payload.command_type === "shutdown" ? "远程关机指令已发送" : "远程下机指令已发送" };
    },
    classroom_shutdown: (payload) => {
      const room = state.classrooms.find((r) => String(r.id) === String(payload.classroom_id));
      if (!room) throw error("教室不存在或不属于当前节点。", 404);
      const online = state.devices.filter((d) => d.online);
      if (!online.length) throw error("当前教室没有在线电脑可关机。", 400);
      log?.push({ nodeCode, action: "classroom_shutdown", payload });
      return { total: online.length, created: online.length, duplicated: 0, message: "已发送当前教室关机指令" };
    },
    sessions_list: (payload) =>
      page(
        state.sessions.map((row) => {
          const copy = { ...row, teacher_code: null };
          copy.display_account = copy.user_role === "teacher" ? copy.teacher_code || copy.student_no : copy.student_no;
          return copy;
        }),
        payload,
        (a, b) => String(b.started_at).localeCompare(String(a.started_at)),
      ),
    logs_list: (payload) => {
      let rows = state.logs;
      if (payload.event_name) rows = rows.filter((r) => r.event_name === payload.event_name);
      if (payload.log_level) rows = rows.filter((r) => r.log_level === payload.log_level);
      return page(rows, payload, (a, b) => String(b.log_time).localeCompare(String(a.log_time)));
    },
    log_event_options: () => ({
      data: [...new Set(state.logs.map((r) => r.event_name))].sort().map((event_name) => ({ event_name })),
    }),
    fault_list: (payload) => {
      const rows = state.faults.map((row) => {
        const copy = { ...row, teacher_code: null };
        copy.display_account = copy.teacher_code || copy.student_no;
        return copy;
      });
      return page(rows, payload, (a, b) => String(b.createtime).localeCompare(String(a.createtime)));
    },
    get_config: () => ({
      server: { node_code: nodeCode, ...state.serverConfig },
      client: { node_code: nodeCode, ...state.clientConfig },
      watchdog: { node_code: nodeCode, ...state.watchdogConfig },
      program_fallbacks: { server: { ...state.serverConfig } },
      program_minimums: { server: { heartbeat_timeout_seconds: 30 }, client: { heartbeat_seconds: 3 }, watchdog: { check_seconds: 1 } },
    }),
    save_server_config: (payload) => {
      Object.assign(state.serverConfig, pick(payload, ["heartbeat_timeout_seconds", "heartbeat_write_interval_seconds", "offline_scan_seconds", "server_recovery_grace_minutes", "session_timeout_batch_size", "fault_cooldown_minutes"], true));
      log?.push({ nodeCode, action: "save_server_config", payload });
      return { message: "服务端配置已保存，后端服务短缓存内会自动生效" };
    },
    save_client_config: (payload) => {
      Object.assign(state.clientConfig, pick(payload, ["heartbeat_seconds", "fullscreen_enabled", "config_refresh_seconds"], true));
      log?.push({ nodeCode, action: "save_client_config", payload });
      return { message: "客户端配置已保存，后端服务短缓存内会自动生效" };
    },
    save_watchdog_config: (payload) => {
      if (!String(payload.client_path || "").trim()) throw error("请填写客户端EXE路径。", 400);
      state.watchdogConfig.client_path = payload.client_path;
      log?.push({ nodeCode, action: "save_watchdog_config", payload });
      return { message: "看门狗配置已保存，客户端策略刷新后生效" };
    },
  };

  function error(message, status) {
    const err = new Error(message);
    err.status = status;
    return err;
  }

  async function handle(req, res) {
    const url = new URL(req.url, "http://mock");
    if (req.method === "GET" && url.pathname === "/api/node/health") {
      if (String(req.headers["x-node-registration-key"] || "") !== registrationKey) {
        respond(res, 401, { ok: false, message: "后端节点注册密钥不正确。" });
        return;
      }
      respond(res, 200, {
        ok: true,
        runtime: "node",
        nodeCode,
        nodeVersion: "v24.0.0-mock",
        adminApiVersion: 2,
        metrics: {
          classroomCount: state.classrooms.length,
          cpuPercent: 12.5,
          memoryPercent: 40,
          onlineClientCount: state.devices.filter((d) => d.online).length,
          httpConnectionCount: 3,
        },
        programFallbacks: { server: { ...state.serverConfig } },
        programMinimums: { server: {}, client: {}, watchdog: {} },
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/node/admin") {
      const timestampText = String(req.headers["x-node-timestamp"] || "").trim();
      const signature = String(req.headers["x-node-signature"] || "").trim().toLowerCase();
      if (!/^\d{10}$/.test(timestampText) || !/^[a-f0-9]{64}$/.test(signature)) {
        respond(res, 401, { ok: false, message: "节点管理请求签名无效或已过期。" });
        return;
      }
      if (Math.abs(Math.floor(Date.now() / 1000) - Number(timestampText)) > 60) {
        respond(res, 401, { ok: false, message: "节点管理请求签名无效或已过期。" });
        return;
      }
      const rawBody = hasRawBody(req) ? req.rawBody : "";
      const expected = crypto.createHmac("sha256", registrationKey).update(`${timestampText}\n${rawBody}`, "utf8").digest("hex");
      if (expected !== signature) {
        respond(res, 401, { ok: false, message: "节点管理请求签名无效或已过期。" });
        return;
      }
      let request;
      try {
        request = JSON.parse(rawBody);
      } catch {
        respond(res, 400, { ok: false, message: "节点返回的数据格式不正确" });
        return;
      }
      const { action, payload = {} } = request || {};
      if (!ADMIN_ACTIONS.has(action) || !handlers[action]) {
        respond(res, 404, { ok: false, node_code: nodeCode, message: "不支持的节点管理操作。" });
        return;
      }
      try {
        const result = await handlers[action](payload);
        respond(res, 200, { ok: true, node_code: nodeCode, ...result });
      } catch (err) {
        respond(res, err.status || 400, { ok: false, node_code: nodeCode, message: err.message });
      }
      return;
    }

    respond(res, 404, { ok: false, message: "not found" });
  }

  return { handle, state, log };
}

function pick(payload, keys, numeric) {
  const out = {};
  for (const key of keys) {
    if (payload[key] === undefined) continue;
    out[key] = numeric ? Number(payload[key]) : payload[key];
  }
  return out;
}

function nextId(rows) {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1;
}

function page(rows, payload, compare) {
  const sorted = [...rows].sort(compare);
  const limit = Math.min(5000, Math.max(1, Number(payload.limit) || 20));
  const pageNum = Math.max(1, Number(payload.page) || 1);
  const offset = (pageNum - 1) * limit;
  return { data: sorted.slice(offset, offset + limit), count: sorted.length };
}

function respond(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}
