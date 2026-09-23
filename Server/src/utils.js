import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = findRootDir(__dirname);

// 通用工具函数只放无业务状态的小能力，方便 routes/services/schema 共用。
// 故障类型配置去空、去重；如果配置为空则使用默认故障类型。
export function normalizeFaultTypes(types, fallbackTypes) {
  const normalized = Array.isArray(types)
    ? types.map((item) => String(item).trim()).filter(Boolean)
    : [];
  const uniqueTypes = [...new Set(normalized)];
  return uniqueTypes.length > 0 ? uniqueTypes : fallbackTypes;
}

// 校验并整理配置里的表名，防止表名拼进 SQL 时出现危险字符。
export function normalizeTables(tables) {
  const normalized = {};
  for (const [key, table] of Object.entries(tables ?? {})) {
    normalized[key] = validateIdentifier(table, key);
  }
  return normalized;
}

// 校验数据库名等 SQL 标识符，规则和表名一致，避免跨库表引用被注入。
export function normalizeIdentifier(value, key) {
  return validateIdentifier(value, key);
}

// 统一输出普通信息日志，格式为：[时间] 标题：内容。
export function consoleInfo(title, message = "") {
  const safeTitle = sanitizeDiagnosticText(title);
  const safeMessage = sanitizeDiagnosticText(message);
  console.log(`[${nowText()}] ${safeTitle}${safeMessage ? `：${safeMessage}` : ""}`);
}

// 统一输出警告日志，用于配置异常、超时下机等需要注意但不中断的情况。
export function consoleWarn(title, message = "") {
  const safeTitle = sanitizeDiagnosticText(title);
  const safeMessage = sanitizeDiagnosticText(message);
  console.warn(`[${nowText()}] ${safeTitle}${safeMessage ? `：${safeMessage}` : ""}`);
}

// 统一输出错误日志，优先打印 stack，便于定位启动或接口异常。
export function consoleError(title, error) {
  const message = error?.stack || error?.message || String(error);
  console.error(`[${nowText()}] ${sanitizeDiagnosticText(title)}：${sanitizeDiagnosticText(message)}`);
}

// 控制台和错误文件的最后一道脱敏：清理日志注入字符以及常见凭据、身份证、IP、MAC。
export function sanitizeDiagnosticText(value) {
  let text = String(value ?? "").replace(/[\r\n\t]+/g, " ").trim();
  text = text.replace(/\b\d{17}[\dXx]\b/g, "[身份证已隐藏]");
  text = text.replace(/\b(?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}\b/g, "[MAC已隐藏]");
  text = text.replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, (ip) =>
    ip === "0.0.0.0" || ip.startsWith("127.") ? ip : "[IP已隐藏]",
  );
  text = text.replace(
    /((?:password|passwd|pwd|token|secret|register[_-]?key|authorization|session(?:id|_id)?)["']?\s*[:=]\s*["']?)([^\s,"'&}\]]+)/gi,
    "$1[已隐藏]",
  );
  return text;
}

// 日志只展示学生学号或教师工号；教师身份证号和手机号永不作为日志兜底。
export function accountLogText(account) {
  const role = account?.userRole ?? account?.user_role;
  const displayNo = String(account?.displayNo ?? account?.display_no ?? "").trim();
  if (role === "teacher") return displayNo || "工号未设置";
  if (role === "student") {
    return displayNo || String(account?.studentNo ?? account?.student_no ?? account?.accountNo ?? "").trim() || "学号未设置";
  }
  return "已隐藏";
}

// 日志中的原登录位置不使用 IP，只保留教室或主机名。
export function logSessionPlace(session) {
  return session?.classroom_name || session?.machine_name || "其他电脑";
}

// 生成控制台日志使用的本地时间文本。
function nowText() {
  return new Date().toLocaleString("zh-CN", { hour12: false });
}

// 标准化设备心跳写库间隔：设置下限，并确保不会超过“心跳超时 - 扫描间隔”。
export function normalizeHeartbeatWriteIntervalSeconds(value, timeoutSeconds = 90, scanSeconds = 30) {
  const requested = Math.max(5, Number(value) || 30);
  const maxInterval = Math.max(5, timeoutSeconds - scanSeconds);
  return Math.min(requested, maxInterval);
}

