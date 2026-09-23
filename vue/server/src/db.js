import mysql from "mysql2/promise";
import { config } from "./config.js";

let pool = null;

// 开发护栏：本机这套代码只准连带 _bfftest 后缀的开发库（详见 config.js 的 devDatabaseSuffix）。
function assertDevDatabase(name, suffix) {
  if (!suffix || String(name).endsWith(suffix)) return;
  throw new Error(
    `学籍库 "${name}" 不以 "${suffix}" 结尾，已拒绝连接。` +
      "BFF 会写节点登记表和登录计数表，本机代码不允许作用于现网库；确认为现场部署后，把 vue/server/src/config.js 的 mysql.devDatabaseSuffix 改成 \"\" 再启动。",
  );
}

function getPool() {
  if (!pool) {
    const db = config.mysql;
    assertDevDatabase(db.database, db.devDatabaseSuffix);
    pool = mysql.createPool({
      host: db.host,
      port: db.port,
      database: db.database,
      user: db.user,
      password: db.password,
      connectionLimit: db.connectionLimit,
      waitForConnections: true,
      // 学籍库 DATETIME 一律按东八区解释，避免 Node 进程时区不同导致时间偏移。
      timezone: "+08:00",
      dateStrings: ["DATE", "DATETIME"],
    });
  }
  return pool;
}

export async function query(sql, params = []) {
  return (await getPool().query(sql, params))[0];
}

export async function execute(sql, params = []) {
  return (await getPool().execute(sql, params))[0];
}

export async function transaction(handler) {
  const conn = await getPool().getConnection();
  try {
    await conn.beginTransaction();
    const result = await handler(conn);
    await conn.commit();
    return result;
  } catch (error) {
    await conn.rollback().catch(() => {});
    throw error;
  } finally {
    conn.release();
  }
}

export async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
