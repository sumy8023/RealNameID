import { ElMessage } from "element-plus";

// BFF 的外壳是 {code, msg, ...平铺字段}；code 非 0 一律当失败抛出去，
// 页面里就只需要写成功分支。
export class ApiError extends Error {
  constructor(message, payload) {
    super(message);
    this.name = "ApiError";
    this.payload = payload;
  }
}

const listeners = new Set();

export function onUnauthorized(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

async function call(method, action, params = {}, { silent = false } = {}) {
  const query = method === "GET" ? toQuery(params) : "";
  const url = `/api/${action}${query ? `?${query}` : ""}`;
  const headers = {};
  let body;
  if (method !== "GET") {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(clean(params));
  }
  const response = await fetch(url, { method, headers, body, credentials: "same-origin" });
  let payload;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (response.status === 401) {
    const message = payload?.msg || "登录已失效，请重新登录";
    for (const listener of listeners) listener(message);
    throw new ApiError(message, payload);
  }
  if (!payload || payload.code !== 0) {
    const message = payload?.msg || `请求失败（HTTP ${response.status}）`;
    if (!silent) ElMessage.error(message);
    throw new ApiError(message, payload);
  }
  return payload;
}

function clean(params) {
  const out = {};
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null || value === "") continue;
    out[key] = typeof value === "boolean" ? (value ? "1" : "0") : String(value);
  }
  return out;
}

function toQuery(params) {
  const fields = new URLSearchParams();
  const values = clean({ ...params, _t: Date.now() });
  for (const [key, value] of Object.entries(values)) fields.set(key, value);
  return fields.toString();
}

export const api = {
  user: null,
  checked: false,
  get: (action, params) => call("GET", action, params),
  post: (action, params, options) => call("POST", action, params, options),
};
