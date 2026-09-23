// 响应外壳统一包含 code、msg、data 和 count，前端不需要为不同实现写分支。
// 关键差异点：ajaxOk 把 data 平铺到顶层，不包一层 data。

// 业务失败：message 直接进外壳的 msg 字段，httpStatus 只在鉴权等少数场景用非 200。
export class ApiError extends Error {
  constructor(message, httpStatus = 200) {
    super(message);
    this.name = "ApiError";
    this.httpStatus = httpStatus;
  }
}


const ISO_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i;
const CHINA_OFFSET_MS = 8 * 3600 * 1000;

function pad(value) {
  return String(value).padStart(2, "0");
}

// 节点用 mysql2 返回 ISO-UTC 字符串，界面要的是东八区墙钟时间。
export function localizeTimes(value) {
  if (Array.isArray(value)) return value.map(localizeTimes);
  if (value instanceof Date) return formatChina(value.getTime());
  if (typeof value === "string") {
    return ISO_TIME_RE.test(value) ? formatChina(Date.parse(value)) : value;
  }
  if (value && typeof value === "object") {
    const result = {};
    for (const [key, item] of Object.entries(value)) result[key] = localizeTimes(item);
    return result;
  }
  return value;
}

function formatChina(ms) {
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms + CHINA_OFFSET_MS);
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
  );
}

export function sendOk(res, data, msg = "操作成功") {
  const body = { code: 0, msg };
  if (data && typeof data === "object") {
    for (const [key, value] of Object.entries(data)) body[key] = value;
  }
  res.json(localizeTimes(body));
}

export function sendFail(res, msg = "操作失败", status = 200) {
  res.status(status).json({ code: 1, msg });
}

export function sendTable(res, list, count, msg = "获取成功") {
  res.json(
    localizeTimes({
      code: 0,
      msg,
      count: Number.parseInt(count, 10) || 0,
      data: Array.isArray(list) ? list : [],
    }),
  );
}
