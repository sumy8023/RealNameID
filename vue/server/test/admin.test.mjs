import assert from "node:assert/strict";
import mysql from "mysql2/promise";
import { after, before, test } from "node:test";
import { config } from "../src/config.js";
import { ADMIN_PASSWORD, NODE_A, NODE_B, startHarness } from "./setup.mjs";

let h;

before(async () => {
  h = await startHarness();
  const login = await h.loginAs();
  assert.equal(login.body.code, 0, `登录失败：${login.body.msg}`);
});

after(async () => {
  await h?.close();
});

test("错误密码、停用账号、弱口令和防爆破锁定各自的文案", async () => {
  assert.equal((await h.call("POST", "login", { admin_name: "testadmin", admin_pass: "wrong" })).body.msg, "用户名或密码错误！");
  assert.equal((await h.call("POST", "login", { admin_name: "disabled", admin_pass: ADMIN_PASSWORD })).body.msg, "该号被禁用，请联系管理员！");
  assert.equal((await h.call("POST", "login", { admin_name: "weakpass", admin_pass: "abc" })).body.msg, "登录密码过于简单，请重设！");
  for (let i = 0; i < 3; i += 1) {
    await h.call("POST", "login", { admin_name: "nobody", admin_pass: "bad" });
  }
  assert.equal((await h.call("POST", "login", { admin_name: "nobody", admin_pass: "bad" })).body.msg, "登录失败次数过多，请等待10分钟后重试！");
});

test("未登录访问数据接口返回 401 而不是重定向 HTML", async () => {
  const response = await fetch(`${h.baseUrl}/api/stats`);
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { code: 1, msg: "当前用户未登录或登录超时，请重新登录" });
});

test("node_options 列出登记节点且绝不泄漏注册密钥", async () => {
  const body = (await h.call("GET", "node_options")).body;
  assert.equal(body.code, 0);
  assert.equal(body.default_node_code, NODE_A.nodeCode);
  assert.equal(body.data.length, 3);
  assert.deepEqual(Object.keys(body.data[0]).sort(), ["is_default", "last_check_at", "last_error", "node_address", "node_code", "online_status", "region_name"]);
});