// 把设备角色代码转换成中文，主要用于控制台心跳日志。
export function deviceRoleText(role) {
  if (role === "teacher") return "教师机";
  if (role === "student") return "学生机";
  return "未匹配";
}

// 把会话用户身份转换成中文，避免和“教师机/学生机”的设备角色混淆。
export function userRoleText(role) {
  if (role === "teacher") return "教师";
  if (role === "student") return "学生";
  return "未知身份";
}

// 把设备状态代码转换成中文，主要用于控制台心跳日志。
export function statusText(status) {
  if (status === "Locked") return "已锁定";
  if (status === "Unlocked") return "已解锁";
  if (status === "Disabled") return "教室停用";
  return status || "未知";
}

// 把下机原因代码转换成中文，用于日志内容和接口提示。
export function logoutReasonText(reason) {
  if (reason === "manual") return "手动退出";
  if (reason === "client-closing") return "客户端关闭";
  if (reason === "classroom-disabled") return "教室停用";
  return reason || "未知原因";
}

// 把请求字段整理成可写入数据库的字符串：空值和空白字符串统一转成 null。
export function nullableString(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text === "" ? null : text;
}

// 把请求里的布尔值兼容解析成 true/false，支持 true、1、yes。
export function parseBoolean(value) {
  if (value === true || value === 1) return true;
  const text = String(value ?? "").trim().toLowerCase();
  return text === "true" || text === "1" || text === "yes";
}

// 把已登录会话整理成前端重复登录弹框需要展示的设备信息。
export function activeSessionInfo(session) {
  return {
    classroomName: session?.classroom_name ?? null,
    ipAddress: session?.ip_address ?? null,
    machineName: session?.machine_name ?? null,
    machineId: session?.machine_id ?? null,
    startedAt: session?.started_at ?? null,
  };
}

// 生成重复登录弹框里的位置文本，优先显示教室，其次 IP、机器名。
export function activeSessionPlace(session) {
  return session?.classroom_name || session?.ip_address || session?.machine_name || "其他电脑";
}

// 生成学生在另一台电脑已登录时的确认提示文案。
export function duplicateLoginMessage(activePlace) {
  return `该账号已在 ${activePlace} 登录。\n是否下线原电脑并登录此电脑？`;
}

// 获取服务端实际看到的来源 IP。授权判断不信任客户端可伪造的转发头。
export function requestIp(req) {
  const raw = req.socket?.remoteAddress || req.ip || "";
  return raw.replace(/^::ffff:/, "") || null;
}

// 把 IPv4 地址转换成数字，方便和 MySQL 的 INET_ATON 范围逻辑保持一致。
export function ipToNumber(ip) {
  if (!ip || typeof ip !== "string") return null;
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return ((parts[0] * 256 + parts[1]) * 256 + parts[2]) * 256 + parts[3];
}

// 把数据库时间或 Date 值格式化成中文本地时间，空值显示“未知”。
export function formatDateTime(value) {
  if (!value) return "未知";
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

// 生成 32 位随机十六进制字符串，用作会话 ID。
export function uuid() {
  return crypto.randomBytes(16).toString("hex");
}

// 把密码明文转成 32 位小写 MD5，和 tp_student.stu_pass 的存储格式保持一致。
export function md5Hex(value) {
  return crypto.createHash("md5").update(String(value ?? ""), "utf8").digest("hex");
}

// 把后端异常追加写入 runtime/error.log，方便部署现场事后排查。
export function writeError(error) {
  const dir = path.join(rootDir, "runtime");
  fs.mkdirSync(dir, { recursive: true });
  const message = sanitizeDiagnosticText(error?.stack || error?.message || String(error));
  fs.appendFileSync(path.join(dir, "error.log"), `[${new Date().toISOString()}] ${message}\n\n`);
}

// 通过 package.json 查找 Server 根目录，用于确定 runtime 日志目录位置。
function findRootDir(startDir) {
  const candidates = [startDir, path.resolve(startDir, "..")];
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, "package.json"))) {
      return candidate;
    }
  }
  return path.resolve(startDir, "..");
}

// 校验表名等 SQL 标识符，只允许字母、数字、下划线且必须以字母开头。
function validateIdentifier(value, key) {
  const text = String(value).trim();
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(text)) {
    throw new Error(`Server/src/config.js 的 tables.${key} 表名无效，只能使用字母、数字、下划线，且必须以字母开头。`);
  }
  return text;
}
