/* uTools bridge：调 preload.js 暴露的 window.services.*（Node child_process 实现）。
   合并在 preload 侧完成。偏好用 utools.dbStorage 持久化。 */
import type {
  PlatformBridge, AppRow, CategoryId, SystemStats, KillResult,
} from "../types";

declare global {
  interface Window {
    services?: {
      listProcesses(category: string): Promise<AppRow[]>;
      systemStats(): Promise<SystemStats>;
      killProcess(pid: number, pids: number[]): Promise<KillResult>;
    };
    utools?: { isDarkColors?: () => boolean; dbStorage?: { getItem(k: string): unknown; setItem(k: string, v: string): void } };
  }
}

export class UtoolsBridge implements PlatformBridge {
  readonly name = "utools" as const;

  async listProcesses(category: CategoryId): Promise<AppRow[]> {
    return (await window.services!.listProcesses(category)) as AppRow[];
  }

  async systemStats(): Promise<SystemStats> {
    return (await window.services!.systemStats()) as SystemStats;
  }

  async killProcess(row: AppRow): Promise<KillResult> {
    const pids = row.allPids && row.allPids.length ? row.allPids : [row.pid];
    return (await window.services!.killProcess(row.pid, pids)) as KillResult;
  }

  getPref(key: string): string | null {
    const u = window.utools;
    if (u?.dbStorage) {
      const v = u.dbStorage.getItem(key);
      return v == null ? null : String(v);
    }
    try { return localStorage.getItem(key); } catch { return null; }
  }
  setPref(key: string, value: string): void {
    const u = window.utools;
    if (u?.dbStorage) { u.dbStorage.setItem(key, value); return; }
    try { localStorage.setItem(key, value); } catch { /* ignore */ }
  }
}
