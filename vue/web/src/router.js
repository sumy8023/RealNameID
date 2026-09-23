import { createRouter, createWebHistory } from "vue-router";
import AppShell from "./AppShell.vue";
import { api } from "./api/client.js";

// name 必须和 BFF 的 action / 节点数据键一致，跨页面传参和表格列名都靠它对齐。
// group 只服务于侧栏分组，顺序即侧栏顺序。
export const PAGES = [
  { path: "overview", name: "overview", title: "主机总览", group: "运行概览", icon: "Monitor", component: () => import("./views/OverviewView.vue") },
  { path: "nodes", name: "nodes", title: "节点管理", group: "接入与参数", icon: "Connection", component: () => import("./views/NodesView.vue") },
  { path: "config", name: "config", title: "参数配置", group: "接入与参数", icon: "Setting", component: () => import("./views/ConfigView.vue") },
  { path: "classroom", name: "classroom", title: "教室管理", group: "资源管理", icon: "School", component: () => import("./views/ClassroomView.vue") },
  { path: "devices", name: "devices", title: "设备明细", group: "资源管理", icon: "Cpu", component: () => import("./views/DevicesView.vue") },
  { path: "sessions", name: "sessions", title: "上机会话", group: "运行记录", icon: "Timer", component: () => import("./views/SessionsView.vue") },
  { path: "fault", name: "fault", title: "故障报修", group: "运行记录", icon: "WarningFilled", component: () => import("./views/FaultView.vue") },
  { path: "logs", name: "logs", title: "系统日志", group: "运行记录", icon: "Document", component: () => import("./views/LogsView.vue") },
];

// 侧栏按组渲染；用 reduce 而不是手写第二份配置，避免两处清单以后对不上。
export const MENU_GROUPS = PAGES.reduce((groups, page) => {
  const found = groups.find((item) => item.title === page.group);
  if (found) found.children.push(page);
  else groups.push({ title: page.group, children: [page] });
  return groups;
}, []);

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/login", name: "login", component: () => import("./LoginView.vue"), meta: { public: true } },
    {
      path: "/",
      component: AppShell,
      children: [
        { path: "", redirect: "/overview" },
        ...PAGES.map((page) => ({
          path: page.path,
          name: page.name,
          component: page.component,
          meta: { title: page.title },
        })),
      ],
    },
    { path: "/:pathMatch(.*)*", redirect: "/overview" },
  ],
});

// 会话有效性只在进入受保护页时确认一次；之后的 401 由 api 层统一处理。
router.beforeEach(async (to) => {
  if (to.meta.public) return true;
  if (!api.checked) {
    try {
      api.user = (await api.get("me")).user;
    } catch {
      api.user = null;
    }
    api.checked = true;
  }
  if (!api.user) return { name: "login", query: { redirect: to.fullPath } };
  return true;
});

export default router;
