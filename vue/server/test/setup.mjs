import crypto from "node:crypto";
import http from "node:http";
import mysql from "mysql2/promise";
import { config } from "../src/config.js";
import { createMockNode } from "./mock-node.mjs";

// 集成测试和冒烟栈都只跑在 xueji_bfftest 里，绝不碰开发机上那份真实的 xueji。
// 这个库同时也是 vue/server/src/config.js 指向的开发库，因此测试只接管自己用到的
// 三张表，不会 DROP 库，也不会动 tp_student / tp_teacher。
export const DEV_DB = "xueji_bfftest";
export const ADMIN_PASSWORD = "DemoAdminPass2026";
const ROOT = { host: "127.0.0.1", port: 3306, user: "root", password: "root" };
// 夹具会整表清节点登记、改写管理员和登录计数表，因此只准打本机开发库，不设绕过开关。
if (!/^(127\.0\.0\.1|localhost|::1)$/.test(String(ROOT.host))) {
  throw new Error(`测试夹具只允许连本机 MySQL，当前 host=${ROOT.host}`);
}
if (!/_bfftest$/.test(DEV_DB)) {
  throw new Error(`测试夹具只允许写带 _bfftest 后缀的开发库，当前目标库=${DEV_DB}`);
}

export const NODE_A = { nodeCode: "TESTA", key: "testakey123", port: 0 };
export const NODE_B = { nodeCode: "TESTB", key: "testbkey123", port: 0 };

