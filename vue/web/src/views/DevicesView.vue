<script setup>
import { onMounted, ref } from "vue";
import NodePicker from "../components/NodePicker.vue";
import { useNodes } from "../composables/useNodes.js";
import { useTable } from "../composables/useTable.js";
import { dash } from "../utils/format.js";

const { current, state } = useNodes();
const range = ref(null);
const table = useTable("devices_list", {
  defaultParams: { node_code: "", keyword: "", classroom_name: "", building_name: "", status: "", device_role: "", overview_status: "" },
  limit: 30,
});

function search() {
  table.filters.node_code = current.value;
  table.page = 1;
  return table.load();
}

function reset() {
  Object.assign(table.filters, {
    node_code: "", keyword: "", classroom_name: "", building_name: "", status: "", device_role: "", overview_status: "",
  });
  return search();
}

onMounted(search);
</script>

<template>
  <section>
    <h2 class="smsj-section-title">设备明细</h2>
    <div class="smsj-toolbar">
      <span class="smsj-tool-field">
        <label>当前节点</label>
        <NodePicker v-model="current" @change="search" />
      </span>
      <el-input v-model="table.filters.keyword" placeholder="机器名/IP/学号/姓名" style="width: 220px" clearable @keyup.enter="search" />
      <el-input v-model="table.filters.classroom_name" placeholder="教室名称" style="width: 140px" clearable @keyup.enter="search" />
      <el-select v-model="table.filters.overview_status" placeholder="在线状态" style="width: 130px" clearable>
        <el-option label="全部状态" value="" />
        <el-option label="在线" value="online" />
        <el-option label="离线" value="offline" />
        <el-option label="在线锁定" value="locked" />
        <el-option label="正在上机" value="using" />
      </el-select>
      <el-select v-model="table.filters.status" placeholder="锁定状态" style="width: 130px" clearable>
        <el-option label="全部锁定" value="" />
        <el-option label="已解锁" value="Unlocked" />
        <el-option label="已锁定" value="Locked" />
        <el-option label="已禁用" value="Disabled" />
      </el-select>
      <el-select v-model="table.filters.device_role" placeholder="机器类型" style="width: 130px" clearable>
        <el-option label="全部类型" value="" />
        <el-option label="学生机" value="student" />
        <el-option label="教师机" value="teacher" />
        <el-option label="未识别" value="unknown" />
      </el-select>
      <div class="right">
        <el-button @click="reset">重置</el-button>
        <el-button type="primary" @click="search" :loading="table.loading">查询</el-button>
      </div>
    </div>

    <div class="smsj-alert info">
      这里只看设备登记与心跳。远程下机、远程关机属于风险操作，请在「主机总览」按教室确认后执行。
    </div>
    <el-alert v-if="table.notice" :title="table.notice" type="warning" :closable="false" show-icon style="margin-bottom: 14px" />

    <el-table class="smsj-table" max-height="max(320px, calc(100vh - 296px))" :data="table.rows" v-loading="table.loading" border>
      <el-table-column label="所属节点" width="140">
        <template #default="{ row }">{{ dash(row._node_region_name || row.node_code) }}</template>
      </el-table-column>
      <el-table-column prop="display_account" label="学号/工号" width="150" show-overflow-tooltip>
        <template #default="{ row }">{{ dash(row.display_account) }}</template>
      </el-table-column>
      <el-table-column prop="display_name" label="姓名" width="96" show-overflow-tooltip>
        <template #default="{ row }">{{ dash(row.display_name) }}</template>
      </el-table-column>
      <el-table-column label="身份" width="72">
        <template #default="{ row }">{{ row.current_user_role === "teacher" ? "教师" : row.current_user_role === "student" ? "学生" : "-" }}</template>
      </el-table-column>
      <el-table-column prop="classroom_name" label="教室" width="140" show-overflow-tooltip />
      <el-table-column label="在线" width="76">
        <template #default="{ row }">
          <span class="state-tag" :class="row.online_text === '在线' ? 'online' : 'offline'">{{ dash(row.online_text) }}</span>
        </template>
      </el-table-column>
      <el-table-column label="锁定" width="86">
        <template #default="{ row }">
          <span class="state-tag" :class="row.status === 'Unlocked' ? 'unlocked' : 'locked'">{{ row.status === "Unlocked" ? "已解锁" : row.status === "Disabled" ? "已禁用" : "已锁定" }}</span>
        </template>
      </el-table-column>
      <el-table-column prop="ip_address" label="IP地址" width="128" />
      <el-table-column prop="mac_address" label="MAC地址" width="150">
        <template #default="{ row }">{{ dash(row.mac_address) }}</template>
      </el-table-column>
      <el-table-column prop="machine_name" label="主机名" width="150" show-overflow-tooltip />
      <el-table-column label="类型" width="82">
        <template #default="{ row }">{{ row.device_role === "teacher" ? "教师机" : row.device_role === "student" ? "学生机" : "未识别" }}</template>
      </el-table-column>
      <el-table-column prop="last_seen_at" label="最后心跳" width="156" />
      <el-table-column prop="machine_id" label="机器ID" min-width="180" show-overflow-tooltip />
      <template #empty>
        <div class="smsj-empty">{{ state.nodes.length ? "没有符合条件的设备" : "还没有登记任何后端节点" }}</div>
      </template>
    </el-table>

    <div class="pager">
      <el-pagination
        v-model:current-page="table.page"
        v-model:page-size="table.pageSize"
        :total="table.count"
        :page-sizes="[30, 80, 150, 300, 500]"
        layout="total, sizes, prev, pager, next"
        @current-change="table.load"
        @size-change="search"
      />
    </div>
  </section>
</template>
