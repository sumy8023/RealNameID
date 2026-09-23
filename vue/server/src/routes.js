import express from "express";
import { config } from "./config.js";
import {
  authRequired,
  destroySession,
  login,
  readToken,
} from "./auth.js";
import { ApiError, sendOk, sendTable } from "./envelope.js";
import {
  assignFallbackDefaultNode,
  defaultNodeCode,
  deleteNode,
  ensureNodesTable,
  insertNode,
  listNodeOptions,
  makeNodeDefault,
  probeNode,
  refreshNodeStatuses,
  registeredNode,
  updateNode,
} from "./nodes.js";
import {
  fanOutCollection,
  fanOutStats,
  fanOutTable,
  nodeAdminRequest,
  requireNodeAdminVersion,
  resolveRequiredNode,
} from "./proxy.js";
import { buildPayload } from "./signature.js";
import { transaction } from "./db.js";
import {
  NODE_CODE_RE,
  boolValue,
  buildFilterPayload,
  isReservedNodeCode,
  numberValue,
  normalizeNodeAddress,
  readParams,
  splitCompositeClassroom,
  text,
} from "./validate.js";

const STATS_KEYS = [
  "classroom_count",
  "enabled_classroom_count",
  "device_count",
  "online_device_count",
  "active_session_count",
  "today_fault_count",
  "today_log_count",
];

// 供写操作透传：浏览器提交什么就转给节点什么，由节点做最终夹取，和 PHP 的行为一致。
function forwardPayload(req) {
  return buildPayload(readParams(req));
}

// 写操作默认原样透传浏览器参数；overrides 用于复合教室ID这类需要在转发前改写的定位参数，
// 否则节点会收到 "TESTA@12" 这种它解析不了的值。
function operatorPayload(req, overrides = {}) {
  const payload = buildPayload(readParams(req), { operatorName: req.admin.adminName || "Vue后台" });
  return Object.assign(payload, overrides);
}