async function ensureRegistryTable(conn) {
  await conn.query(`CREATE TABLE IF NOT EXISTS \`${config.tables.nodes}\` (
    node_code VARCHAR(64) NOT NULL PRIMARY KEY, region_name VARCHAR(100) NOT NULL, node_address VARCHAR(500) NOT NULL,
    online_status TINYINT(1) NOT NULL DEFAULT 0, last_check_at DATETIME NULL, last_error VARCHAR(500) NULL,
    register_key VARCHAR(128) NOT NULL, is_default TINYINT(1) NOT NULL DEFAULT 0,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP)
    ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
}

function seedFor(nodeCode, offset) {
  // offset 只用来隔开两个节点的自增主键；时间单独给，避免拼出非法 ISO 串。
  const hour = offset === 0 ? 1 : 5;
  const t = (day, h, minute = 0) =>
    `2026-09-${String(day).padStart(2, "0")}T${String(h).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00.000Z`;
  const room = (id, code, name, building, enabled) => ({
    id: offset + id,
    node_code: nodeCode,
    classroom_code: `${nodeCode}-${code}`,
    classroom_name: `${nodeCode}${name}`,
    building_name: building,
    ip_start: `10.0.${offset}.2`,
    ip_end: `10.0.${offset}.200`,
    teacher_ip: `10.0.${offset}.1`,
    enabled,
    out_time: 10,
    allow_student_shutdown: 1,
  });
  return {
    serverConfig: {
      heartbeat_timeout_seconds: 30,
      heartbeat_write_interval_seconds: 15,
      offline_scan_seconds: 15,
      server_recovery_grace_minutes: 5,
      session_timeout_batch_size: 300,
      fault_cooldown_minutes: 20,
    },
    clientConfig: { heartbeat_seconds: 5, fullscreen_enabled: 1, http_timeout_seconds: 10, config_refresh_seconds: 15 },
    watchdogConfig: { client_path: "\\\\server\\share\\RealName.SimpleClient.exe", check_seconds: 2 },
    classrooms: [room(1, "A101", "一号教室", "A楼", 1), { ...room(2, "B201", "二号教室", "B楼", 0), ip_start: "", ip_end: "" }],
    devices: [
      { id: offset + 1, machine_id: `${nodeCode}-M1`, machine_name: `${nodeCode.toLowerCase()}-pc-01`, ip_address: `10.0.${offset}.10`, mac_address: "AA:BB:CC:00:00:01", classroom_id: offset + 1, classroom_name: `${nodeCode}-A101`, device_role: "student", status: "Unlocked", current_user_name: "演示学生", current_session_id: `${nodeCode}s1`, last_seen_at: t(21, hour + 9), online: true, using: true },
      { id: offset + 2, machine_id: `${nodeCode}-M2`, machine_name: `${nodeCode.toLowerCase()}-pc-02`, ip_address: `10.0.${offset}.11`, mac_address: "AA:BB:CC:00:00:02", classroom_id: offset + 1, classroom_name: `${nodeCode}-A101`, device_role: "student", status: "Locked", current_user_name: null, current_session_id: null, last_seen_at: t(20, hour), online: false, using: false },
    ],
    sessions: [
      { id: `${nodeCode}s1`, machine_id: `${nodeCode}-M1`, node_code: nodeCode, user_role: "student", student_no: "STUDENT-DEMO-001", name: "演示学生", started_at: t(21, hour, 5), ended_at: null, status: "active", machine_name: `${nodeCode.toLowerCase()}-pc-01`, ip_address: `10.0.${offset}.10`, classroom_name: `${nodeCode}-A101`, use_minutes: 30 },
      { id: `${nodeCode}s2`, machine_id: `${nodeCode}-M2`, node_code: nodeCode, user_role: "teacher", student_no: "TEACHER-DEMO", name: "演示教师", started_at: t(19, hour), ended_at: t(19, hour + 1), status: "ended", machine_name: `${nodeCode.toLowerCase()}-pc-02`, ip_address: `10.0.${offset}.11`, classroom_name: `${nodeCode}-A101`, use_minutes: 60 },
    ],
    logs: [
      { id: offset + 1, event_name: "登录成功", message: `${nodeCode} 学生登录`, operator_name: null, log_level: "info", log_source: "Node", machine_id: `${nodeCode}-M1`, machine_name: `${nodeCode.toLowerCase()}-pc-01`, ip_address: `10.0.${offset}.10`, mac_address: "AA:BB:CC:00:00:01", classroom_name: `${nodeCode}-A101`, log_time: t(21, hour, 5) },
      { id: offset + 2, event_name: "远程关机", message: `${nodeCode} 关机指令`, operator_name: "testadmin", log_level: "warning", log_source: "Vue后台", machine_id: `${nodeCode}-M2`, machine_name: `${nodeCode.toLowerCase()}-pc-02`, ip_address: `10.0.${offset}.11`, mac_address: "AA:BB:CC:00:00:02", classroom_name: `${nodeCode}-A101`, log_time: t(21, hour + 2) },
    ],
    faults: [{ id: offset + 1, ip: `10.0.${offset}.10`, classroom_name: `${nodeCode}-A101`, type: "键盘鼠标", student_no: "STUDENT-DEMO-001", info: "鼠标失灵", createtime: t(21, hour, 30) }],
  };
}

function serve(handler) {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      req.rawBody = Buffer.concat(chunks).toString("utf8");
      void handler(req, res);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

const md5 = (value) => crypto.createHash("md5").update(String(value)).digest("hex");

export async function startHarness({ port = 0, serveWeb = false } = {}) {
  const root = await mysql.createConnection(ROOT);
  await root.query(`CREATE DATABASE IF NOT EXISTS \`${DEV_DB}\` DEFAULT CHARSET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await root.end();

  config.mysql = { host: ROOT.host, port: ROOT.port, database: DEV_DB, user: ROOT.user, password: ROOT.password, connectionLimit: 4, devDatabaseSuffix: "_bfftest" };
  // 冒烟栈要真的吐出打包后的 SPA，才能用浏览器验收界面；自动化测试只打接口。
  config.server.webRoot = serveWeb ? "web" : "";
  config.node.connectTimeoutMs = 800;
  config.node.responseTimeoutMs = 3000;
  config.node.probeTimeoutMs = 1500;

  // 结构与 vue/server/scripts/init-dev-dbs.mjs 保持一致，只补不删；已存在时不改动列定义。
  const admin = await mysql.createConnection({ ...ROOT, database: DEV_DB });
  await admin.query(`CREATE TABLE IF NOT EXISTS \`${config.tables.admins}\` (
    id INT AUTO_INCREMENT PRIMARY KEY, admin_name VARCHAR(50) NOT NULL, admin_pass CHAR(32) NOT NULL,
    admin_xm VARCHAR(50) NULL, post VARCHAR(50) NULL, state TINYINT NOT NULL DEFAULT 1,
    login_last INT NULL, login_ip VARCHAR(50) NULL, UNIQUE KEY uk_admin_name (admin_name)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await admin.query(`CREATE TABLE IF NOT EXISTS \`${config.tables.loginAttempts}\` (
    id INT AUTO_INCREMENT PRIMARY KEY, user_id VARCHAR(50) NOT NULL, attempt_time INT NOT NULL,
    ip_address VARCHAR(64) NULL, login_attempts INT NOT NULL DEFAULT 0, KEY idx_user_id (user_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await ensureRegistryTable(admin);

  // 测试用例依赖确定的节点集合与"只有一个默认节点"，所以节点登记表整体由测试接管；
  // 跑完后重新执行 init-dev-dbs.mjs 即可把本机开发节点补回来。
  await admin.query(`DELETE FROM \`${config.tables.nodes}\``);
  await admin.query(
    `DELETE FROM \`${config.tables.admins}\` WHERE admin_name IN ('testadmin', 'weakpass', 'disabled')`,
    );
  await admin.query(
    `DELETE FROM \`${config.tables.loginAttempts}\` WHERE user_id IN ('testadmin', 'weakpass', 'disabled', 'nobody')`,
  );
  await admin.query(
    `INSERT INTO \`${config.tables.admins}\` (admin_name, admin_pass, admin_xm, post, state) VALUES
     ('testadmin', ?, '测试管理员', '机房管理员', 1),
     ('weakpass', ?, '弱口令账号', '机房管理员', 1),
     ('disabled', ?, '停用账号', '机房管理员', 0)`,
    [md5(ADMIN_PASSWORD), md5("abc"), md5(ADMIN_PASSWORD)],
  );

  const nodeA = createMockNode({ nodeCode: NODE_A.nodeCode, registrationKey: NODE_A.key, seed: seedFor(NODE_A.nodeCode, 0), log: [] });
  const nodeB = createMockNode({ nodeCode: NODE_B.nodeCode, registrationKey: NODE_B.key, seed: seedFor(NODE_B.nodeCode, 100), log: [] });
  const a = await serve(nodeA.handle);
  const b = await serve(nodeB.handle);
  NODE_A.port = a.port;
  NODE_B.port = b.port;

  await ensureRegistryTable(admin);
  await admin.query(
    `INSERT INTO \`${config.tables.nodes}\` (node_code, region_name, node_address, register_key, is_default) VALUES
     (?, '测试一区', ?, ?, 1), (?, '测试二区', ?, ?, 0), ('BROKEN', '坏节点', ?, 'brokenkey1', 0)`,
    [
      NODE_A.nodeCode, `http://127.0.0.1:${a.port}/`, NODE_A.key,
      NODE_B.nodeCode, `http://127.0.0.1:${b.port}`, NODE_B.key,
      "http://127.0.0.1:1",
    ],
  );
  await admin.end();

  const { createApp } = await import("../src/app.js");
  const app = createApp();
  const listener = await new Promise((resolve) => {
    const server = app.listen(port, "127.0.0.1", () => resolve(server));
  });
  const baseUrl = `http://127.0.0.1:${listener.address().port}`;
  const state = { cookie: "" };

  async function call(method, action, params = {}, { form = "urlencoded" } = {}) {
    const url = new URL(`${baseUrl}/api/${action}`);
    const headers = {};
    if (state.cookie) headers.Cookie = state.cookie;
    let body;
    if (method === "GET") {
      for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
    } else if (form === "json") {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(params);
    } else {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      const fields = new URLSearchParams();
      for (const [key, value] of Object.entries(params)) fields.set(key, String(value));
      body = fields.toString();
    }
    const response = await fetch(url, { method, headers, body });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) state.cookie = setCookie.split(";")[0];
    return { status: response.status, body: await response.json() };
  }

  return {
    baseUrl,
    call,
    state,
    nodes: { A: nodeA, B: nodeB },
    registry: { ...ROOT, database: DEV_DB },
    async loginAs(name = "testadmin", password = ADMIN_PASSWORD) {
      return call("POST", "login", { admin_name: name, admin_pass: password });
    },
    async close() {
      await new Promise((resolve) => listener.close(resolve));
      await new Promise((resolve) => a.server.close(resolve));
      await new Promise((resolve) => b.server.close(resolve));
      const { closePool } = await import("../src/db.js");
      await closePool();
      // 只清掉测试自己插入的行，保留库、表结构和 tp_student / tp_teacher。
      const cleanup = await mysql.createConnection({ ...ROOT, database: DEV_DB });
      await cleanup.query(
        `DELETE FROM \`${config.tables.nodes}\` WHERE node_code IN (?, ?, 'BROKEN')`,
        [NODE_A.nodeCode, NODE_B.nodeCode],
      );
      await cleanup.query(
        `DELETE FROM \`${config.tables.admins}\` WHERE admin_name IN ('weakpass', 'disabled')`,
      );
      await cleanup.query(
        `DELETE FROM \`${config.tables.loginAttempts}\` WHERE user_id IN ('testadmin', 'weakpass', 'disabled', 'nobody')`,
      );
      await cleanup.end();
    },
  };
}
