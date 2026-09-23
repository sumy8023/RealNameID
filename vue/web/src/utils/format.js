// 日期范围统一使用 "YYYY-MM-DD - YYYY-MM-DD" 格式；
// 这里集中转换，避免每个页面各写一遍日期拼接。
export function rangeToParam(range) {
  if (!Array.isArray(range) || range.length < 2) return "";
  return `${day(range[0])} - ${day(range[1])}`;
}

function day(value) {
  if (!value) return "";
  if (typeof value === "string") return value.slice(0, 10);
  const date = new Date(value);
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function dash(value) {
  if (value === null || value === undefined || value === "") return "-";
  return String(value);
}

export function nodeLabel(code, region) {
  if (!code) return "未分配节点";
  return region ? `${region}（${code}）` : code;
}

export function boolText(value) {
  return Number(value) === 1 ? "是" : "否";
}
