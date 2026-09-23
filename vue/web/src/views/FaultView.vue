<script setup>
import { onMounted, ref } from "vue";
import { useTable } from "../composables/useTable.js";
import { dash, rangeToParam } from "../utils/format.js";

const range = ref(null);
const table = useTable("fault_list", { defaultParams: { keyword: "", type: "", date: "" }, limit: 30 });

function search() {
  table.filters.date = rangeToParam(range.value);
  table.page = 1;
  return table.load();
}

function reset() {
  Object.assign(table.filters, { keyword: "", type: "", date: "" });
  range.value = null;
  return search();
}

onMounted(search);
</script>

<template>
  <section>
    <h2 class="smsj-section-title">故障报修</h2>
    <div class="smsj-toolbar">
      <el-input v-model="table.filters.keyword" placeholder="IP/学号/工号/教室/内容" style="width: 240px" clearable @keyup.enter="search" />
      <el-select v-model="table.filters.type" placeholder="故障类型" style="width: 130px" clearable>
        <el-option label="全部类型" value="" />
        <el-option label="键盘鼠标" value="键盘鼠标" />
        <el-option label="显示器" value="显示器" />
        <el-option label="主机" value="主机" />
        <el-option label="其他" value="其他" />
      </el-select>
      <el-date-picker v-model="range" type="daterange" value-format="YYYY-MM-DD" start-placeholder="开始日期" end-placeholder="结束日期" style="width: 240px" />
      <div class="right">
        <el-button @click="reset">重置</el-button>
        <el-button type="primary" @click="search" :loading="table.loading">查询</el-button>
      </div>
    </div>

    <el-alert v-if="table.notice" :title="table.notice" type="warning" :closable="false" show-icon style="margin-bottom: 14px" />

    <el-table class="smsj-table" max-height="max(320px, calc(100vh - 296px))" :data="table.rows" v-loading="table.loading" border>
      <el-table-column label="所属节点" width="140">
        <template #default="{ row }">{{ dash(row._node_region_name || row.node_code) }}</template>
      </el-table-column>
      <el-table-column prop="ip" label="IP地址" width="128" />
      <el-table-column prop="classroom_name" label="教室" width="140" show-overflow-tooltip>
        <template #default="{ row }">{{ dash(row.classroom_name) }}</template>
      </el-table-column>
      <el-table-column prop="type" label="故障类型" width="116" />
      <el-table-column prop="display_account" label="学号/工号" width="150" show-overflow-tooltip />
      <el-table-column prop="info" label="故障描述" min-width="280" show-overflow-tooltip />
      <el-table-column prop="createtime" label="报修时间" width="156" />
      <template #empty><div class="smsj-empty">还没有收到故障报修</div></template>
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
