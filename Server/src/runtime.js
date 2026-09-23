import { config } from "./config.js";
import {
  normalizeFaultTypes,
  normalizeHeartbeatWriteIntervalSeconds,
  normalizeIdentifier,
  normalizeTables,
} from "./utils.js";

// 运行时配置中心：
// 这里不再读取外置 JSON，只负责把 config.js 里的配置转换为运行时常量。

// serverConfig 是完整配置，来源只允许是 config.js。
export const serverConfig = config;
// tableConfig/tables 是校验后的表名，业务 SQL 只能使用这里导出的表名。
export const tableConfig = normalizeTables(serverConfig.tables);
export const tables = tableConfig;
// faultTypes 是去空、去重后的故障类型；如果配置为空则回退默认类型。
export const faultTypes = normalizeFaultTypes(serverConfig.fault?.types, config.fault.types);

// 运行时参数集中在这里导出，避免 routes/services/schema 各自重复解析配置。
// 优先级：config.js。
const runtimeConfig = serverConfig.server ?? {};
const mysqlConfig = serverConfig.mysql ?? {};
const faultConfig = serverConfig.fault ?? {};

// nodeCode 是本次 Node 实例的稳定身份；只有完全留空时才在初始化兼容模式下使用 GLOBAL。
const configuredNodeCode = String(runtimeConfig.nodeCode ?? "").trim();
if (configuredNodeCode !== "" && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(configuredNodeCode)) {
  throw new Error("server.nodeCode 格式不正确：只能使用字母、数字、下划线和短横线，且首字符必须为字母或数字。");
}
export const nodeCode = configuredNodeCode || "GLOBAL";
// 注册密钥只用于受保护的节点管理健康检查，不会下发给客户端或 Watchdog。
const configuredNodeRegistrationKey = String(runtimeConfig.nodeRegistrationKey ?? "").trim();
if (configuredNodeRegistrationKey !== "" && !/^[A-Za-z0-9]{6,128}$/.test(configuredNodeRegistrationKey)) {
  throw new Error("server.nodeRegistrationKey 格式不正确：必须为6到128位英文字母和数字。");
}
export const nodeRegistrationKey = configuredNodeRegistrationKey;

// realnameauth 是业务主库；学生账号来源库可以是另一台 MySQL，不能依赖跨库 JOIN。
export const mainDatabase = normalizeIdentifier(mysqlConfig.database, "mysql.database");
export const studentDatabase = normalizeIdentifier(
  mysqlConfig.student?.database ?? mysqlConfig.studentDatabase ?? mysqlConfig.database,
  "mysql.student.database",
);
// 只有没有显式配置独立学生库、且学生表就在业务主库时，后端才负责创建/迁移/修正 tp_student。
export const manageLocalStudentTable = !mysqlConfig.student && studentDatabase === mainDatabase;

// 后端监听端口，单位：TCP 端口号。
export const port = Number(runtimeConfig.port);
// 心跳超时单位：秒；下限固定为 30 秒，避免配置过小导致网络抖动时误判下机。
export const heartbeatTimeoutSeconds = Math.max(30, Number(runtimeConfig.heartbeatTimeoutSeconds));
// 超时扫描间隔单位：秒；下限固定为 5 秒，防止配置成 0 或负数造成高频扫描。
export const offlineScanSeconds = Math.max(5, Number(runtimeConfig.offlineScanSeconds));
// 服务端启动恢复宽限，单位：分钟；0 表示不启用。
export const serverRecoveryGraceMinutes = Math.max(0, Number(runtimeConfig.serverRecoveryGraceMinutes) || 0);
// 写库节流单位：秒；不能超过“心跳超时 - 扫描间隔”，否则设备可能还没来得及刷新就被判超时。
export const heartbeatWriteIntervalSeconds = normalizeHeartbeatWriteIntervalSeconds(
  runtimeConfig.heartbeatWriteIntervalSeconds,
  heartbeatTimeoutSeconds,
  offlineScanSeconds,
);
// 每批超时处理单位：条；至少 1 条，避免配置错误导致扫描器永远不处理数据。
export const sessionTimeoutBatchSize = Math.max(1, Number(runtimeConfig.sessionTimeoutBatchSize));
// 故障报修冷却单位：分钟；至少 1 分钟，避免 0 分钟导致重复提交刷库。
export const faultCooldownMinutes = Math.max(1, Number(faultConfig.cooldownMinutes));
export const allowedFaultTypes = new Set(faultTypes);

// 客户端动态配置的 Node 下发默认值，仅用于数据库缺失或配置非法时兜底。
// 客户端自己的本地启动兜底请改 Client/appsettings.jsonc。
export const clientDynamicConfigDefaults = Object.freeze({
  heartbeatSeconds: 5,
  fullscreenEnabled: false,
  heartbeatFailLockCount: 0,
  httpTimeoutSeconds: 10,
  configRefreshSeconds: 15,
  clientAliveSeconds: 5,
  restoreSessionEnabled: true,
  faultEnabled: true,
});

// Watchdog 动态配置的 Node 下发默认值，仅用于数据库缺失或配置非法时兜底。
// Watchdog 自己的本地启动兜底请改 WatchdogService/watchdogsettings.jsonc。
export const watchdogDynamicConfigDefaults = Object.freeze({
  clientPath: "C:\\Program Files\\RealNameSimple\\Client\\RealName.SimpleClient.exe",
  checkSeconds: 3,
  policySeconds: 15,
  sessionSeconds: 5,
  aliveStaleSeconds: 0,
  httpTimeoutSeconds: 5,
  retryLogSeconds: 30,
  sessionGuard: true,
  aliveGuard: false,
});

// 客户端心跳间隔单位：秒；服务端下发时最低 3 秒，避免客户端配置过小造成请求过密。
export const clientHeartbeatSeconds = clientDynamicConfigDefaults.heartbeatSeconds;