export function createRouter() {
  const router = express.Router();

  router.post("/login", async (req, res) => {
    const params = readParams(req);
    const { token, user } = await login({
      userName: text(params, "admin_name") || text(params, "username"),
      password: text(params, "admin_pass") || text(params, "password"),
      ipAddress: req.ip,
    });
    res.setHeader(
      "Set-Cookie",
      `${config.auth.cookieName}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${config.auth.ttlSeconds}`,
    );
    sendOk(res, { user: { admin_name: user.admin_name, admin_xm: user.admin_xm, post: user.post } }, "登陆成功，欢迎回来");
  });

  router.post("/logout", (req, res) => {
    destroySession(readToken(req));
    res.setHeader("Set-Cookie", `${config.auth.cookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
    sendOk(res, {}, "已退出登录");
  });

  router.get("/me", authRequired, (req, res) => {
    sendOk(res, {
      user: { admin_name: req.admin.adminName, admin_xm: req.admin.adminXm, post: req.admin.post },
    });
  });

  router.use(authRequired);

  // ---------- 节点管理 ----------

  router.all("/node_status", async (req, res) => {
    const params = readParams(req);
    const requested = text(params, "node_code");
    // 编号写错不等于"只查这个节点"，按 PHP 的 listNodeInput 语义退化成查全部。
    const effective = requested && NODE_CODE_RE.test(requested) && !isReservedNodeCode(requested) ? requested : "";
    const nodes = await refreshNodeStatuses(effective);
    const onlineCount = nodes.filter((item) => item.online).length;
    sendOk(
      res,
      {
        status: {
          online: onlineCount > 0,
          online_count: onlineCount,
          node_count: nodes.length,
          nodes,
          message: onlineCount > 0 ? "后端节点运行中" : "没有可用的后端节点",
        },
        nodes,
      },
      "获取成功",
    );
  });

  router.get("/node_options", async (req, res) => {
    await ensureNodesTable();
    sendOk(res, { data: await listNodeOptions(), default_node_code: await defaultNodeCode() }, "获取成功");
  });

  router.post("/node_save", async (req, res) => {
    await ensureNodesTable();
    const params = readParams(req);
    const original = text(params, "original_node_code");
    const nodeCode = text(params, "node_code");
    const regionName = text(params, "region_name");
    const nodeAddress = normalizeNodeAddress(text(params, "node_address"));
    let registerKey = text(params, "register_key");

    if (!NODE_CODE_RE.test(nodeCode) || nodeCode.toUpperCase() === "GLOBAL") {
      throw new ApiError("节点编号格式不正确，且不能使用 GLOBAL");
    }
    if (!regionName || Buffer.byteLength(regionName, "utf8") > 100) {
      throw new ApiError("请填写有效的区域名称");
    }
    if (!nodeAddress) throw new ApiError("后端地址必须是有效的 http 或 https 地址");
    if (original && original !== nodeCode) {
      throw new ApiError("节点编号是稳定标识，不能直接修改；请删除登记后按新编号重新添加");
    }

    const existing = await registeredNode(nodeCode);
    const storedKey = existing ? String(existing.register_key || "").trim() : "";
    // 编辑时留空表示"沿用原来那份密钥"，而不是把密钥清空——否则一次误操作就会把节点锁死。
    if (existing && !registerKey) registerKey = storedKey;
    if (!/^[A-Za-z0-9]{6,128}$/.test(registerKey)) {
      throw new ApiError("注册密钥需使用6到128位英文字母和数字");
    }

    const probe = await probeNode(nodeCode, nodeAddress, registerKey);
    if (!existing && !probe.online) {
      throw new ApiError(`节点注册校验失败：${probe.message || "后端节点不可用"}`);
    }
    if (existing && registerKey !== storedKey && !probe.online) {
      throw new ApiError(`新注册密钥校验失败：${probe.message || "后端节点不可用"}`);
    }

    if (existing) {
      await updateNode({
        nodeCode,
        regionName,
        nodeAddress,
        registerKey,
        online: probe.online,
        errorMessage: probe.message,
      });
    } else {
      await insertNode({ nodeCode, regionName, nodeAddress, registerKey });
    }
    if (!(await defaultNodeCode())) {
      await makeNodeDefault(nodeCode);
    }

    let msg = probe.online ? "节点已保存并验证在线" : `节点已保存，但当前离线：${probe.message}`;
    if (probe.online) {
      const adminReady = await nodeAdminRequest(
        { node_code: nodeCode, node_address: nodeAddress, register_key: registerKey },
        "get_config",
        {},
      ).catch(() => null);
      if (!adminReady) msg = "节点已保存，但节点管理接口不可用，请先部署新版后端";
    }
    sendOk(res, { node_code: nodeCode }, msg);
  });

  router.post("/node_check", async (req, res) => {
    await ensureNodesTable();
    const nodeCode = text(readParams(req), "node_code");
    if (!(await registeredNode(nodeCode))) throw new ApiError("节点不存在");
    const [status] = await refreshNodeStatuses(nodeCode);
    sendOk(res, { status }, "检测完成");
  });

  router.post("/node_delete", async (req, res) => {
    await ensureNodesTable();
    const nodeCode = text(readParams(req), "node_code");
    if (!nodeCode || nodeCode.toUpperCase() === "GLOBAL") throw new ApiError("不能删除 GLOBAL 默认配置");
    // PHP 删不存在的编号也会回成功，这里改成明确拒绝。
    const node = await registeredNode(nodeCode);
    if (!node) throw new ApiError("节点不存在");
    await deleteNode(nodeCode);
    if (node.is_default) await assignFallbackDefaultNode();
    sendOk(res, {}, "节点登记已删除，配置和教室绑定已保留");
  });

  router.post("/node_set_default", async (req, res) => {
    await ensureNodesTable();
    const nodeCode = text(readParams(req), "node_code");
    if (!(await registeredNode(nodeCode))) throw new ApiError("节点不存在");
    await transaction(async () => {
      await makeNodeDefault(nodeCode);
    });
    sendOk(res, { node_code: nodeCode }, "默认节点已设置");
  });

  // ---------- 总览 ----------

  router.get("/stats", async (req, res) => {
    const { data, msg } = await fanOutStats({
      params: readParams(req),
      action: "stats",
      payload: {},
      keys: STATS_KEYS,
    });
    sendOk(res, { data }, msg);
  });

  // ---------- 配置 ----------

  router.get("/get_config", async (req, res) => {
    const node = await resolveRequiredNode(readParams(req), { preferFirst: true });
    const data = await nodeAdminRequest(node, "get_config", forwardPayload(req));
    const remoteFallbacks = data.program_fallbacks && typeof data.program_fallbacks === "object" ? data.program_fallbacks : {};
    const remoteMinimums = data.program_minimums && typeof data.program_minimums === "object" ? data.program_minimums : {};
    sendOk(
      res,
      {
        node_code: data.node_code || node.node_code,
        server: data.server || {},
        client: data.client || {},
        watchdog: data.watchdog || {},
        program_fallbacks: {
          server: remoteFallbacks.server || {},
          client: config.programFallbacks.client,
          watchdog: config.programFallbacks.watchdog,
        },
        program_minimums: {
          server: { ...config.programMinimums.server, ...(remoteMinimums.server || {}) },
          client: { ...config.programMinimums.client, ...(remoteMinimums.client || {}) },
          watchdog: { ...config.programMinimums.watchdog, ...(remoteMinimums.watchdog || {}) },
        },
      },
      "获取成功",
    );
  });

  for (const action of ["save_server_config", "save_client_config", "save_watchdog_config"]) {
    router.post(`/${action}`, async (req, res) => {
      const node = await resolveRequiredNode(readParams(req));
      const data = await nodeAdminRequest(node, action, operatorPayload(req));
      sendOk(res, { node_code: data.node_code || node.node_code }, text(data, "message") || "操作成功");
    });
  }

  // ---------- 教室 ----------

  router.get("/classroom_list", async (req, res) => {
    const params = readParams(req);
    const { list, count, msg } = await fanOutTable({
      params,
      action: "classroom_list",
      payload: buildFilterPayload(params),
      sortField: "id",
    });
    sendTable(res, list, count, msg);
  });

  router.get("/classroom_options", async (req, res) => {
    const params = readParams(req);
    const { data, msg } = await fanOutCollection({
      params,
      action: "classroom_options",
      payload: buildFilterPayload(params),
      keyField: "id",
      compositeKey: true,
    });
    sendOk(res, { data }, msg);
  });

  router.get("/classroom_building_options", async (req, res) => {
    const params = readParams(req);
    const { data, msg } = await fanOutCollection({
      params,
      action: "classroom_building_options",
      payload: buildFilterPayload(params),
      keyField: "building_name",
    });
    sendOk(res, { data }, msg);
  });

  // 跨节点搬迁：源节点读全量 → 目标节点建新行 → 源节点删旧行，中途失败做补偿删除。
  async function moveClassroom(req, res, sourceCode, targetCode) {
    const params = readParams(req);
    const id = numberValue(params, "id", { fallback: 0, min: 0 });
    const source = await requireNodeAdminVersion(sourceCode);
    const target = await requireNodeAdminVersion(targetCode);
    const sourceRow = await nodeAdminRequest(source, "classroom_get", { id }).catch((error) => {
      throw new ApiError(`源节点教室读取失败：${error.message}`);
    });
    if (Number(sourceRow.online_count) > 0 || Number(sourceRow.active_session_count) > 0) {
      throw new ApiError("该教室仍有在线电脑或进行中的会话，暂不能跨节点移动");
    }

    const payload = { ...operatorPayload(req), id: 0, node_code: targetCode };
    const created = await nodeAdminRequest(target, "classroom_save", payload).catch((error) => {
      throw new ApiError(`目标节点校验或创建失败：${error.message}`);
    });
    const newId = created.classroom_id;
    try {
      await nodeAdminRequest(source, "classroom_delete", { id, operator_name: req.admin.adminName });
    } catch (error) {
      if (!newId) throw new ApiError(`源节点删除失败：${error.message}`);
      const rolledBack = await nodeAdminRequest(target, "classroom_delete", { id: newId }).then(() => true).catch(() => false);
      throw new ApiError(
        rolledBack
          ? `源节点删除失败，已撤销目标节点创建：${error.message}`
          : "源节点删除失败，目标节点补偿删除也失败；源数据仍保留，请检查目标节点是否存在重复教室",
      );
    }
    sendOk(
      res,
      { moved: 1, from_node_code: sourceCode, to_node_code: targetCode },
      `教室已从 ${sourceCode} 移动到 ${targetCode}`,
    );
  }

  router.post("/classroom_save", async (req, res) => {
    const params = readParams(req);
    const id = numberValue(params, "id", { fallback: 0, min: 0 });
    const sourceCode = text(params, "original_node_code");
    const node = await resolveRequiredNode(params);
    if (id > 0 && sourceCode && sourceCode.toUpperCase() !== "GLOBAL" && sourceCode !== node.node_code) {
      await moveClassroom(req, res, sourceCode, node.node_code);
      return;
    }
    const data = await nodeAdminRequest(node, "classroom_save", operatorPayload(req));
    sendOk(res, { node_code: data.node_code || node.node_code, classroom_id: data.classroom_id }, text(data, "message") || "教室配置已保存");
  });

  router.post("/classroom_toggle", async (req, res) => {
    const params = readParams(req);
    const id = numberValue(params, "id", { fallback: 0, min: 0 });
    if (id < 1) throw new ApiError("教室ID无效");
    const node = await resolveRequiredNode(params);
    const data = await nodeAdminRequest(node, "classroom_toggle", {
      ...operatorPayload(req),
      id,
      enabled: boolValue(params, "enabled"),
    });
    sendOk(
      res,
      { node_code: data.node_code || node.node_code, id, enabled: Number(data.enabled ?? boolValue(params, "enabled")) },
      text(data, "message") || (Number(data.enabled) === 1 ? "教室已启用" : "教室已停用"),
    );
  });

  router.post("/classroom_delete", async (req, res) => {
    const params = readParams(req);
    const id = numberValue(params, "id", { fallback: 0, min: 0 });
    if (id < 1) throw new ApiError("教室ID无效");
    const node = await resolveRequiredNode(params);
    const data = await nodeAdminRequest(node, "classroom_delete", { ...operatorPayload(req), id });
    sendOk(res, { node_code: data.node_code || node.node_code }, text(data, "message") || "删除成功");
  });

  // ---------- 设备 ----------

  router.get("/devices_list", async (req, res) => {
    const params = readParams(req);
    // 教室用 节点编号@数字id 定位时，这一次请求其实只能落到那一个节点上。
    const { nodeCode, classroomId } = splitCompositeClassroom(params);
    const scoped = { ...params, node_code: nodeCode, classroom_id: classroomId };
    const { list, count, msg } = await fanOutTable({
      params: scoped,
      action: "devices_list",
      payload: buildFilterPayload(scoped),
      sortField: "last_seen_at",
    });
    sendTable(res, list, count, msg);
  });

  router.post("/device_command", async (req, res) => {
    const params = readParams(req);
    const commandType = text(params, "command_type");
    if (commandType !== "force_logout" && commandType !== "shutdown") throw new ApiError("命令类型不正确。");
    if (!text(params, "machine_id")) throw new ApiError("缺少设备标识。");
    const node = await resolveRequiredNode(params);
    const data = await nodeAdminRequest(node, "device_command", operatorPayload(req));
    sendOk(res, {
      node_code: data.node_code || node.node_code,
      created: !!data.created,
      command_id: data.command_id || "",
    }, text(data, "message") || "指令已发送");
  });

  router.post("/classroom_shutdown", async (req, res) => {
    const params = readParams(req);
    const { nodeCode, classroomId } = splitCompositeClassroom(params);
    const scoped = { ...params, node_code: nodeCode, classroom_id: classroomId };
    if (numberValue(scoped, "classroom_id", { fallback: 0, min: 0 }) < 1) throw new ApiError("教室ID无效");
    const node = await resolveRequiredNode(scoped);
    const data = await nodeAdminRequest(node, "classroom_shutdown", operatorPayload(req, { classroom_id: classroomId }));
    sendOk(res, {
      node_code: data.node_code || node.node_code,
      total: Number(data.total) || 0,
      created: Number(data.created) || 0,
      duplicated: Number(data.duplicated) || 0,
    }, text(data, "message") || "已发送当前教室关机指令");
  });

  // ---------- 记录 ----------

  const tables = [
    { path: "sessions_list", action: "sessions_list", sortField: "started_at" },
    { path: "logs_list", action: "logs_list", sortField: "log_time" },
    { path: "fault_list", action: "fault_list", sortField: "createtime" },
  ];
  for (const item of tables) {
    router.get(`/${item.path}`, async (req, res) => {
      const params = readParams(req);
      const { list, count, msg } = await fanOutTable({
        params,
        action: item.action,
        payload: buildFilterPayload(params),
        sortField: item.sortField,
      });
      sendTable(res, list, count, msg);
    });
  }

  router.get("/log_event_options", async (req, res) => {
    const { data, msg } = await fanOutCollection({
      params: readParams(req),
      action: "log_event_options",
      payload: {},
      keyField: "event_name",
    });
    sendOk(res, { data }, msg);
  });

  return router;
}
