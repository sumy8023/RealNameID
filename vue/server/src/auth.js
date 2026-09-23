import crypto from "node:crypto";
import { config } from "./config.js";
import { execute, query } from "./db.js";
import { ApiError } from "./envelope.js";

const adminTable = `\`${config.tables.admins}\``;
const attemptTable = `\`${config.tables.loginAttempts}\``;

// 复用校区后台账号：不新建管理员表、不加角色，登录即全权（与 PHP 后台现状一致）。
// 登录时序也保持和 LoginAction 一致，两个后台共享 tp_login_attempts 的爆破计数。

const sessions = new Map();

function md5(value) {
  return crypto.createHash("md5").update(String(value), "utf8").digest("hex");
}

// 与 PHP __lowPass 同一条正则：至少数字+小写+大写，长度 6 起。
function isWeakPassword(password) {
  return !/^(?=.*\d)(?=.*[a-z])(?=.*[A-Z]).{6,}$/.test(String(password || ""));
}

function pruneSessions() {
  const now = Date.now();
  for (const [token, session] of sessions) {
    if (session.expiresAt <= now) sessions.delete(token);
  }
}

export function issueSession(user) {
  pruneSessions();
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, {
    adminId: user.id,
    adminName: user.admin_name,
    adminXm: user.admin_xm || "",
    post: user.post || "",
    expiresAt: Date.now() + config.auth.ttlSeconds * 1000,
  });
  return token;
}

export function touchSession(token) {
  const session = sessions.get(token);
  if (!session) return null;
  session.expiresAt = Date.now() + config.auth.ttlSeconds * 1000;
  return session;
}

export function destroySession(token) {
  sessions.delete(token);
}

async function latestAttempt(userName) {
  const rows = await query(
    `SELECT login_attempts, attempt_time FROM ${attemptTable}
     WHERE user_id = ? ORDER BY attempt_time DESC LIMIT 1`,
    [userName],
  );
  return rows[0] || null;
}

function isLocked(attempt) {
  if (!attempt || Number.parseInt(attempt.login_attempts, 10) < config.auth.maxFailedAttempts) return false;
  const last = Number.parseInt(attempt.attempt_time, 10) || 0;
  return Date.now() / 1000 - last < config.auth.lockMinutes * 60;
}

async function recordFailure(userName, ipAddress) {
  const latest = await latestAttempt(userName);
  if (latest) {
    await execute(`UPDATE ${attemptTable} SET login_attempts = login_attempts + 1 WHERE user_id = ?`, [userName]);
    return;
  }
  await execute(
    `INSERT INTO ${attemptTable} (user_id, attempt_time, ip_address, login_attempts) VALUES (?, ?, ?, 1)`,
    [userName, Math.floor(Date.now() / 1000), String(ipAddress || "").slice(0, 64)],
  );
}

export async function login({ userName, password, ipAddress }) {
  const name = String(userName || "").trim();
  const pass = String(password || "");
  if (!name || !pass) throw new ApiError("用户名或密码错误！");

  if (isLocked(await latestAttempt(name))) {
    throw new ApiError("登录失败次数过多，请等待10分钟后重试！");
  }

  const rows = await query(
    `SELECT id, admin_name, admin_xm, post, state FROM ${adminTable} WHERE admin_name = ? AND admin_pass = ? LIMIT 1`,
    [name, md5(pass)],
  );
  const user = rows[0];
  if (!user) {
    await recordFailure(name, ipAddress);
    if (isLocked(await latestAttempt(name))) throw new ApiError("登录失败次数过多，请等待10分钟后重试！");
    throw new ApiError("用户名或密码错误！");
  }
  if (Number.parseInt(user.state, 10) === 0) throw new ApiError("该号被禁用，请联系管理员！");
  if (config.auth.rejectWeakPassword && isWeakPassword(pass)) {
    throw new ApiError("登录密码过于简单，请重设！");
  }

  await execute(`UPDATE ${adminTable} SET login_last = ? WHERE id = ?`, [Math.floor(Date.now() / 1000), user.id]);
  await execute(`DELETE FROM ${attemptTable} WHERE user_id = ?`, [name]);
  return { token: issueSession(user), user: { id: user.id, admin_name: user.admin_name, admin_xm: user.admin_xm, post: user.post } };
}

export function readToken(req) {
  const cookie = req.headers.cookie || "";
  for (const part of cookie.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === config.auth.cookieName) return decodeURIComponent(rest.join("="));
  }
  const header = String(req.headers.authorization || "");
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

export function authRequired(req, _res, next) {
  const session = touchSession(readToken(req));
  if (!session) {
    next(new ApiError("当前用户未登录或登录超时，请重新登录", 401));
    return;
  }
  req.admin = session;
  next();
}
