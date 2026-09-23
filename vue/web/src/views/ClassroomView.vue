<script setup>
import { computed, onMounted, reactive, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import NodePicker from "../components/NodePicker.vue";
import FieldHelp from "../components/FieldHelp.vue";
import { useNodes } from "../composables/useNodes.js";
import { useTable } from "../composables/useTable.js";
import { api } from "../api/client.js";
import { dash } from "../utils/format.js";

const { current, state } = useNodes();
const table = useTable("classroom_list", { defaultParams: { node_code: "", keyword: "", building_name: "", enabled: "" } });
const buildings = ref([]);

const dialog = ref(false);
const saving = ref(false);
const form = reactive(emptyForm());

function emptyForm() {
  return {
    id: 0,
    original_node_code: "",
    node_code: "",
    classroom_code: "",
    classroom_name: "",
    building_name: "",
    ip_start: "",
    ip_end: "",
    teacher_ip: "",
    enabled: 1,
    out_time: 10,
    allow_student_shutdown: 0,
  };
}

const moving = computed(() => form.id > 0 && form.original_node_code && form.node_code !== form.original_node_code);

async function search() {
  table.filters.node_code = current.value;
  table.page = 1;
  const ret = await table.load();
  if (ret) {
    const options = await api.get("classroom_building_options", { node_code: current.value }, { silent: true }).catch(() => null);
    buildings.value = [...new Set([...(options?.data || []).map((item) => item.building_name), ...(ret.data || []).map((row) => row.building_name)])].filter(Boolean);
  }
}

function create() {
  Object.assign(form, emptyForm(), { node_code: current.value || state.nodes[0]?.node_code || "" });
  dialog.value = true;
}

function edit(row) {
  Object.assign(form, {
    id: row.id,
    original_node_code: row.node_code || "",
    node_code: row.node_code || "",
    classroom_code: row.classroom_code,
    classroom_name: row.classroom_name,
    building_name: row.building_name || "",
    ip_start: row.ip_start || "",
    ip_end: row.ip_end || "",
    teacher_ip: row.teacher_ip || "",
    enabled: Number(row.enabled) ? 1 : 0,
    out_time: Number(row.out_time) || 0,
    allow_student_shutdown: Number(row.allow_student_shutdown) ? 1 : 0,
  });
  dialog.value = true;
}

// 节点侧还会再校验一遍，这里提前拦是为了让用户当场看到是哪一条规则不满足。
function validate() {
  if (!form.classroom_code.trim()) return "请填写教室编号";
  if (!form.classroom_name.trim()) return "请填写教室名称";
  if (!form.node_code) return "请选择所属节点";
  const start = form.ip_start.trim();
  const end = form.ip_end.trim();
  if (!!start !== !!end) return "学生机IP段起始和结束地址需同时填写";
  if (!start && !form.teacher_ip.trim()) return "学生机IP段为空时，教师机IP必须填写";
  return "";
}

async function save() {
  const problem = validate();
  if (problem) {
    ElMessage.warning(problem);
    return;
  }
  if (moving.value) {
    await ElMessageBox.confirm(
      `教室将从 ${form.original_node_code} 移动到 ${form.node_code}，原节点上的记录会被删除。教室内有在线电脑时会被拒绝。`,
      "确认跨节点移动",
      { type: "warning", confirmButtonText: "确认移动" },
    );
  }
  saving.value = true;
  try {
    // 所有字段都显式提交：节点侧对缺失字段会按自己的默认值落库，不能漏发。
    const ret = await api.post("classroom_save", { ...form, enabled: String(form.enabled), out_time: String(form.out_time) });
    ElMessage.success(ret.msg);
    dialog.value = false;
    await search();
  } catch {
    /* 失败提示已由 api 层弹出 */
  } finally {
    saving.value = false;
  }
}

async function toggle(row, next) {
  try {
    const ret = await api.post("classroom_toggle", { node_code: row.node_code, id: row.id, enabled: next ? "1" : "0" });
    ElMessage.success(ret.msg);
  } catch {
    row.enabled = next ? 1 : 0;
  }
  await table.load();
}

async function remove(row) {
  await ElMessageBox.confirm(`确定删除教室「${row.classroom_name}」的配置？设备历史与会话记录不会被删除。`, "确认删除", { type: "warning" });
  const ret = await api.post("classroom_delete", { node_code: row.node_code, id: row.id });
  ElMessage.success(ret.msg);
  await search();
}

onMounted(search);
</script>

<template>
  <section>
    <h2 class="smsj-section-title">教室管理</h2>
    <div class="smsj-toolbar">
      <span class="smsj-tool-field">
        <label>当前节点</label>
        <NodePicker v-model="current" @change="search" />
      </span>
      <el-input v-model="table.filters.keyword" placeholder="编号/名称/楼栋/IP" style="width: 220px" clearable @keyup.enter="search" />
      <el-select v-model="table.filters.building_name" placeholder="楼栋" style="width: 140px" clearable>
        <el-option label="全部楼栋" value="" />
        <el-option v-for="name in buildings" :key="name" :label="name" :value="name" />
      </el-select>
      <el-select v-model="table.filters.enabled" placeholder="启用状态" style="width: 130px" clearable>
        <el-option label="全部状态" value="" />
        <el-option label="已启用" value="1" />
        <el-option label="已停用" value="0" />
      </el-select>
      <div class="right">
        <el-button @click="search" :loading="table.loading">刷新</el-button>
        <el-button type="primary" @click="create">新增教室</el-button>
      </div>
    </div>

    <el-alert v-if="table.notice" :title="table.notice" type="warning" :closable="false" show-icon style="margin-bottom: 14px" />

    <el-table class="smsj-table" max-height="max(320px, calc(100vh - 296px))" :data="table.rows" v-loading="table.loading" border row-key="id">
      <el-table-column label="所属节点" width="140">
        <template #default="{ row }">{{ dash(row._node_region_name || row.node_code) }}</template>
      </el-table-column>
      <el-table-column prop="building_name" label="楼栋" width="110" show-overflow-tooltip>
        <template #default="{ row }">{{ dash(row.building_name) }}</template>
      </el-table-column>
      <el-table-column prop="classroom_name" label="教室名称" min-width="150" show-overflow-tooltip />
      <el-table-column prop="classroom_code" label="教室编号" width="120" />
      <el-table-column label="学生机IP段" width="220">
        <template #default="{ row }">{{ row.ip_start ? `${row.ip_start} - ${row.ip_end}` : "未设置" }}</template>
      </el-table-column>
      <el-table-column label="教师机IP" width="128">
        <template #default="{ row }">{{ dash(row.teacher_ip) }}</template>
      </el-table-column>
      <el-table-column label="空闲下机" width="96" align="right">
        <template #default="{ row }">{{ row.out_time }} 分</template>
      </el-table-column>
      <el-table-column label="教师联动关机" width="116">
        <template #default="{ row }">
          <span class="state-tag" :class="Number(row.allow_student_shutdown) === 1 ? 'online' : 'neutral'">{{ Number(row.allow_student_shutdown) === 1 ? "开" : "关" }}</span>
        </template>
      </el-table-column>
      <el-table-column label="启用" width="82">
        <template #default="{ row }">
          <el-switch :model-value="Number(row.enabled) === 1" @update:model-value="(next) => toggle(row, next)" />
        </template>
      </el-table-column>
      <el-table-column label="操作" width="140" fixed="right">
        <template #default="{ row }">
          <el-button link type="primary" @click="edit(row)">编辑</el-button>
          <el-button link type="danger" @click="remove(row)">删除</el-button>
        </template>
      </el-table-column>
      <template #empty>
        <div class="smsj-empty">{{ state.nodes.length ? "这个节点还没有教室配置" : "请先在「节点管理」里登记并验证后端节点" }}</div>
      </template>
    </el-table>

    <div class="pager">
      <el-pagination
        v-model:current-page="table.page"
        v-model:page-size="table.pageSize"
        :total="table.count"
        :page-sizes="[20, 50, 100, 200]"
        layout="total, sizes, prev, pager, next"
        @current-change="table.load"
        @size-change="search"
      />
    </div>

    <el-dialog v-model="dialog" :title="form.id ? '编辑教室' : '新增教室'" width="640px" destroy-on-close>
      <div v-if="moving" class="smsj-alert">这是一次跨节点移动：保存后新记录建在 {{ form.node_code }}，{{ form.original_node_code }} 上的原记录会被删除。</div>
      <div class="smsj-fields room-fields">
        <div class="smsj-field">
          <span class="k req">所属节点</span>
          <span class="v">
            <el-select v-model="form.node_code">
              <el-option v-for="node in state.nodes" :key="node.node_code" :label="`${node.region_name}（${node.node_code}）`" :value="node.node_code" />
            </el-select>
          </span>
        </div>
        <div class="smsj-field">
          <span class="k">空闲下机</span>
          <span class="v">
            <el-input-number v-model="form.out_time" :min="0" :max="1440" :controls-position="'right'" class="num" />
            <span class="unit">分钟</span>
          </span>
        </div>
        <div class="smsj-field">
          <span class="k req">教室编号</span>
          <span class="v"><el-input v-model="form.classroom_code" maxlength="64" placeholder="例如 A101" /></span>
        </div>
        <div class="smsj-field">
          <span class="k req">教室名称</span>
          <span class="v"><el-input v-model="form.classroom_name" maxlength="100" /></span>
        </div>
        <div class="smsj-field">
          <span class="k">楼栋</span>
          <span class="v"><el-input v-model="form.building_name" maxlength="100" placeholder="例如 A楼，可留空" /></span>
        </div>
        <div class="smsj-field">
          <span class="k">教师机IP</span>
          <span class="v"><el-input v-model="form.teacher_ip" placeholder="学生机IP段留空时必填" /></span>
        </div>
        <div class="smsj-field wide">
          <span class="k">学生机IP段</span>
          <span class="v">
            <el-input v-model="form.ip_start" placeholder="起始 IP" />
            <span class="unit">至</span>
            <el-input v-model="form.ip_end" placeholder="结束 IP" />
            <span class="hint">起止需同时填写或同时留空</span>
          </span>
        </div>
        <div class="smsj-field wide">
          <span class="k">策略开关</span>
          <span class="v">
            <el-checkbox v-model="form.enabled" :true-value="1" :false-value="0">启用教室</el-checkbox>
            <span class="smsj-field-wrap">
              <el-checkbox v-model="form.allow_student_shutdown" :true-value="1" :false-value="0">教师联动关机</el-checkbox>
              <FieldHelp label="教师联动关机" text="开启后，教师机下机时可选择同时关机本教室在线学生机。" />
            </span>
          </span>
        </div>
      </div>
      <template #footer>
        <el-button @click="dialog = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="save">保存</el-button>
      </template>
    </el-dialog>
  </section>
</template>

<style scoped>
/* 弹窗里字段用两列栅格；标签列压到 78px，控件才能拿到足够宽度对齐。 */
.room-fields { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.room-fields .k { flex: 0 0 78px; }
.room-fields .num { width: 108px; flex: 0 0 108px; }
.k.req::before { content: "*"; margin-right: 3px; color: var(--danger); }
</style>
