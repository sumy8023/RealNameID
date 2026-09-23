<script setup>
import { onMounted, reactive, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import FieldHelp from "../components/FieldHelp.vue";
import { useNodes } from "../composables/useNodes.js";
import { api } from "../api/client.js";
import { dash } from "../utils/format.js";

const { state, refreshStatus, onlineCount } = useNodes();
const dialog = ref(false);
const saving = ref(false);
const form = reactive({ original_node_code: "", node_code: "", region_name: "", node_address: "", register_key: "" });

async function reload() {
  await refreshStatus();
}

function create() {
  Object.assign(form, { original_node_code: "", node_code: "", region_name: "", node_address: "", register_key: "" });
  dialog.value = true;
}

function edit(node) {
  Object.assign(form, {
    original_node_code: node.node_code,
    node_code: node.node_code,
    region_name: node.region_name,
    node_address: node.url || node.node_address,
    register_key: "",
  });
  dialog.value = true;
}

function validate() {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(form.node_code) || form.node_code.toUpperCase() === "GLOBAL") {
    return "节点编号只能是字母数字下划线短横线，且不能使用 GLOBAL";
  }
  if (!form.region_name.trim()) return "请填写区域名称";
  if (!/^https?:\/\//.test(form.node_address.trim())) return "后端地址必须是完整的 http 或 https 地址";
  if (!form.original_node_code && !/^[A-Za-z0-9]{6,128}$/.test(form.register_key)) return "注册密钥需使用6到128位英文字母和数字";
  return "";
}

async function save() {
  const problem = validate();
  if (problem) {
    ElMessage.warning(problem);
    return;
  }
  saving.value = true;
  try {
    const ret = await api.post("node_save", { ...form });
    ElMessage.success(ret.msg);
    dialog.value = false;
    await reload();
  } catch {
    /* 校验失败的原因由后端给出，已弹出 */
  } finally {
    saving.value = false;
  }
}

async function check(node) {
  const ret = await api.post("node_check", { node_code: node.node_code });
  ElMessage.success(`${node.region_name}：${ret.status.message}`);
  await reload();
}

async function setDefault(node) {
  const ret = await api.post("node_set_default", { node_code: node.node_code });
  ElMessage.success(ret.msg);
  await reload();
}

async function remove(node) {
  await ElMessageBox.confirm(
    `删除节点登记后，不会删除该节点的配置、教室和历史数据，确定继续？`,
    `删除 ${node.region_name}`,
    { type: "warning", confirmButtonText: "确认删除" },
  );
  const ret = await api.post("node_delete", { node_code: node.node_code });
  ElMessage.success(ret.msg);
  await reload();
}

function metric(node, key) {
  const value = node.metrics?.[key];
  return value === undefined || value === null ? "-" : value;
}

onMounted(reload);
</script>

<template>
  <section>
    <h2 class="smsj-section-title">节点管理</h2>
    <div class="smsj-toolbar">
      <div class="right">
        <span class="node-name">{{ state.statuses.length }} 个节点，{{ onlineCount() }} 个在线</span>
        <el-button @click="reload" :loading="!state.loaded">刷新检测</el-button>
        <el-button type="primary" @click="create">登记节点</el-button>
      </div>
    </div>

    <div class="smsj-alert info">
      节点编号是稳定标识，登记后不能改名；地址和注册密钥改动会立即重新探测。业务数据都存在各节点自己的库里，这里只登记入口。
    </div>

    <div v-if="state.statuses.length" class="smsj-host-grid">
      <div v-for="node in state.statuses" :key="node.node_code" class="smsj-host-card" :class="node.online ? 'online' : 'offline'">
        <div class="smsj-host-title">
          {{ node.region_name }}
          <span class="state-tag" :class="node.online ? 'online' : 'offline'">{{ node.online ? "在线" : "离线" }}</span>
          <span v-if="node.is_default" class="badge-default spacer">默认</span>
          <span v-else class="spacer"></span>
          <span class="node-name">{{ node.node_code }}</span>
        </div>
        <div class="smsj-host-line"><b>地址</b>{{ dash(node.url) }}</div>
        <div class="node-metrics">
          <span><b>教室</b>{{ node.classroom_count }}</span>
          <span><b>接口</b>v{{ node.admin_api_version || 0 }}</span>
          <span><b>延迟</b>{{ node.latency_ms === null ? "-" : `${node.latency_ms}ms` }}</span>
          <span><b>CPU</b>{{ metric(node, "cpuPercent") }}%</span>
          <span><b>内存</b>{{ metric(node, "memoryPercent") }}%</span>
          <span><b>客户端</b>{{ metric(node, "onlineClientCount") }}</span>
        </div>
        <div v-if="!node.online" class="smsj-host-line err">{{ dash(node.message) }}</div>
        <div class="smsj-host-line dim">检测于 {{ dash(node.checked_at) }}</div>
        <div class="smsj-host-actions">
          <el-button @click="check(node)">检测</el-button>
          <el-button @click="edit(node)">编辑</el-button>
          <el-button :disabled="!node.online || node.is_default === 1" @click="setDefault(node)">设为默认</el-button>
          <el-button type="danger" plain @click="remove(node)">删除</el-button>
        </div>
      </div>
    </div>
    <div v-else class="smsj-empty">还没有登记后端节点，先点「登记节点」把第一台后端接进来。</div>

    <el-dialog v-model="dialog" :title="form.original_node_code ? '编辑节点' : '登记节点'" width="560px" destroy-on-close>
      <!-- 小节标题与四条说明正文照 PHP Tpl/smsj_system/nodes.html 搬运 -->
      <h4 class="smsj-section-subtitle">基本信息</h4>
      <el-form label-width="110px">
        <el-form-item label="节点编号" required>
          <span class="smsj-field-wrap">
            <el-input v-model="form.node_code" :readonly="!!form.original_node_code" maxlength="64" placeholder="例如 node01" />
            <FieldHelp label="节点编号" text="必须与对应后端服务配置文件中的节点编号完全一致。" />
          </span>
        </el-form-item>
        <el-form-item label="区域名称" required>
          <span class="smsj-field-wrap">
            <el-input v-model="form.region_name" maxlength="100" placeholder="例如 校区、楼栋、机房名称" />
            <FieldHelp label="区域名称" text="后台展示和下拉选择使用的区域名称，建议填写机房、楼层或校区等人工好识别的名称。" />
          </span>
        </el-form-item>
        <h4 class="smsj-section-subtitle">连接配置</h4>
        <el-form-item label="后端地址" required>
          <span class="smsj-field-wrap">
            <el-input v-model="form.node_address" placeholder="例如 http://127.0.0.1:3000" />
            <FieldHelp label="后端地址" text="对应后端的http服务器地址包含端口，系统会自动访问节点健康检查接口。" />
          </span>
        </el-form-item>
        <el-form-item label="注册密钥" :required="!form.original_node_code">
          <span class="smsj-field-wrap">
            <el-input v-model="form.register_key" type="password" show-password autocomplete="new-password"
                      :placeholder="form.original_node_code ? '留空表示沿用原来的密钥' : '必填，6至128位字母或数字'" />
            <FieldHelp label="注册密钥" text="对应后端节点配置文件中的密钥值；编辑节点时留空会沿用原密钥，填写新密钥则必须通过在线校验。" />
          </span>
        </el-form-item>
      </el-form>
      <div class="smsj-alert" style="margin: 6px 0 0">保存时会实时探测该节点，新节点必须能通过编号与密钥校验才会落库。</div>
      <template #footer>
        <el-button @click="dialog = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="save">保存</el-button>
      </template>
    </el-dialog>
  </section>
</template>
