import mysql from "mysql2/promise";
import { mainDatabase, serverConfig, studentDatabase } from "./runtime.js";

// MySQL 配置只来自 Server/src/config.js，经 runtime.js 导出到这里。
// 后端数据库访问统一从这里拿连接池，避免业务模块自己创建连接。
const mysqlConfig = serverConfig.mysql ?? {};
const studentMysqlConfig = mysqlConfig.student ?? {};

// dbConfig 是业务库 mysql2/promise 连接池最终使用的配置。
// host：MySQL 地址，单位：IP 或域名。
// port：MySQL 端口，单位：TCP 端口号。
// database/user/password：数据库名、用户名、密码。
// charset：固定使用 utf8mb4，支持中文和 emoji 等完整 Unicode 字符。
// waitForConnections：连接池满时等待可用连接，而不是直接报错。
// connectionLimit：连接池最大连接数，单位：个连接。
// queueLimit：等待连接的排队上限，单位：个请求；0 表示不限制。
export const dbConfig = {
  host: mysqlConfig.host,
  port: Number(mysqlConfig.port),
  database: mainDatabase,
  user: mysqlConfig.user,
  password: mysqlConfig.password,
  charset: "utf8mb4",
  waitForConnections: true,
  connectionLimit: normalizePoolNumber(mysqlConfig.connectionLimit, 10),
  queueLimit: normalizePoolNumber(mysqlConfig.queueLimit, 0),
};

// studentDbConfig 是学籍库连接池配置。未单独填写的地址、端口、账号、密码会回退业务库配置。
export const studentDbConfig = {
  host: studentMysqlConfig.host ?? mysqlConfig.host,
  port: Number(studentMysqlConfig.port ?? mysqlConfig.port),
  database: studentDatabase,
  user: studentMysqlConfig.user ?? mysqlConfig.user,
  password: studentMysqlConfig.password ?? mysqlConfig.password,
  charset: "utf8mb4",
  waitForConnections: true,
  connectionLimit: normalizePoolNumber(studentMysqlConfig.connectionLimit ?? mysqlConfig.connectionLimit, dbConfig.connectionLimit),
  queueLimit: normalizePoolNumber(studentMysqlConfig.queueLimit ?? mysqlConfig.queueLimit, dbConfig.queueLimit),
};

// 开发护栏：本机这套代码只准连带 _bfftest 后缀的开发库，防止误写现网（详见 config.js 的 devDatabaseSuffix）。
function assertDevDatabase(name, label) {
  const suffix = String(mysqlConfig.devDatabaseSuffix ?? "");
  if (!suffix || String(name).endsWith(suffix)) return;
  throw new Error(
    `${label} "${name}" 不以 "${suffix}" 结尾，已拒绝连接。` +
      "本机代码不允许读写现网库；确认为现场部署后，把 Server/src/config.js 的 mysql.devDatabaseSuffix 改成 \"\" 再启动。",
  );
}
assertDevDatabase(dbConfig.database, "业务库");
assertDevDatabase(studentDbConfig.database, "学籍库");

// 全局业务库连接池：模块加载时创建，整个后端进程复用。
export const pool = mysql.createPool(dbConfig);
// 全局账号库连接池：只读取 tp_student 和 tp_teacher，支持生产环境连接到另一台 MySQL。
export const studentPool = mysql.createPool(studentDbConfig);

// 业务库 SELECT 查询辅助函数：返回 rows，适合读取列表或单条记录。
export async function query(sql, params = []) {
  const [rows] = await pool.query(sql, params);
  return rows;
}

// 账号库 SELECT 查询辅助函数：返回 rows；不要用它写入或迁移 tp_student、tp_teacher。
export async function studentQuery(sql, params = []) {
  const [rows] = await studentPool.query(sql, params);
  return rows;
}

// 业务库 INSERT/UPDATE/DELETE/DDL 辅助函数：返回执行结果，适合写入或建表迁移。
export async function execute(sql, params = []) {
  const [result] = await pool.execute(sql, params);
  return result;
}

// 业务库事务辅助函数：work 内部使用同一个连接，成功自动提交，异常自动回滚。
export async function transaction(work) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const result = await work(connection);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

function normalizePoolNumber(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return fallback;
  return Math.floor(number);
}
