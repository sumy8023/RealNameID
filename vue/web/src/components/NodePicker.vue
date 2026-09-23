<script setup>
import { computed } from "vue";
import { useNodes } from "../composables/useNodes.js";

const props = defineProps({ modelValue: { type: String, default: "" }, width: { type: String, default: "170px" } });
const emit = defineEmits(["update:modelValue", "change"]);
const { state } = useNodes();

// 对外仍然用空串表示"全部节点"，但选项值借 API 官方哨兵 ALL，
// 否则 el-select 会把空值当未选中，只显示占位符而不是"全部节点"。
const value = computed({
  get: () => props.modelValue || "ALL",
  set: (next) => {
    const normalized = next === "ALL" ? "" : next;
    emit("update:modelValue", normalized);
    emit("change", normalized);
  },
});
</script>

<template>
  <el-select v-model="value" :style="{ width }" placeholder="选择节点">
    <el-option label="全部节点" value="ALL" />
    <el-option v-for="node in state.nodes" :key="node.node_code" :value="node.node_code">
      <span>{{ node.region_name }}</span>
      <span class="node-name">（{{ node.node_code }}）</span>
      <span v-if="!node.online_status" class="node-name">· 上次检测离线</span>
    </el-option>
  </el-select>
</template>
