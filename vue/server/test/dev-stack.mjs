import process from "node:process";
import { startHarness } from "./setup.mjs";

// 本地冒烟栈：两个 mock 节点 + 临时库 + 真实 BFF + 打包好的 SPA，
// 用来在没有真后端和真学籍库的机器上把 9 个页面点一遍。
// 这不是生产启动方式，只服务开发验收。
const PORT = Number(process.env.SMSJ_SMOKE_PORT || 14850);

const harness = await startHarness({ port: PORT, serveWeb: true });
console.log(`实名上机后台冒烟栈已启动：http://127.0.0.1:${PORT}`);
console.log("登录账号 demo-admin / DemoAdminPass2026");
console.log("登记节点 TESTA / TESTB（两个 mock），以及一个故意指向死端口的 BROKEN");

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    await harness.close().catch(() => null);
    process.exit(0);
  });
}
