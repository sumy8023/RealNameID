<script setup>
import { QuestionFilled } from "@element-plus/icons-vue";

// 参数配置、节点弹窗、教室弹窗共用同一种说明浮层：标题 + 正文 + 可选底栏。
defineProps({
  label: { type: String, required: true },
  text: { type: String, required: true },
  foot: { type: String, default: "" },
});
</script>

<template>
  <el-popover placement="top" :width="360" trigger="click" popper-class="smsj-help-pop">
    <template #reference>
      <el-icon class="hint-icon"><QuestionFilled /></el-icon>
    </template>
    <p class="smsj-help-pop-title">{{ label }}</p>
    <p class="smsj-help-pop-text">{{ text }}</p>
    <p v-if="foot" class="smsj-help-pop-foot">{{ foot }}</p>
  </el-popover>
</template>
