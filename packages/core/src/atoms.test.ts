import { describe, expect, test } from "bun:test";
import { appIconKind } from "./atoms";
import type { AppRow } from "./types";

const row = (overrides: Partial<AppRow> = {}): AppRow => ({
  id: "app",
  identity: "app",
  snapshotToken: "snapshot",
  name: "App",
  monogram: "Ap",
  procs: 1,
  cpu: 0,
  mem: 0,
  pid: 10,
  path: "/Applications/App.app",
  helpers: [],
  allPids: [10],
  ...overrides,
});

describe("应用图标类型", () => {
  test("真实图标始终优先", () => {
    expect(appIconKind(row({ iconUrl: "data:image/png;base64,AA==", systemOwned: true }))).toBe("real");
  });

  test("系统来源使用独立系统图标", () => {
    expect(appIconKind(row({ systemOwned: true }))).toBe("system");
    expect(appIconKind(row({ sys: true }))).toBe("system");
  });

  test("普通未知进程统一使用通用应用图标", () => {
    expect(appIconKind(row({ name: "python", monogram: "py" }))).toBe("application");
    expect(appIconKind(row({ name: "rapportd", monogram: "ra" }))).toBe("application");
  });
});
