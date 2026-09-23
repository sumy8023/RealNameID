import express from "express";
import crypto from "node:crypto";
import { execute, query, studentQuery, transaction } from "./db.js";
import { allowedFaultTypes, faultTypes, nodeCode, nodeRegistrationKey, tables } from "./runtime.js";
import {addLog,clientPolicyResponse,completeDeviceCommand,endSessionAndLockDevice,findAccountByCanonicalNo,findAccountsByLoginIdentifier,findFaultReporterByAccount,getClientConfig,getNodeClientMetrics,getProgramFallbacks,getProgramMinimums,getServerConfig,getWatchdogConfig,isClassroomIpAllowed,isClassroomSystemEnabled,logDeviceHeartbeat,markClientDisabled,matchClassroomByIp,rememberDeviceHeartbeatWrite,serverRecoveryGraceRemainingSeconds,shouldWriteDeviceHeartbeat,takePendingDeviceCommand,teacherLogoutAndShutdownStudents,touchDeviceLastSeen,touchLoginDevice,upsertHeartbeatDevice,validateActiveSessionForDevice,} from "./services.js";
import {accountLogText,activeSessionInfo,activeSessionPlace,consoleError,consoleInfo,consoleWarn,duplicateLoginMessage,logSessionPlace,logoutReasonText,md5Hex,nullableString,parseBoolean,requestIp,userRoleText,uuid,writeError,} from "./utils.js";
import { attachRequestMetrics, getNodeRuntimeMetrics } from "./nodeMetrics.js";
import { handleNodeAdminAction, NodeAdminError } from "./admin.js";

const reportedIpMismatchWarnings = new Set();

