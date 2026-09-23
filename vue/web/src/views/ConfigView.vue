<script setup>
import { onMounted, reactive, ref } from "vue";
import { ElMessage } from "element-plus";
import FieldHelp from "../components/FieldHelp.vue";
import NodePicker from "../components/NodePicker.vue";
import { useNodes } from "../composables/useNodes.js";
import { api } from "../api/client.js";

// 字段标签、小节分组和 help 正文由当前管理后台统一维护。
const GROUPS = {
  server: {
    title: "服务端配置",
    action: "save_server_config",
    sections: [
      {
        title: "会话与超时",
        fields: [
          { key: "heartbeat_timeout_seconds", label: "会话超时秒", min: 30, max: 3600, unit: "秒", help: "服务端从最后一次成功心跳开始计时，超过这个时间没有收到新的成功心跳，就把上机会话记为心跳超时下机，并在后台显示离线。它是独立配置，不会随客户端心跳间隔自动改。" },
          { key: "offline_scan_seconds", label: "超时扫描秒", min: 5, max: 3600, unit: "秒", help: "服务端每隔多少秒扫描一次已经超过“会话超时秒”的上机会话。数值越小，异常下机处理越及时。" },
          { key: "server_recovery_grace_minutes", label: "恢复宽限分钟", min: 0, max: 1440, unit: "分钟", help: "后端服务重启后的保护时间。宽限期内不自动结束心跳超时的进行中会话，仍在运行的客户端恢复心跳后会继续原会话；填 0 表示关闭。" },
          { key: "session_timeout_batch_size", label: "单批处理数", min: 1, max: 5000, unit: "条", help: "每次超时扫描最多自动结束多少条会话。机房规模大时可适当调高，避免一次处理过多记录。" },
        ],
      },
      {
        title: "心跳与报修",
        fields: [
          { key: "heartbeat_write_interval_seconds", label: "心跳写库秒", min: 5, max: 3600, unit: "秒", help: "客户端每次心跳都会到服务端并刷新在线时间。本项只控制机器状态、当前用户等完整快照在状态不变时多久完整写库一次；状态变化会立即写入。" },
          { key: "fault_cooldown_minutes", label: "故障冷却分钟", min: 1, max: 1440, unit: "分钟", help: "同一台电脑/IP 两次提交故障报修之间必须间隔的分钟数，用来防止学生重复提交刷屏。" },
        ],
      },
    ],
  },
  client: {
    title: "客户端配置",
    action: "save_client_config",
    sections: [
      {
        title: "连接与心跳",
        fields: [
          { key: "heartbeat_seconds", label: "心跳间隔秒", min: 3, max: 3600, unit: "秒", help: "客户端多久向服务端主动上报一次“我还活着”。例如填 10，就是每 10 秒带上机器、IP、状态、当前会话等信息请求一次服务端。" },
          { key: "http_timeout_seconds", label: "HTTP超时秒", min: 5, max: 120, unit: "秒", help: "客户端每次请求后端接口最多等待多少秒。超过这个时间，本次心跳/登录/报修请求算失败。" },
          { key: "config_refresh_seconds", label: "配置刷新秒", min: 3, max: 86400, unit: "秒", help: "客户端运行中多久重新读取一次本页客户端配置。修改故障入口、心跳参数后，新客户端会按这个间隔感知。" },
          { key: "client_alive_seconds", label: "活性文件秒", min: 1, max: 3600, unit: "秒", help: "客户端多久更新一次本机 client.alive 文件。看门狗用它判断客户端窗口是否还在响应。" },
        ],
      },
      {
        title: "登录与会话",
        fields: [
          { key: "fullscreen_enabled", label: "锁屏全屏", type: "bool", help: "控制客户端未登录时是否启用现场锁屏全屏模式。后端服务正常时按这里的配置生效；后端服务暂时不可用时，客户端使用本地配置兜底。" },
          { key: "restore_session_enabled", label: "恢复会话", type: "bool", help: "开启后，客户端重启时会尝试恢复未超时的上机会话，减少异常关闭后的重复登录。" },
          { key: "heartbeat_fail_lock_count", label: "心跳失败锁定次数", min: 0, max: 100, unit: "次", help: "已登录状态下连续请求服务端失败达到多少次后，本地锁回登录页。填 0 表示关闭连续失败本地锁定，只继续重试上报。" },
        ],
      },
      {
        title: "故障报修",
        fields: [
          { key: "fault_enabled", label: "故障报修", type: "bool", help: "控制登录页是否显示故障报修入口。关闭后客户端隐藏入口，后端也会拒绝新的报修提交。" },
        ],
      },
    ],
  },
  watchdog: {
    title: "看门狗配置",
    action: "save_watchdog_config",
    sections: [
      {
        title: "启动与通信",
        fields: [
          // 客户端路径不显示兜底值：UNC 路径无法作为通用示例，显示出来会误导配置。
          { key: "client_path", label: "客户端路径", type: "text", noFallback: true, help: "看门狗拉起客户端时使用的 EXE 路径，通常是 SMB 共享路径，例如 \\\\服务器\\RealName.SimpleClient.exe。" },
          { key: "check_seconds", label: "主检查间隔秒", min: 1, max: 3600, unit: "秒", help: "看门狗主循环多久检查一次客户端进程，负责发现客户端被关闭后重新拉起。" },
          { key: "policy_seconds", label: "策略刷新秒", min: 1, max: 86400, unit: "秒", help: "看门狗多久向后端读取一次教室启停策略和看门狗配置。教室停用或路径调整会按这个间隔生效。" },
          { key: "http_timeout_seconds", label: "HTTP超时秒", min: 1, max: 120, unit: "秒", help: "看门狗请求后端策略或心跳接口等待多少秒算超时。后端或网络异常时会使用上次有效策略继续运行。" },
        ],
      },
      {
        title: "守护策略",
        fields: [
          { key: "session_guard", label: "会话守护", type: "bool", help: "开启后，看门狗会兜底检查本机缓存会话是否仍有效，发现失效会结束旧客户端并清理缓存。" },
          { key: "alive_guard", label: "无响应守护", type: "bool", help: "开启后，看门狗会根据 client.alive 判断客户端是否卡死，并自动重启客户端。" },
          { key: "session_seconds", label: "会话检查秒", min: 1, max: 3600, unit: "秒", help: "存在本机会话缓存时，看门狗多久兜底检查一次会话是否已经超时、被接管或被停用。" },
          { key: "alive_stale_seconds", label: "无响应秒", min: 0, max: 86400, unit: "秒", help: "client.alive 超过这个秒数没有更新时，认为客户端窗口卡死或无响应，看门狗会结束并重新拉起客户端。填 0 表示关闭无响应检测。" },
        ],
      },
      {
        title: "日志策略",
        fields: [
          { key: "retry_log_seconds", label: "日志冷却秒", min: 0, max: 3600, unit: "秒", help: "相同拉起失败、网络失败等错误在这个时间内只写一次日志，避免断网时 watchdog.log 被刷屏。填 0 表示关闭按时间冷却，同一类错误在本次看门狗进程运行期间只写一次。" },
        ],
      },
    ],
  },
};

