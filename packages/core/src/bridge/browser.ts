/* 浏览器 bridge：纯前端预览，用动态 mock 数据（每次轮询数值都会小幅变化）。
   kill 是"假关闭"（记入 killed 集合，后续快照不再包含），用于无原生后端时
   完整验证 UI / 键盘流 / 排序 / 搜索 / 不闪烁。 */
import type {
  PlatformBridge, AppRow, CategoryId, SystemStats, KillResult,
} from "../types";
import { tickSnapshot } from "./mock-data";

export class BrowserBridge implements PlatformBridge {
  readonly name = "browser" as const;
  private killed = new Set<string>();
  // 最近一次快照：listProcesses 推进它，systemStats 复用它，
  // 保证同一刷新周期内「列表」与「系统资源条」来自同一份数据、求和自洽。
  private lastTick: { cpu: number; memUsed: number } | null = null;

  async listProcesses(category: CategoryId): Promise<AppRow[]> {
    const t = tickSnapshot(category, this.killed);
    this.lastTick = { cpu: t.cpu, memUsed: t.memUsed };
    return t.list;
  }

  async systemStats(): Promise<SystemStats> {
    // 复用最近一次 listProcesses 的快照；若尚未取过（首帧并发），现取一份。
    const t = this.lastTick ?? (() => {
      const s = tickSnapshot("all", this.killed);
      return { cpu: s.cpu, memUsed: s.memUsed };
    })();
    return { cpuPercent: t.cpu, memUsedMb: t.memUsed, memTotalMb: 16384 };
  }

  async killProcess(row: AppRow): Promise<KillResult> {
    this.killed.add(row.id);
    return { ok: true, killed: row.allPids || [row.pid] };
  }

  getPref(key: string): string | null {
    try { return localStorage.getItem(key); } catch { return null; }
  }
  setPref(key: string, value: string): void {
    try { localStorage.setItem(key, value); } catch { /* ignore */ }
  }
}