test("node_status 真签名探测全部节点，坏节点离线并回写状态列", async () => {
  const conn = await mysql.createConnection(h.registry);
  // 先把 updated_at 钉在一个过去的时刻：它参与默认/首选节点排序，
  // 如果状态回写把它顶高，每次轮询都会把节点顺序打乱。
  await conn.query(`UPDATE \`${config.tables.nodes}\` SET updated_at = '2020-01-01 00:00:00' WHERE node_code = ?`, [NODE_A.nodeCode]);

  const body = (await h.call("GET", "node_status")).body;
  assert.equal(body.status.online, true);
  assert.equal(body.status.online_count, 2);
  assert.equal(body.status.node_count, 3);
  assert.equal(body.status.message, "后端节点运行中");
  const a = body.nodes.find((item) => item.node_code === NODE_A.nodeCode);
  assert.equal(a.online, true);
  assert.equal(a.admin_api_version, 2);
  assert.equal(a.classroom_count, 2);
  assert.equal(a.metrics.cpuPercent, 12.5);
  assert.match(a.checked_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  const broken = body.nodes.find((item) => item.node_code === "BROKEN");
  assert.equal(broken.online, false);
  assert.equal(broken.message, "后端服务未启动或无法连接");

  const [rows] = await conn.query(
    `SELECT node_code, online_status, last_error, updated_at FROM \`${config.tables.nodes}\` ORDER BY node_code`,
  );
  await conn.end();
  const tested = rows.find((r) => r.node_code === NODE_A.nodeCode);
  assert.equal(tested.online_status, 1);
  assert.equal(tested.last_error, null);
  assert.equal(tested.updated_at.getTime(), Date.parse("2020-01-01T00:00:00+08:00"));
  assert.equal(rows.find((r) => r.node_code === "BROKEN").online_status, 0);
  assert.match(rows.find((r) => r.node_code === "BROKEN").last_error, /无法连接/);
});

test("注册密钥写错的节点必须被拒绝，而不是当成在线", async () => {
  const body = (await h.call("POST", "node_save", {
    node_code: "BADKEY",
    region_name: "密钥错误",
    node_address: `http://127.0.0.1:${NODE_A.port}`,
    register_key: "wrongsecret",
  })).body;
  assert.equal(body.code, 1);
  // 复用 A 的地址但填了错密钥：健康探测被节点直接拒绝，新节点不允许离线落库。
  assert.equal(body.msg, "节点注册校验失败：后端节点注册密钥不正确。");
});

test("新节点登记成功后可被探测，且编辑留空密钥表示沿用原密钥", async () => {
  const edit = (await h.call("POST", "node_save", {
    node_code: NODE_A.nodeCode,
    original_node_code: NODE_A.nodeCode,
    region_name: "测试一区改名",
    node_address: `http://127.0.0.1:${NODE_A.port}`,
    register_key: "",
  })).body;
  assert.equal(edit.code, 0);
  assert.equal(edit.node_code, NODE_A.nodeCode);
  assert.equal(edit.msg, "节点已保存并验证在线");
  const options = (await h.call("GET", "node_options")).body;
  assert.equal(options.data.find((item) => item.node_code === NODE_A.nodeCode).region_name, "测试一区改名");
});

test("节点编号改名、GLOBAL 保留字和删除不存在节点都要被拒绝", async () => {
  assert.match((await h.call("POST", "node_save", { node_code: "TESTD", original_node_code: "TESTA", region_name: "x", node_address: `http://127.0.0.1:${NODE_A.port}`, register_key: "abcdefgh" })).body.msg, /稳定标识/);
  assert.equal((await h.call("POST", "node_save", { node_code: "GLOBAL", region_name: "x", node_address: "http://1.1.1.1", register_key: "abcdefgh" })).body.msg, "节点编号格式不正确，且不能使用 GLOBAL");
  assert.equal((await h.call("POST", "node_save", { node_code: "T", region_name: "", node_address: "http://1.1.1.1", register_key: "abcdefgh" })).body.msg, "请填写有效的区域名称");
  assert.equal((await h.call("POST", "node_save", { node_code: "T", region_name: "ok", node_address: "1.1.1.1", register_key: "abcdefgh" })).body.msg, "后端地址必须是有效的 http 或 https 地址");
  assert.equal((await h.call("POST", "node_save", { node_code: "T", region_name: "ok", node_address: "http://1.1.1.1", register_key: "短" })).body.msg, "注册密钥需使用6到128位英文字母和数字");
  assert.equal((await h.call("POST", "node_delete", { node_code: "GHOST" })).body.msg, "节点不存在");
  assert.equal((await h.call("POST", "node_delete", { node_code: "GLOBAL" })).body.msg, "不能删除 GLOBAL 默认配置");
});

test("stats 汇总全部可用节点，坏节点只降级不致命", async () => {
  const body = (await h.call("GET", "stats")).body;
  assert.equal(body.code, 0);
  assert.match(body.msg, /部分节点统计失败/);
  assert.equal(body.data.classroom_count, 4);
  assert.equal(body.data.enabled_classroom_count, 2);
  assert.equal(body.data.device_count, 4);
  assert.equal(body.data.online_device_count, 2);
  assert.equal(body.data.active_session_count, 2);
  assert.equal(body.data.today_log_count, 4);
  assert.equal(body.data.node_count, 2);
  // 键名即总览页的 DOM id，改名会静默把看板变成空白。
  assert.deepEqual(Object.keys(body.data).filter((k) => !k.startsWith("node_")).sort(), [
    "active_session_count", "classroom_count", "device_count", "enabled_classroom_count",
    "online_device_count", "today_fault_count", "today_log_count",
  ]);
});

test("classroom_list 多节点合并按 id 倒序，并给每行标注区域", async () => {
  const merged = (await h.call("GET", "classroom_list")).body;
  assert.equal(merged.code, 0);
  assert.match(merged.msg, /部分节点读取失败：坏节点/);
  assert.equal(merged.count, 4);
  assert.deepEqual(merged.data.map((row) => row.id), [102, 101, 2, 1]);
  assert.equal(merged.data[0]._node_region_name, "测试二区");
  assert.equal(merged.data[0].node_code, NODE_B.nodeCode);
  assert.equal(merged.data[3]._node_region_name, "测试一区改名");

  const single = (await h.call("GET", "classroom_list", { node_code: NODE_A.nodeCode })).body;
  assert.equal(single.count, 2);
  assert.equal(single.msg, "获取成功");
  assert.deepEqual(single.data.map((row) => row.classroom_code), ["TESTA-B201", "TESTA-A101"]);

  const filtered = (await h.call("GET", "classroom_list", { node_code: NODE_A.nodeCode, enabled: "1" })).body;
  assert.equal(filtered.count, 1);
  assert.equal(filtered.data[0].classroom_code, "TESTA-A101");
});

test("节点编号写坏时扇出接口直接报错，不悄悄退化成全节点", async () => {
  assert.equal((await h.call("GET", "classroom_list", { node_code: "not a node" })).body.msg, "没有可用的后端节点");
});

test("教室下拉把主键命名空间成 节点@id，楼栋下拉跨节点去重", async () => {
  const rooms = (await h.call("GET", "classroom_options")).body;
  assert.equal(rooms.code, 0);
  assert.deepEqual(rooms.data.map((row) => row.id).slice(0, 2), ["TESTA@1", "TESTA@2"]);
  assert.ok(rooms.data.every((row) => typeof row.raw_id === "number"));
  assert.ok(rooms.data.every((row) => "_node_region_name" in row === false));

  const buildings = (await h.call("GET", "classroom_building_options")).body;
  assert.deepEqual(buildings.data.map((row) => row.building_name), ["A楼", "B楼"]);
  assert.equal(buildings.data[0].node_code, NODE_A.nodeCode);
});

test("devices_list 支持复合教室ID定位到单节点，并保留在线筛选", async () => {
  const scoped = (await h.call("GET", "devices_list", { classroom_id: `${NODE_A.nodeCode}@1`, limit: "30" })).body;
  assert.equal(scoped.count, 2);
  assert.ok(scoped.msg === "获取成功");
  assert.deepEqual(scoped.data.map((row) => row.machine_id), ["TESTA-M1", "TESTA-M2"]);
  assert.equal(scoped.data[0].online_text, "在线");
  assert.equal(scoped.data[0].current_user_role, "student");
  assert.equal(scoped.data[0].display_account, "STUDENT-DEMO-001");
  assert.equal(scoped.data[0]._node_region_name, "测试一区改名");

  const online = (await h.call("GET", "devices_list", { node_code: NODE_A.nodeCode, overview_status: "online" })).body;
  assert.equal(online.count, 1);
  assert.equal(online.data[0].machine_id, "TESTA-M1");

  const offline = (await h.call("GET", "devices_list", { node_code: NODE_A.nodeCode, overview_status: "offline" })).body;
  assert.equal(offline.count, 1);
  assert.equal(offline.data[0].machine_id, "TESTA-M2");

  const merged = (await h.call("GET", "devices_list", { limit: "50" })).body;
  assert.equal(merged.count, 4);
  // 合并排序按最后心跳倒序，最新的一条来自 TESTB。
  assert.equal(merged.data[0].machine_id, "TESTB-M1");
});

test("远程指令的三条护栏由节点判定，BFF 原样透出文案", async () => {
  const ok = (await h.call("POST", "device_command", { node_code: NODE_A.nodeCode, machine_id: "TESTA-M1", command_type: "force_logout", classroom_id: "1" })).body;
  assert.equal(ok.code, 0);
  assert.equal(ok.msg, "远程下机指令已发送");
  assert.equal(ok.node_code, NODE_A.nodeCode);
  assert.match(ok.command_id, /^[a-f0-9]{32}$/);
  assert.equal(ok.created, true);
  assert.equal(h.nodes.A.log.at(-1).payload.operator_name, "testadmin");

  assert.equal((await h.call("POST", "device_command", { node_code: NODE_A.nodeCode, machine_id: "TESTA-M2", command_type: "shutdown" })).body.msg, "设备离线，不能执行远程关机。");
  assert.equal((await h.call("POST", "device_command", { node_code: NODE_A.nodeCode, machine_id: "TESTA-M1", command_type: "restart" })).body.msg, "命令类型不正确。");
  assert.equal((await h.call("POST", "device_command", { node_code: NODE_A.nodeCode, machine_id: "", command_type: "shutdown" })).body.msg, "缺少设备标识。");
  assert.equal((await h.call("POST", "device_command", { node_code: "GHOST", machine_id: "TESTA-M1", command_type: "shutdown" })).body.msg, "节点不存在，请先在节点管理中登记并验证节点");
});

test("一键关机接受复合ID并回报台数", async () => {
  const body = (await h.call("POST", "classroom_shutdown", { classroom_id: `${NODE_B.nodeCode}@101`, node_code: "" })).body;
  assert.equal(body.code, 0);
  assert.equal(body.node_code, NODE_B.nodeCode);
  assert.equal(body.total, 1);
  assert.equal(body.msg, "已发送当前教室关机指令");
  assert.equal((await h.call("POST", "classroom_shutdown", { classroom_id: "0", node_code: NODE_A.nodeCode })).body.msg, "教室ID无效");
});

test("教室保存走同一节点写入，并把操作人带给节点", async () => {
  const created = (await h.call("POST", "classroom_save", {
    node_code: NODE_A.nodeCode,
    id: "0",
    classroom_code: "TESTA-C301",
    classroom_name: "三号教室",
    building_name: "C楼",
    ip_start: "10.9.9.2",
    ip_end: "10.9.9.20",
    teacher_ip: "10.9.9.1",
    enabled: "1",
    out_time: "15",
    allow_student_shutdown: "1",
  })).body;
  assert.equal(created.code, 0);
  assert.equal(created.msg, "教室配置已保存");
  assert.ok(created.classroom_id > 0);
  assert.equal(h.nodes.A.state.classrooms.find((r) => r.classroom_code === "TESTA-C301").out_time, 15);

  const missing = (await h.call("POST", "classroom_save", { node_code: NODE_A.nodeCode, classroom_code: "", classroom_name: "" })).body;
  assert.equal(missing.msg, "请填写教室编号。");
  assert.equal((await h.call("POST", "classroom_save", { node_code: NODE_A.nodeCode, classroom_code: "X", classroom_name: "Y", ip_start: "10.1.1.1" })).body.msg, "学生机IP段起始和结束地址需同时填写。");

  const toggled = (await h.call("POST", "classroom_toggle", { node_code: NODE_A.nodeCode, id: String(created.classroom_id), enabled: "0" })).body;
  assert.equal(toggled.msg, "教室已停用");
  assert.equal(toggled.enabled, 0);
  assert.equal((await h.call("POST", "classroom_toggle", { node_code: NODE_A.nodeCode, id: "0", enabled: "1" })).body.msg, "教室ID无效");
  const removed = (await h.call("POST", "classroom_delete", { node_code: NODE_A.nodeCode, id: String(created.classroom_id) })).body;
  assert.equal(removed.msg, "删除成功");
  assert.equal((await h.call("POST", "classroom_delete", { node_code: NODE_A.nodeCode, id: String(created.classroom_id) })).body.msg, "教室配置不存在。");
});

test("跨节点搬教室：在线则拒绝，空闲则源删目标建", async () => {
  const blocked = (await h.call("POST", "classroom_save", {
    node_code: NODE_A.nodeCode,
    original_node_code: NODE_B.nodeCode,
    id: "101",
    classroom_code: "TESTB-A101",
    classroom_name: "搬过来的教室",
    enabled: "1",
  })).body;
  assert.equal(blocked.code, 1);
  assert.match(blocked.msg, /在线|进行中的会话|失败/);

  const moved = (await h.call("POST", "classroom_save", {
    node_code: NODE_A.nodeCode,
    original_node_code: NODE_B.nodeCode,
    id: "102",
    classroom_code: "TESTB-B201",
    classroom_name: "二号教室",
    building_name: "B楼",
    enabled: "0",
  })).body;
  assert.equal(moved.moved, 1);
  assert.equal(moved.from_node_code, NODE_B.nodeCode);
  assert.equal(moved.to_node_code, NODE_A.nodeCode);
  assert.equal(moved.msg, `教室已从 ${NODE_B.nodeCode} 移动到 ${NODE_A.nodeCode}`);
  assert.equal(h.nodes.B.state.classrooms.some((r) => r.id === 102), false);
  assert.ok(h.nodes.A.state.classrooms.some((r) => r.classroom_code === "TESTB-B201"));
});

test("记录类接口按各自时间字段合并，并透出节点区域名", async () => {
  const sessions = (await h.call("GET", "sessions_list", { limit: "50" })).body;
  assert.equal(sessions.count, 4);
  assert.equal(sessions.data[0].id, "TESTBs1");
  assert.equal(sessions.data[0].user_role, "student");
  assert.equal(sessions.data[0].display_account, "STUDENT-DEMO-001");
  // 教师会话的 student_no 存的是 teacher_num，display_account 才是工号；这里 mock 没有学籍库，取回学号本身。
  const teacher = sessions.data.find((row) => row.user_role === "teacher");
  assert.equal(teacher.student_no, "TEACHER-DEMO");
  assert.equal(teacher.display_account, "TEACHER-DEMO");
  assert.match(sessions.data[0].started_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);

  const logs = (await h.call("GET", "logs_list", { limit: "50" })).body;
  assert.equal(logs.count, 4);
  assert.ok(logs.data[0]._node_region_name);
  const only = (await h.call("GET", "logs_list", { node_code: NODE_A.nodeCode, log_level: "warning" })).body;
  assert.equal(only.count, 1);
  assert.equal(only.data[0].event_name, "远程关机");

  const events = (await h.call("GET", "log_event_options")).body;
  assert.deepEqual(events.data.map((row) => row.event_name), ["登录成功", "远程关机"]);
  assert.equal(events.data[0].node_code, NODE_A.nodeCode);

  const faults = (await h.call("GET", "fault_list", { limit: "50" })).body;
  assert.equal(faults.count, 2);
  assert.equal(faults.data[0].display_account, "STUDENT-DEMO-001");
});

// 空调联动是定制功能，已从本项目整体移除；这条守住接口不会悄悄复活。
test("空调任务接口已随功能一并下线", async () => {
  const fetchAuthenticated = (action) => fetch(`${h.baseUrl}/api/${action}`, { headers: { Cookie: h.state.cookie } });
  const list = await fetchAuthenticated("ac_task_list");
  const stats = await fetchAuthenticated("ac_task_stats");
  assert.equal(list.status, 404);
  assert.equal(stats.status, 404);
});

test("get_config 返回节点自身配置，client/watchdog 兜底值来自 BFF 常量", async () => {
  const body = (await h.call("GET", "get_config", { node_code: NODE_A.nodeCode })).body;
  assert.equal(body.code, 0);
  assert.equal(body.node_code, NODE_A.nodeCode);
  assert.equal(body.server.heartbeat_timeout_seconds, 30);
  assert.equal(body.client.heartbeat_seconds, 5);
  assert.equal(body.program_fallbacks.server.heartbeat_timeout_seconds, 30);
  assert.deepEqual(body.program_fallbacks.client, config.programFallbacks.client);
  assert.equal(body.program_minimums.client.heartbeat_seconds, 3);
  // 省略节点编号时应自动落到默认节点，而不是报"请选择有效的后端节点"。
  assert.equal((await h.call("GET", "get_config", {})).body.node_code, NODE_A.nodeCode);
});

test("配置保存把全部字段和登录名一起带给节点，缺路径要报错", async () => {
  const saved = (await h.call("POST", "save_server_config", { node_code: NODE_A.nodeCode, heartbeat_timeout_seconds: "45", offline_scan_seconds: "20", heartbeat_write_interval_seconds: "10" })).body;
  assert.equal(saved.code, 0);
  assert.equal(saved.msg, "服务端配置已保存，后端服务短缓存内会自动生效");
  assert.equal(h.nodes.A.state.serverConfig.heartbeat_timeout_seconds, 45);
  const last = h.nodes.A.log.at(-1);
  assert.equal(last.payload.operator_name, "testadmin");
  assert.equal(last.payload.node_code, NODE_A.nodeCode);

  assert.equal((await h.call("POST", "save_watchdog_config", { node_code: NODE_A.nodeCode, client_path: "" })).body.msg, "请填写客户端EXE路径。");
  assert.equal((await h.call("POST", "save_client_config", { node_code: "GHOST", heartbeat_seconds: "6" })).body.msg, "节点不存在，请先在节点管理中登记并验证节点");
});

test("默认节点切换后 node_options 的排序与默认值随之变化", async () => {
  assert.equal((await h.call("POST", "node_set_default", { node_code: "GHOST" })).body.msg, "节点不存在");
  const set = (await h.call("POST", "node_set_default", { node_code: NODE_B.nodeCode })).body;
  assert.equal(set.code, 0);
  assert.equal((await h.call("GET", "node_options")).body.default_node_code, NODE_B.nodeCode);
  await h.call("POST", "node_set_default", { node_code: NODE_A.nodeCode });
});
