/* Tauri bridge：通过 invoke 调 Rust 后端（sysinfo 枚举 + 合并 + kill_tree）。
   合并/图标在 Rust 侧完成，前端拿到的已是 AppRow。 */
import type {
  PlatformBridge, AppRow, CategoryId, SystemStats, KillResult,
} from "../types";

// 动态拿 invoke：优先 ESM，兜底 window.__TAURI__（withGlobalTauri）
async function getInvoke(): Promise<(cmd: string, args?: any) => Promise<any>> {
  const g = window as any;
  if (g.__TAURI__?.core?.invoke) return g.__TAURI__.core.invoke;
  try {
    const mod = await import("@tauri-apps/api/core");
    return mod.invoke;
  } catch {
    return g.__TAURI__.core.invoke;
  }
}

export class TauriBridge implements PlatformBridge {
  readonly name = "tauri" as const;
  private invokeFn: ((cmd: string, args?: any) => Promise<any>) | null = null;

  private async invoke(cmd: string, args?: any): Promise<any> {
    if (!this.invokeFn) this.invokeFn = await getInvoke();
    return this.invokeFn(cmd, args);
  }

  async listProcesses(category: CategoryId): Promise<AppRow[]> {
    const rows = (await this.invoke("list_processes", { category })) as AppRow[];
    return rows;
  }

  async systemStats(): Promise<SystemStats> {
    return (await this.invoke("system_stats")) as SystemStats;
  }

  async killProcess(row: AppRow): Promise<KillResult> {
    const pids = row.allPids && row.allPids.length ? row.allPids : [row.pid];
    return (await this.invoke("kill_process", {
      pid: row.pid,
      pids,
    })) as KillResult;
  }

  getPref(key: string): string | null {
    try { return localStorage.getItem(key); } catch { return null; }
  }
  setPref(key: string, value: string): void {
    try { localStorage.setItem(key, value); } catch { /* ignore */ }
  }
}
