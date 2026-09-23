import { config } from "./config.js";
import { ApiError } from "./envelope.js";
import { NodeTimeoutError, requestJson } from "./http.js";
import { encodeRequestBody, nowTimestamp, sign } from "./signature.js";
import {
  NODE_CODE_RE,
  isReservedNodeCode,
  mergeScanCap,
  normalizeNodeAddress,
  pageLimit,
  text,
} from "./validate.js";
import { ensureNodesTable, preferredNodeCode, probeNode, registeredNode, registeredNodes } from "./nodes.js";

// 单个节点请求：签名、发送、校验身份，任何一步失败都抛 ApiError，文案与 PHP 保持一致。
export async function nodeAdminRequest(node, action, payload) {
  const address = normalizeNodeAddress(node.node_address);
  const registerKey = String(node.register_key || "").trim();
  if (!address || !registerKey) throw new ApiError("节点地址或注册密钥配置不正确");

  const rawBody = encodeRequestBody(action, payload);
  const timestamp = nowTimestamp();
  let response;
  try {
    response = await requestJson(`${address}/api/node/admin`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "X-Node-Timestamp": timestamp,
        "X-Node-Signature": sign(registerKey, timestamp, rawBody),
      },
      body: rawBody,
      timeoutMs: config.node.connectTimeoutMs + config.node.responseTimeoutMs,
    });
  } catch (error) {
    if (error instanceof NodeTimeoutError) throw new ApiError("节点数据库操作超时，未回退到PHP本地库");
    throw new ApiError("节点数据库代理不可用，请检查后端服务");
  }

  let data;
  try {
    data = JSON.parse(response.text);
  } catch {
    data = null;
  }
  if (!response.status) throw new ApiError("节点返回了无效的HTTP响应");
  if (!data || typeof data !== "object") throw new ApiError("节点返回的数据格式不正确");

  const actualNodeCode = text(data, "node_code");
  if (actualNodeCode && actualNodeCode !== node.node_code) {
    throw new ApiError("节点身份与后台登记不一致，已拒绝操作");
  }
  if (response.status !== 200 || !data.ok) {
    throw new ApiError(text(data, "message") || "节点数据库操作失败");
  }
  return data;
}

// 只探测、不写业务库；跨节点搬迁前用它确认两侧都支持管理接口 v2。
export async function requireNodeAdminVersion(nodeCode, minimumVersion = 2) {
  const node = await registeredNode(nodeCode);
  if (!node) throw new ApiError(`节点不存在：${nodeCode}`);
  const probe = await probeNode(nodeCode, node.node_address, node.register_key);
  if (!probe.online) throw new ApiError(`节点不可用：${nodeCode}，${probe.message}`);
  if ((probe.adminApiVersion || 0) < minimumVersion) {
    throw new ApiError(`节点 ${nodeCode} 后端版本过旧，请先升级到管理接口版本${minimumVersion}`);
  }
  return node;
}

