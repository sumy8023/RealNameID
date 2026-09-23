<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import NodePicker from "../components/NodePicker.vue";
import { useNodes } from "../composables/useNodes.js";
import { api } from "../api/client.js";
import { dash } from "../utils/format.js";

const CARDS = [
  { key: "classroom_count", label: "教室总数" },
  { key: "enabled_classroom_count", label: "已启用教室" },
  { key: "device_count", label: "登记设备" },
  { key: "online_device_count", label: "在线设备", tint: true },
  { key: "active_session_count", label: "进行中会话", tint: true },
  { key: "today_fault_count", label: "今日报修", amber: true },
  { key: "today_log_count", label: "今日日志" },
];

const REFRESH_SECONDS = 10;
const PAGE_SIZES = [60, 120, 240];
// 筛选条件只活到这次浏览结束：sessionStorage 在切换页面和刷新后仍在，关掉标签页或浏览器自然清空。
const STORE_KEY = "smsj.overview.filters";

const { current, state, refreshStatus, startPolling, stopPolling } = useNodes();
const stats = ref({});
const notice = ref("");
const buildings = ref([]);
const building = ref("");
const rooms = ref([]);
const room = ref("");
const hosts = ref([]);
const hostsLoading = ref(false);
const page = ref(1);
const pageSize = ref(PAGE_SIZES[0]);
const totalCount = ref(0);
const autoRefresh = ref(false);
const countdown = ref(REFRESH_SECONDS);
let tick = null;

const selectedRoom = computed(() => rooms.value.find((item) => item.id === room.value) || null);

function restore() {
  let saved = {};
  try {
    saved = JSON.parse(sessionStorage.getItem(STORE_KEY) || "{}");
  } catch {
    saved = {};
  }
  if (typeof saved.node === "string") current.value = saved.node;
  if (typeof saved.building === "string") building.value = saved.building;
  if (typeof saved.room === "string") room.value = saved.room;
  if (Number.isInteger(saved.page) && saved.page > 0) page.value = saved.page;
  if (PAGE_SIZES.includes(saved.pageSize)) pageSize.value = saved.pageSize;
  if (typeof saved.autoRefresh === "boolean") autoRefresh.value = saved.autoRefresh;
}

function persist() {
  sessionStorage.setItem(
    STORE_KEY,
    JSON.stringify({
      node: current.value, building: building.value, room: room.value,
      page: page.value, pageSize: pageSize.value, autoRefresh: autoRefresh.value,
    }),
  );
}

async function loadStats() {
  const ret = await api.get("stats", { node_code: current.value }, { silent: true }).catch(() => null);
  if (!ret) {
    stats.value = {};
    notice.value = "统计不可用，请确认后端服务在线";
    return;
  }
  stats.value = ret.data || {};
  notice.value = ret.msg && ret.msg !== "获取成功" ? ret.msg : "";
}

async function loadFilters() {
  const [buildingsRet, roomsRet] = await Promise.all([
    api.get("classroom_building_options", { node_code: current.value }, { silent: true }).catch(() => null),
    api.get("classroom_options", { node_code: current.value, building_name: building.value }, { silent: true }).catch(() => null),
  ]);
  buildings.value = (buildingsRet?.data || []).map((item) => item.building_name);
  if (building.value && !buildings.value.includes(building.value)) {
    building.value = "";
    return loadFilters();
  }
  rooms.value = roomsRet?.data || [];
  // 教室 ID 带节点前缀，换节点后原值多半已经不存在，这时才放弃记住的选择。
  if (!rooms.value.some((item) => item.id === room.value)) room.value = "";
  await loadHosts();
}

async function loadHosts() {
  if (!room.value) {
    hosts.value = [];
    totalCount.value = 0;
    return;
  }
  hostsLoading.value = true;
  try {
    // 教室用 节点编号@数字id 定位，BFF 会据此把请求钉到那一个节点上。
    const ret = await api.get("devices_list", { classroom_id: room.value, page: page.value, limit: pageSize.value }, { silent: true });
    hosts.value = ret.data || [];
    totalCount.value = ret.count || 0;
    notice.value = ret.msg && ret.msg !== "获取成功" ? ret.msg : "";
  } catch (error) {
    hosts.value = [];
    totalCount.value = 0;
    notice.value = error.message;
  } finally {
    hostsLoading.value = false;
  }
}

async function refreshAll() {
  await Promise.all([loadStats(), loadFilters(), refreshStatus()]);
}

