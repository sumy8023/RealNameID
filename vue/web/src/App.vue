<script setup>
// size=small 全局生效：后台信息密度优先，默认 32px 控件在表格里显得松散。
</script>

<template>
  <el-config-provider size="small" :button="{ autoInsertSpace: false }">
    <RouterView />
  </el-config-provider>
</template>
