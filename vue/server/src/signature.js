import crypto from "node:crypto";

// 节点只信任它自己配置里的注册密钥，签名原文是 `${timestamp}\n${rawBody}`。
// rawBody 必须和实际发出的字节完全一致，所以这里先序列化成字符串再签、再发同一个字符串。
export function encodeRequestBody(action, payload) {
  return JSON.stringify({ action, payload });
}

export function sign(secret, timestamp, rawBody) {
  return crypto.createHmac("sha256", secret).update(`${timestamp}\n${rawBody}`, "utf8").digest("hex");
}

export function nowTimestamp() {
  return String(Math.floor(Date.now() / 1000));
}

// 请求侧因为 DEFAULT_FILTER=htmlspecialchars 会把收到的参数转义一遍，转发前要解码；
// BFF 不做全局转义，浏览器提交什么就是什么，所以这里只需剔除缓存位和数组型参数。
export function buildPayload(source, { operatorName } = {}) {
  const payload = {};
  for (const [key, value] of Object.entries(source || {})) {
    if (key === "_t") continue;
    if (value === null || typeof value === "object") continue;
    payload[key] = String(value);
  }
  if (operatorName) payload.operator_name = operatorName;
  return payload;
}