async function command(host, type) {
  const label = type === "shutdown" ? "远程关机" : "远程下机";
  const extra = type === "shutdown" ? "该计算机会直接断电，请确认学生已经保存内容。" : "该计算机会退回登录页。";
  await ElMessageBox.confirm(`${label}：${host.machine_name || host.ip_address || host.machine_id}（${host.ip_address}）${extra}`, `确认${label}`, {
    type: "warning",
    confirmButtonText: `确认${label}`,
  });
  const ret = await api.post("device_command", {
    node_code: host.node_code,
    machine_id: host.machine_id,
    classroom_id: host.classroom_id,
    command_type: type,
  });
  ElMessage.success(ret.msg);
  await loadHosts();
}

async function shutdownRoom() {
  // 在线台数取教室选项接口给的全量值：主机列表已经分页了，不能再用当前页的行数。
  const online = Number(selectedRoom.value?.online_count) || 0;
  if (!online) {
    ElMessage.warning("当前教室没有在线电脑可关机");
    return;
  }
  await ElMessageBox.confirm(
    `将向 ${selectedRoom.value.classroom_name} 当前在线的 ${online} 台电脑下发关机指令。请确认教室内没有正在使用的学生，否则后果自负！`,
    "一键关机整间教室",
    { type: "error", confirmButtonText: "确认关机", cancelButtonText: "取消" },
  );
  const ret = await api.post("classroom_shutdown", { classroom_id: room.value, node_code: current.value });
  ElMessage.success(`${ret.msg}（新增 ${ret.created} 条，已有待执行 ${ret.duplicated} 条）`);
  await loadHosts();
}

function canLogout(host) {
  return host.online_text === "在线" && host.status === "Unlocked" && host.current_session_id;
}

function roleText(host) {
  return host.current_user_role === "teacher" ? "教师" : host.current_user_role === "student" ? "学生" : "未上机";
}

watch([current, building, room, page, pageSize, autoRefresh], persist);

watch(current, async () => {
  building.value = "";
  room.value = "";
  page.value = 1;
  await refreshAll();
});
watch(building, async () => {
  page.value = 1;
  await loadFilters();
});
// 用户手动换教室时只改 room，不经过 loadFilters，这里必须自己把主机列表拉回来。
watch(room, async () => {
  page.value = 1;
  await loadHosts();
});
watch(page, loadHosts);
watch(pageSize, async () => {
  page.value = 1;
  await loadHosts();
});
watch(autoRefresh, (on) => {
  if (tick) window.clearInterval(tick);
  countdown.value = REFRESH_SECONDS;
  if (!on) return;
  tick = window.setInterval(() => {
    countdown.value -= 1;
    if (countdown.value > 0) return;
    countdown.value = REFRESH_SECONDS;
    void loadHosts();
  }, 1000);
});

onMounted(async () => {
  restore();
  await refreshAll();
  // 记住的节点可能已经在节点管理里被删掉，这时按"全部节点"重来，避免下拉框显示一个不存在的编号。
  if (current.value && !state.nodes.some((node) => node.node_code === current.value)) {
    current.value = "";
    await refreshAll();
  }
  startPolling();
});
onUnmounted(() => {
  stopPolling();
  if (tick) window.clearInterval(tick);
});
</script>