// 保存按钮分别对应服务端、客户端和 Watchdog 配置。
const SAVE_LABELS = { server: "保存服务端配置", client: "保存客户端配置", watchdog: "保存看门狗配置" };

// 摊平后供 load()/save() 按组取字段，避免两处字段清单对不上。
const FIELDS = Object.fromEntries(Object.entries(GROUPS).map(([key, group]) => [key, group.sections.flatMap((section) => section.fields)]));

const { current, state, reload: reloadNodes } = useNodes();
const forms = reactive({ server: {}, client: {}, watchdog: {} });
const hints = reactive({ fallbacks: {}, minimums: {} });
const loadedNode = ref("");
const loading = ref(false);
const savingGroup = ref("");

async function load() {
  loading.value = true;
  try {
    const ret = await api.get("get_config", { node_code: current.value });
    loadedNode.value = ret.node_code;
    hints.fallbacks = ret.program_fallbacks || {};
    hints.minimums = ret.program_minimums || {};
    // 布尔列后端回的是 0/1 整数，表单需要真正的布尔才能正确显示开关。
    for (const group of Object.keys(FIELDS)) {
      const source = ret[group] || {};
      const target = {};
      for (const field of FIELDS[group]) {
        const raw = source[field.key];
        target[field.key] = field.type === "bool" ? Number(raw) === 1 : raw ?? (field.type === "text" ? "" : 0);
      }
      forms[group] = target;
    }
  } finally {
    loading.value = false;
  }
}

