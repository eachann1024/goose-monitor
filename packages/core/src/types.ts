/* ProcKill 共享类型 —— bridge 与 UI 之间的契约。 */

/** 合并后的子进程（Electron Helper 等）。 */
export interface Helper {
  name: string;
  /** 角色描述，如 "GPU" / "标签页 ×9" / "主进程"。 */
  role: string;
  cpu: number; // 百分比
  mem: number; // MB
  pid: number;
}

/** 一行 = 一个应用 / 进程组（已合并 Helper）。 */
export interface AppRow {
  id: string;
  /** 跨刷新/重启稳定的应用身份，用于持久化豁免和计划任务。 */
  identity: string;
  /** 当前进程组快照；后端在终止前重验，防止 PID 复用或成员变化。 */
  snapshotToken: string;
  /** 显示名（应用名或进程名）。 */
  name: string;
  /** 字母字形（图标占位用，1-2 字符）。 */
  monogram: string;
  /** 品牌色（图标方块底色）。 */
  color: string;
  /** 合并后的进程总数。 */
  procs: number;
  /** 合并后 CPU 总和（%）。 */
  cpu: number;
  /** 合并后内存总和（MB）。 */
  mem: number;
  /** 主进程/代表 PID。 */
  pid: number;
  /** 可执行路径。 */
  path: string;
  /** 子进程明细。 */
  helpers: Helper[];
  /** 系统/后台进程（图标更小、圆角更小）。 */
  sys?: boolean;
  /** 监听端口（网络分类用）。 */
  port?: string;
  /** 真实图标 data URL（运行时由后端提供，可选）。 */
  iconUrl?: string;
  /** 合并组下所有 PID，kill 时需要。 */
  allPids?: number[];
  /** 连续低占用（CPU<1%）累计分钟数，供菜单栏「自动清理」判断空闲时长。 */
  idleMinutes?: number;
  /** 后端保守判定为可参与自动清理的真实 GUI 应用。 */
  autoCleanEligible?: boolean;
}

export type CategoryId = "gui" | "all" | "cpu" | "mem" | "net" | "bg";

export interface Category {
  id: CategoryId;
  label: string;
  icon: string;
  key: string; // ⌘<key>
}

export interface SystemStats {
  /** 全局 CPU 占用百分比（0-100，已按核数归一）。 */
  cpuPercent: number;
  /** 已用内存 MB。 */
  memUsedMb: number;
  /** 总内存 MB。 */
  memTotalMb: number;
}

export interface KillResult {
  ok: boolean;
  /** 被结束的 PID 列表。 */
  killed: number[];
  error?: string;
}

/** 平台桥接接口 —— Tauri / uTools / 浏览器各自实现。 */
export interface PlatformBridge {
  /** 平台名，用于调试与降级提示。 */
  readonly name: "tauri" | "utools" | "browser";
  /** 列出某分类下的进程组（已做 Helper 合并）。 */
  listProcesses(category: CategoryId): Promise<AppRow[]>;
  /** 系统整体资源占用（侧栏底部用）。 */
  systemStats(): Promise<SystemStats>;
  /** 结束一个进程组（含其所有子进程）。 */
  killProcess(row: AppRow): Promise<KillResult>;
  /** 持久化「以后不再提醒」偏好。 */
  getPref(key: string): string | null;
  setPref(key: string, value: string): void;
}
