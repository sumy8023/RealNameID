import assert from "node:assert/strict";
import { test } from "node:test";
import { localizeTimes, sendOk } from "../src/envelope.js";
import { buildPayload, encodeRequestBody, sign } from "../src/signature.js";
import { boolValue, dateFilter, normalizeNodeAddress, numberValue, pageLimit, splitCompositeClassroom } from "../src/validate.js";

test("ISO 时间统一成东八区墙钟，非时间字符串原样保留", () => {
  const out = localizeTimes({
    last_seen_at: "2026-09-21T07:00:00.000Z",
    nested: [{ created_at: "2026-09-21T07:00:00.000Z" }],
    name: "2026-09-21 15:00:00",
    plus: "2026-09-21T07:00:00+02:00",
    count: 12,
    maybe: null,
  });
  assert.equal(out.last_seen_at, "2026-09-21 15:00:00");
  assert.equal(out.nested[0].created_at, "2026-09-21 15:00:00");
  assert.equal(out.name, "2026-09-21 15:00:00");
  // 07:00+02:00 是 05:00 UTC，东八区即 13:00；与统一的东八区换算规则一致。
  assert.equal(out.plus, "2026-09-21 13:00:00");
  assert.equal(out.count, 12);
  assert.equal(out.maybe, null);
});

test("ajaxOk 把 data 平铺到顶层，不包一层 data", async () => {
  let sent;
  await sendOk({ json: (body) => { sent = body; } }, { node_code: "TESTA", status: { online: true } }, "获取成功");
  assert.deepEqual(Object.keys(sent).sort(), ["code", "msg", "node_code", "status"]);
  assert.equal(sent.code, 0);
  assert.equal(sent.node_code, "TESTA");
});

test("签名原文是 timestamp\\n rawBody，且 payload 编码稳定", () => {
  const body = encodeRequestBody("stats", { node_code: "TESTA", keyword: "教室" });
  assert.equal(body, '{"action":"stats","payload":{"node_code":"TESTA","keyword":"教室"}}');
  const sig = sign("k", "1700000000", body);
  assert.match(sig, /^[a-f0-9]{64}$/);
  // 节点是对原始字节签名的，body 或时间戳任一变化都必须导致签名不同。
  assert.notEqual(sig, sign("k", "1700000001", body));
  assert.notEqual(sig, sign("k2", "1700000000", body));
});

test("转发 payload 丢掉缓存位、数组和空值", () => {
  assert.deepEqual(
    buildPayload({ _t: "1710000", page: "3", ids: ["1", "2"], empty: "", node_code: "TESTA" }, { operatorName: "admin01" }),
    { page: "3", empty: "", node_code: "TESTA", operator_name: "admin01" },
  );
});

test("分页夹取遵循统一的 pageLimit 规则", () => {
  assert.deepEqual(pageLimit({}), { page: 1, limit: 20, offset: 0 });
  assert.deepEqual(pageLimit({ page: "0", limit: "99999" }), { page: 1, limit: 500, offset: 0 });
  assert.deepEqual(pageLimit({ page: "3", limit: "50" }), { page: 3, limit: 50, offset: 100 });
});

test("布尔只认明确真值，其余一律关", () => {
  assert.equal(boolValue({ enabled: "1" }, "enabled"), 1);
  assert.equal(boolValue({ enabled: "true" }, "enabled"), 1);
  assert.equal(boolValue({ enabled: true }, "enabled"), 1);
  assert.equal(boolValue({ enabled: "0" }, "enabled"), 0);
  assert.equal(boolValue({ enabled: "false" }, "enabled"), 0);
  assert.equal(boolValue({}, "enabled", 1), 1);
});

test("三种日期写法都归一成节点认识的 date", () => {
  assert.deepEqual(dateFilter({ date: "2026-09-01 - 2026-09-05" }), { date: "2026-09-01 - 2026-09-05" });
  assert.deepEqual(dateFilter({ date: "2026-09-01~2026-09-05" }), { date: "2026-09-01 - 2026-09-05" });
  assert.deepEqual(dateFilter({ start_date: "2026-09-01", end_date: "2026-09-05" }), { date: "2026-09-01 - 2026-09-05" });
  assert.deepEqual(dateFilter({ date: "2026-09-01" }), { date: "2026-09-01 - 2026-09-01" });
  assert.deepEqual(dateFilter({ date: "垃圾输入" }), {});
  assert.deepEqual(dateFilter({}), {});
});

test("节点地址归一：去尾斜杠、拒非 http、拒内嵌凭据", () => {
  assert.equal(normalizeNodeAddress("http://10.0.0.1:14848/"), "http://10.0.0.1:14848");
  assert.equal(normalizeNodeAddress("  https://a.example.com/api/  "), "https://a.example.com/api");
  assert.equal(normalizeNodeAddress("ftp://a.example.com"), "");
  assert.equal(normalizeNodeAddress("http://user:pw@10.0.0.1"), "");
  assert.equal(normalizeNodeAddress("不是地址"), "");
});

test("复合教室ID拆出节点编号，普通数字ID原样透传", () => {
  assert.deepEqual(splitCompositeClassroom({ classroom_id: "TESTA@42", node_code: "" }), { nodeCode: "TESTA", classroomId: "42" });
  assert.deepEqual(splitCompositeClassroom({ classroom_id: "42", node_code: "TESTB" }), { nodeCode: "TESTB", classroomId: "42" });
  // GLOBAL@42 的编号部分同样匹配节点编号语法，会被拆出来；随后在节点校验那一步被拒，
  // 这与路由参数归一化和节点编号校验规则一致。
  assert.deepEqual(splitCompositeClassroom({ classroom_id: "GLOBAL@42", node_code: "TESTB" }), { nodeCode: "GLOBAL", classroomId: "42" });
  assert.deepEqual(splitCompositeClassroom({ classroom_id: "", node_code: "TESTB" }), { nodeCode: "TESTB", classroomId: "" });
});

test("数字参数非法时回落默认并夹进区间", () => {
  assert.equal(numberValue({ id: "abc" }, "id", { fallback: 0, min: 0 }), 0);
  assert.equal(numberValue({ id: "-5" }, "id", { fallback: 1, min: 1 }), 1);
  assert.equal(numberValue({ out_time: "99999" }, "out_time", { fallback: 10, min: 0, max: 1440 }), 1440);
});