<template>
  <section>
    <h2 class="smsj-section-title">主机总览</h2>

    <div class="smsj-stat">
      <div v-for="card in CARDS" :key="card.key" class="smsj-card" :class="{ tinted: card.tint, amber: card.amber }">
        <div class="label">{{ card.label }}</div>
        <div class="value">{{ stats[card.key] ?? "-" }}</div>
      </div>
    </div>

    <div class="smsj-toolbar">
      <span class="smsj-tool-field">
        <label>当前节点</label>
        <NodePicker v-model="current" />
      </span>
      <span class="smsj-tool-field">
        <label>楼栋</label>
        <el-select v-model="building" style="width: 118px" placeholder="全部">
          <el-option label="全部楼栋" value="" />
          <el-option v-for="name in buildings" :key="name" :label="name" :value="name" />
        </el-select>
      </span>
      <span class="smsj-tool-field">
        <label>教室</label>
        <el-select v-model="room" style="width: 190px" placeholder="选择教室">
          <el-option v-for="item in rooms" :key="item.id" :value="item.id"
                     :label="`${item.classroom_name}（在线 ${item.online_count}/${item.device_count}）`" />
        </el-select>
      </span>
      <div class="right">
        <span class="auto-refresh">
          <el-switch v-model="autoRefresh" size="small" />
          <span v-if="autoRefresh" class="refresh-ring" :style="{ '--p': (1 - countdown / REFRESH_SECONDS) * 100 }">
            <span>{{ countdown }}</span>
          </span>
          <span v-else class="refresh-off">自动刷新</span>
        </span>
        <el-button @click="refreshAll">刷新</el-button>
        <el-button type="danger" plain :disabled="!selectedRoom || !selectedRoom.online_count" @click="shutdownRoom">
          一键关机本教室
        </el-button>
      </div>
    </div>

    <div v-if="notice" class="smsj-alert">{{ notice }}</div>
    <div v-if="!state.nodes.length" class="smsj-empty">还没有登记后端节点，请先到「节点管理」添加。</div>
    <div v-else-if="!rooms.length" class="smsj-empty">当前节点还没有教室配置，请先到「教室管理」添加。</div>
    <div v-else-if="!room" class="smsj-empty">选择一间教室后显示该教室的电脑，并可执行远程下机或关机。</div>
    <div v-else-if="!hosts.length && !hostsLoading" class="smsj-empty">这间教室还没有上报过设备，学生机开机后会自动登记。</div>

    <div v-if="room" class="smsj-host-grid dense" v-loading="hostsLoading">
      <div v-for="host in hosts" :key="host.machine_id" class="smsj-host-card" :class="host.online_text === '在线' ? 'online' : 'offline'">
        <div class="smsj-host-title">
          <span>{{ host.machine_name || host.ip_address || host.machine_id }}</span>
          <span class="state-tag" :class="host.online_text === '在线' ? 'online' : 'offline'" style="margin-left: 6px">{{ host.online_text }}</span>
        </div>
        <div class="host-metrics">
          <span><b>学号/工号</b>{{ dash(host.display_account) }}</span>
          <span><b>角色</b>{{ roleText(host) }}</span>
          <span><b>姓名</b>{{ dash(host.display_name) }}</span>
          <span><b>机器类型</b>{{ host.device_role === "teacher" ? "教师机" : host.device_role === "student" ? "学生机" : "未识别" }}</span>
          <span><b>IP</b>{{ dash(host.ip_address) }}</span>
          <span>
            <b>状态</b>
            <span class="state-tag" :class="host.status === 'Unlocked' ? 'unlocked' : 'locked'">{{ host.status === "Unlocked" ? "已解锁" : host.status === "Disabled" ? "已禁用" : "已锁定" }}</span>
          </span>
          <span class="span-2"><b>最后心跳</b>{{ dash(host.last_seen_at) }}</span>
        </div>
        <div class="smsj-host-actions">
          <el-button size="small" :disabled="!canLogout(host)" @click="command(host, 'force_logout')">下机</el-button>
          <el-button size="small" type="danger" plain :disabled="host.online_text !== '在线'" @click="command(host, 'shutdown')">关机</el-button>
        </div>
      </div>
    </div>

    <div v-if="room && totalCount" class="pager">
      <el-pagination
        v-model:current-page="page"
        v-model:page-size="pageSize"
        :total="totalCount"
        :page-sizes="PAGE_SIZES"
        layout="total, sizes, prev, pager, next"
      />
    </div>
  </section>
</template>

<style scoped>
.auto-refresh { display: inline-flex; align-items: center; gap: 8px; margin-right: 4px; }
.refresh-off { color: #4f5f58; font-size: 13px; }
/* 倒计时刻度：走完一圈即触发刷新，比纯文本更看得出来还剩几秒。 */
.refresh-ring {
  --p: 0;
  position: relative; display: grid; place-items: center; width: 26px; height: 26px; flex: 0 0 26px;
  border-radius: 50%;
  background: conic-gradient(var(--brand-500) calc(var(--p) * 1%), #e8edf3 0);
  font-size: 11.5px; font-weight: 600; font-variant-numeric: tabular-nums; line-height: 1;
}
.refresh-ring::after { content: ""; position: absolute; inset: 3px; border-radius: 50%; background: #fff; }
.refresh-ring span { position: relative; z-index: 1; color: var(--ink); }
/* 主机卡片：两列指标栅格，比一列行长句省一半高度。 */
.smsj-host-grid.dense { grid-template-columns: repeat(auto-fill, minmax(228px, 1fr)); }
.smsj-host-grid.dense :deep(.smsj-host-card) { padding: 8px 9px; }
.smsj-host-grid.dense :deep(.smsj-host-title) { margin-bottom: 6px; font-size: 13px; }
.smsj-host-grid.dense :deep(.smsj-host-actions) { margin-top: 7px; padding-top: 7px; }
.host-metrics {
  display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1px 8px;
  padding: 5px 7px; border-radius: 6px; background: #f7f9fc; font-size: 11.5px; color: var(--ink);
}
.host-metrics span { display: flex; gap: 4px; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.host-metrics span.span-2 { grid-column: 1 / -1; }
.host-metrics b { font-weight: 500; color: var(--muted); flex: 0 0 auto; }
</style>
