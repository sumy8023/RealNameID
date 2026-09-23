const { createApp } = Vue;

// 登录页本地兜底值；正常会被 C# 从 appsettings.jsonc 读取后覆盖，不由 Node 后端下发。
var CLIENT_LOCAL_CONFIG = {
  loginFastClickMs: 1000,
  loginCooldownSeconds: 3,
};

// 登录页 Vue 应用：负责登录表单、故障报修、重复登录确认和空闲关机倒计时。
createApp({
  // 页面响应式状态定义，所有模板上用到的字段都集中在这里。
  data() {
    return {
      // 学号/账号输入框内容。
      studentNo: "",
      // 姓名输入框内容。
      name: "",
      // 密码输入框内容。
      password: "",
      // 是否显示明文密码。
      passwordVisible: false,
      // Node 后端是否已经连接成功；未连接时提示服务器连接失败。
      nodeOnline: false,
      // 登录或自动关机请求是否处理中。
      loading: false,
      // 当前客户端 IP 是否命中后端教室 IP 配置。
      ipAllowed: true,
      // 登录按钮快速重复点击判定窗口，单位毫秒，来自本地 JS 配置。
      loginFastClickMs: Number(CLIENT_LOCAL_CONFIG.loginFastClickMs) || 1000,
      // 登录频繁点击后的冷却秒数，来自本地 JS 配置。
      loginCooldownSeconds: Number.isFinite(Number(CLIENT_LOCAL_CONFIG.loginCooldownSeconds))
        ? Math.max(0, Math.floor(Number(CLIENT_LOCAL_CONFIG.loginCooldownSeconds)))
        : 3,
      // 上一次点击登录的时间戳，用于判断连续点击。
      lastLoginClickAt: 0,
      // 登录频繁点击冷却剩余秒数。
      loginCooldown: 0,
      // 登录冷却倒计时定时器。
      loginCooldownTimer: null,
      // 表单下方提示文案。
      message: "",
      // 提示类型：error/success/空字符串。
      messageType: "",
      // 右上角 toast 是否显示。
      toastVisible: false,
      // 右上角 toast 文案。
      toastMessage: "",
      // 右上角 toast 类型。
      toastType: "",
      // toast 自动关闭定时器。
      toastTimer: null,
      // 当前教室配置的登录页空闲自动关机分钟数，0 表示不启用。
      idleShutdownMinutes: 0,
      // 空闲自动关机倒计时剩余秒数。
      idleShutdownRemainingSeconds: 0,
      // 空闲自动关机倒计时定时器。
      idleShutdownTimer: null,
      // 是否已经触发过自动关机，防止倒计时结束后重复发送消息。
      idleShutdownTriggered: false,
      // 极域等教学广播全屏覆盖登录页时暂停自动关机倒计时。
      idleShutdownPaused: false,
      // 重复登录确认框是否显示。
      loginConflictVisible: false,
      // 后端返回的已登录设备信息。
      loginConflict: null,
      // 是否正在提交“下线原电脑并登录本机”。
      takeoverSubmitting: false,
      // 故障报修弹窗是否显示。
      faultDialogVisible: false,
      // 当前选中的故障类型；启动后会被后端下发配置覆盖。
      faultType: "键盘鼠标",
      // 故障类型默认兜底列表；后端 /api/client-config 成功后会覆盖。
      faultTypes: ["键盘鼠标", "显示器", "主机", "其他"],
      // 是否显示并允许使用故障报修入口。
      faultEnabled: true,
      // 故障报修人账号，兼容旧字段名 faultStudentNo。
      faultStudentNo: "",
      // 故障描述文本。
      faultDescription: "",
      // 是否正在提交故障报修。
      faultSubmitting: false,
      // 是否正在校验报修账号。
      faultChecking: false,
      // 故障报修二次确认框是否显示。
      faultConfirmVisible: false,
      powerMenuVisible: false,
      // 待确认的电源操作；空字符串表示未打开确认弹窗。
      powerConfirmAction: "",
    };
  },
  // 页面挂载后监听 C# WebView2 发来的消息，并主动请求客户端配置。
  mounted() {
    window.chrome.webview.addEventListener("message", (event) => {
      const data = event.data;
      if (!data) {
        return;
      }

      // 登录成功前的淡出动画通知：停止登录页自动关机倒计时。
      if (data.type === "fadeOut") {
        document.documentElement.classList.add("is-fading-out");
        this.idleShutdownPaused = false;
        this.stopIdleShutdownCountdown();
        return;
      }

      // 客户端回到登录页时重置表单、弹窗和倒计时状态。
      if (data.type === "reset") {
        document.documentElement.classList.remove("is-fading-out");
        this.resetLoginForm();
        this.stopLoginCooldown();
        this.loading = false;
        this.message = this.ipAllowed ? "" : "非法IP，请联系机房管理员";
        this.messageType = this.ipAllowed ? "" : "error";
        this.faultDialogVisible = false;
        this.faultSubmitting = false;
        this.faultChecking = false;
        this.faultConfirmVisible = false;
        this.loginConflictVisible = false;
        this.loginConflict = null;
        this.powerMenuVisible = false;
        this.powerConfirmAction = "";
        this.takeoverSubmitting = false;
        this.startIdleShutdownCountdown();
        return;
      }

      // C# 从后端拿到客户端配置后转发给页面。
      if (data.type === "clientConfig") {
        this.applyClientConfig(data);
        return;
      }

      // Node 连接状态变化：离线提示连接失败，恢复后清理该提示。
      if (data.type === "nodeConnection") {
        this.applyNodeConnection(data);
        return;
      }

      // C# 单独拿到教室策略后刷新空闲关机时间。
      if (data.type === "clientPolicy") {
        this.applyClientPolicy(data);
        return;
      }

      // 教学广播全屏覆盖期间暂停关机；恢复登录页后从完整配置时长重新倒计时。
      if (data.type === "idleShutdownPause") {
        this.pauseIdleShutdownCountdown();
        return;
      }
      if (data.type === "idleShutdownRestart") {
        this.restartIdleShutdownCountdown();
        return;
      }

      // 故障报修提交前，先接收账号校验结果。
      if (data.type === "faultStudentCheckResult") {
        this.faultChecking = false;
        this.faultConfirmVisible = !!data.ok;
        this.message = data.message || "";
        this.messageType = data.ok ? "" : "error";
        if (data.message) {
          this.showToast(data.message, data.ok ? "success" : "error");
        }
        return;
      }

      // 故障报修提交完成后的结果处理。
      if (data.type === "faultResult") {
        this.faultSubmitting = false;
        this.faultChecking = false;
        this.faultConfirmVisible = false;
        this.message = data.message || "";
        this.messageType = data.ok ? "success" : "error";
        if (data.message) {
          this.showToast(data.message, data.ok ? "success" : "error");
        }
        if (data.ok) {
          this.faultDialogVisible = false;
          this.faultStudentNo = "";
          this.faultDescription = "";
        }
        return;
      }

      // 后端发现该账号已在其他电脑登录时，显示接管确认框。
      if (data.type === "loginConflict") {
        this.loading = false;
        this.takeoverSubmitting = false;
        this.loginConflict = data.activeSession || {};
        this.loginConflict.activePlace = data.activePlace || this.loginConflict.classroomName || this.loginConflict.machineName || "其他电脑";
        this.loginConflictVisible = true;
        this.message = data.message || "该账号已在其他电脑登录。";
        this.messageType = "error";
        return;
      }

      // 没有 message 的普通消息不展示。
      if (!data.message) {
        return;
      }

      // 普通登录成功/失败/处理中消息统一在这里更新页面提示。
      if (typeof data.loading === "boolean") {
        this.loading = data.loading;
      } else if (data.type === "error" || data.type === "success") {
        this.loading = false;
        this.takeoverSubmitting = false;
      }

      this.message = data.message;
      this.messageType = data.type === "error" ? "error" : data.type === "success" ? "success" : "";
      if (Number(data.toastDurationMs) > 0) {
        this.showToast(data.message, this.messageType || "error", Number(data.toastDurationMs));
      }
    });
    // 页面启动后主动向 C# 请求后端客户端配置。
    this.requestClientConfig();
    window.addEventListener("keydown", this.handlePowerDialogKeydown);
  },
  beforeUnmount() {
    window.removeEventListener("keydown", this.handlePowerDialogKeydown);
  },
  methods: {
    requestPower(action) {
      if (action !== "shutdown" && action !== "restart") {
        return;
      }

      this.powerMenuVisible = false;
      this.powerConfirmAction = action;
      this.$nextTick(() => this.$refs.powerCancel?.focus());
    },
    cancelPower() {
      this.powerConfirmAction = "";
      this.$nextTick(() => this.$refs.powerTrigger?.focus());
    },
    confirmPower() {
      const action = this.powerConfirmAction;
      if (action !== "shutdown" && action !== "restart") {
        return;
      }

      this.powerConfirmAction = "";
      window.chrome.webview.postMessage(JSON.stringify({ type: "power", powerAction: action }));
    },
    handlePowerDialogKeydown(event) {
      if (!this.powerConfirmAction) {
        return;
      }

      if (event.key === "Escape") {
        event.preventDefault();
        this.cancelPower();
        return;
      }

      if (event.key !== "Tab") {
        return;
      }

      const focusable = Array.from(this.$refs.powerDialog?.querySelectorAll("button:not(:disabled)") || []);
      if (focusable.length === 0) {
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    },
    // 向 C# 请求客户端配置，C# 会调用后端 /api/client-config 后再回传给页面。
    requestClientConfig() {
      window.chrome.webview.postMessage(
        JSON.stringify({
          type: "clientConfig",
        }),
      );
    },
    // 应用后端下发的客户端配置：故障类型、报修入口和空闲关机分钟数。
    applyClientConfig(data) {
      this.applyNodeConnection({ online: data.nodeOnline === true, message: data.message });
      this.loginFastClickMs = this.normalizeIntegerRange(data.loginFastClickMs, this.loginFastClickMs, 0, 10000);
      this.loginCooldownSeconds = this.normalizeIntegerRange(data.loginCooldownSeconds, this.loginCooldownSeconds, 0, 300);
      this.faultEnabled = data.faultEnabled !== false;

      if (this.loginCooldown <= 0) {
        this.stopLoginCooldown();
      } else if (this.loginCooldown > this.loginCooldownSeconds) {
        this.loginCooldown = this.loginCooldownSeconds;
      }

      if (!this.faultEnabled) {
        this.faultDialogVisible = false;
        this.faultSubmitting = false;
        this.faultChecking = false;
        this.faultConfirmVisible = false;
      }

      // 故障类型只接受非空字符串，并去掉前后空格。
      const faultTypes = Array.isArray(data.faultTypes)
        ? data.faultTypes.map((item) => String(item).trim()).filter(Boolean)
        : [];
      // 后端返回有效故障类型时覆盖前端默认兜底列表。
      if (faultTypes.length > 0) {
        this.faultTypes = [...new Set(faultTypes)];
        if (!this.faultTypes.includes(this.faultType)) {
          this.faultType = this.faultTypes[0];
        }
      }

      this.applyClientPolicy(data);
    },
    // 标准化后端下发的整数配置，超出范围时夹到安全范围。
    normalizeIntegerRange(value, fallback, min, max) {
      const number = Number(value);
      if (!Number.isFinite(number)) {
        return fallback;
      }
      return Math.min(max, Math.max(min, Math.floor(number)));
    },
    // 应用当前 IP 对应的客户端策略：非法 IP 时显示提示并关闭空闲关机倒计时。
    applyClientPolicy(data) {
      const wasAllowed = this.ipAllowed;
      const nextAllowed = data.ipAllowed !== false;
      this.ipAllowed = nextAllowed;

      if (!nextAllowed) {
        const message = data.message || "非法IP，请联系机房管理员";
        this.applyIdleShutdownPolicy(0);
        this.loading = false;
        this.message = message;
        this.messageType = "error";
        if (wasAllowed || this.toastMessage !== message) {
          this.showToast(message, "error", 5000);
        }
        return;
      }

      if (this.message === "非法IP，请联系机房管理员" || this.message === "服务器连接失败，正在重试。") {
        this.message = "";
        this.messageType = "";
      }

      this.applyIdleShutdownPolicy(data.idleShutdownMinutes);
    },
    // 应用 Node 连接状态，控制离线提示和普通错误提示清理。
    applyNodeConnection(data) {
      const nextOnline = data.online === true;
      this.nodeOnline = nextOnline;

      if (!nextOnline) {
        const message = data.message || "服务器连接失败，正在重试。";
        this.loading = false;
        this.message = message;
        this.messageType = "error";
        return;
      }

      if (this.message === "服务器连接失败，正在重试。") {
        this.message = "";
        this.messageType = "";
      }
    },
    // 重置登录表单字段和重复登录确认状态。
    resetLoginForm() {
      this.studentNo = "";
      this.name = "";
      this.password = "";
      this.passwordVisible = false;
      this.loginConflictVisible = false;
      this.loginConflict = null;
      this.takeoverSubmitting = false;
      this.idleShutdownTriggered = false;
      if (!this.ipAllowed) {
        this.message = "非法IP，请联系机房管理员";
        this.messageType = "error";
      }
    },
    // 启动登录频繁点击冷却，冷却秒数由客户端本地配置控制。
    startLoginCooldown() {
      const seconds = this.normalizeIntegerRange(this.loginCooldownSeconds, 3, 0, 300);
      window.clearInterval(this.loginCooldownTimer);
      if (seconds <= 0) {
        this.loginCooldownTimer = null;
        this.loginCooldown = 0;
        this.showToast("请勿频繁点击登录。");
        return;
      }

      this.loginCooldown = seconds;
      this.loading = false;
      this.message = "";
      this.messageType = "";
      this.showToast(`操作过于频繁，请${seconds}秒后再登录。`);

      // 每秒减少一次冷却时间，归零后自动停止。
      this.loginCooldownTimer = window.setInterval(() => {
        this.loginCooldown -= 1;
        if (this.loginCooldown <= 0) {
          this.stopLoginCooldown();
        }
      }, 1000);
    },
    // 停止登录冷却并清理计时状态。
    stopLoginCooldown() {
      window.clearInterval(this.loginCooldownTimer);
      this.loginCooldownTimer = null;
      this.loginCooldown = 0;
      this.lastLoginClickAt = 0;
    },
    // 密码只允许半角可见 ASCII 字符，避免中文输入法误提交候选词。
    sanitizePassword(value) {
      return String(value || "").replace(/[^\x21-\x7e]/g, "");
    },
    // 在浏览器写入前尽量阻止中文/全角字符进入密码框。
    onPasswordBeforeInput(event) {
      if (event.data && this.sanitizePassword(event.data) !== event.data) {
        event.preventDefault();
        this.showToast("密码只能输入英文、数字和半角符号。");
      }
    },
    // 兜底清洗已经进入输入框的内容，包括输入法提交和拖拽等情况。
    onPasswordInput(event) {
      const next = this.sanitizePassword(event.target.value);
      if (next !== event.target.value) {
        event.target.value = next;
        this.showToast("密码只能输入英文、数字和半角符号。");
      }
      this.password = next;
    },
    // 粘贴时先清洗剪贴板文本，避免中文或全角字符被带入。
    onPasswordPaste(event) {
      const text = event.clipboardData?.getData("text") || "";
      const next = this.sanitizePassword(text);
      if (next !== text) {
        event.preventDefault();
        const input = event.target;
        const start = input.selectionStart ?? input.value.length;
        const end = input.selectionEnd ?? input.value.length;
        const value = `${input.value.slice(0, start)}${next}${input.value.slice(end)}`;
        input.value = value;
        input.setSelectionRange(start + next.length, start + next.length);
        this.password = value;
        this.showToast("密码只能输入英文、数字和半角符号。");
      }
    },
    // 显示右上角提示，默认作为错误提示，指定时间后自动隐藏。
    showToast(message, type = "error", durationMs = 2600) {
      window.clearTimeout(this.toastTimer);
      this.toastMessage = message;
      this.toastType = type;
      this.toastVisible = true;
      this.toastTimer = window.setTimeout(() => {
        this.toastVisible = false;
      }, durationMs);
    },
    // 应用教室 out_time 策略，换算成分钟并重新启动登录页空闲倒计时。
    applyIdleShutdownPolicy(minutes) {
      const value = Number(minutes);
      const nextMinutes = Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
      // 策略未变化且倒计时正在运行时，不重复重置倒计时。
      if (nextMinutes === this.idleShutdownMinutes && this.idleShutdownTimer && this.idleShutdownRemainingSeconds > 0) {
        return;
      }

      this.idleShutdownMinutes = nextMinutes;
      this.startIdleShutdownCountdown();
    },
    // 启动登录页空闲自动关机倒计时。
    startIdleShutdownCountdown() {
      window.clearInterval(this.idleShutdownTimer);
      this.idleShutdownTimer = null;
      this.idleShutdownTriggered = false;

      if (this.idleShutdownPaused) {
        this.idleShutdownRemainingSeconds = 0;
        return;
      }

      // out_time 为 0 或无效时不启用自动关机。
      if (this.idleShutdownMinutes <= 0) {
        this.idleShutdownRemainingSeconds = 0;
        return;
      }

      // 每秒扣减剩余秒数，到 0 后触发自动关机消息。
      this.idleShutdownRemainingSeconds = this.idleShutdownMinutes * 60;
      this.idleShutdownTimer = window.setInterval(() => {
        this.idleShutdownRemainingSeconds -= 1;
        if (this.idleShutdownRemainingSeconds <= 0) {
          this.triggerIdleShutdown();
        }
      }, 1000);
    },
    // 停止登录页空闲自动关机倒计时。
    stopIdleShutdownCountdown() {
      window.clearInterval(this.idleShutdownTimer);
      this.idleShutdownTimer = null;
      this.idleShutdownRemainingSeconds = 0;
    },
    // 教学广播覆盖时暂停空闲关机，并阻止心跳策略刷新重新启动倒计时。
    pauseIdleShutdownCountdown() {
      this.idleShutdownPaused = true;
      this.idleShutdownTriggered = false;
      this.stopIdleShutdownCountdown();
    },
    // 教学广播退出后，从后台配置的完整 out_time 重新开始倒计时。
    restartIdleShutdownCountdown() {
      if (!this.idleShutdownPaused) {
        return;
      }

      this.idleShutdownPaused = false;
      this.startIdleShutdownCountdown();
    },
    // 空闲倒计时结束后通知 C# 执行系统关机。
    triggerIdleShutdown() {
      // 已触发过则直接返回，防止定时器或重复调用导致多次关机请求。
      if (this.idleShutdownTriggered || this.idleShutdownPaused) {
        return;
      }

      this.idleShutdownTriggered = true;
      this.stopIdleShutdownCountdown();
      this.loading = true;
      this.message = "长时间未登录，正在自动关机...";
      this.messageType = "error";
      window.chrome.webview.postMessage(
        JSON.stringify({
          type: "idleShutdown",
        }),
      );
    },
    // 把剩余秒数格式化成登录页展示的倒计时文本。
    idleShutdownText() {
      const total = Math.max(0, this.idleShutdownRemainingSeconds);
      const minutes = Math.floor(total / 60);
      const seconds = total % 60;
      if (minutes > 0) {
        return `${minutes}分${String(seconds).padStart(2, "0")}秒`;
      }
      return `${seconds}秒`;
    },
    // 打开故障报修弹窗，如果登录账号已填，则自动带入报修账号。
    openFaultDialog() {
      if (!this.faultEnabled) {
        this.showToast("故障报修入口已关闭。");
        return;
      }

      if (!this.faultStudentNo && this.studentNo) {
        this.faultStudentNo = this.studentNo;
      }

      this.faultDialogVisible = true;
      this.message = "";
      this.messageType = "";
    },
    // 关闭故障报修弹窗；提交中或校验中不允许关闭。
    closeFaultDialog() {
      if (this.faultSubmitting || this.faultChecking) {
        return;
      }

      // 如果正在二次确认页，关闭动作先返回表单编辑页。
      if (this.faultConfirmVisible) {
        this.faultConfirmVisible = false;
        return;
      }

      this.faultDialogVisible = false;
    },
    // 提交故障报修前的第一步：校验表单并请求后端确认账号存在。
    submitFault() {
      if (!this.faultEnabled) {
        this.showToast("故障报修入口已关闭。");
        return;
      }

      if (!this.faultStudentNo) {
        this.showToast("请输入报修账号。");
        return;
      }

      if (!this.faultDescription) {
        this.showToast("请填写故障描述。");
        return;
      }

      this.faultChecking = true;
      this.message = "";
      this.messageType = "";

      // 先发给 C#，再由 C# 调用后端 /api/fault/check-student。
      window.chrome.webview.postMessage(
        JSON.stringify({
          type: "faultCheckStudent",
          faultStudentNo: this.faultStudentNo,
          name: this.name,
        }),
      );
    },
    // 取消故障报修二次确认，回到报修表单。
    cancelFaultConfirm() {
      this.faultConfirmVisible = false;
    },
    // 二次确认后正式提交故障报修。
    confirmFaultSubmit() {
      if (!this.faultEnabled) {
        this.faultConfirmVisible = false;
        this.showToast("故障报修入口已关闭。");
        return;
      }

      // 已在提交中时忽略重复点击。
      if (this.faultSubmitting) {
        return;
      }

      this.faultConfirmVisible = false;
      this.faultSubmitting = true;
      this.message = "";
      this.messageType = "";

      // 发给 C#，由 C# 调用后端 /api/fault 写入报修记录。
      window.chrome.webview.postMessage(
        JSON.stringify({
          type: "fault",
          faultType: this.faultType,
          faultStudentNo: this.faultStudentNo,
          name: this.name,
          faultInfo: this.faultDescription,
        }),
      );
    },
    // 登录按钮提交入口：做前端必填校验、频繁点击限制和重复提交保护。
    submit() {
      const now = Date.now();

      // 冷却中直接提示剩余时间。
      if (this.loginCooldown > 0) {
        this.showToast(`操作过于频繁，请${this.loginCooldown}秒后再登录。`);
        return;
      }

    // 正在登录时再次快速点击，会按客户端本地 JS 配置进入冷却。
      if (this.loading) {
        if (this.lastLoginClickAt > 0 && now - this.lastLoginClickAt <= this.loginFastClickMs) {
          this.startLoginCooldown();
        }
        return;
      }

      // 当前 IP 不在后端教室 IP 配置内时禁止登录。
      if (!this.ipAllowed) {
        this.showToast("非法IP，请联系机房管理员", "error", 5000);
        return;
      }

      // 登录账号必填，可填写学生学号或教师工号、身份证号；教师手机号也由后端兼容识别。
      if (!this.studentNo) {
        this.showToast("请输入账号。");
        return;
      }

      // 姓名必填，和后端学生姓名校验配合。
      if (!this.name) {
        this.showToast("请输入姓名。");
        return;
      }

      // 密码必填。
      if (!this.password) {
        this.showToast("请输入密码。");
        return;
      }

      // 客户端本地时间窗口内重复点击登录，进入冷却，避免频繁请求后端。
      if (this.lastLoginClickAt > 0 && now - this.lastLoginClickAt <= this.loginFastClickMs) {
        this.startLoginCooldown();
        return;
      }

      // 进入登录中状态，并清理上一次重复登录确认信息。
      this.lastLoginClickAt = now;
      this.loading = true;
      this.loginConflictVisible = false;
      this.loginConflict = null;
      this.takeoverSubmitting = false;
      this.message = "正在登录...";
      this.messageType = "";

      this.postLogin(false);
    },
    // 向 C# 发送登录请求，forceLogin=true 表示确认下线原电脑并登录本机。
    postLogin(forceLogin) {
      window.chrome.webview.postMessage(
        JSON.stringify({
          type: "login",
          studentNo: this.studentNo,
          name: this.name,
          password: this.password,
          forceLogin: !!forceLogin,
        }),
      );
    },
    // 取消重复登录接管，不下线原电脑。
    cancelTakeoverLogin() {
      if (this.takeoverSubmitting) {
        return;
      }

      this.loginConflictVisible = false;
      this.loginConflict = null;
      this.message = "";
      this.messageType = "";
    },
    // 确认重复登录接管，下线原电脑并重新提交登录。
    confirmTakeoverLogin() {
      // 正在提交或普通登录处理中时不重复提交。
      if (this.takeoverSubmitting || this.loading) {
        return;
      }

      this.takeoverSubmitting = true;
      this.loading = true;
      this.message = "正在登录...";
      this.messageType = "";
      this.postLogin(true);
    },
    // 读取重复登录弹窗中的设备信息，空值时显示兜底文案。
    activeLoginValue(key, fallback) {
      const value = this.loginConflict?.[key];
      return value ? String(value) : fallback;
    },
  },
}).mount("#app");
