import { reactive } from "vue";
import { api } from "../api/client.js";

// 列表页共用同一套"筛选 + 分页 + 加载"，也统一了 BFF 的 {code,count,data} 拆解。
// 返回 reactive 对象而不是散落的 ref：模板里可以直接 table.rows / table.filters.xxx。
export function useTable(action, { defaultParams = {}, limit = 50 } = {}) {
  const table = reactive({
    rows: [],
    count: 0,
    loading: false,
    notice: "",
    page: 1,
    pageSize: limit,
    filters: { ...defaultParams },
  });

  async function load() {
    table.loading = true;
    try {
      const ret = await api.get(action, { ...table.filters, page: table.page, limit: table.pageSize });
      table.rows = ret.data || [];
      table.count = ret.count || 0;
      table.notice = ret.msg && ret.msg !== "获取成功" ? ret.msg : "";
      return ret;
    } catch (error) {
      table.rows = [];
      table.count = 0;
      table.notice = error.message;
      return null;
    } finally {
      table.loading = false;
    }
  }

  function search() {
    table.page = 1;
    return load();
  }

  function reset() {
    table.filters = { ...defaultParams };
    return search();
  }

  table.load = load;
  table.search = search;
  table.reset = reset;
  return table;
}
