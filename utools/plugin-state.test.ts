import { describe, expect, test } from "bun:test";

const { QUERY_PREF_KEY, resolveEntryQuery } = require("./plugin-state.cjs") as {
  QUERY_PREF_KEY: string;
  resolveEntryQuery: (entry: unknown, savedQuery: unknown) => string;
};

describe("uTools 搜索恢复", () => {
  test("普通进入恢复上次筛选词", () => {
    expect(QUERY_PREF_KEY).toBe("pk_query");
    expect(resolveEntryQuery({ type: "text" }, "chrome gpu")).toBe("chrome gpu");
  });

  test("带词进入优先于历史筛选", () => {
    expect(resolveEntryQuery({ type: "regex", payload: "结束进程 node" }, "chrome"))
      .toBe("node");
  });
});
