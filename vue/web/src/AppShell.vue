<script setup>
import { computed, onMounted, onUnmounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import {
  ArrowDown, Connection, Cpu, Document, Expand, Fold, Monitor, School,
  Setting, Timer, WarningFilled,
} from "@element-plus/icons-vue";
import { MENU_GROUPS } from "./router.js";
import { api, onUnauthorized } from "./api/client.js";
import { useNodes } from "./composables/useNodes.js";

const ICONS = { Monitor, Connection, Setting, School, Cpu, Timer, WarningFilled, Document };

const route = useRoute();
const router = useRouter();
const { state, reload, startPolling, stopPolling, onlineCount } = useNodes();

const collapsed = ref(localStorage.getItem("smsj.sidebar") === "collapsed");
const currentGroup = computed(() => MENU_GROUPS.find((group) => group.children.some((page) => page.name === route.name))?.title || "");

function toggleSidebar() {
  collapsed.value = !collapsed.value;
  localStorage.setItem("smsj.sidebar", collapsed.value ? "collapsed" : "expanded");
}

async function logout() {
  await api.post("logout", {}, { silent: true }).catch(() => null);
  api.user = null;
  api.checked = false;
  router.replace({ name: "login" });
}

let off = null;
onMounted(async () => {
  off = onUnauthorized(() => {
    api.user = null;
    api.checked = false;
    void router.replace({ name: "login" });
  });
  await reload();
  startPolling();
});
onUnmounted(() => {
  stopPolling();
  off?.();
});
</script>

<template>
  <div class="shell" :class="{ 'is-collapsed': collapsed }">
    <aside class="side">
      <div class="side-brand">
        <span class="side-brand-mark">
          <el-icon><Monitor /></el-icon>
        </span>
        <span v-show="!collapsed" class="side-brand-text">
          实名上机<small>管理后台</small>
        </span>
      </div>

      <el-scrollbar class="side-scroll">
        <nav class="side-nav">
          <template v-for="group in MENU_GROUPS" :key="group.title">
            <p v-if="!collapsed" class="side-group">{{ group.title }}</p>
            <hr v-else class="side-group-line">
            <RouterLink
              v-for="page in group.children"
              :key="page.name"
              class="side-item"
              :to="{ name: page.name }"
              :title="page.title"
            >
              <el-icon class="side-item-icon"><component :is="ICONS[page.icon]" /></el-icon>
              <span v-show="!collapsed">{{ page.title }}</span>
            </RouterLink>
          </template>
        </nav>
      </el-scrollbar>

      <div class="side-foot">
        <span class="dot" :class="onlineCount() ? 'on' : 'off'"></span>
        <span v-show="!collapsed">后端节点 {{ onlineCount() }}/{{ state.nodes.length }} 在线</span>
      </div>
    </aside>

    <div class="main">
      <header class="topbar">
        <button class="topbar-toggle" type="button" :aria-label="collapsed ? '展开菜单' : '收起菜单'" @click="toggleSidebar">
          <el-icon><Expand v-if="collapsed" /><Fold v-else /></el-icon>
        </button>
        <el-breadcrumb separator="/">
          <el-breadcrumb-item>{{ currentGroup || "实名上机" }}</el-breadcrumb-item>
          <el-breadcrumb-item>{{ route.meta.title }}</el-breadcrumb-item>
        </el-breadcrumb>

        <div class="topbar-right">
          <el-tag v-if="state.loaded && !onlineCount()" type="danger" size="small" effect="light">后端节点全部离线</el-tag>
          <el-dropdown trigger="click">
            <span class="topbar-user">
              <span class="topbar-avatar">{{ (api.user?.admin_xm || api.user?.admin_name || "?").slice(0, 1) }}</span>
              <span>{{ api.user?.admin_xm || api.user?.admin_name }}</span>
              <el-icon class="topbar-caret"><ArrowDown /></el-icon>
            </span>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item disabled>登录名 {{ api.user?.admin_name }} · {{ api.user?.post || "未设置职务" }}</el-dropdown-item>
                <el-dropdown-item divided @click="logout">退出登录</el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </div>
      </header>

      <section class="content">
        <RouterView />
      </section>
    </div>
  </div>
</template>
