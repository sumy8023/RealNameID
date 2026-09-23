import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { config } from "./config.js";
import { ApiError } from "./envelope.js";
import { createRouter } from "./routes.js";

const entryDir = path.dirname(fileURLToPath(import.meta.url));

// 静态目录有两种落点：开发时 src/app.js 往上一级是 vue/server/web（vite 直接输出到这里），
// 发布包里 server.js 与 web 同级。两种都试，取真实存在的那个，
// 免得把 webRoot 写成只在某一种形态下才对的路径。
function resolveWebRoot() {
  if (!config.server.webRoot) return "";
  if (path.isAbsolute(config.server.webRoot)) return config.server.webRoot;
  const candidates = [
    path.join(entryDir, config.server.webRoot),
    path.join(entryDir, "..", config.server.webRoot),
  ];
  return candidates.find((candidate) => fs.existsSync(path.join(candidate, "index.html"))) || candidates[candidates.length - 1];
}

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "512kb" }));
  app.use(express.urlencoded({ extended: false, limit: "512kb" }));
  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, runtime: "admin-server" });
  });
  app.use("/api", createRouter());

  const webRoot = resolveWebRoot();
  if (webRoot) {
    app.use(express.static(webRoot, { index: false, maxAge: "1h" }));
    // SPA 用 history 路由，非 /api 的深链接一律回 index.html。
    app.get(/^(?!\/api\/).*/, (_req, res, next) => {
      res.sendFile(path.join(webRoot, "index.html"), (error) => {
        if (error) next();
      });
    });
  }

  app.use((error, _req, res, _next) => {
    if (error instanceof ApiError) {
      res.status(error.httpStatus).json({ code: 1, msg: error.message });
      return;
    }
    console.error("[admin-server] 未处理异常", error);
    res.status(500).json({ code: 1, msg: "服务器错误" });
  });
  return app;
}