// 写操作的节点定位：编号必填、必须已登记；preferFirst 时允许省略并回落到默认节点。
export async function resolveRequiredNode(params, { preferFirst = false } = {}) {
  await ensureNodesTable();
  let nodeCode = text(params, "node_code");
  if ((!nodeCode || nodeCode.toUpperCase() === "GLOBAL") && preferFirst) {
    nodeCode = await preferredNodeCode();
  }
  if (!nodeCode || isReservedNodeCode(nodeCode) || !NODE_CODE_RE.test(nodeCode)) {
    throw new ApiError("请选择有效的后端节点");
  }
  const node = await registeredNode(nodeCode);
  if (!node) throw new ApiError("节点不存在，请先在节点管理中登记并验证节点");
  return node;
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

// 扇出集合的公共前置：解析要打哪些节点，空集直接报错。
async function selectNodes(params) {
  await ensureNodesTable();
  const nodes = await registeredNodes(text(params, "node_code"));
  if (!nodes.length) throw new ApiError("没有可用的后端节点");
  return nodes;
}

function descending(a, b) {
  const an = Number(a);
  const bn = Number(b);
  const bothNumeric = a !== "" && b !== "" && Number.isFinite(an) && Number.isFinite(bn);
  if (bothNumeric) return bn - an;
  // 时间字段是 ISO 串，字典序即时间序；混排时把非数字一律按字符串倒序处理。
  const as = String(a ?? "");
  const bs = String(b ?? "");
  if (as === bs) return 0;
  return as < bs ? 1 : -1;
}

// 表格类：单节点直接下推分页；多节点各取前 offset+limit 行，再合并排序切片。
export async function fanOutTable({ params, action, payload, sortField }) {
  const nodes = await selectNodes(params);
  const { page, limit, offset } = pageLimit(params);
  if (offset >= config.merge.scanLimit) {
    throw new ApiError(`合并分页最多支持前 ${config.merge.scanLimit} 行，请缩小节点范围或筛选条件后重试`);
  }

  if (nodes.length === 1) {
    const node = nodes[0];
    const data = await nodeAdminRequest(node, action, { ...payload, page, limit });
    const list = (Array.isArray(data.data) ? data.data : []).map((row) => withNodeRegion(row, node));
    return { list, count: Number.parseInt(data.count, 10) || 0, msg: text(data, "message") || "获取成功" };
  }

  const scanLimit = mergeScanCap(offset, limit);
  const settled = await mapWithConcurrency(nodes, config.merge.concurrency, (node) =>
    nodeAdminRequest(node, action, { ...payload, page: 1, limit: scanLimit })
      .then((data) => ({
        node,
        count: Number.parseInt(data.count, 10) || 0,
        rows: (Array.isArray(data.data) ? data.data : []).map((row) => withNodeRegion(row, node)),
      }))
      .catch((error) => ({ node, failed: true, message: error.message })),
  );

  const all = [];
  const failed = [];
  let total = 0;
  for (const item of settled) {
    if (item.failed) {
      failed.push(item.node);
      continue;
    }
    total += item.count;
    all.push(...item.rows);
  }
  if (!all.length && failed.length === nodes.length) {
    throw new ApiError(`所有后端节点均不可用：${failed.map((n) => n.region_name).join("、")}`);
  }
  all.sort((a, b) => descending(a?.[sortField] ?? "", b?.[sortField] ?? ""));
  return {
    list: all.slice(offset, offset + limit),
    count: total,
    msg: failed.length ? `部分节点读取失败：${failed.map((n) => n.region_name).join("、")}` : "获取成功",
  };
}

// 下拉集合类：不分页、按业务键去重，先到先得；教室选项额外把主键命名空间成 节点编号@id。
export async function fanOutCollection({ params, action, payload, keyField, compositeKey = false }) {
  const nodes = await selectNodes(params);
  const settled = await mapWithConcurrency(nodes, config.merge.concurrency, (node) =>
    nodeAdminRequest(node, action, payload)
      .then((data) => ({ node, rows: Array.isArray(data.data) ? data.data : [] }))
      .catch((error) => ({ node, failed: true, message: error.message })),
  );

  const data = [];
  const seen = new Set();
  const failed = [];
  for (const item of settled) {
    if (item.failed) {
      failed.push(item.node);
      continue;
    }
    for (const raw of item.rows) {
      const row = { ...raw };
      if (!row.node_code) row.node_code = item.node.node_code;
      if (compositeKey) {
        row.raw_id = row.id ?? 0;
        row.id = `${item.node.node_code}@${row.raw_id}`;
      }
      const key = row[keyField];
      if (key === undefined || key === null || key === "") continue;
      if (seen.has(key)) continue;
      seen.add(key);
      data.push(row);
    }
  }
  if (!data.length && failed.length === nodes.length) {
    throw new ApiError(`所有后端节点均不可用：${failed.map((n) => n.region_name).join("、")}`);
  }
  return {
    data,
    msg: failed.length ? `部分节点读取失败：${failed.map((n) => n.region_name).join("、")}` : "获取成功",
  };
}

// 统计类：按固定键列表求和，并回一个成功节点数。
export async function fanOutStats({ params, action, payload, keys }) {
  const nodes = await selectNodes(params);
  const settled = await mapWithConcurrency(nodes, config.merge.concurrency, (node) =>
    nodeAdminRequest(node, action, payload).catch((error) => ({ failed: true, node, message: error.message })),
  );

  const sum = {};
  for (const key of keys) sum[key] = 0;
  const failed = [];
  for (const item of settled) {
    if (item.failed) {
      failed.push(item.node);
      continue;
    }
    for (const key of keys) {
      sum[key] += Number.parseInt(item?.data?.[key], 10) || 0;
    }
  }
  if (failed.length === nodes.length) {
    throw new ApiError(`所有后端节点均不可用：${failed.map((n) => n.region_name).join("、")}`);
  }
  sum.node_count = nodes.length - failed.length;
  return { data: sum, msg: failed.length ? `部分节点统计失败：${failed.map((n) => n.region_name).join("、")}` : "获取成功" };
}

function withNodeRegion(row, node) {
  const copy = { ...row };
  if (!copy.node_code) copy.node_code = node.node_code;
  copy._node_region_name = node.region_name;
  return copy;
}
