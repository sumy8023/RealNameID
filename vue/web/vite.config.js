import { fileURLToPath } from "node:url";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

// 构建产物直接落到 BFF 的静态目录，发布时不需要再拷一次，
// 也保证 src/server.js 里按包根解析的 webRoot 在开发和发布两种形态下都指对。
export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  server: {
    port: 14851,
    proxy: {
      "/api": { target: "http://127.0.0.1:14850", changeOrigin: true },
    },
  },
  build: {
    outDir: "../server/web",
    emptyOutDir: true,
  },
});
