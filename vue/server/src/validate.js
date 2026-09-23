import { config } from "./config.js";

export const NODE_CODE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export const COMPOSITE_ID_RE = /^([A-Za-z0-9][A-Za-z0-9_-]{0,63})@(\d+)$/;

// 浏览器可能用 query、表单或 JSON 提交，统一成一份参数表。
export function readParams(req) {
  return { ...(req.query || {}), ...(req.body || {}) };
}

export function text(params, key, fallback = "") {
  const value = params?.[key];
  if (value === undefined || value === null || typeof value === "object") return fallback;
  return String(value).trim();
}

export function numberValue(params, key, { fallback = 0, min = null, max = null } = {}) {
  const raw = params?.[key];
  const parsed = raw === undefined || raw === null || raw === "" ? Number.NaN : Number.parseInt(String(raw), 10);
  let value = Number.isFinite(parsed) ? parsed : Number.parseInt(fallback, 10) || 0;
  if (min !== null && value < min) value = min;
  if (max !== null && value > max) value = max;
  return value;
}

// 布尔参数只有明确的真值算开，其余（含空串、"false"）一律关。
export function boolValue(params, key, fallback = 0) {
  const raw = params?.[key];
  if (raw === undefined || raw === null) return fallback ? 1 : 0;
  if (typeof raw === "boolean") return raw ? 1 : 0;
  const value = String(raw).trim();
  return value === "true" || value === "on" || value === "1" ? 1 : 0;
}

export function pageLimit(params) {
  const limit = numberValue(params, "limit", { fallback: 20, min: 1, max: 500 });
  const page = numberValue(params, "page", { fallback: 1, min: 1 });
  return { page, limit, offset: (page - 1) * limit };
}

// 日期参数统一认 `date`（"YYYY-MM-DD - YYYY-MM-DD"），并兼容 start_date/end_date 写法，
// 将三种输入统一折成节点认识的 `date`。
export function dateFilter(params) {
  const raw = text(params, "date");
  if (raw) {
    const normalized = raw.replace(/\s*~\s*/g, " - ").replace(/\s+-\s+/g, " - ");
    const parts = normalized.split(" - ").filter(Boolean);
    const start = /^\d{4}-\d{2}-\d{2}$/.test(parts[0] || "") ? parts[0] : "";
    const end = /^\d{4}-\d{2}-\d{2}$/.test(parts[1] || parts[0] || "") ? (parts[1] || parts[0]) : "";
    if (start && end) return { date: `${start} - ${end}` };
    if (start) return { date: `${start} - ${start}` };
  }
  const start = text(params, "start_date");
  const end = text(params, "end_date");
  if (/^\d{4}-\d{2}-\d{2}$/.test(start) && /^\d{4}-\d{2}-\d{2}$/.test(end)) return { date: `${start} - ${end}` };
  return {};
}

// 用筛选后参数替换原始参数：只保留有值的键，避免把空串当成有效筛选发给节点。
export function buildFilterPayload(params) {
  const payload = {};
  for (const key of ["keyword", "status", "type", "event_name", "operator_name", "log_level", "log_source",
    "user_role", "device_role", "classroom_name", "classroom_code", "building_name", "source", "enabled",
    "overview_status"]) {
    const value = text(params, key);
    if (value !== "") payload[key] = value;
  }
  const classroomId = text(params, "classroom_id");
  if (classroomId !== "") payload.classroom_id = classroomId;
  const online = text(params, "online");
  if (online === "1" || online === "0") payload.online = online;
  Object.assign(payload, dateFilter(params));
  return payload;
}

export function normalizeNodeAddress(value) {
  const raw = String(value || "").trim().replace(/\/+$/, "");
  if (!raw) return "";
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return "";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
  if (!parsed.hostname) return "";
  // 内嵌账号密码的地址会让凭据泄漏在 URL 里，直接拒。
  if (parsed.username || parsed.password) return "";
  return raw;
}

export function isReservedNodeCode(value) {
  const upper = String(value || "").toUpperCase();
  return upper === "GLOBAL" || upper === "ALL";
}

export function nodeCodeOf(params) {
  return text(params, "node_code");
}

// 教室在跨节点场景下用 `节点编号@数字id` 定位，拆开后可直接决定该请求打到哪个节点。
export function splitCompositeClassroom(params) {
  const raw = text(params, "classroom_id");
  const matched = COMPOSITE_ID_RE.exec(raw);
  if (!matched) return { nodeCode: nodeCodeOf(params), classroomId: raw };
  return { nodeCode: matched[1], classroomId: matched[2] };
}

export function mergeScanCap(offset, limit) {
  return Math.min(config.merge.scanLimit, offset + limit);
}