function formatValue(group, field, value) {
  if (field.type === "bool") return Number(value) === 1 ? "开" : "关";
  return `${value}${field.unit || ""}`;
}

// 浮层底栏：当前系统的顺序是先程序兜底值、再最小值，空值不显示。
function footerFor(group, field) {
  if (field.noFallback) return "";
  const parts = [];
  const fallback = hints.fallbacks[group]?.[field.key];
  const minimum = hints.minimums[group]?.[field.key];
  if (fallback !== undefined && fallback !== null) parts.push(`程序兜底值：${formatValue(group, field, fallback)}`);
  if (minimum !== undefined && minimum !== null) parts.push(`最小值：${formatValue(group, field, minimum)}`);
  return parts.join(" ");
}

async function save(group) {
  const payload = { node_code: loadedNode.value };
  // 每个字段都显式带上：节点侧对缺失字段会按自己的默认值落库，漏发等于偷偷改值。
  for (const field of FIELDS[group]) {
    const value = forms[group][field.key];
    payload[field.key] = field.type === "bool" ? (value ? "1" : "0") : String(value ?? "");
  }
  savingGroup.value = group;
  try {
    const ret = await api.post(GROUPS[group].action, payload);
    ElMessage.success(ret.msg);
    await load();
  } catch {
    /* 具体原因由节点给出，已弹出 */
  } finally {
    savingGroup.value = "";
  }
}

onMounted(async () => {
  await reloadNodes();
  await load();
});
</script>

<template>
  <section>
    <h2 class="smsj-section-title">参数配置</h2>
    <div class="smsj-toolbar">
      <span class="smsj-tool-field">
        <label>配置节点</label>
        <NodePicker v-model="current" @change="load" />
      </span>
      <div class="right">
        <span v-if="loadedNode" class="node-name">正在编辑 {{ loadedNode }}</span>
        <el-button @click="load" :loading="loading">重新读取</el-button>
      </div>
    </div>

    <div class="smsj-alert info">
      当前配置只对选中的后端节点生效，未单独配置的项目使用全局默认值。配置写进该节点自己的业务库，后端按短缓存自动生效，不需要重启服务。带 <b>?</b> 的字段可查看使用说明。
    </div>
    <div v-if="!state.nodes.length" class="smsj-alert">还没有可用节点，请先去「节点管理」登记。</div>

    <div v-loading="loading" class="smsj-config-groups">
      <div v-for="(group, name) in GROUPS" :key="name" class="smsj-card">
        <h3 class="smsj-group-title">{{ group.title }}<span class="count">{{ FIELDS[name].length }} 项</span></h3>
        <section v-for="section in group.sections" :key="section.title" class="smsj-config-section">
          <h4 class="smsj-section-subtitle">{{ section.title }}</h4>
          <div class="smsj-fields">
            <div v-for="field in section.fields" :key="field.key" class="smsj-field" :class="{ wide: field.type === 'text' }">
              <span class="k">{{ field.label }}</span>
              <span class="v">
                <el-switch v-if="field.type === 'bool'" v-model="forms[name][field.key]" />
                <el-input v-else-if="field.type === 'text'" v-model="forms[name][field.key]" />
                <template v-else>
                  <el-input-number v-model="forms[name][field.key]" :min="field.min" :max="field.max" :controls-position="'right'" class="num" />
                  <span v-if="field.unit" class="unit">{{ field.unit }}</span>
                </template>
                <FieldHelp v-if="field.help" :label="field.label" :text="field.help" :foot="footerFor(name, field)" />
              </span>
            </div>
          </div>
        </section>
        <div class="smsj-form-actions">
          <el-button type="primary" :loading="savingGroup === name" :disabled="!loadedNode" @click="save(name)">
            {{ SAVE_LABELS[name] }}
          </el-button>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.smsj-config-groups { display: grid; gap: 10px; }
.smsj-config-section + .smsj-config-section { margin-top: 4px; }
/* 数字框带右侧步进按钮时默认 150px 太宽，压到能看清数值即可。 */
.num { width: 118px; flex: 0 0 118px; }
.num :deep(.el-input__inner) { font-variant-numeric: tabular-nums; }
</style>
