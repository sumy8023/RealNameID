import { port } from "./runtime.js";
import { createApp } from "./routes.js";
import { ensureSchema } from "./schema.js";
import { closeTimedOutSessions, startSessionTimeoutScanner } from "./services.js";
import { consoleError, consoleInfo, writeError } from "./utils.js";
import { setHttpServer } from "./nodeMetrics.js";

// server.js 是后端启动入口，只负责启动顺序编排。
// 具体数据库结构放在 schema.js，业务逻辑放在 services.js，接口定义放在 routes.js。
async function start() {
  // 初始化数据库结构：建表、补字段、迁移旧表名和旧字段。
  await ensureSchema();

  // 先处理一次历史超时会话，避免后端重启后旧 active 会话长期挂着。
  await closeTimedOutSessions();

  // 启动后台定时扫描器，按配置周期把超时未心跳的 active 会话改为 timeout。
  startSessionTimeoutScanner();

  // 创建 Express 应用，路由、中间件和错误处理都在 routes.js 内部注册。
  const app = createApp();

  // 等待监听真正成功，使端口占用等异步监听错误能进入统一启动异常处理。
  const httpServer = await new Promise((resolve, reject) => {
    const server = app.listen(port, "0.0.0.0");
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve(server);
    };
    server.once("error", onError);
    server.once("listening", onListening);
  });
  setHttpServer(httpServer);
  // 只打印必要的启动信息，数据库和教室明细不输出到控制台。
  consoleInfo("实名上机后端已启动", `监听地址：http://0.0.0.0:${port}`);
}

// 捕获启动阶段的任何异常，例如数据库连不上、表结构迁移失败、端口占用等。
start().catch((error) => {
  const startupError = error?.code === "EADDRINUSE"
    ? new Error(`端口 ${port} 已被占用，请先结束占用该端口的进程后再启动。`)
    : error;
  // 同时写入错误日志和控制台，最后退出进程，避免后端处于半启动状态。
  writeError(startupError);
  consoleError("后端启动失败", startupError);
  process.exit(1);
});
