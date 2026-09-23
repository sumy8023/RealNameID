import http from "node:http";
import https from "node:https";

const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 64 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 64 });

// 一次节点请求的两种失败：连不上（服务没起/网络不通）和连上但没回（处理慢）。
// 上层要按不同文案回给后台，所以这里用错误码区分。
export class NodeUnreachableError extends Error {
  constructor(message) {
    super(message);
    this.code = "ENODEUNREACHABLE";
  }
}

export class NodeTimeoutError extends Error {
  constructor(message) {
    super(message);
    this.code = "ENODETIMEOUT";
  }
}

export function requestJson(url, { method = "GET", headers = {}, body, timeoutMs = 3000 } = {}) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(url);
    } catch {
      reject(new NodeUnreachableError("地址格式不正确"));
      return;
    }
    const isHttps = target.protocol === "https:";
    const lib = isHttps ? https : http;
    const payload = body === undefined ? null : Buffer.from(body, "utf8");
    const request = lib.request(
      {
        agent: isHttps ? httpsAgent : httpAgent,
        method,
        hostname: target.hostname,
        port: target.port || (isHttps ? 443 : 80),
        path: `${target.pathname}${target.search}`,
        headers: {
          ...headers,
          ...(payload ? { "Content-Length": payload.length } : {}),
        },
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          resolve({
            status: response.statusCode || 0,
            text: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    request.setTimeout(timeoutMs, () => {
      request.destroy(new NodeTimeoutError("节点响应超时"));
    });
    request.on("error", (error) => {
      reject(
        error instanceof NodeTimeoutError
          ? error
          : new NodeUnreachableError(error.code === "ECONNREFUSED" ? "连接被拒绝" : "连接失败"),
      );
    });
    if (payload) request.write(payload);
    request.end();
  });
}
