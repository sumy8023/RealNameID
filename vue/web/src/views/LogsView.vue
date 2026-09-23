<script setup>
import { onMounted, ref } from "vue";
import { api } from "../api/client.js";
import { useTable } from "../composables/useTable.js";
import { dash, rangeToParam } from "../utils/format.js";

// 只列本项目还会产生的事件；库里遗留的"扫码*"历史事件由 log_event_options 动态补进来。
const KNOWN_EVENTS = [
  "登录成功", "恢复上机", "登录失败", "登录冲突", "异地登录", "用户下机", "异常下机", "远程下机", "远程关机", "教室关机",
  "故障报修", "教室停用", "接口错误",
];

const ADMIN_SOURCES = ["Vue后台"];
function sourceText(value) {
  if (!value) return "-";
  if (value === "Node") return "后端服务";
  if (ADMIN_SOURCES.includes(value)) return "管理后台";
  return value;
}

const range = ref(null);
const events = ref([...KNOWN_EVENTS]);
const table = useTable("logs_list", {
  defaultParams: { keyword: "", event_name: "", operator_name: "", log_level: "", log_source: "", date: "" },
});

// 日志页从不发 node_code：日志表里没有节点列，由 BFF 从登记表合成，因此这里不给节点筛选。
function search() {
  table.filters.date = rangeToParam(range.value);
  table.page = 1;
  return table.load();
}

function reset() {
  Object.assign(table.filters, { keyword: "", event_name: "", operator_name: "", log_level: "", log_source: "", date: "" });
  range.value = null;
  return search();
}

async function loadEvents() {
  const ret = await api.get("log_event_options", {}, { silent: true }).catch(() => null);
  if (!ret) return;
  const extra = (ret.data || []).map((item) => item.event_name).filter((name) => name && !KNOWN_EVENTS.includes(name));
  events.value = [...KNOWN_EVENTS, ...extra];
}

onMounted(async () => {
  await search();
  await loadEvents();
});
</script>

<template>
  <section>
    <h2 class="smsj-section-title">系统日志</h2>
    <div class="smsj-toolbar">
      <el-select v-model="table.filters.event_name" placeholder="事件" style="width: 160px" filterable clearable>
        <el-option label="全部事件" value="" />
        <el-option v-for="event in events" :key="event" :label="event" :value="event" />
      </el-select>
      <el-input v-model="table.filters.operator_name" placeholder="操作人" style="width: 140px" clearable @keyup.enter="search" />
      <el-select v-model="table.filters.log_level" placeholder="级别" style="width: 110px" clearable>
        <el-option label="全部级别" value="" />
        <el-option label="普通" value="info" />
        <el-option label="警告" value="warning" />
        <el-option label="报错" value="error" />
      </el-select>
      <el-select v-model="table.filters.log_source" placeholder="来源" style="width: 130px" clearable>
        <el-option label="全部来源" value="" />
        <el-option label="管理后台" value="Vue后台" />
        <el-option label="后端服务" value="Node" />
        <el-option label="客户端" value="客户端" />
        <el-option label="守护服务" value="Watchdog" />
      </el-select>
      <el-input v-model="table.filters.keyword" placeholder="机器/IP/内容/教室" style="width: 220px" clearable @keyup.enter="search" />
      <el-date-picker v-model="range" type="daterange" value-format="YYYY-MM-DD" start-placeholder="开始日期" end-placeholder="结束日期" style="width: 240px" />
      <div class="right">
        <el-button @click="reset">重置</el-button>
        <el-button type="primary" @click="search" :loading="table.loading">查询</el-button>
      </div>
    </div>

    <el-alert v-if="table.notice" :title="table.notice" type="warning" :closable="false" show-icon style="margin-bottom: 14px" />

    <el-table class="smsj-table" max-height="max(320px, calc(100vh - 296px))" :data="table.rows" v-loading="table.loading" border>
      <el-table-column prop="log_time" label="日志时间" width="156" />
      <el-table-column label="级别" width="76">
        <template #default="{ row }">
          <span class="state-tag" :class="row.log_level === 'error' ? 'danger' : row.log_level === 'warning' ? 'locked' : 'neutral'">
            {{ row.log_level === "error" ? "报错" : row.log_level === "warning" ? "警告" : "普通" }}
          </span>
        </template>
      </el-table-column>
      <el-table-column prop="event_name" label="事件" width="120" show-overflow-tooltip />
      <el-table-column label="来源" width="96">
        <template #default="{ row }">{{ sourceText(row.log_source) }}</template>
      </el-table-column>
      <el-table-column label="操作人" width="106">
        <template #default="{ row }">{{ dash(row.operator_name) }}</template>
      </el-table-column>
      <el-table-column prop="message" label="日志内容" min-width="300" show-overflow-tooltip />
      <el-table-column label="教室" width="140" show-overflow-tooltip>
        <template #default="{ row }">{{ dash(row.classroom_name) }}</template>
      </el-table-column>
      <el-table-column label="主机名" width="140" show-overflow-tooltip>
        <template #default="{ row }">{{ dash(row.machine_name) }}</template>
      </el-table-column>
      <el-table-column prop="ip_address" label="IP地址" width="128">
        <template #default="{ row }">{{ dash(row.ip_address) }}</template>
      </el-table-column>
      <el-table-column label="所属节点" width="140">
        <template #default="{ row }">{{ dash(row._node_region_name || row.node_code) }}</template>
      </el-table-column>
      <el-table-column prop="machine_id" label="机器ID" min-width="180" show-overflow-tooltip />
      <template #empty><div class="smsj-empty">没有符合条件的日志</div></template>
    </el-table>

    <div class="pager">
      <el-pagination
        v-model:current-page="table.page"
        v-model:page-size="table.pageSize"
        :total="table.count"
        :page-sizes="[50, 100, 200, 500]"
        layout="total, sizes, prev, pager, next"
        @current-change="table.load"
        @size-change="search"
      />
    </div>
  </section>
</template>
