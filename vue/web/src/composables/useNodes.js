import { reactive, ref } from "vue";
import { api } from "../api/client.js";

// 节点清单和在线状态全站共享一份：每个页面各自轮询 node_status 的话，
// BFF 对节点的探测次数会按页面数放大。
const state = reactive({
  nodes: [],
  defaultNodeCode: "",
  statuses: [],
  loaded: false,
});

const current = ref("");
let polling = null;
let loading = null;

async function loadOptions() {
  const ret = await api.get("node_options");
  state.nodes = ret.data || [];
  state.defaultNodeCode = ret.default_node_code || "";
  state.loaded = true;
}

async function refreshStatus() {
  const ret = await api.get("node_status", { node_code: current.value }, { silent: true }).catch(() => null);
  if (ret) {
    state.statuses = ret.nodes || [];
    return ret.status || null;
  }
  return null;
}

async function reload() {
  if (!loading) {
    loading = Promise.all([loadOptions(), refreshStatus()]).finally(() => {
      loading = null;
    });
  }
  return loading;
}

function startPolling(ms = 15000) {
  stopPolling();
  polling = window.setInterval(() => {
    void refreshStatus();
  }, ms);
}

function stopPolling() {
  if (polling) window.clearInterval(polling);
  polling = null;
}

export function useNodes() {
  function statusOf(nodeCode) {
    if (!nodeCode) return state.statuses.some((item) => item.online) ? "online" : "offline";
    return state.statuses.find((item) => item.node_code === nodeCode)?.online ? "online" : "offline";
  }

  function onlineCount() {
    return state.statuses.filter((item) => item.online).length;
  }

  return { state, current, reload, refreshStatus, startPolling, stopPolling, statusOf, onlineCount };
}
