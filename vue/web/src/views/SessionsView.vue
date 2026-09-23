<script setup>
import { onMounted, ref } from "vue";
import NodePicker from "../components/NodePicker.vue";
import { useNodes } from "../composables/useNodes.js";
import { useTable } from "../composables/useTable.js";
import { dash, rangeToParam } from "../utils/format.js";

const { current, state } = useNodes();
const range = ref(null);
const table = useTable("sessions_list", {
  defaultParams: { node_code: "", keyword: "", user_role: "", status: "", date: "" },
});

function search() {
  table.filters.node_code = current.value;
  table.filters.date = rangeToParam(range.value);
  table.page = 1;
  return table.load();
}

function reset() {
  Object.assign(table.filters, { node_code: "", keyword: "", user_role: "", status: "", date: "" });
  range.value = null;
  return search();
}

onMounted(search);
</script>

<template>
  <section>
    <h2 class="smsj-section-title">上机会话</h2>
    <div class="smsj-toolbar">
      <span class="smsj-tool-field">
        <label>当前节点</label>
        <NodePicker v-model="current" @change="search" />
      </span>
      <el-input v-model="table.filters.keyword" placeholder="学号/工号/姓名/机器/IP/教室" style="width: 240px" clearable @keyup.enter="search" />
      <el-select v-model="table.filters.user_role" placeholder="身份" style="width: 110px" clearable>
        <el-option label="全部身份" value="" />
        <el-option label="学生" value="student" />
        <el-option label="教师" value="teacher" />
      </el-select>
      <el-select v-model="table.filters.status" placeholder="会话状态" style="width: 130px" clearable>
        <el-option label="全部状态" value="" />
        <el-option label="进行中" value="active" />
        <el-option label="正常结束" value="ended" />
        <el-option label="心跳超时" value="timeout" />
      </el-select>
      <el-date-picker v-model="range" type="daterange" value-format="YYYY-MM-DD" start-placeholder="开始日期" end-placeholder="结束日期" style="width: 240px" />
      <div class="right">
        <el-button @click="reset">重置</el-button>
        <el-button type="primary" @click="search" :loading="table.loading">查询</el-button>
      </div>
    </div>

    <el-alert v-if="table.notice" :title="table.notice" type="warning" :closable="false" show-icon style="margin-bottom: 14px" />

    <el-table class="smsj-table" max-height="max(320px, calc(100vh - 296px))" :data="table.rows" v-loading="table.loading" border row-key="id">
      <el-table-column prop="id" label="会话ID" width="180" show-overflow-tooltip />
      <el-table-column label="所属节点" width="140">
        <template #default="{ row }">{{ dash(row._node_region_name || row.node_code) }}</template>
      </el-table-column>
      <el-table-column label="身份" width="72">
        <template #default="{ row }">{{ row.user_role === "teacher" ? "教师" : "学生" }}</template>
      </el-table-column>
      <el-table-column prop="display_account" label="学号/工号" width="150" show-overflow-tooltip />
      <el-table-column prop="name" label="姓名" width="96" show-overflow-tooltip />
      <el-table-column prop="classroom_name" label="教室" width="140" show-overflow-tooltip />
      <el-table-column prop="machine_name" label="主机名" width="140" show-overflow-tooltip />
      <el-table-column prop="ip_address" label="IP地址" width="128" />
      <el-table-column prop="machine_id" label="机器ID" width="170" show-overflow-tooltip />
      <el-table-column label="状态" width="96">
        <template #default="{ row }">
          <span class="state-tag" :class="row.status === 'active' ? 'unlocked' : row.status === 'timeout' ? 'danger' : 'offline'">
            {{ row.status === "active" ? "进行中" : row.status === "timeout" ? "心跳超时" : "正常结束" }}
          </span>
        </template>
      </el-table-column>
      <el-table-column prop="started_at" label="开始时间" width="156" />
      <el-table-column label="结束时间" width="156">
        <template #default="{ row }">{{ dash(row.ended_at) }}</template>
      </el-table-column>
      <el-table-column label="时长" width="80" align="right">
        <template #default="{ row }">{{ dash(row.use_minutes) }} 分</template>
      </el-table-column>
      <template #empty>
        <div class="smsj-empty">{{ state.nodes.length ? "没有符合条件的会话" : "还没有登记任何后端节点" }}</div>
      </template>
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
