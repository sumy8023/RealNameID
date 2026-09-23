import process from "node:process";
import { config } from "./config.js";
import { closePool, query } from "./db.js";
import { ensureNodesTable } from "./nodes.js";
import { createApp } from "./app.js";

async function start() {
  // 节点登记表是 BFF 唯一的本地写库，启动时就确认连得上、建得起，
  // 问题当场暴露，而不是等管理员第一次点"节点管理"才发现。
  await query("SELECT 1 AS ok");
  await ensureNodesTable();
  const app = createApp();
  const server = app.listen(config.server.port, "0.0.0.0");
  server.on("error", (error) => {
    console.error(
      error?.code === "EADDRINUSE"
        ? `端口 ${config.server.port} 已被占用，请先结束占用该端口的进程后再启动。`
        : "管理后台启动失败",
      error,
    );
    process.exit(1);
  });
  server.on("listening", () => {
    console.log(`实名上机管理后台已启动：http://0.0.0.0:${config.server.port}`);
    console.log(`节点登记表：${config.mysql.database}.${config.tables.nodes}`);
  });
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      server.close(() => {
        void closePool().finally(() => process.exit(0));
      });
    });
  }
}

start().catch((error) => {
  console.error("管理后台启动失败", error);
  process.exit(1);
});
