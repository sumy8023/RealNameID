import { config } from "./config.js";
import { execute, query } from "./db.js";
import { requestJson, NodeUnreachableError, NodeTimeoutError } from "./http.js";
import { NODE_CODE_RE, isReservedNodeCode, normalizeNodeAddress, text } from "./validate.js";

const table = `\`${config.tables.nodes}\``;

const CREATE_SQL = `CREATE TABLE IF NOT EXISTS ${table} (
  node_code VARCHAR(64) NOT NULL COMMENT '后端节点稳定编号，必须与后端配置中的节点编号一致' PRIMARY KEY,
  region_name VARCHAR(100) NOT NULL COMMENT '节点所属区域名称',
  node_address VARCHAR(500) NOT NULL COMMENT '后端服务地址，例如 http://127.0.0.1:14848',
  online_status TINYINT(1) NOT NULL DEFAULT 0 COMMENT '最近一次检测状态：1在线，0离线',
  last_check_at DATETIME NULL COMMENT '最近一次检测时间',
  last_error VARCHAR(500) NULL COMMENT '最近一次检测失败原因，在线时为空',
  register_key VARCHAR(128) NOT NULL COMMENT '访问节点检测与管理接口使用的注册密钥',
  is_default TINYINT(1) NOT NULL DEFAULT 0 COMMENT '是否为后台默认选中的节点：1是，0否',
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '最后更新时间'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='实名上机后端节点登记与管理状态表'`;

let tableReady = false;

// 老库可能没有 is_default，缺列时补一次；建表检查每个进程只做一遍。
export async function ensureNodesTable() {
  if (tableReady) {
    await normalizeDefaultNode();
    return;
  }
  await execute(CREATE_SQL);
  const columns = await query(`SHOW COLUMNS FROM ${table} LIKE 'is_default'`);
  if (!columns.length) {
    await execute(
      `ALTER TABLE ${table} ADD COLUMN is_default TINYINT(1) NOT NULL DEFAULT 0
       COMMENT '是否为后台默认选中的节点：1是，0否' AFTER register_key`,
    );
  }
  tableReady = true;
  await normalizeDefaultNode();
}

export async function normalizeDefaultNode() {
  const rows = await query(`SELECT COUNT(*) AS total FROM ${table} WHERE is_default = 1`);
  const total = rows[0]?.total || 0;
  if (total === 1) return;
  if (total === 0) {
    await assignFallbackDefaultNode();
    return;
  }
  const keep = await query(
    `SELECT node_code FROM ${table} WHERE is_default = 1
     ORDER BY updated_at DESC, region_name ASC, node_code ASC LIMIT 1`,
  );
  const code = keep[0]?.node_code;
  if (!code) return;
  await execute(`UPDATE ${table} SET is_default = CASE WHEN node_code = ? THEN 1 ELSE 0 END`, [code]);
}

export async function assignFallbackDefaultNode() {
  const rows = await query(
    `SELECT node_code FROM ${table} ORDER BY updated_at DESC, region_name ASC, node_code ASC LIMIT 1`,
  );
  const code = rows[0]?.node_code;
  if (code) {
    await execute(`UPDATE ${table} SET is_default = CASE WHEN node_code = ? THEN 1 ELSE 0 END`, [code]);
  }
}

export async function defaultNodeCode() {
  const rows = await query(
    `SELECT node_code FROM ${table} WHERE is_default = 1 ORDER BY updated_at DESC, node_code ASC LIMIT 1`,
  );
  return rows[0]?.node_code || "";
}

export async function preferredNodeCode() {
  const rows = await query(
    `SELECT node_code FROM ${table} ORDER BY is_default DESC, updated_at DESC, region_name ASC, node_code ASC LIMIT 1`,
  );
  return rows[0]?.node_code || "";
}

export async function registeredNode(nodeCode) {
  const code = String(nodeCode || "").trim();
  if (!code || isReservedNodeCode(code)) return null;
  const rows = await query(
    `SELECT node_code, region_name, node_address, register_key, is_default FROM ${table} WHERE node_code = ? LIMIT 1`,
    [code],
  );
  return rows[0] || null;
}

// 扇出用的节点集合：空 / ALL / GLOBAL 表示全部；编号格式非法表示没有可用节点。
// 注意这里不按 online_status 过滤，离线节点照样要试，否则状态一坏就再也看不到它。
export async function registeredNodes(requestedNodeCode = "") {
  const code = String(requestedNodeCode || "").trim();
  const upper = code.toUpperCase();
  if (code && upper !== "ALL" && upper !== "GLOBAL") {
    if (!NODE_CODE_RE.test(code)) return [];
    const rows = await query(
      `SELECT node_code, region_name, node_address, register_key FROM ${table}
       WHERE node_code = ? ORDER BY region_name ASC, node_code ASC`,
      [code],
    );
    return rows;
  }
  return query(
    `SELECT node_code, region_name, node_address, register_key FROM ${table}
     ORDER BY region_name ASC, node_code ASC`,
  );
}

export async function listNodeOptions() {
  return query(
    `SELECT node_code, region_name, node_address, online_status, last_check_at, last_error, is_default
     FROM ${table} ORDER BY is_default DESC, region_name ASC, node_code ASC`,
  );
}