// 路由层只负责接收请求、调用业务函数、返回 JSON。
// 复杂业务尽量放在 services.js，避免接口文件继续膨胀。
export function createApp() {
  // Express 应用实例，server.js 会拿它去 listen。
  const app = express();
  // 客户端只提交少量 JSON，1mb 足够覆盖登录、心跳、故障报修。
  app.use(express.json({
    limit: "1mb",
    verify: (req, _res, buffer) => {
      req.rawJsonBody = buffer.toString("utf8");
    },
  }));
  attachRequestMetrics(app);

  // 根路径接口：浏览器直接访问时返回后端在线状态。
  app.get("/", (_req, res) => {
    res.json({
      // ok：接口是否正常。
      ok: true,
      // message：给人工访问根路径时看的简短状态。
      message: "实名上机后端运行中。",
      nodeCode,
    });
  });

  // 健康检查接口：检查 Node 进程和数据库连接是否正常。
  app.get("/api/health", async (_req, res) => {
    try {
      // 数据库探活查询，业务库和学籍库都能执行说明连接池可用。
      await Promise.all([query("SELECT 1 AS ok"), studentQuery("SELECT 1 AS ok")]);
      const serverConfig = await getServerConfig();
      res.json({
        // ok：后端和数据库都正常。
        ok: true,
        // runtime：当前后端运行环境。
        runtime: "node",
        // nodeCode：当前Node节点编号。
        nodeCode,
        // nodeVersion：Node.js 版本，排查部署环境时有用。
        nodeVersion: process.version,
        // database：业务库连接状态。
        database: "connected",
        // studentDatabase：学籍库连接状态。
        studentDatabase: "connected",
        // recoveryGraceRemainingSeconds：服务端刚恢复时，距离恢复宽限结束还剩多少秒。
        recoveryGraceRemainingSeconds: serverRecoveryGraceRemainingSeconds(serverConfig),
      });
    } catch (error) {
      writeError(error);
      consoleError("健康检查失败", error);
      res.status(500).json({
        // ok：false 表示健康检查失败。
        ok: false,
        // runtime：即使数据库失败，也标明当前运行环境。
        runtime: "node",
        // nodeCode：当前Node节点编号。
        nodeCode,
        // error：不向未认证调用方暴露数据库或路径等底层细节。
        error: "后端依赖检查失败。",
      });
    }
  });

  // 节点管理健康检查：必须携带与当前 Node 本地配置一致的注册密钥。
  app.get("/api/node/health", async (req, res) => {
    const key = String(req.get("x-node-registration-key") ?? "").trim();
    if (!nodeRegistrationKey) {
      res.status(403).json({ ok: false, message: "当前后端节点未配置注册密钥。" });
      return;
    }
    if (!key || key !== nodeRegistrationKey) {
      res.status(401).json({ ok: false, message: "后端节点注册密钥不正确。" });
      return;
    }

    try {
      await Promise.all([query("SELECT 1 AS ok"), studentQuery("SELECT 1 AS ok")]);
      const serverConfig = await getServerConfig();
      const [runtimeMetrics, clientMetrics] = await Promise.all([
        getNodeRuntimeMetrics(),
        getNodeClientMetrics(serverConfig),
      ]);
      res.json({
        ok: true,
        runtime: "node",
        nodeCode,
        nodeVersion: process.version,
        database: "connected",
        studentDatabase: "connected",
        recoveryGraceRemainingSeconds: serverRecoveryGraceRemainingSeconds(serverConfig),
        // metrics：仅在已通过注册密钥的管理接口中返回运行指标。
        metrics: { ...runtimeMetrics, ...clientMetrics },
        programFallbacks: getProgramFallbacks(),
        programMinimums: getProgramMinimums(),
        adminApiVersion: 2,
      });
    } catch (error) {
      writeError(error);
      consoleError("节点健康检查失败", error);
      res.status(500).json({ ok: false, runtime: "node", nodeCode, error: "后端依赖检查失败。" });
    }
  });

  // Vue 后台的节点管理入口：只接受固定动作，由当前 Node 操作自己的业务库。
  app.post("/api/node/admin", async (req, res, next) => {
    if (!nodeRegistrationKey) {
      res.status(403).json({ ok: false, message: "当前后端节点未配置注册密钥。" });
      return;
    }
    if (!validNodeAdminSignature(req)) {
      res.status(401).json({ ok: false, message: "节点管理请求签名无效或已过期。" });
      return;
    }

    try {
      const result = await handleNodeAdminAction(req.body?.action, req.body?.payload);
      res.json({ ok: true, ...result });
    } catch (error) {
      if (error instanceof NodeAdminError) {
        res.status(error.status).json({ ok: false, node_code: nodeCode, message: error.message });
        return;
      }
      next(error);
    }
  });

  // 客户端配置接口：下发故障类型和心跳间隔。
  app.get("/api/client-config", async (_req, res, next) => {
    try {
      const clientConfig = await getClientConfig();
      res.json({
        // ok：客户端配置接口是否成功。
        ok: true,
        // faultTypes：故障报修下拉框类型，类型本身仍来自后端配置。
        faultTypes,
        ...clientConfig,
      });
    } catch (error) {
      next(error);
    }
  });

  // 查询当前 IP 所属教室策略，客户端和 Watchdog 都会调用。
  app.post("/api/client-policy", async (req, res, next) => {
    try {
      // ipAddress：授权使用服务端看到的来源 IP；回环调试时才回退客户端上报值。
      const ipAddress = authoritativeClientIp(req, req.body?.ipAddress ?? req.body?.ip);
      // classroom：根据 IP 匹配到的教室策略，包含 enabled/out_time 等信息。
      const classroom = await matchClassroomByIp(ipAddress, { includeDisabled: true });
      // watchdogConfig：Watchdog运行期配置，后端从数据库读取并做范围兜底。
      const watchdogConfig = await getWatchdogConfig();
      res.json({
        ...clientPolicyResponse(classroom),
        watchdogConfig,
      });
    } catch (error) {
      next(error);
    }
  });

  // 登录入口：账号校验、重复登录提示、确认后的异地接管。
  app.post("/api/login", async (req, res, next) => {
    try {
      const {
        // machineId：客户端机器唯一 ID。
        machineId = "",
        // machineName：客户端主机名。
        machineName = "",
        // hostname：兼容旧字段，等同于 machineName。
        hostname = "",
        // ipAddress：客户端上报的 IP。
        ipAddress = null,
        // macAddress：客户端上报的 MAC。
        macAddress = null,
        // studentNo：兼容字段名，实际承载学号、工号、身份证号或手机号。
        studentNo = "",
        // name：登录姓名。
        name = "",
        // password：登录密码。
        password = "",
        // forceLogin：重复登录时是否确认下线原电脑。
        forceLogin = false,
      } = req.body ?? {};
      // inputMachineId：清理空白后的机器 ID。
      const inputMachineId = String(machineId).trim();
      // inputMachineName：优先 machineName，兼容 hostname。
      const inputMachineName = String(machineName || hostname || "").trim();
      // inputIpAddress：授权使用服务端来源 IP，回环调试时才使用客户端上报值。
      const inputIpAddress = authoritativeClientIp(req, ipAddress, inputMachineId);
      // inputMacAddress：空字符串统一转 null。
      const inputMacAddress = nullableString(macAddress);
      // inputAccount：清理空白后的登录账号。
      const inputAccount = String(studentNo).trim();
      // inputName：清理空白后的姓名。
      const inputName = String(name).trim();
      // shouldTakeover：是否执行异地登录接管。
      const shouldTakeover = parseBoolean(forceLogin);
      // classroom：当前 IP 对应教室策略，登录前先判断是否启用实名上机。
      const classroom = await matchClassroomByIp(inputIpAddress, { includeDisabled: true });
      if (!isClassroomIpAllowed(classroom)) {
        const policy = clientPolicyResponse(classroom);
        consoleWarn("非法IP地址", `主机：${inputMachineName || "未上报"}，来源地址未匹配到教室配置`);
        res.json({
          // allowed：IP 未匹配教室，不允许登录。
          allowed: false,
          // sessionId：登录失败时没有会话 ID。
          sessionId: null,
          // name：登录失败时没有用户姓名。
          name: null,
          // message：返回给登录页的固定提示。
          message: policy.message,
          // policy：补充非法 IP 策略字段。
          ...policy,
        });
        return;
      }
      if (!isClassroomSystemEnabled(classroom)) {
        // policy：停用教室返回给客户端的统一策略响应。
        const policy = clientPolicyResponse(classroom);
        consoleWarn("教室停用", `主机：${inputMachineName || "未上报"}，尝试登录已停用教室：${classroom.classroomName || "未知教室"}`);
        res.json({
          // allowed：是否允许登录。
          allowed: false,
          // sessionId：登录失败时没有会话 ID。
          sessionId: null,
          // name：登录失败时没有用户姓名。
          name: null,
          // policy：补充停用教室策略字段。
          ...policy,
        });
        return;
      }

      // inputPasswordMd5：学生和教师密码都按 32 位小写 MD5 比较。
      const inputPasswordMd5 = md5Hex(password);
      // accountLookup：学生机和教师机都允许识别学生、教师账号，最终用姓名和密码确认唯一身份。
      const accountLookup = await findAccountsByLoginIdentifier(inputAccount, inputName);
      const matchedUsers = accountLookup.candidates.filter((candidate) =>
        candidate.name === inputName && String(candidate.password ?? "").trim().toLowerCase() === inputPasswordMd5,
      );
      const user = !accountLookup.ambiguous && matchedUsers.length === 1 ? matchedUsers[0] : null;
      if (!user) {
        const ambiguous = accountLookup.ambiguous || matchedUsers.length > 1;
        await addLog("登录失败", "登录失败：登录标识已隐藏", inputMachineId, null, { level: "warning" });
        consoleWarn("登录失败", `主机：${inputMachineName || "未上报"}，登录标识：已隐藏，原因：账号、姓名或密码错误${ambiguous ? "或账号标识不唯一" : ""}`);
        res.json({
          // allowed：账号校验失败，不允许登录。
          allowed: false,
          // sessionId：登录失败时没有会话 ID。
          sessionId: null,
          // name：登录失败时没有用户姓名。
          name: null,
          // message：返回给登录页的提示。
          message: "账号、姓名或密码错误。",
        });
        return;
      }

      // canonicalAccount：学生为学号，教师无论使用何种标识都统一保存 teacher_num。
      const canonicalAccount = String(user.accountNo).trim();
      const displayAccount = accountLogText(user);
      if (Number(user.pingbi) === 1) {
        await addLog("登录失败", `${userRoleText(user.userRole)}账号已屏蔽：${displayAccount}`, inputMachineId, null, { level: "warning" });
        consoleWarn("登录失败", `主机：${inputMachineName || "未上报"}，身份：${userRoleText(user.userRole)}，账号：${displayAccount}，原因：账号已屏蔽`);
        res.json({
          // allowed：账号被屏蔽，不允许登录。
          allowed: false,
          // sessionId：登录失败时没有会话 ID。
          sessionId: null,
          // name：登录失败时没有用户姓名。
          name: null,
          // message：返回给登录页的提示。
          message: "账号已被屏蔽，禁止登录。",
          // accountBlocked：区分"账号被屏蔽"与其它登录失败，客户端据此决定要不要允许重试。
          accountBlocked: true,
        });
        return;
      }

      // sessionId：本次新建会话 ID；同机恢复时不会使用这个新 ID。
      const sessionId = uuid();
      // loginResult：事务内完成设备锁定、会话创建或重复登录冲突判断。
      const loginResult = await transaction(async (conn) => {
        await touchLoginDevice(
          {
            machineId: inputMachineId,
            machineName: inputMachineName,
            ipAddress: inputIpAddress,
            macAddress: inputMacAddress,
            classroom,
          },
          conn,
        );

        // activeSessions：同一身份、同一规范账号的 active 会话，用于判断重复登录。
        const [activeSessions] = await conn.execute(
          `SELECT
             s.id,
             s.machine_id,
             s.node_code,
             s.started_at,
             d.machine_name,
             d.ip_address,
             d.classroom_name
           FROM ${tables.sessions} s
           LEFT JOIN ${tables.devices} d ON d.machine_id = s.machine_id
           WHERE s.user_role = ?
             AND s.student_no = ?
             AND s.node_code = ?
             AND s.status = 'active'
             AND s.ended_at IS NULL
           ORDER BY s.started_at DESC
           FOR UPDATE`,
           [user.userRole, canonicalAccount, nodeCode],
        );

        // sameMachineSession：同一台电脑重复启动时直接恢复原会话。
        const sameMachineSession = activeSessions.find((item) => inputMachineId && item.machine_id === inputMachineId && item.node_code === nodeCode);
        if (sameMachineSession) {
          await conn.execute(
            `UPDATE ${tables.devices}
             SET status = ?, current_user_name = ?, current_session_id = ?
             WHERE machine_id = ?`,
          ["Unlocked", user.name, sameMachineSession.id, inputMachineId],
        );
        await addLog("恢复上机", `${userRoleText(user.userRole)}账号 ${displayAccount} 恢复上机会话`, inputMachineId, conn);
        return {
          // allowed：允许进入上机状态。
          allowed: true,
          // sessionId：复用同机已有会话 ID。
          sessionId: sameMachineSession.id,
          // studentNo：兼容旧客户端字段名，返回规范账号。
          studentNo: canonicalAccount,
          // userRole：本次登录用户身份。
          userRole: user.userRole,
          // name：登录用户姓名。
          name: user.name,
          // message：返回给客户端的提示。
          message: "登录成功。",
          // restored：标记为同机恢复会话。
          restored: true,
        };
      }

        // conflictSession：同一账号在其他电脑上的最新 active 会话。
        const conflictSession = activeSessions[0];
        if (conflictSession) {
          // activeSession：返回给客户端确认框展示的原登录设备详情。
          const activeSession = activeSessionInfo(conflictSession);
          // activePlace：确认框里优先展示教室，其次 IP/机器名。
          const activePlace = activeSessionPlace(conflictSession);
          const safeLogPlace = logSessionPlace(conflictSession);
          if (!shouldTakeover) {
            // message：提示当前用户是否下线原电脑。
            const message = duplicateLoginMessage(activePlace);
            await addLog("登录冲突", `等待确认下线原电脑：${userRoleText(user.userRole)}账号 ${displayAccount} 已在 ${safeLogPlace} 登录`, inputMachineId, conn, { level: "warning" });
            return {
              // allowed：需要确认接管，暂不允许登录。
              allowed: false,
              // requiresTakeover：客户端据此弹出“是否下线原电脑”确认框。
              requiresTakeover: true,
              // sessionId：未确认接管前没有新会话 ID。
              sessionId: null,
              // name：未登录成功时没有用户姓名。
              name: null,
              // message：确认框提示文本。
              message,
              // activePlace：原登录位置摘要。
              activePlace,
              // activeSession：原登录设备详情。
              activeSession,
            };
          }

          // conflictSessionIds：需要被结束的原 active 会话 ID。
          const conflictSessionIds = activeSessions.map((item) => item.id);
          // placeholders：批量更新 SQL 的占位符。
          const placeholders = conflictSessionIds.map(() => "?").join(",");
          await conn.execute(
            `UPDATE ${tables.sessions}
             SET status = 'ended', ended_at = NOW()
             WHERE id IN (${placeholders}) AND status = 'active' AND ended_at IS NULL`,
            conflictSessionIds,
          );
          await conn.execute(
            `UPDATE ${tables.devices}
             SET status = 'Locked', current_user_name = NULL, current_session_id = NULL
             WHERE current_session_id IN (${placeholders})`,
            conflictSessionIds,
          );
          await addLog("异地登录", `${userRoleText(user.userRole)}账号 ${displayAccount} 已下线原电脑并登录本机，原位置：${safeLogPlace}`, inputMachineId, conn);
        }

        await conn.execute(
          `INSERT INTO ${tables.sessions} (id, machine_id, node_code, user_role, student_no, name, started_at, status)
           VALUES (?, ?, ?, ?, ?, ?, NOW(), ?)`,
          [sessionId, inputMachineId, nodeCode, user.userRole, canonicalAccount, user.name, "active"],
        );
        await conn.execute(
          `UPDATE ${tables.devices}
           SET status = ?, current_user_name = ?, current_session_id = ?
           WHERE machine_id = ?`,
          ["Unlocked", user.name, sessionId, inputMachineId],
        );
        await addLog("登录成功", `${userRoleText(user.userRole)}账号 ${displayAccount} 登录成功`, inputMachineId, conn);
        return {
          // allowed：允许进入上机状态。
          allowed: true,
          // sessionId：本次新建会话 ID。
          sessionId,
          // studentNo：兼容旧客户端字段名，返回规范账号。
          studentNo: canonicalAccount,
          // userRole：本次登录用户身份。
          userRole: user.userRole,
          // name：登录用户姓名。
          name: user.name,
          // message：返回给客户端的提示。
          message: "登录成功。",
          // restored：新登录不是恢复会话。
          restored: false,
          // takeover：是否为确认后接管旧电脑。
          takeover: Boolean(conflictSession),
        };
      });

      if (!loginResult.allowed) {
        consoleWarn("登录冲突", `主机：${inputMachineName || "未上报"}，身份：${userRoleText(user.userRole)}，账号：${displayAccount}，已在其他电脑登录，等待确认`);
        res.json(loginResult);
        return;
      }

      consoleInfo(loginResult.restored ? "恢复上机" : loginResult.takeover ? "异地登录" : "登录成功", `主机：${inputMachineName || "未上报"}，身份：${userRoleText(user.userRole)}，账号：${displayAccount}`);
      res.json(loginResult);
    } catch (error) {
      next(error);
    }
  });

  // 恢复会话：客户端被 Watchdog 重新拉起后尝试恢复右下角上机卡片。
  app.post("/api/restore-session", async (req, res, next) => {
    try {
      const {
        // machineId：客户端机器唯一 ID。
        machineId = "",
        // machineName：客户端主机名。
        machineName = "",
        // hostname：兼容旧字段，等同于 machineName。
        hostname = "",
        // ipAddress：客户端上报 IP。
        ipAddress = null,
        // macAddress：客户端上报 MAC。
        macAddress = null,
        // sessionId：客户端本地缓存的会话 ID。
        sessionId = "",
      } = req.body ?? {};
      // inputMachineId：清理空白后的机器 ID。
      const inputMachineId = String(machineId).trim();
      // inputMachineName：优先 machineName，兼容 hostname。
      const inputMachineName = String(machineName || hostname || "").trim();
      // inputSessionId：清理空白后的会话 ID。
      const inputSessionId = String(sessionId).trim();
      // inputIpAddress：授权使用服务端来源 IP，回环调试时才使用客户端上报值。
      const inputIpAddress = authoritativeClientIp(req, ipAddress, inputMachineId);
      // inputMacAddress：空字符串统一转 null。
      const inputMacAddress = nullableString(macAddress);

      if (!inputMachineId || !inputSessionId) {
        res.json({
          // allowed：缺少必要缓存信息，不能恢复。
          allowed: false,
          // sessionId：没有可恢复会话。
          sessionId: null,
          // name：没有可恢复用户。
          name: null,
          // message：返回给客户端的提示。
          message: "没有可恢复的上机会话。",
        });
        return;
      }

      // classroom：恢复会话前同样检查当前教室是否启用实名上机。
      const classroom = await matchClassroomByIp(inputIpAddress, { includeDisabled: true });
      if (!isClassroomIpAllowed(classroom)) {
        const policy = clientPolicyResponse(classroom);
        res.json({
          // allowed：IP 未匹配教室，不允许恢复。
          allowed: false,
          // sessionId：恢复失败时没有可用会话。
          sessionId: null,
          // name：恢复失败时没有用户姓名。
          name: null,
          // message：返回给客户端的固定提示。
          message: policy.message,
          // policy：补充非法 IP 策略字段。
          ...policy,
        });
        return;
      }
      if (!isClassroomSystemEnabled(classroom)) {
        await transaction(async (conn) => {
          await markClientDisabled(
            {
              machineId: inputMachineId,
              machineName: inputMachineName,
              ipAddress: inputIpAddress,
              macAddress: inputMacAddress,
              sessionId: inputSessionId,
              classroom,
            },
            conn,
          );
        });
        // policy：停用教室返回给客户端的统一策略响应。
        const policy = clientPolicyResponse(classroom);
        res.json({
          // allowed：教室停用，不允许恢复。
          allowed: false,
          // sessionId：恢复失败时没有可用会话。
          sessionId: null,
          // name：恢复失败时没有用户姓名。
          name: null,
          // policy：补充停用教室策略字段。
          ...policy,
        });
        return;
      }

      // restoreResult：事务内校验缓存会话是否仍然能恢复。
      const restoreResult = await transaction(async (conn) => {
        // sessions：按 sessionId + machineId 锁定查询原会话。
        const [sessions] = await conn.execute(
          `SELECT
             s.id,
             s.machine_id,
             s.user_role,
             s.student_no,
             s.name,
             s.status,
             s.ended_at
           FROM ${tables.sessions} s
           WHERE s.id = ? AND s.machine_id = ? AND s.node_code = ?
           LIMIT 1
           FOR UPDATE`,
          [inputSessionId, inputMachineId, nodeCode],
        );
        // session：当前要恢复的会话记录。
        const session = sessions[0];
        if (!session) {
          return {
            // allowed：缓存会话无效，不允许恢复。
            allowed: false,
            // sessionId：恢复失败时没有可用会话。
            sessionId: null,
            // name：恢复失败时没有用户姓名。
            name: null,
            // message：返回给客户端的提示。
            message: "本次登录已失效，请重新登录。",
          };
        }

        // 恢复接口只看会话最终状态；心跳超时仍由后台扫描器统一判定。
        const isExpired = session.status !== "active" || session.ended_at;
        if (isExpired) {
          return {
            // allowed：会话已结束，不允许恢复。
            allowed: false,
            // sessionId：恢复失败时没有可用会话。
            sessionId: null,
            // name：恢复失败时没有用户姓名。
            name: null,
            // message：返回给客户端的提示。
            message: "本次登录已失效，请重新登录。",
          };
        }

        if (!isLoginRole(session.user_role)) {
          await endSessionAndLockDevice(
            inputSessionId,
            inputMachineId,
            "会话身份无效",
            "账号身份无效，无法恢复上机",
            conn,
          );
          return {
            // allowed：会话身份无效，不允许恢复。
            allowed: false,
            // sessionId：恢复失败时没有可用会话。
            sessionId: null,
            // name：恢复失败时没有用户姓名。
            name: null,
            // message：返回给客户端的提示。
            message: "本次登录已失效，请重新登录。",
          };
        }

        const account = await findAccountByCanonicalNo(session.student_no, session.user_role);
        if (!account || account.ambiguous) {
          await endSessionAndLockDevice(
            inputSessionId,
            inputMachineId,
            "恢复上机失败",
            `${userRoleText(session.user_role)}账号已不存在或标识不唯一，账号内容已隐藏`,
            conn,
          );
          return {
            // allowed：账号不存在，不允许恢复。
            allowed: false,
            // sessionId：恢复失败时没有可用会话。
            sessionId: null,
            // name：恢复失败时没有用户姓名。
            name: null,
            // message：返回给客户端的提示。
            message: "账号不存在，请重新登录。",
          };
        }

        if (Number(account.pingbi) === 1) {
          await endSessionAndLockDevice(
            inputSessionId,
            inputMachineId,
            "恢复上机失败",
            `${userRoleText(session.user_role)}账号 ${accountLogText(account)} 已被屏蔽`,
            conn,
          );
          return {
            // allowed：账号被屏蔽，不允许恢复。
            allowed: false,
            // sessionId：恢复失败时没有可用会话。
            sessionId: null,
            // name：恢复失败时没有用户姓名。
            name: null,
            // message：返回给客户端的提示。
            message: "账号已被屏蔽，禁止恢复上机。",
          };
        }

        await touchLoginDevice(
          {
            machineId: inputMachineId,
            machineName: inputMachineName,
            ipAddress: inputIpAddress,
            macAddress: inputMacAddress,
            classroom,
          },
          conn,
        );
        await conn.execute(
          `UPDATE ${tables.devices}
           SET status = ?, current_user_name = ?, current_session_id = ?
           WHERE machine_id = ?`,
          ["Unlocked", account.name, inputSessionId, inputMachineId],
        );
        const displayAccount = accountLogText(account);
        await addLog("恢复上机", `${userRoleText(session.user_role)}账号 ${displayAccount} 自动恢复上机会话`, inputMachineId, conn);
        return {
          // allowed：允许恢复上机状态。
          allowed: true,
          // sessionId：恢复成功的会话 ID。
          sessionId: inputSessionId,
          // studentNo：兼容旧客户端字段名，返回规范账号。
          studentNo: session.student_no,
          // userRole：恢复成功的用户身份。
          userRole: session.user_role,
          // name：恢复成功的用户姓名。
          name: account.name,
          // message：返回给客户端的提示。
          message: "已恢复上机会话。",
          // restored：标记为自动恢复。
          restored: true,
          // logAccount：仅供路由完成控制台日志，响应前必须移除。
          logAccount: displayAccount,
        };
      });

      const { logAccount, ...publicRestoreResult } = restoreResult;
      if (restoreResult.allowed) {
        consoleInfo("恢复上机", `主机：${inputMachineName || "未上报"}，身份：${userRoleText(restoreResult.userRole)}，账号：${logAccount || "已隐藏"}`);
      } else {
        consoleWarn("恢复上机失败", `主机：${inputMachineName || "未上报"}，原因：${restoreResult.message}`);
      }
      res.json(publicRestoreResult);
    } catch (error) {
      next(error);
    }
  });

  // 下机入口：结束会话、锁定设备，并记录下机原因。
  app.post("/api/logout", async (req, res, next) => {
    try {
      // machineId：要锁回登录状态的设备 ID。
      // sessionId：需要结束的会话 ID。
      // reason：下机原因，用于日志展示。
      const { machineId = "", sessionId = "", reason = "manual" } = req.body ?? {};
      if (!String(machineId).trim() || !String(sessionId).trim()) {
        res.status(400).json({ ok: false, message: "下机参数不完整。" });
        return;
      }
      const logoutApplied = await transaction(async (conn) => {
        const [sessions] = await conn.execute(
          `SELECT id FROM ${tables.sessions}
           WHERE id = ? AND machine_id = ? AND node_code = ? AND status = 'active' AND ended_at IS NULL
           LIMIT 1 FOR UPDATE`,
          [sessionId, machineId, nodeCode],
        );
        if (!sessions[0]) {
          return false;
        }
        await conn.execute(`UPDATE ${tables.sessions} SET status = ?, ended_at = NOW() WHERE id = ? AND node_code = ?`, ["ended", sessionId, nodeCode]);
        await conn.execute(
          `UPDATE ${tables.devices}
           SET status = ?, current_user_name = NULL, current_session_id = NULL
           WHERE machine_id = ? AND current_session_id = ?`,
          ["Locked", machineId, sessionId],
        );
        await addLog("用户下机", `设备下机：${logoutReasonText(reason)}`, machineId, conn);
        return true;
      });
      if (!logoutApplied) {
        res.status(409).json({ ok: false, message: "本次登录已失效，请重新登录。" });
        return;
      }
      consoleInfo("用户下机", `设备已下机，原因：${logoutReasonText(reason)}`);
      res.json({
        // ok：下机处理成功。
        ok: true,
      });
    } catch (error) {
      next(error);
    }
  });

  // 教师机专用下机入口：服务端核验教师会话、来源IP和教室权限后批量排队学生机关机。
  app.post("/api/teacher-logout", async (req, res, next) => {
    try {
      const result = await teacherLogoutAndShutdownStudents({
        machineId: req.body?.machineId,
        sessionId: req.body?.sessionId,
        sourceIp: authoritativeClientIp(req, req.body?.ipAddress, req.body?.machineId),
        // 兼容未携带该字段的旧客户端：旧接口语义就是学生机关机。
        // 旧客户端可能还带 shutdownAirConditioner，这里直接忽略，教师下机本身照常完成。
        shutdownStudents: req.body?.shutdownStudents === undefined ? true : req.body?.shutdownStudents,
      });
      if (!result.ok) {
        res.status(result.status || 400).json({ ok: false, message: result.message });
        return;
      }
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  // 故障报修账号预校验，便于登录页弹窗即时反馈。
  app.post("/api/fault/check-student", async (req, res, next) => {
    try {
      const clientConfig = await getClientConfig();
      if (!clientConfig.faultEnabled) {
        res.status(403).json({
          ok: false,
          message: "故障报修入口已关闭。",
        });
        return;
      }

      // reporterAccount：故障报修人账号，兼容旧 studentNo/faultStudentNo 字段。
      const reporterAccount = nullableString(req.body?.studentNo ?? req.body?.faultStudentNo ?? req.body?.account ?? req.body?.faultAccount);
      const reporterName = nullableString(req.body?.name ?? req.body?.faultName);
      if (!reporterAccount) {
        res.status(400).json({
          // ok：校验失败。
          ok: false,
          // message：返回给报修弹窗的提示。
          message: "请输入报修账号。",
        });
        return;
      }

      // reporter：账号可以来自学生表或教师表。
      const reporter = await findFaultReporterByAccount(reporterAccount, reporterName);
      if (!reporter.ok) {
        res.status(400).json({
          // ok：校验失败。
          ok: false,
          // message：返回给报修弹窗的提示。
          message: reporter.reason === "ambiguous"
            ? "报修账号无法唯一确认，请填写身份证号或工号。"
            : "账号不存在，请检查账号。",
        });
        return;
      }

      res.json({
        // ok：报修账号校验通过。
        ok: true,
        account: reporter.account.accountNo,
        name: reporter.account.name,
        userRole: reporter.account.userRole,
      });
    } catch (error) {
      next(error);
    }
  });

  // 故障报修正式提交，写入故障表并做同 IP 冷却限制。
  app.post("/api/fault", async (req, res, next) => {
    try {
      const clientConfig = await getClientConfig();
      if (!clientConfig.faultEnabled) {
        res.status(403).json({
          ok: false,
          message: "故障报修入口已关闭。",
        });
        return;
      }

      // faultType：故障类型，必须在配置白名单里。
      const faultType = nullableString(req.body?.type ?? req.body?.faultType);
      // reporterAccount：报修人账号，兼容旧 studentNo/faultStudentNo 字段。
      const reporterAccount = nullableString(req.body?.studentNo ?? req.body?.faultStudentNo ?? req.body?.account ?? req.body?.faultAccount);
      const reporterName = nullableString(req.body?.name ?? req.body?.faultName);
      // info：故障描述。
      const info = nullableString(req.body?.info ?? req.body?.faultInfo);
      // ip：使用服务端来源 IP；回环调试时才回退客户端上报值。
      const ip = authoritativeClientIp(req, req.body?.ip ?? req.body?.ipAddress);
      const classroom = await matchClassroomByIp(ip, { includeDisabled: true });
      const classroomName = classroom?.classroomName ?? null;

      if (!faultType || !reporterAccount || !info) {
        res.status(400).json({
          // ok：提交失败。
          ok: false,
          // message：返回给报修弹窗的提示。
          message: "请选择故障类型、填写报修账号和故障描述。",
        });
        return;
      }

      if (!allowedFaultTypes.has(faultType)) {
        res.status(400).json({
          // ok：提交失败。
          ok: false,
          // message：返回给报修弹窗的提示。
          message: "故障类型无效。",
        });
        return;
      }

      // reporter：报修账号必须能在学生表或教师表中唯一确认。
      const reporter = await findFaultReporterByAccount(reporterAccount, reporterName);
      if (!reporter.ok) {
        res.status(400).json({
          // ok：提交失败。
          ok: false,
          // message：返回给报修弹窗的提示。
          message: reporter.reason === "ambiguous"
            ? "报修账号无法唯一确认，请填写身份证号或工号。"
            : "账号不存在，请检查账号。",
        });
        return;
      }
      const reporterUser = reporter.account;
      const canonicalReporterAccount = String(reporterUser.accountNo).trim();
      const displayReporterAccount = accountLogText(reporterUser);
      const reporterRoleText = userRoleText(reporterUser.userRole);

      const serverConfig = await getServerConfig();
      // recentFault：同 IP 冷却时间内最近一次故障报修。
      const [recentFault] = await query(
        `SELECT id, createtime
         FROM ${tables.faults}
         WHERE ip = ? AND createtime >= DATE_SUB(NOW(), INTERVAL ? MINUTE)
         ORDER BY createtime DESC
         LIMIT 1`,
        [ip ?? "", serverConfig.faultCooldownMinutes],
      );
      if (recentFault) {
        res.status(429).json({
          // ok：提交失败。
          ok: false,
          // message：冷却限制提示。
          message: `同一台电脑 ${serverConfig.faultCooldownMinutes} 分钟内只能提交一次故障报修。`,
        });
        return;
      }

      await execute(
        `INSERT INTO ${tables.faults} (ip, classroom_name, \`type\`, student_no, info, createtime)
         VALUES (?, ?, ?, ?, ?, NOW())`,
        [ip ?? "", classroomName, faultType, canonicalReporterAccount, info],
      );
      await addLog("故障报修", `故障报修：${faultType}，${reporterRoleText}账号：${displayReporterAccount}，教室：${classroomName || "未匹配"}`, null, null, { level: "warning" });
      consoleInfo("故障报修", `教室：${classroomName || "未匹配"}，${reporterRoleText}账号：${displayReporterAccount}，类型：${faultType}`);
      res.json({
        // ok：故障报修提交成功。
        ok: true,
        // message：返回给报修弹窗的提示。
        message: "故障报修已提交，管理员会尽快处理。",
      });
    } catch (error) {
      next(error);
    }
  });

  // 客户端远程指令执行结果回报：用于更新命令队列状态和记录执行日志。
  app.post("/api/command-result", async (req, res, next) => {
    try {
      const { machineId = "", commandId = "", status = "", message = "" } = req.body ?? {};
      const result = await completeDeviceCommand(commandId, machineId, status, message);
      if (!result.ok) {
        res.status(400).json(result);
        return;
      }
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  // 心跳入口：维护设备在线状态，并返回会话/教室/心跳配置。
  app.post("/api/heartbeat", async (req, res, next) => {
    try {
      const {
        // machineId：客户端机器唯一 ID。
        machineId = "",
        // machineName：客户端主机名。
        machineName = "",
        // hostname：兼容旧字段，等同于 machineName。
        hostname = "",
        // ipAddress：客户端上报 IP。
        ipAddress = null,
        // macAddress：客户端上报 MAC。
        macAddress = null,
        // status：客户端当前锁定状态。
        status = "Locked",
        // currentUserName：当前上机用户姓名。
        currentUserName = null,
        // currentSessionId：当前上机会话 ID。
        currentSessionId = null,
        // source：心跳来源，真正客户端传 client；Watchdog 传 watchdog，避免误领取远程命令。
        source = "",
      } = req.body ?? {};
      // inputMachineId：清理空白后的机器 ID。
      const inputMachineId = String(machineId).trim();
      // deviceName：优先 machineName，兼容 hostname。
      const deviceName = String(machineName || hostname || "").trim();
      // inputIpAddress：授权使用服务端来源 IP，回环调试时才使用客户端上报值。
      const inputIpAddress = authoritativeClientIp(req, ipAddress, inputMachineId);
      // inputMacAddress：空字符串统一转 null。
      const inputMacAddress = nullableString(macAddress);
      // classroom：当前设备 IP 对应的教室策略。
      const classroom = await matchClassroomByIp(inputIpAddress, { includeDisabled: true });
      // inputSessionId：空字符串统一转 null。
      const inputSessionId = nullableString(currentSessionId);
      const clientConfig = await getClientConfig();
      const serverConfig = await getServerConfig();
      if (!isClassroomIpAllowed(classroom)) {
        const policy = clientPolicyResponse(classroom);
        res.json({
          // policy：非法 IP 策略字段。
          ...policy,
          // sessionExpired：有会话 ID 时提示客户端回到登录状态。
          sessionExpired: Boolean(inputSessionId),
          // message：非法 IP 固定提示。
          message: policy.message,
          // idleShutdownMinutes：未匹配教室没有 out_time 策略。
          idleShutdownMinutes: 0,
          // heartbeatSeconds：服务端下发的下一轮心跳间隔。
          heartbeatSeconds: clientConfig.heartbeatSeconds,
        });
        return;
      }
      if (!isClassroomSystemEnabled(classroom)) {
        await transaction(async (conn) => {
          await markClientDisabled(
            {
              machineId: inputMachineId,
              machineName: deviceName,
              ipAddress: inputIpAddress,
              macAddress: inputMacAddress,
              sessionId: inputSessionId,
              classroom,
            },
            conn,
          );
        });
        // policy：停用教室返回给客户端的统一策略响应。
        const policy = clientPolicyResponse(classroom);
        res.json({
          // policy：停用教室策略字段。
          ...policy,
          // sessionExpired：有会话 ID 时提示客户端回到登录状态。
          sessionExpired: Boolean(inputSessionId),
          // message：停用教室提示。
          message: policy.message,
        });
        return;
      }

      // inputStatus：客户端上报状态，缺失时默认 Locked。
      const inputStatus = String(status || "Locked").trim() || "Locked";
      // sessionCheck：校验会话是否仍为当前机器的 active 会话；机器类型不限制学生或教师身份。
      const sessionCheck = inputSessionId
        ? await validateActiveSessionForDevice(inputSessionId, inputMachineId)
        : null;
      // sessionExpired：会话不存在、已结束或身份无效时强制失效。
      const sessionExpired = inputSessionId ? !sessionCheck?.active : false;
      const sessionMessage = sessionCheck?.invalidRole
        ? "本次登录已失效，请重新登录。"
        : sessionExpired
          ? "本次登录已失效，请重新登录。"
          : null;
      // deviceStatus：会话过期时强制设备状态回到 Locked。
      const deviceStatus = sessionExpired ? "Locked" : inputStatus;
      // deviceUserName：会话过期时清空当前用户。
      const deviceUserName = sessionExpired ? null : nullableString(currentUserName);
      // deviceSessionId：会话过期时清空当前会话。
      const deviceSessionId = sessionExpired ? null : inputSessionId;
      // deviceRecord：准备写入 tp_smsj_devices 的设备状态快照。
      const deviceRecord = {
        // machineId：客户端机器唯一 ID。
        machineId: inputMachineId,
        // machineName：设备显示名称。
        machineName: deviceName || inputMachineId || "unknown",
        // ipAddress：设备 IP。
        ipAddress: inputIpAddress,
        // macAddress：设备 MAC。
        macAddress: inputMacAddress,
        // classroomId：匹配到的教室 ID。
        classroomId: classroom.classroomId,
        // classroomName：匹配到的教室名称。
        classroomName: classroom.classroomName,
        // deviceRole：student/teacher/unknown。
        deviceRole: classroom.deviceRole,
        // status：Locked/Unlocked/Disabled 等设备状态。
        status: deviceStatus,
        // currentUserName：当前上机用户。
        currentUserName: deviceUserName,
        // currentSessionId：当前上机会话。
        currentSessionId: deviceSessionId,
      };

      logDeviceHeartbeat({
        machineId: inputMachineId,
        machineName: deviceName,
        ipAddress: inputIpAddress,
        macAddress: inputMacAddress,
        status: deviceStatus,
        currentUserName: deviceUserName,
        classroom,
      });

      if (shouldWriteDeviceHeartbeat(deviceRecord, sessionExpired, serverConfig)) {
        await upsertHeartbeatDevice(deviceRecord);
        rememberDeviceHeartbeatWrite(deviceRecord);
      } else {
        await touchDeviceLastSeen(deviceRecord.machineId);
      }

      // 远程下机/关机只派发给真正客户端，避免 Watchdog 的会话兜底心跳误领取命令。
      const command = String(source || "").trim().toLowerCase() === "client"
        ? await takePendingDeviceCommand(deviceRecord.machineId)
        : null;

      res.json({
        // ok：心跳处理成功。
        ok: true,
        // ipAllowed：当前 IP 已匹配教室配置。
        ipAllowed: true,
        // sessionExpired：当前会话是否已过期。
        sessionExpired,
        // message：需要客户端展示的提示。
        message: sessionMessage,
        // idleShutdownMinutes：登录页空闲自动关机分钟数。
        idleShutdownMinutes: classroom.idleShutdownMinutes,
        // allowStudentShutdown：仅用于客户端展示教师下机选项，最终权限仍由 /api/teacher-logout 校验。
        allowStudentShutdown: classroom.allowStudentShutdown === true,
        // deviceRole：当前 IP 匹配到的设备角色。
        deviceRole: classroom.deviceRole,
        // heartbeatSeconds：服务端下发的下一轮心跳间隔。
        heartbeatSeconds: clientConfig.heartbeatSeconds,
        // command：Vue 后台下发给当前设备的一条远程指令。
        command,
      });
    } catch (error) {
      next(error);
    }
  });

  // 所有接口异常统一落 runtime/error.log，并返回简短错误给客户端。
  app.use((error, req, res, _next) => {
    writeError(error);
    consoleError("接口异常", error);
    void addLog(
      "接口错误",
      `接口 ${req.method} ${req.path}：请求处理失败，详细信息已写入本地错误日志`,
      req.body?.machineId ?? null,
      null,
      { level: "error" },
    ).catch((logError) => {
      consoleError("接口错误日志写入失败", logError);
    });
    res.status(500).json({ message: "服务器错误" });
  });
  return app;
}

function validNodeAdminSignature(req) {
  const timestampText = String(req.get("x-node-timestamp") ?? "").trim();
  const signature = String(req.get("x-node-signature") ?? "").trim().toLowerCase();
  if (!/^\d{10}$/.test(timestampText) || !/^[a-f0-9]{64}$/.test(signature)) return false;
  const timestamp = Number(timestampText);
  if (!Number.isFinite(timestamp) || Math.abs(Math.floor(Date.now() / 1000) - timestamp) > 60) return false;
  const body = typeof req.rawJsonBody === "string" ? req.rawJsonBody : "";
  const expected = crypto.createHmac("sha256", nodeRegistrationKey).update(`${timestampText}\n${body}`, "utf8").digest("hex");
  return crypto.timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(expected, "hex"));
}

// 生产授权以服务端 socket 来源 IP 为准；只有本机联调请求才使用客户端上报 IP。
function authoritativeClientIp(req, reportedValue, machineId = null) {
  const sourceIp = nullableString(requestIp(req));
  const reportedIp = nullableString(reportedValue);
  if (!sourceIp || isLoopbackIp(sourceIp)) {
    return reportedIp ?? sourceIp;
  }

  if (reportedIp && reportedIp !== sourceIp) {
    const warningKey = `${machineId || "unknown"}|${sourceIp}|${reportedIp}`;
    if (!reportedIpMismatchWarnings.has(warningKey)) {
      reportedIpMismatchWarnings.add(warningKey);
      consoleWarn("客户端IP不一致", "客户端上报IP与服务端来源IP不一致，授权按来源IP处理");
    }
  }
  return sourceIp;
}

function isLoopbackIp(ipAddress) {
  return ipAddress === "::1" || ipAddress.startsWith("127.");
}

function isLoginRole(role) {
  return role === "student" || role === "teacher";
}