export async function insertNode({ nodeCode, regionName, nodeAddress, registerKey }) {
  await execute(
    `INSERT INTO ${table} (node_code, region_name, node_address, online_status, last_check_at, last_error, register_key)
     VALUES (?, ?, ?, ?, NOW(), ?, ?)`,
    [nodeCode, regionName, nodeAddress, 1, null, registerKey],
  );
}

export async function updateNode({ nodeCode, regionName, nodeAddress, registerKey, online, errorMessage }) {
  await execute(
    `UPDATE ${table} SET region_name = ?, node_address = ?, register_key = ?,
       online_status = ?, last_check_at = NOW(), last_error = ?
     WHERE node_code = ?`,
    [regionName, nodeAddress, registerKey, online ? 1 : 0, online ? null : errorMessage, nodeCode],
  );
}

export async function makeNodeDefault(nodeCode) {
  await execute(`UPDATE ${table} SET is_default = 0 WHERE is_default <> 0`);
  await execute(`UPDATE ${table} SET is_default = 1 WHERE node_code = ?`, [nodeCode]);
}

export async function deleteNode(nodeCode) {
  await execute(`DELETE FROM ${table} WHERE node_code = ?`, [nodeCode]);
}

export async function nodeRowCount() {
  const rows = await query(`SELECT COUNT(*) AS total FROM ${table}`);
  return rows[0]?.total || 0;
}

// 状态回写显式自赋值 updated_at：ON UPDATE CURRENT_TIMESTAMP 只在该列未被显式赋值时触发。
// 若顶高了 updated_at，preferredNodeCode / defaultNodeCode 的排序会被轮询改写，默认节点会漂。
async function writeStatus(nodeCode, online, errorMessage) {
  await execute(
    `UPDATE ${table} SET online_status = ?, last_check_at = NOW(), last_error = ?, updated_at = updated_at
     WHERE node_code = ?`,
    [online ? 1 : 0, online ? null : errorMessage, nodeCode],
  );
}

function chinaNow() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

export async function probeNode(expectedNodeCode, address, registerKey) {
  const startedAt = Date.now();
  const normalized = normalizeNodeAddress(address);
  const fail = (message) => ({ online: false, message, latencyMs: round1(Date.now() - startedAt) });
  if (!normalized) return fail("后端地址配置不正确");
  if (!registerKey) return fail("未配置后端节点检测密钥");
  try {
    const response = await requestJson(`${normalized}/api/node/health`, {
      headers: { "X-Node-Registration-Key": registerKey },
      timeoutMs: config.node.probeTimeoutMs,
    });
    let data = null;
    try {
      data = JSON.parse(response.text);
    } catch {
      data = null;
    }
    if (response.status !== 200) {
      return fail(data && data.message ? data.message : `后端节点检测失败（HTTP ${response.status}）`);
    }
    if (!data || !data.ok) return fail("后端节点检测返回无效");
    const actual = text(data, "nodeCode");
    if (expectedNodeCode && actual && actual !== expectedNodeCode) {
      return fail("节点编号与后台登记不一致");
    }
    return {
      online: true,
      message: "后端服务运行中",
      nodeVersion: data.nodeVersion ? String(data.nodeVersion) : "",
      adminApiVersion: Number.parseInt(data.adminApiVersion, 10) || 0,
      metrics: data.metrics && typeof data.metrics === "object" ? data.metrics : {},
      programFallbacks: data.programFallbacks && typeof data.programFallbacks === "object" ? data.programFallbacks : {},
      programMinimums: data.programMinimums && typeof data.programMinimums === "object" ? data.programMinimums : {},
      latencyMs: round1(Date.now() - startedAt),
    };
  } catch (error) {
    if (error instanceof NodeTimeoutError) return fail("后端节点检测超时");
    if (error instanceof NodeUnreachableError) return fail("后端服务未启动或无法连接");
    return fail("后端节点检测失败");
  }
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

// 单个节点的对外状态：探测并回写缓存列，字段名在所有节点中保持一致。
export async function nodeStatus(node) {
  const probe = await probeNode(node.node_code, node.node_address, node.register_key);
  await writeStatus(node.node_code, probe.online, probe.message);
  const metrics = probe.metrics || {};
  return {
    online: !!probe.online,
    node_code: node.node_code || "",
    region_name: node.region_name || "",
    is_default: node.is_default ? 1 : 0,
    url: node.node_address || "",
    message: probe.message || "后端节点检测失败",
    node_version: probe.nodeVersion || "",
    admin_api_version: probe.adminApiVersion || 0,
    latency_ms: probe.latencyMs ?? null,
    metrics,
    classroom_count: Number.parseInt(metrics.classroomCount, 10) || 0,
    updated_at: node.updated_at ?? null,
    checked_at: chinaNow(),
  };
}

export async function refreshNodeStatuses(nodeCode = "") {
  await ensureNodesTable();
  const rows = nodeCode
    ? await query(`SELECT * FROM ${table} WHERE node_code = ? ORDER BY is_default DESC, region_name ASC, node_code ASC`, [nodeCode])
    : await query(`SELECT * FROM ${table} ORDER BY is_default DESC, region_name ASC, node_code ASC`);
  // 探测互不依赖，并发跑；单节点探测最多 probeTimeoutMs，全量节点不会再按个数线性叠加等待。
  return Promise.all(rows.map(nodeStatus));
}
