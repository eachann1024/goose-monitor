/* 菜单栏（状态栏）模式 —— Tauri 状态栏图标下挂的 popover。
   像素级复刻设计稿 v8_tray.jsx 的最终（去噪）形态，并接上真实 bridge 数据与交互：
     · 默认弹层（V8Tray）   —— 行只保留「勾选框 · 图标 · 名称 · CPU」（去掉了 ⋯ 与逐行电源键）；
                             顶部红色「结束所选 N」批量结束 + 搜索框；底部键盘 legend + 偏好齿轮。
                             键盘优先：↑↓ 移动 cursor · ␣ 勾选 · ⌘⏎ 结束所选 · ⌘F 搜索 · ⌘, 偏好。
     · 偏好设置（V8Settings）—— 自动清理：空闲应用自动结束（条件可定义：空闲超过 [N 分钟▾] 且 CPU [< N%▾]）、
                             结束前二次确认、开机时随系统启动。

   注意：按用户 chat3 反馈「自动关闭菜单不要有 不需要」——已删除「无操作自动收起 / 倒计时」整套
   （分段控件 + 环形倒计时 + 底部计时条），仅保留可定义的「自动清理空闲应用」。

   同一份前端，两种宿主：
   - Tauri popover 窗口：透明背景，卡片填满窗口（?popover 由 Rust 端注入，亦自动探测）。
   - 浏览器预览：渲染完整桌面场景（墙纸 + 菜单栏 + 箭头），方便无后端演示。

   渲染策略与主应用一致：骨架持久、列表增量 diff、轮询刷新不闪烁。 */
import "./styles_guard";
import { detectBridge, type PlatformBridge } from "./bridge";
import type { AppRow } from "./types";
import { fmtCpu } from "./shared";
import { icon } from "./icons";
import { appIcon, kbd, h } from "./atoms";
import BRAND_ICON_URL from "../assets/app-icon.png";

const TRAY_W = 360;
const REFRESH_MS = 2000;

type View = "default" | "settings" | "timer";
type TimerTab = "countdown" | "schedule";
type TimerMode = "set" | "running" | "paused" | "due" | "done";

// 自动清理「空闲超过」可选时长（分钟）与「CPU 阈值」可选上限（%）。
const IDLE_MIN_OPTIONS = [10, 30, 60, 120];
const CPU_MAX_OPTIONS = [1, 3, 5];

interface TrayState {
  view: View;
  list: AppRow[];                 // 当前进程组列表（已合并 Helper）
  selected: Set<string>;          // 多选集合（按 AppRow.id）
  cursor: number;                 // 键盘 cursor 行索引（↑↓ 移动）
  query: string;
  loading: boolean;
  theme: "dark" | "light";
  // 偏好（持久化）
  autoClean: boolean;             // 空闲应用自动结束
  idleMin: number;                // 空闲超过 N 分钟
  cpuMax: number;                 // 且 CPU < N%
  confirmKill: boolean;           // 结束前二次确认
  autostart: boolean;             // 开机自启
  timerTab: TimerTab;             // 定时退出：倒计时 / 计划
  timerMode: TimerMode;
  timerMinutes: number;
  timerTotalSec: number;
  timerRemainSec: number;
  timerTargetIds: string[];
  scheduleRules: ScheduleRule[];
}

interface ScheduleRule {
  id: string;
  time: string;
  repeat: "daily" | "workday";
  appIds: string[];
  on: boolean;
}

// 一行的复用引用（增量 diff 用）
interface TrayRowRefs {
  row: HTMLElement;
  check: HTMLElement;
  iconHolder: HTMLElement;
  name: HTMLElement;
  cpu: HTMLElement;
  signature: string;
}

class TrayApp {
  private bridge: PlatformBridge;
  private root: HTMLElement;
  private s: TrayState;
  private refreshTimer: number | null = null;
  private countdownTimer: number | null = null;
  private scheduleTimer: number | null = null;
  private pendingConfirmCancel: (() => void) | null = null;
  private loadSeq = 0;
  private recentlyKilled = new Map<string, number>();
  private static readonly KILL_MASK_MS = 4000;

  // 运行宿主：Tauri popover 窗口 or 浏览器预览（完整桌面场景）
  private readonly previewScene: boolean;

  // ---- 持久骨架引用 ----
  private scene!: HTMLElement;        // 预览态外层场景（墙纸 + 菜单栏 + 箭头）
  private popover!: HTMLElement;      // popover 卡片本体（两种宿主都用）
  private bodyDefault!: HTMLElement;  // 默认弹层内容容器
  private bodySettings!: HTMLElement; // 偏好设置内容容器
  private bodyTimer!: HTMLElement;    // 定时退出内容容器
  private confirmLayer!: HTMLElement; // 自定义确认卡片层
  // 默认弹层内的引用
  private killBtn!: HTMLElement; private killBtnCount!: HTMLElement;
  private searchInput!: HTMLInputElement;
  private listBox!: HTMLElement;
  private emptyEl!: HTMLElement;
  // 偏好设置内的可编辑下拉引用（值变化时回填文本）
  private idlePillLabel!: HTMLElement;
  private cpuPillLabel!: HTMLElement;
  // 浮层菜单（EditPill 下拉 / 任意弹出）容器，附加在 popover 上
  private menuLayer!: HTMLElement;

  private rows = new Map<string, TrayRowRefs>();

  private get isTauri(): boolean { return this.bridge.name === "tauri"; }

  constructor(root: HTMLElement) {
    this.root = root;
    this.bridge = detectBridge();
    const params = new URLSearchParams(location.search);
    // Tauri popover 窗口由 Rust 端用 ?popover=1 加载；浏览器默认渲染完整场景预览。
    this.previewScene = !this.isTauri && !params.has("popover");

    this.s = {
      view: "default",
      list: [],
      selected: new Set(),
      cursor: 0,
      query: "",
      loading: true,
      theme: this.resolveTheme(),
      autoClean: this.bridge.getPref("pk_tray_autoclean") === "1",
      idleMin: this.readNumPref("pk_tray_idlemin", 30, IDLE_MIN_OPTIONS),
      cpuMax: this.readNumPref("pk_tray_cpumax", 1, CPU_MAX_OPTIONS),
      confirmKill: this.bridge.getPref("pk_tray_confirm") !== "0", // 默认开
      autostart: this.bridge.getPref("pk_tray_autostart") === "1",
      timerTab: (this.bridge.getPref("pk_tray_timer_tab") === "schedule" ? "schedule" : "countdown"),
      timerMode: "set",
      timerMinutes: this.readNumPref("pk_tray_timer_minutes", 45, [15, 30, 45, 60, 90, 120]),
      timerTotalSec: 45 * 60,
      timerRemainSec: 45 * 60,
      timerTargetIds: [],
      scheduleRules: this.readScheduleRules(),
    };
    this.applyTheme();
  }

  // 读取数值偏好，校验落在允许集合内，否则回退默认。
  private readNumPref(key: string, def: number, allowed: number[]): number {
    const raw = this.bridge.getPref(key);
    const n = raw == null ? NaN : Number(raw);
    return allowed.includes(n) ? n : def;
  }

  private readScheduleRules(): ScheduleRule[] {
    const fallback: ScheduleRule[] = [
      { id: "lunch", time: "12:30", repeat: "workday", appIds: [], on: false },
      { id: "eod", time: "18:45", repeat: "daily", appIds: [], on: false },
    ];
    const raw = this.bridge.getPref("pk_tray_timer_rules");
    if (!raw) return fallback;
    try {
      const parsed = JSON.parse(raw) as ScheduleRule[];
      return Array.isArray(parsed) && parsed.length ? parsed : fallback;
    } catch {
      return fallback;
    }
  }

  private saveScheduleRules(): void {
    this.bridge.setPref("pk_tray_timer_rules", JSON.stringify(this.s.scheduleRules));
  }

  private resolveTheme(): "dark" | "light" {
    const saved = this.bridge.getPref("pk_theme");
    if (saved === "dark" || saved === "light") return saved;
    const prefersLight = window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches;
    return prefersLight ? "light" : "dark";
  }

  private applyTheme(): void {
    document.body.setAttribute("data-theme", this.s.theme);
    document.body.classList.toggle("preview", this.previewScene);
    document.body.classList.toggle("popover", !this.previewScene);
  }

  // ============================================================
  //  数据
  // ============================================================
  async load(initial = false): Promise<void> {
    const seq = ++this.loadSeq;
    try {
      // 菜单栏只展示「界面应用」分组（与设计稿一致）
      const list = await this.bridge.listProcesses("gui");
      if (seq !== this.loadSeq) return;
      this.s.list = this.maskKilled(list);
      this.s.loading = false;
      this.updateList();
      this.updateKillBtn();
      void this.maybeAutoClean();
    } catch (e) {
      if (seq !== this.loadSeq) return;
      console.error("[Tray] load failed", e);
      this.s.loading = false;
      this.updateList();
    } finally {
      if (initial) this.startPolling();
    }
  }

  private startPolling(): void {
    if (this.refreshTimer != null) return;
    this.refreshTimer = window.setInterval(() => {
      if (document.hidden) return;
      if (this.s.view === "settings") return; // 设置页不刷新列表
      const seq = ++this.loadSeq;
      this.bridge.listProcesses("gui")
        .then((list) => {
          if (seq !== this.loadSeq) return;
          this.s.list = this.maskKilled(list);
          this.updateList();
          this.updateKillBtn();
          void this.maybeAutoClean();
        })
        .catch(() => {});
    }, REFRESH_MS);
  }

  private maskKilled(list: AppRow[]): AppRow[] {
    if (this.recentlyKilled.size === 0) return list;
    const now = performance.now();
    for (const [id, until] of this.recentlyKilled) if (now >= until) this.recentlyKilled.delete(id);
    if (this.recentlyKilled.size === 0) return list;
    return list.filter((a) => !this.recentlyKilled.has(a.id));
  }

  private get visible(): AppRow[] {
    const q = this.s.query.trim().toLowerCase();
    const base = this.s.list;
    if (!q) return base;
    return base.filter((a) => (a.name + " " + a.path).toLowerCase().includes(q));
  }

  // 自动清理：空闲应用自动结束（条件可定义：空闲 > idleMin 分钟 且 CPU < cpuMax%）。
  // 空闲时长由后端 IdleTracker 提供（AppRow.idleMinutes）；缺字段（旧后端）则跳过，
  // 绝不仅凭 CPU 低就杀，避免误伤刚启动还没攒够空闲时长的应用。
  private autoCleaning = false;
  private async maybeAutoClean(): Promise<void> {
    if (!this.s.autoClean || this.autoCleaning) return;
    const targets = this.s.list.filter(
      (a) =>
        // 兜底：自动清理永不碰系统/后台进程（如 XProtect、liquiddetectiond），
        // 即便后端误标或将来口子放开，也不会被空闲条件误杀。
        !a.sys &&
        typeof a.idleMinutes === "number" &&
        a.idleMinutes >= this.s.idleMin &&
        a.cpu < this.s.cpuMax &&
        !this.recentlyKilled.has(a.id),
    );
    if (!targets.length) return;
    this.autoCleaning = true;
    try {
      await this.doKill(targets);
      const names = targets.map((t) => t.name).join("、");
      this.toast(`自动清理：已结束 ${targets.length} 个空闲应用（${names}）`);
    } finally {
      this.autoCleaning = false;
    }
  }

  // 轻量 toast（自动清理等被动操作的反馈）。
  private toast(msg: string): void {
    let t = document.getElementById("tray-toast");
    if (!t) {
      t = h("div", {
        attrs: { id: "tray-toast" },
        style: {
          position: "fixed", bottom: "16px", left: "50%", transform: "translateX(-50%)",
          maxWidth: "320px", padding: "8px 14px", borderRadius: "9px",
          background: "var(--bg-elev)", border: "1px solid var(--border-2)",
          color: "var(--fg-1)", font: "var(--t-sm)", boxShadow: "var(--shadow-pop)",
          zIndex: "60", textAlign: "center", transition: "opacity .25s", pointerEvents: "none",
        },
      });
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.style.opacity = "1";
    window.setTimeout(() => { if (t) t.style.opacity = "0"; }, 2800);
  }

  // ============================================================
  //  操作
  // ============================================================
  private toggleSelect(id: string): void {
    const sel = this.s.selected;
    sel.has(id) ? sel.delete(id) : sel.add(id);
    this.updateList();
    this.updateKillBtn();
  }

  // 把 cursor 移到某行（点击行时同步），并触发选中态高亮刷新。
  private setCursorById(id: string): void {
    const idx = this.visible.findIndex((a) => a.id === id);
    if (idx >= 0) { this.s.cursor = idx; this.updateList(); }
  }

  private moveCursor(delta: number): void {
    const v = this.visible;
    if (!v.length) return;
    this.s.cursor = Math.max(0, Math.min(v.length - 1, this.s.cursor + delta));
    this.updateList();
    // 把 cursor 行滚入视野
    const a = v[this.s.cursor];
    const ref = a && this.rows.get(a.id);
    if (ref) ref.row.scrollIntoView({ block: "nearest" });
  }

  // ␣：勾选/取消 cursor 当前所在行。
  private toggleCursorRow(): void {
    const a = this.visible[this.s.cursor];
    if (a) this.toggleSelect(a.id);
  }

  private async killSelected(): Promise<void> {
    const targets = this.s.list.filter((a) => this.s.selected.has(a.id));
    if (!targets.length) return;
    if (this.s.confirmKill) {
      const ok = await this.confirmKillTargets(targets, "结束所选应用");
      if (!ok) return;
    }
    await this.doKill(targets);
  }

  private async confirmKillTargets(targets: AppRow[], title: string): Promise<boolean> {
    if (!targets.length) return false;
    const names = targets.map((a) => a.name).slice(0, 3).join("、") + (targets.length > 3 ? ` 等 ${targets.length} 个` : "");
    return new Promise((resolve) => {
      let dontRemind = false;
      const close = (ok: boolean) => {
        if (ok && dontRemind) this.setPref("confirmKill", false, "pk_tray_confirm", "0");
        this.pendingConfirmCancel = null;
        this.hideConfirmLayer();
        resolve(ok);
      };
      this.pendingConfirmCancel = () => close(false);
      const checkBox = h("span", { style: { width: "16px", height: "16px", borderRadius: "5px", border: "1.5px solid var(--border-strong)", display: "grid", placeItems: "center", flex: "none" } });
      const toggle = () => {
        dontRemind = !dontRemind;
        checkBox.style.background = dontRemind ? "var(--accent)" : "transparent";
        checkBox.style.borderColor = dontRemind ? "var(--accent)" : "var(--border-strong)";
        checkBox.replaceChildren(...(dontRemind ? [icon("check", 11, { color: "var(--fg-on-accent)" } as any)] : []));
      };
      const card = h("div", {
        style: { width: "300px", borderRadius: "14px", background: "var(--bg-elev)", border: "1px solid var(--border-2)", boxShadow: "var(--shadow-pop)", padding: "18px", color: "var(--fg-1)" },
        children: [
          h("div", { style: { display: "flex", alignItems: "center", gap: "10px" }, children: [
            h("span", { style: { width: "34px", height: "34px", borderRadius: "10px", display: "grid", placeItems: "center", background: "var(--danger-bg)", color: "var(--danger-fg)" }, children: [icon("power", 18)] }),
            h("div", { children: [
              h("div", { style: { font: "var(--t-lg)", fontWeight: "700", color: "var(--fg-1)" }, text: title }),
              h("div", { style: { font: "var(--t-xs)", color: "var(--fg-3)", marginTop: "2px" }, text: `${targets.length} 个应用 · Enter 确认` }),
            ] }),
          ] }),
          h("p", { style: { margin: "14px 0 0", font: "var(--t-sm)", color: "var(--fg-2)" }, text: `将强制结束 ${names} 及其合并的子进程，未保存内容可能会丢失。` }),
          h("button", { style: { marginTop: "14px", width: "100%", display: "flex", alignItems: "center", gap: "8px", padding: "0", border: "none", background: "transparent", color: "var(--fg-2)", cursor: "pointer", font: "var(--t-sm)", textAlign: "left" }, on: { click: toggle }, children: [checkBox, document.createTextNode("以后不再提醒")] }),
          h("div", { style: { display: "flex", gap: "10px", marginTop: "18px" }, children: [
            h("button", { style: { flex: "1", height: "36px", borderRadius: "10px", border: "1px solid var(--border-2)", background: "var(--bg-panel)", color: "var(--fg-1)", cursor: "pointer", font: "var(--t-base)", fontWeight: "600" }, on: { click: () => close(false) }, text: "取消" }),
            h("button", { style: { flex: "1", height: "36px", borderRadius: "10px", border: "none", background: "var(--danger)", color: "var(--fg-on-accent)", cursor: "pointer", font: "var(--t-base)", fontWeight: "700" }, on: { click: () => close(true) }, text: "结束" }),
          ] }),
        ],
      });
      this.confirmLayer.style.display = "grid";
      this.confirmLayer.replaceChildren(card);
    });
  }

  private hideConfirmLayer(): void {
    this.confirmLayer.replaceChildren();
    this.confirmLayer.style.display = "none";
  }

  private cancelConfirm(): void {
    const cancel = this.pendingConfirmCancel;
    if (cancel) cancel();
    else this.hideConfirmLayer();
  }

  private async doKill(targets: AppRow[]): Promise<void> {
    for (const app of targets) {
      try {
        const res = await this.bridge.killProcess(app);
        if (res.ok) {
          this.recentlyKilled.set(app.id, performance.now() + TrayApp.KILL_MASK_MS);
          this.s.list = this.s.list.filter((a) => a.id !== app.id);
          this.s.selected.delete(app.id);
        }
      } catch { /* 单个失败不阻断其余 */ }
    }
    ++this.loadSeq; // 让在途刷新失效，避免被 kill 的进程复活
    // cursor 收敛到有效范围
    const v = this.visible;
    if (this.s.cursor >= v.length) this.s.cursor = Math.max(0, v.length - 1);
    this.updateList();
    this.updateKillBtn();
  }

  private setPref<K extends keyof TrayState>(key: K, value: TrayState[K], storeKey: string, storeVal: string): void {
    (this.s as any)[key] = value;
    this.bridge.setPref(storeKey, storeVal);
  }

  // ============================================================
  //  骨架挂载
  // ============================================================
  start(): void {
    this.mount();
    this.installKeys();
    this.renderView();
    this.load(true);
    this.armScheduleTimers();
    (window as any).__prockillTray = this;
  }

  private mount(): void {
    // 视觉（宽度/背景/边框/阴影/圆角）交给 tray.css 按 body.popover / body.preview 区分。
    this.popover = h("div", {
      className: "tray-popover",
      style: { overflow: "hidden", display: "flex", flexDirection: "column", position: "relative" },
    });

    this.bodyDefault = this.buildDefaultBody();
    this.bodySettings = this.buildSettingsBody();
    this.bodyTimer = this.buildTimerBody();
    this.popover.appendChild(this.bodyDefault);
    this.popover.appendChild(this.bodySettings);
    this.popover.appendChild(this.bodyTimer);

    // 浮层（EditPill 下拉等）—— 绝对定位在 popover 内，默认空。
    this.menuLayer = h("div");
    this.popover.appendChild(this.menuLayer);

    this.confirmLayer = h("div", {
      style: {
        position: "absolute", inset: "0", zIndex: "70", display: "none", placeItems: "center",
        background: "rgba(8,9,12,0.48)", backdropFilter: "blur(3px)", pointerEvents: "auto",
      },
    });
    this.confirmLayer.addEventListener("click", (e) => {
      if (e.target === this.confirmLayer) this.cancelConfirm();
    });
    this.popover.appendChild(this.confirmLayer);

    if (this.previewScene) {
      this.scene = this.buildScene(this.popover);
      this.root.appendChild(this.scene);
    } else {
      this.root.appendChild(this.popover);
    }
  }

  // 浏览器预览：桌面墙纸 + 菜单栏 + 箭头 + popover（复刻 TrayScene）
  private buildScene(popover: HTMLElement): HTMLElement {
    const light = this.s.theme === "light";
    const wall = light
      ? "linear-gradient(155deg,#cdd6e6 0%,#aeb9cf 55%,#9fb0c8 100%)"
      : "linear-gradient(155deg,#1c2433 0%,#10151f 55%,#0a0e15 100%)";

    const trayIcon = h("span", {
      style: {
        display: "grid", placeItems: "center", width: "22px", height: "20px", borderRadius: "5px",
        background: light ? "rgba(217,119,87,0.14)" : "rgba(224,135,95,0.24)",
        boxShadow: "inset 0 0 0 1px var(--accent)",
      },
      children: [this.brandTile(15, 4)],
    });
    const menubar = h("div", {
      style: {
        position: "absolute", top: "0", left: "0", right: "0", height: "26px",
        display: "flex", alignItems: "center", padding: "0 12px",
        background: light ? "rgba(255,255,255,0.55)" : "rgba(10,12,18,0.55)",
        backdropFilter: "blur(8px)",
        borderBottom: light ? "1px solid rgba(0,0,0,0.06)" : "1px solid rgba(255,255,255,0.06)",
      },
      children: [
        h("span", { style: { font: "600 12px/1 var(--font-sans)", color: light ? "#1b2330" : "#e9edf5" }, text: "鹅的监控" }),
        h("span", { style: { marginLeft: "14px", font: "var(--t-xs)", color: light ? "rgba(27,35,48,0.6)" : "rgba(233,237,245,0.6)" }, text: "窗口　帮助" }),
        h("span", {
          style: { marginLeft: "auto", display: "flex", alignItems: "center", gap: "12px", color: light ? "rgba(27,35,48,0.78)" : "rgba(233,237,245,0.82)" },
          children: [
            icon("wifi", 14),
            h("span", { style: { font: "var(--t-mono-sm)" }, text: "10:24" }),
            trayIcon,
          ],
        }),
      ],
    });

    // 箭头（指向 tray 图标）
    const caret = h("div", {
      style: {
        position: "absolute", top: "30px", right: "27px", width: "0", height: "0",
        borderLeft: "7px solid transparent", borderRight: "7px solid transparent",
        borderBottom: "7px solid var(--bg-panel)",
        filter: "drop-shadow(0 -1px 0 var(--border-2))", zIndex: "2",
      },
    });

    // popover 在场景中定位到右上
    Object.assign(popover.style, { position: "absolute", top: "36px", right: "12px", width: "326px" } as Partial<CSSStyleDeclaration>);

    return h("div", {
      className: "tray-scene",
      attrs: { "data-theme": this.s.theme },
      style: { background: wall },
      children: [menubar, caret, popover],
    });
  }

  // 品牌 logo 方块（鹅的监控真实图标）
  private brandTile(size = 22, radius = 6): HTMLElement {
    return appIcon(
      { id: "__brand", name: "鹅的监控", monogram: "鹅", color: "#F5B544", procs: 1, cpu: 0, mem: 0, pid: 0, path: "", helpers: [], iconUrl: BRAND_ICON_URL } as AppRow,
      size, radius,
    );
  }

  // ---------- 默认弹层 ----------
  private buildDefaultBody(): HTMLElement {
    const body = h("div", { style: { flex: "1", display: "flex", flexDirection: "column", minHeight: "0" } });

    // —— TrayHead：红色「结束所选 N」+ 搜索框 ——
    this.killBtnCount = h("span", {
      style: {
        minWidth: "20px", height: "20px", padding: "0 6px", borderRadius: "999px",
        background: "rgba(255,255,255,0.22)", display: "grid", placeItems: "center",
        font: "var(--t-mono-sm)", fontWeight: "700",
      },
    });
    this.killBtn = h("button", {
      style: {
        width: "100%", height: "40px", display: "flex", alignItems: "center",
        justifyContent: "center", gap: "9px", borderRadius: "10px", border: "none",
        cursor: "pointer", font: "var(--t-base)", fontWeight: "700",
      },
      on: { click: () => this.killSelected() },
      children: [icon("power", 16), document.createTextNode("结束所选"), this.killBtnCount],
    });

    const timerBtn = h("button", {
      attrs: { title: "定时退出" },
      style: {
        width: "100%", height: "40px", display: "flex", alignItems: "center", justifyContent: "center", gap: "8px",
        borderRadius: "10px", border: "1px solid var(--border-2)", background: "var(--bg-elev)", color: "var(--fg-1)",
        cursor: "pointer", font: "var(--t-base)", fontWeight: "700", marginTop: "8px",
      },
      on: { click: () => this.openTimer("countdown") },
      children: [icon("clock", 16, { color: "var(--accent)" } as any), document.createTextNode("定时退出")],
    });

    this.searchInput = h("input", {
      attrs: { placeholder: "搜索应用…" },
      style: {
        flex: "1", background: "transparent", border: "none", outline: "none",
        color: "var(--fg-1)", font: "var(--t-row)",
      },
      on: { input: (e) => { this.s.query = (e.target as HTMLInputElement).value; this.s.cursor = 0; this.updateList(); } },
    }) as HTMLInputElement;
    const searchBar = h("div", {
      style: {
        marginTop: "8px", height: "34px", display: "flex", alignItems: "center", gap: "8px",
        padding: "0 8px 0 10px", borderRadius: "9px", background: "var(--bg-input)", border: "1px solid var(--border-1)",
      },
      children: [
        icon("search", 15, { color: "var(--fg-3)" } as any),
        this.searchInput,
        kbd("⌘F", true),
      ],
    });

    body.appendChild(h("div", { style: { padding: "12px 12px 6px" }, children: [this.killBtn, timerBtn, searchBar] }));

    // —— 列表区 ——
    this.listBox = h("div", {
      className: "tray-scroll tray-listbox",
      style: { padding: "2px 6px 8px", display: "flex", flexDirection: "column", gap: "1px", flex: "1", minHeight: "0", overflowY: "auto" },
    });
    this.emptyEl = h("div", { style: { padding: "30px", textAlign: "center", color: "var(--fg-3)", font: "var(--t-sm)", display: "none" } });
    this.listBox.appendChild(this.emptyEl);
    body.appendChild(this.listBox);

    // —— TrayFoot：键盘 legend + 设置齿轮 ——
    body.appendChild(this.buildFoot());
    return body;
  }

  private buildFoot(): HTMLElement {
    const footKey = (k: string, t: string, wide = false) =>
      h("span", { style: { display: "inline-flex", alignItems: "center", gap: "6px", whiteSpace: "nowrap" }, children: [
        kbd(k, wide), h("span", { className: "t-xs", style: { color: "var(--fg-3)" }, text: t }),
      ] });

    const settingsBtn = h("button", {
      attrs: { title: "偏好设置　⌘," },
      style: {
        width: "30px", height: "30px", flex: "none", display: "grid", placeItems: "center",
        borderRadius: "8px", border: "1px solid var(--border-1)", background: "var(--bg-elev)",
        color: "var(--fg-2)", cursor: "pointer",
      },
      on: { click: () => this.openSettings() },
      children: [icon("sliders-horizontal", 16)],
    });

    return h("footer", {
      style: {
        height: "40px", flex: "none", display: "flex", alignItems: "center", gap: "11px",
        padding: "0 8px 0 12px", borderTop: "1px solid var(--border-1)", background: "var(--bg-sidebar)",
      },
      children: [
        h("div", { style: { display: "flex", alignItems: "center", gap: "11px", flex: "1", minWidth: "0" }, children: [
          footKey("↑↓", "选择"),
          footKey("␣", "勾选"),
          footKey("⌘⏎", "结束所选", true),
        ] }),
        settingsBtn,
      ],
    });
  }

  // ---------- 偏好设置 ----------
  private buildSettingsBody(): HTMLElement {
    const body = h("div", { style: { flex: "1", display: "none", flexDirection: "column", minHeight: "0", background: "var(--bg-panel)" } });

    // header
    const back = h("button", {
      attrs: { title: "返回　Esc" },
      style: { width: "30px", height: "30px", display: "grid", placeItems: "center", borderRadius: "8px", border: "none", background: "transparent", color: "var(--fg-2)", cursor: "pointer" },
      on: { click: () => this.closeSettings() },
      children: [icon("arrow-left", 17)],
    });
    body.appendChild(h("div", {
      style: { height: "46px", flex: "none", display: "flex", alignItems: "center", gap: "8px", padding: "0 8px", borderBottom: "1px solid var(--border-1)", background: "var(--bg-panel)" },
      children: [
        back,
        h("span", { style: { font: "var(--t-lg)", fontWeight: "700", color: "var(--fg-1)" }, text: "偏好设置" }),
        h("span", { style: { marginLeft: "auto", marginRight: "6px", font: "var(--t-xs)", color: "var(--fg-3)" }, text: "Preferences" }),
      ],
    }));

    // —— 自动清理 ——
    const cleanSwitch = this.switch(this.s.autoClean, (on) => this.setPref("autoClean", on, "pk_tray_autoclean", on ? "1" : "0"));
    const confirmSwitch = this.switch(this.s.confirmKill, (on) => this.setPref("confirmKill", on, "pk_tray_confirm", on ? "1" : "0"));
    const autostartSwitch = this.switch(this.s.autostart, (on) => {
      this.setPref("autostart", on, "pk_tray_autostart", on ? "1" : "0");
      if (this.isTauri) {
        const inv = (window as any).__TAURI__?.core?.invoke;
        if (inv) inv("set_autostart", { enabled: on }).catch(() => {});
      }
    });

    // 可定义条件：空闲超过 [N 分钟▾] / 且 CPU [< N%▾]
    this.idlePillLabel = h("span", { style: { font: "var(--t-mono)", fontSize: "12px", color: "var(--fg-1)", whiteSpace: "nowrap" }, text: `${this.s.idleMin} 分钟` });
    this.cpuPillLabel = h("span", { style: { font: "var(--t-mono)", fontSize: "12px", color: "var(--fg-1)", whiteSpace: "nowrap" }, text: `< ${this.s.cpuMax}%` });
    const idlePill = this.editPill(this.idlePillLabel, (anchor) =>
      this.openMenu(anchor, IDLE_MIN_OPTIONS.map((m) => ({ label: `${m} 分钟`, on: m === this.s.idleMin, pick: () => {
        this.setPref("idleMin", m, "pk_tray_idlemin", String(m));
        this.idlePillLabel.textContent = `${m} 分钟`;
        void this.maybeAutoClean();
      } }))),
    );
    const cpuPill = this.editPill(this.cpuPillLabel, (anchor) =>
      this.openMenu(anchor, CPU_MAX_OPTIONS.map((c) => ({ label: `< ${c}%`, on: c === this.s.cpuMax, pick: () => {
        this.setPref("cpuMax", c, "pk_tray_cpumax", String(c));
        this.cpuPillLabel.textContent = `< ${c}%`;
        void this.maybeAutoClean();
      } }))),
    );

    body.appendChild(h("div", { style: { padding: "4px 0 2px" }, children: [
      h("div", { className: "t-label", style: { padding: "10px 14px 4px" }, text: "自动清理" }),
      this.setRow("zap", "var(--warn)", "空闲应用自动结束", "满足下列条件的应用自动 Quit", cleanSwitch),
      // 可定义条件（缩进 53px 与父行图标对齐）
      h("div", { style: { display: "flex", flexDirection: "column", gap: "8px", padding: "0 12px 12px 53px" }, children: [
        h("div", { style: { display: "flex", alignItems: "center", gap: "10px" }, children: [
          h("span", { className: "t-xs", style: { color: "var(--fg-3)", width: "58px", flex: "none" }, text: "空闲超过" }),
          idlePill,
        ] }),
        h("div", { style: { display: "flex", alignItems: "center", gap: "10px" }, children: [
          h("span", { className: "t-xs", style: { color: "var(--fg-3)", width: "58px", flex: "none" }, text: "且 CPU" }),
          cpuPill,
        ] }),
      ] }),

      h("div", { style: { height: "1px", background: "var(--border-1)", margin: "0 12px 6px" } }),

      this.setRow("check", null, "结束前二次确认", "批量结束时弹出确认（含「不再提醒」）", confirmSwitch),
      this.setRow("moon-star", null, "开机时随系统启动", "", autostartSwitch),
    ] }));

    // 弹性占位：把 footer 顶到卡片底部
    body.appendChild(h("div", { style: { flex: "1", minHeight: "0" } }));

    // footer：完成
    body.appendChild(h("footer", {
      style: { marginTop: "auto", height: "48px", flex: "none", display: "flex", alignItems: "center", padding: "0 12px", borderTop: "1px solid var(--border-1)", background: "var(--bg-sidebar)" },
      children: [
        h("span", { className: "t-xs", style: { color: "var(--fg-3)" }, text: "更改即时生效" }),
        h("button", {
          style: { marginLeft: "auto", height: "32px", padding: "0 18px", borderRadius: "9px", border: "none", cursor: "pointer", background: "var(--accent)", color: "var(--fg-on-accent)", font: "var(--t-base)", fontWeight: "700", display: "inline-flex", alignItems: "center", gap: "8px" },
          on: { click: () => this.closeSettings() },
          text: "完成",
        }),
      ],
    }));
    return body;
  }

  // 可编辑下拉 pill（设计稿 EditPill）：点击在其下方弹出选项菜单。
  private editPill(labelEl: HTMLElement, onOpen: (anchor: HTMLElement) => void): HTMLElement {
    const pill = h("span", {
      style: {
        display: "inline-flex", alignItems: "center", gap: "7px", height: "30px", padding: "0 8px 0 11px",
        borderRadius: "8px", background: "var(--bg-input)", border: "1px solid var(--border-2)",
        cursor: "pointer", whiteSpace: "nowrap", flex: "none",
      },
      on: { click: (e) => { e.stopPropagation(); onOpen(pill); } },
      children: [labelEl, icon("chevron-down", 13, { color: "var(--fg-3)" } as any)],
    });
    return pill;
  }

  // 在 anchor 下方弹出一个选项菜单（单选，命中项右侧打勾）。点击外部/选项后关闭。
  private openMenu(anchor: HTMLElement, items: { label: string; on: boolean; pick: () => void }[]): void {
    this.closeMenu();
    const menu = h("div", {
      className: "tray-menu",
      style: {
        position: "absolute", minWidth: "120px", background: "var(--bg-elev)",
        border: "1px solid var(--border-2)", borderRadius: "10px", boxShadow: "var(--shadow-pop)",
        padding: "5px", zIndex: "40",
      },
      on: { click: (e) => e.stopPropagation() },
    });
    for (const it of items) {
      const btn = h("button", {
        style: {
          display: "flex", width: "100%", alignItems: "center", gap: "8px", height: "30px",
          padding: "0 9px", borderRadius: "7px", border: "none", cursor: "pointer",
          background: it.on ? "var(--bg-row-sel)" : "transparent", color: "var(--fg-1)",
          font: "var(--t-sm)", textAlign: "left",
        },
        on: { click: () => { it.pick(); this.closeMenu(); } },
        children: [h("span", { style: { flex: "1" }, text: it.label })],
      });
      if (it.on) btn.appendChild(icon("check", 14, { color: "var(--accent)" } as any));
      menu.appendChild(btn);
    }
    this.menuLayer.appendChild(menu);
    // 定位到 anchor 下方（相对 popover 计算坐标）。
    const pop = this.popover.getBoundingClientRect();
    const a = anchor.getBoundingClientRect();
    menu.style.left = (a.left - pop.left) + "px";
    menu.style.top = (a.bottom - pop.top + 4) + "px";
  }

  private closeMenu(): void { this.menuLayer.replaceChildren(); }

  private openSettings(): void {
    this.s.view = "settings";
    this.closeMenu();
    this.renderView();
  }
  private closeSettings(): void {
    this.s.view = "default";
    this.closeMenu();
    this.renderView();
  }

  private openTimer(tab: TimerTab = this.s.timerTab): void {
    this.s.view = "timer";
    this.s.timerTab = tab;
    this.bridge.setPref("pk_tray_timer_tab", tab);
    this.closeMenu();
    this.renderView();
    this.renderTimerBody();
  }

  private closeTimer(): void {
    this.s.view = "default";
    this.closeMenu();
    this.renderView();
  }

  private selectedTargets(): AppRow[] {
    return this.s.list.filter((a) => this.s.selected.has(a.id));
  }

  private targetsByIds(ids: string[]): AppRow[] {
    return this.s.list.filter((a) => ids.includes(a.id));
  }

  private appChip(app: AppRow): HTMLElement {
    return h("span", {
      style: { height: "28px", display: "inline-flex", alignItems: "center", gap: "7px", padding: "0 9px 0 4px", borderRadius: "999px", background: "var(--bg-elev)", border: "1px solid var(--border-1)", color: "var(--fg-2)", font: "var(--t-xs)", whiteSpace: "nowrap" },
      children: [appIcon(app, 20, 6), document.createTextNode(app.name.replace("Google ", ""))],
    });
  }

  private buildTimerBody(): HTMLElement {
    const body = h("div", { style: { flex: "1", display: "none", flexDirection: "column", minHeight: "0", background: "var(--bg-panel)" } });
    return body;
  }

  private renderTimerBody(): void {
    if (!this.bodyTimer) return;
    const tab = this.s.timerTab;
    const back = h("button", {
      attrs: { title: "返回　Esc" },
      style: { width: "30px", height: "30px", display: "grid", placeItems: "center", borderRadius: "8px", border: "none", background: "transparent", color: "var(--fg-2)", cursor: "pointer" },
      on: { click: () => this.closeTimer() },
      children: [icon("arrow-left", 17)],
    });
    const seg = h("div", { style: { display: "flex", gap: "3px", padding: "3px", borderRadius: "11px", background: "var(--bg-input)", border: "1px solid var(--border-1)" } });
    for (const [id, label, iconName] of [["countdown", "倒计时", "timer"], ["schedule", "计划", "calendar"]] as const) {
      const on = tab === id;
      seg.appendChild(h("button", {
        style: { flex: "1", height: "34px", display: "inline-flex", alignItems: "center", justifyContent: "center", gap: "7px", borderRadius: "8px", border: "none", cursor: "pointer", font: "var(--t-base)", fontWeight: "700", background: on ? "var(--bg-row-sel)" : "transparent", color: on ? "var(--accent)" : "var(--fg-2)", boxShadow: on ? "inset 0 0 0 1px var(--accent)" : "none" },
        on: { click: () => this.openTimer(id) },
        children: [icon(iconName, 15), document.createTextNode(label)],
      }));
    }
    const header = h("header", { style: { flex: "none", padding: "10px 12px", borderBottom: "1px solid var(--border-1)" }, children: [
      h("div", { style: { display: "flex", alignItems: "center", gap: "8px", marginBottom: "10px" }, children: [
        back,
        h("span", { style: { font: "var(--t-title)", color: "var(--fg-1)", whiteSpace: "nowrap" }, text: "定时退出" }),
        h("span", { style: { marginLeft: "auto", color: "var(--fg-3)", font: "var(--t-xs)", whiteSpace: "nowrap" }, text: tab === "countdown" ? "一次性 · 到点退出" : "按计划 · 自动退出" }),
      ] }),
      seg,
    ] });
    this.bodyTimer.replaceChildren(header, tab === "countdown" ? this.buildCountdownPane() : this.buildSchedulePane());
  }

  private buildCountdownPane(): HTMLElement {
    const targets = this.s.timerMode === "set" ? this.selectedTargets() : this.targetsByIds(this.s.timerTargetIds);
    const mode = this.s.timerMode;
    const setMode = mode === "set";
    const remaining = this.s.timerRemainSec;
    const mm = Math.floor(remaining / 60);
    const ss = remaining % 60;
    const pct = setMode ? this.s.timerMinutes / 120 : Math.max(0, remaining / Math.max(1, this.s.timerTotalSec));
    const dash = 565 * (1 - Math.min(1, Math.max(0, pct)));
    const center = setMode ? `${this.s.timerMinutes}` : `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
    const dial = h("div", { style: { position: "relative", width: "218px", height: "218px", margin: "10px auto 0", touchAction: "none", cursor: setMode ? "grab" : "default" } });
    dial.innerHTML = `<svg viewBox="0 0 220 220" width="218" height="218" style="display:block"><circle cx="110" cy="110" r="90" fill="none" stroke="var(--bg-track)" stroke-width="14"/><circle cx="110" cy="110" r="90" fill="none" stroke="var(--accent)" stroke-width="14" stroke-linecap="round" stroke-dasharray="565" stroke-dashoffset="${dash}" transform="rotate(-90 110 110)"/></svg>`;
    dial.appendChild(h("div", { style: { position: "absolute", inset: "0", display: "grid", placeItems: "center", pointerEvents: "none", textAlign: "center" }, children: [
      h("div", { children: [
        h("div", { style: { font: "600 44px/1 var(--font-mono)", color: "var(--fg-1)", fontVariantNumeric: "tabular-nums" }, text: center }),
        h("div", { style: { font: "var(--t-sm)", color: "var(--fg-3)", marginTop: "7px" }, text: setMode ? "拖表盘调时长" : (mode === "paused" ? "已暂停" : `剩余 · 共 ${Math.round(this.s.timerTotalSec / 60)} 分`) }),
      ] }),
    ] }));
    if (setMode) {
      const setFromEvent = (e: PointerEvent) => {
        const r = dial.getBoundingClientRect();
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        let frac = Math.atan2(e.clientX - cx, -(e.clientY - cy)) / (2 * Math.PI);
        if (frac < 0) frac += 1;
        const minutes = Math.max(1, Math.round(frac * 120));
        this.s.timerMinutes = minutes;
        this.bridge.setPref("pk_tray_timer_minutes", String(minutes));
        this.renderTimerBody();
      };
      dial.addEventListener("pointerdown", (e) => { dial.setPointerCapture(e.pointerId); setFromEvent(e); });
      dial.addEventListener("pointermove", (e) => { if ((e.buttons & 1) === 1) setFromEvent(e); });
    }
    const pane = h("div", { style: { flex: "1", display: "flex", flexDirection: "column", minHeight: "0", padding: "8px 18px 0", overflow: "hidden" }, children: [dial] });
    if (setMode) {
      const presets = h("div", { style: { display: "flex", justifyContent: "center", gap: "8px", marginTop: "14px", flexWrap: "wrap" } });
      for (const m of [15, 30, 45, 60]) presets.appendChild(h("button", { style: { height: "30px", padding: "0 13px", borderRadius: "999px", border: m === this.s.timerMinutes ? "1px solid var(--accent)" : "1px solid var(--border-2)", background: m === this.s.timerMinutes ? "var(--bg-row-sel)" : "transparent", color: m === this.s.timerMinutes ? "var(--accent)" : "var(--fg-2)", cursor: "pointer", font: "var(--t-sm)", fontWeight: "700" }, on: { click: () => { this.s.timerMinutes = m; this.bridge.setPref("pk_tray_timer_minutes", String(m)); this.renderTimerBody(); } }, text: `${m} 分` }));
      pane.appendChild(presets);
      pane.appendChild(h("div", { className: "t-label", style: { marginTop: "18px", marginBottom: "8px" }, text: "到点退出这些应用" }));
      pane.appendChild(targets.length ? h("div", { style: { display: "flex", flexWrap: "wrap", gap: "8px" }, children: targets.map((a) => this.appChip(a)) }) : h("div", { style: { color: "var(--fg-3)", font: "var(--t-sm)", padding: "8px 0" }, text: "先在列表里勾选要定时退出的应用" }));
      pane.appendChild(h("div", { style: { flex: "1" } }));
      pane.appendChild(h("button", { style: { height: "44px", marginBottom: "14px", borderRadius: "12px", border: "none", background: targets.length ? "var(--accent)" : "var(--bg-elev)", color: targets.length ? "var(--fg-on-accent)" : "var(--fg-3)", cursor: targets.length ? "pointer" : "default", font: "var(--t-base)", fontSize: "14px", fontWeight: "800", display: "inline-flex", alignItems: "center", justifyContent: "center", gap: "9px" }, on: { click: () => this.startCountdown() }, children: [icon("play", 16), document.createTextNode(targets.length ? `${this.s.timerMinutes} 分钟后退出` : "请选择应用")] }));
    } else if (mode === "due") {
      pane.appendChild(h("div", { style: { textAlign: "center", color: "var(--fg-2)", font: "var(--t-sm)", marginTop: "10px" }, text: `时间到，准备退出 ${targets.length} 个应用` }));
      pane.appendChild(h("div", { style: { display: "flex", gap: "10px", marginTop: "auto", marginBottom: "16px" }, children: [
        h("button", { style: { flex: "1", height: "42px", borderRadius: "11px", border: "1px solid var(--border-2)", background: "var(--bg-elev)", color: "var(--fg-1)", cursor: "pointer", font: "var(--t-base)", fontWeight: "700" }, on: { click: () => this.snoozeCountdown() }, text: "顺延 10 分" }),
        h("button", { style: { flex: "1", height: "42px", borderRadius: "11px", border: "none", background: "var(--danger)", color: "var(--fg-on-accent)", cursor: "pointer", font: "var(--t-base)", fontWeight: "800" }, on: { click: () => void this.finishCountdownKill() }, text: "立即退出" }),
      ] }));
    } else {
      pane.appendChild(h("div", { style: { display: "flex", flexWrap: "wrap", gap: "8px", justifyContent: "center", marginTop: "14px" }, children: targets.map((a) => this.appChip(a)) }));
      pane.appendChild(h("div", { style: { flex: "1" } }));
      pane.appendChild(h("footer", { style: { display: "flex", justifyContent: "center", gap: "22px", paddingBottom: "16px" }, children: [
        this.roundAction("plus", "+10 分", () => { this.s.timerRemainSec += 600; this.s.timerTotalSec += 600; this.renderTimerBody(); }),
        this.roundAction(mode === "running" ? "pause" : "play", mode === "running" ? "暂停" : "继续", () => { this.s.timerMode = mode === "running" ? "paused" : "running"; this.ensureCountdownTick(); this.renderTimerBody(); }),
        this.roundAction("x", "取消", () => this.cancelCountdown(), true),
      ] }));
    }
    return pane;
  }

  private roundAction(iconName: string, label: string, fn: () => void, danger = false): HTMLElement {
    return h("button", { style: { display: "inline-flex", flexDirection: "column", alignItems: "center", gap: "6px", border: "none", background: "transparent", color: danger ? "var(--danger-fg)" : "var(--fg-2)", cursor: "pointer", font: "var(--t-xs)" }, on: { click: fn }, children: [
      h("span", { style: { width: "48px", height: "48px", display: "grid", placeItems: "center", borderRadius: "999px", background: danger ? "var(--danger-bg)" : "var(--bg-elev)", border: `1px solid ${danger ? "var(--danger)" : "var(--border-2)"}` }, children: [icon(iconName, 19)] }),
      document.createTextNode(label),
    ] });
  }

  private buildSchedulePane(): HTMLElement {
    const active = this.s.scheduleRules.filter((r) => r.on).length;
    const pane = h("div", { style: { flex: "1", display: "flex", flexDirection: "column", minHeight: "0", overflow: "hidden" } });
    pane.appendChild(h("div", { style: { padding: "12px 14px", borderBottom: "1px solid var(--border-1)" }, children: [
      h("div", { className: "t-label", text: `今天 · ${active} 条生效` }),
      this.timeline(),
    ] }));
    const list = h("div", { className: "tray-scroll", style: { flex: "1", minHeight: "0", overflowY: "auto", padding: "12px 14px", display: "flex", flexDirection: "column", gap: "9px" } });
    for (const rule of this.s.scheduleRules) list.appendChild(this.ruleCard(rule));
    list.appendChild(h("button", { style: { height: "40px", borderRadius: "11px", border: "1.5px dashed var(--border-strong)", background: "transparent", color: "var(--fg-2)", cursor: "pointer", font: "var(--t-base)", fontWeight: "700", display: "inline-flex", alignItems: "center", justifyContent: "center", gap: "8px" }, on: { click: () => this.addScheduleRule() }, children: [icon("plus", 15, { color: "var(--accent)" } as any), document.createTextNode("新建定时")] }));
    pane.appendChild(list);
    return pane;
  }

  private timeline(): HTMLElement {
    const wrap = h("div", { style: { position: "relative", height: "88px", marginTop: "6px" } });
    wrap.appendChild(h("div", { style: { position: "absolute", left: "0", right: "0", top: "54px", height: "10px", borderRadius: "999px", background: "var(--bg-track)", overflow: "hidden" } }));
    for (const hour of [0, 6, 12, 18, 24]) {
      wrap.appendChild(h("span", { style: { position: "absolute", left: `${Math.min(99.5, (hour / 24) * 100)}%`, top: "70px", transform: hour === 0 ? "none" : hour === 24 ? "translateX(-100%)" : "translateX(-50%)", color: "var(--fg-3)", font: "var(--t-xs)", fontVariantNumeric: "tabular-nums" }, text: `${String(hour).padStart(2, "0")}:00` }));
    }
    for (const rule of this.s.scheduleRules) {
      const [hh, mm] = rule.time.split(":").map(Number);
      const left = ((hh + mm / 60) / 24) * 100;
      wrap.appendChild(h("div", { style: { position: "absolute", left: `${left}%`, top: "2px", transform: "translateX(-50%)", display: "flex", flexDirection: "column", alignItems: "center", opacity: rule.on ? "1" : "0.38" }, children: [
        h("span", { style: { width: "22px", height: "22px", borderRadius: "7px", display: "grid", placeItems: "center", background: "var(--bg-elev)", border: "1px solid var(--border-2)", color: rule.on ? "var(--accent)" : "var(--fg-3)" }, children: [icon("clock", 13)] }),
        h("span", { style: { marginTop: "4px", color: "var(--fg-2)", font: "var(--t-mono-sm)", fontWeight: "700" }, text: rule.time }),
        h("span", { style: { marginTop: "3px", width: "2px", height: "14px", borderRadius: "2px", background: rule.on ? "var(--accent)" : "var(--border-strong)" } }),
      ] }));
    }
    return wrap;
  }

  private ruleCard(rule: ScheduleRule): HTMLElement {
    const targets = this.ruleTargets(rule);
    return h("div", { style: { display: "flex", alignItems: "center", gap: "12px", padding: "11px 12px", borderRadius: "13px", background: "var(--bg-elev)", border: "1px solid var(--border-1)", opacity: rule.on ? "1" : "0.62" }, children: [
      h("div", { style: { minWidth: "48px", textAlign: "center", color: "var(--fg-1)", font: "600 18px/1 var(--font-mono)", fontVariantNumeric: "tabular-nums" }, text: rule.time }),
      h("div", { style: { width: "1px", alignSelf: "stretch", background: "var(--border-1)" } }),
      h("div", { style: { flex: "1", minWidth: "0" }, children: [
        h("div", { style: { display: "inline-flex", alignItems: "center", gap: "5px", color: "var(--fg-3)", font: "var(--t-xs)", marginBottom: "6px" }, children: [icon(rule.repeat === "workday" ? "briefcase" : "repeat", 12), document.createTextNode(rule.repeat === "workday" ? "每个工作日" : "每天")] }),
        h("div", { style: { color: "var(--fg-2)", font: "var(--t-sm)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }, text: targets.map((a) => a.name.replace("Google ", "")).join("、") || "当前所选应用" }),
      ] }),
      this.switch(rule.on, (on) => {
        if (on && !rule.appIds.length) {
          const targets = this.selectedTargets();
          if (!targets.length) { this.toast("先勾选应用再启用计划"); this.renderTimerBody(); return; }
          rule.appIds = targets.map((a) => a.id);
        }
        rule.on = on;
        this.saveScheduleRules();
        this.armScheduleTimers();
        this.renderTimerBody();
      }),
    ] });
  }

  private ruleTargets(rule: ScheduleRule): AppRow[] {
    return this.targetsByIds(rule.appIds);
  }

  private addScheduleRule(): void {
    const targets = this.selectedTargets();
    if (!targets.length) { this.toast("先勾选要定时退出的应用"); return; }
    const now = new Date();
    now.setMinutes(now.getMinutes() + 30);
    const time = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    this.s.scheduleRules.push({ id: `rule-${Date.now()}`, time, repeat: "daily", appIds: targets.map((a) => a.id), on: true });
    this.saveScheduleRules();
    this.armScheduleTimers();
    this.renderTimerBody();
  }

  private startCountdown(): void {
    const targets = this.selectedTargets();
    if (!targets.length) { this.toast("先勾选要定时退出的应用"); return; }
    const seconds = this.s.timerMinutes * 60;
    this.s.timerTargetIds = targets.map((a) => a.id);
    this.s.timerTotalSec = seconds;
    this.s.timerRemainSec = seconds;
    this.s.timerMode = "running";
    this.ensureCountdownTick();
    this.renderTimerBody();
  }

  private ensureCountdownTick(): void {
    if (this.countdownTimer != null) window.clearInterval(this.countdownTimer);
    if (this.s.timerMode !== "running") return;
    this.countdownTimer = window.setInterval(() => {
      if (this.s.timerMode !== "running") return;
      this.s.timerRemainSec = Math.max(0, this.s.timerRemainSec - 1);
      if (this.s.timerRemainSec <= 0) {
        if (this.countdownTimer != null) window.clearInterval(this.countdownTimer);
        this.countdownTimer = null;
        this.s.timerMode = "due";
        void this.finishCountdownKill();
      }
      this.renderTimerBody();
    }, 1000);
  }

  private snoozeCountdown(): void {
    this.s.timerTotalSec = 600;
    this.s.timerRemainSec = 600;
    this.s.timerMode = "running";
    this.ensureCountdownTick();
    this.renderTimerBody();
  }

  private cancelCountdown(): void {
    if (this.countdownTimer != null) window.clearInterval(this.countdownTimer);
    this.countdownTimer = null;
    this.s.timerMode = "set";
    this.s.timerTargetIds = [];
    this.s.timerRemainSec = this.s.timerMinutes * 60;
    this.s.timerTotalSec = this.s.timerRemainSec;
    this.renderTimerBody();
  }

  private async finishCountdownKill(): Promise<void> {
    const targets = this.targetsByIds(this.s.timerTargetIds);
    if (!targets.length) { this.toast("没有可退出的目标应用"); this.cancelCountdown(); return; }
    if (this.s.confirmKill) {
      const ok = await this.confirmKillTargets(targets, "定时退出应用");
      if (!ok) return;
    }
    await this.doKill(targets);
    this.s.timerMode = "done";
    this.renderTimerBody();
  }

  private armScheduleTimers(): void {
    if (this.scheduleTimer != null) window.clearTimeout(this.scheduleTimer);
    const now = new Date();
    let next: { rule: ScheduleRule; at: Date } | null = null;
    for (const rule of this.s.scheduleRules.filter((r) => r.on && r.appIds.length)) {
      const [hh, mm] = rule.time.split(":").map(Number);
      const at = new Date(now);
      at.setHours(hh, mm, 0, 0);
      if (at <= now) at.setDate(at.getDate() + 1);
      if (!next || at < next.at) next = { rule, at };
    }
    if (!next) return;
    const delay = Math.max(1000, Math.min(24 * 60 * 60 * 1000, next.at.getTime() - now.getTime()));
    this.scheduleTimer = window.setTimeout(async () => {
      const targets = this.ruleTargets(next!.rule);
      if (targets.length && (!this.s.confirmKill || await this.confirmKillTargets(targets, "计划退出应用"))) await this.doKill(targets);
      this.armScheduleTimers();
    }, delay);
  }

  // 开关
  private switch(on: boolean, onToggle: (on: boolean) => void): HTMLElement {
    const knob = h("span", { style: { width: "16px", height: "16px", borderRadius: "999px", background: "var(--fg-on-accent)", boxShadow: "0 1px 2px rgba(0,0,0,0.3)" } });
    const sw = h("span", {
      attrs: { role: "switch" },
      style: {
        width: "38px", height: "22px", flex: "none", borderRadius: "999px", padding: "2px", display: "flex",
        transition: "background .15s", cursor: "pointer",
      },
      on: { click: () => { state = !state; render(); onToggle(state); } },
      children: [knob],
    });
    let state = on;
    const render = () => {
      Object.assign(sw.style, {
        justifyContent: state ? "flex-end" : "flex-start",
        background: state ? "var(--accent)" : "var(--bg-track)",
        border: state ? "1px solid var(--accent)" : "1px solid var(--border-strong)",
      } as Partial<CSSStyleDeclaration>);
    };
    render();
    return sw;
  }

  private setRow(iconName: string, accent: string | null, title: string, desc: string, control: HTMLElement | null): HTMLElement {
    const left = h("span", {
      style: { width: "30px", height: "30px", flex: "none", display: "grid", placeItems: "center", borderRadius: "8px", background: "var(--bg-elev)", border: "1px solid var(--border-1)", color: accent || "var(--fg-2)" },
      children: [icon(iconName, 16)],
    });
    const mid = h("div", { style: { flex: "1", minWidth: "0" }, children: [
      h("div", { style: { font: "var(--t-row)", fontWeight: "600", color: "var(--fg-1)" }, text: title }),
      ...(desc ? [h("div", { className: "t-xs", style: { color: "var(--fg-3)", marginTop: "1px" }, text: desc })] : []),
    ] });
    return h("div", { style: { display: "flex", alignItems: "center", gap: "11px", padding: "10px 12px" }, children: [left, mid, control] });
  }

  // ============================================================
  //  视图切换 + 增量更新
  // ============================================================
  private renderView(): void {
    const settings = this.s.view === "settings";
    const timer = this.s.view === "timer";
    this.bodyDefault.style.display = settings || timer ? "none" : "flex";
    this.bodySettings.style.display = settings ? "flex" : "none";
    this.bodyTimer.style.display = timer ? "flex" : "none";
    if (timer) this.renderTimerBody();
    const target = settings ? this.bodySettings : timer ? this.bodyTimer : this.bodyDefault;
    target.classList.remove("tray-fade"); void target.offsetWidth; target.classList.add("tray-fade");
  }

  private updateKillBtn(): void {
    const n = this.s.selected.size;
    const has = n > 0;
    Object.assign(this.killBtn.style, {
      background: has ? "var(--danger)" : "var(--bg-elev)",
      color: has ? "var(--fg-on-accent)" : "var(--fg-3)",
      boxShadow: has ? "0 1px 0 rgba(0,0,0,0.15), inset 0 1px 0 rgba(255,255,255,0.18)" : "none",
      cursor: has ? "pointer" : "default",
    } as Partial<CSSStyleDeclaration>);
    this.killBtnCount.style.display = has ? "grid" : "none";
    this.killBtnCount.textContent = String(n);
  }

  // 列表增量 diff
  private updateList(): void {
    const v = this.visible;
    if (this.s.cursor >= v.length) this.s.cursor = Math.max(0, v.length - 1);
    if (this.s.loading && v.length === 0) { this.showEmpty("正在读取应用…"); return; }
    if (v.length === 0) { this.showEmpty(this.s.query ? "没有匹配的应用" : "没有界面应用"); return; }
    this.emptyEl.style.display = "none";

    const wantIds = new Set(v.map((a) => a.id));
    for (const [id, ref] of this.rows) {
      if (!wantIds.has(id)) { ref.row.remove(); this.rows.delete(id); }
    }
    let prev: HTMLElement | null = null;
    v.forEach((a, i) => {
      let ref = this.rows.get(a.id);
      if (!ref) { ref = this.buildRow(a); this.rows.set(a.id, ref); }
      this.updateRow(ref, a, i === this.s.cursor);
      const shouldFollow = prev ? prev.nextSibling : this.listBox.firstChild;
      if (ref.row !== shouldFollow) this.listBox.insertBefore(ref.row, shouldFollow);
      prev = ref.row;
    });
  }

  private showEmpty(msg: string): void {
    for (const [, ref] of this.rows) ref.row.remove();
    this.rows.clear();
    this.emptyEl.textContent = msg;
    this.emptyEl.style.display = "";
  }

  // 一行：勾选框 · 图标 · 名称 · CPU（去噪终态，无 ⋯ / 电源键）。
  private buildRow(a: AppRow): TrayRowRefs {
    const check = h("span", {
      style: { width: "18px", height: "18px", flex: "none", borderRadius: "5px", display: "grid", placeItems: "center" },
    });
    const iconHolder = h("span", { style: { display: "inline-flex", flex: "none" } });
    const name = h("span", {
      style: { flex: "1", minWidth: "0", font: "var(--t-row)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
    });
    const cpu = h("span", { style: { font: "var(--t-mono-sm)", minWidth: "42px", textAlign: "right" } });
    const row = h("div", {
      style: { display: "flex", alignItems: "center", gap: "11px", height: "38px", padding: "0 12px", borderRadius: "9px", cursor: "pointer" },
      on: {
        // 点击行：勾选 + 把 cursor 落在此行。
        click: () => { this.setCursorById(a.id); this.toggleSelect(a.id); },
        mouseenter: () => { if (!this.s.selected.has(a.id)) row.style.background = "var(--bg-row-hover)"; },
        mouseleave: () => { if (!this.s.selected.has(a.id)) row.style.background = "transparent"; },
      },
      children: [check, iconHolder, name, cpu],
    });
    return { row, check, iconHolder, name, cpu, signature: "" };
  }

  private updateRow(ref: TrayRowRefs, a: AppRow, isCursor: boolean): void {
    const checked = this.s.selected.has(a.id);
    const muted = a.cpu < 1 && !checked;
    const sig = [a.cpu, a.name, checked ? 1 : 0, isCursor ? 1 : 0, a.iconUrl || "", a.color, a.monogram].join("|");
    if (ref.signature === sig) return;
    ref.signature = sig;

    // 勾选态填底；cursor 行加 1px 焦点框（设计稿 inset 0 0 0 1px border-2）。
    ref.row.style.background = checked ? "var(--bg-row-sel)" : "transparent";
    ref.row.style.boxShadow = isCursor ? "inset 0 0 0 1px var(--border-2)" : "none";

    // 勾选框
    Object.assign(ref.check.style, {
      background: checked ? "var(--accent)" : "transparent",
      border: checked ? "1px solid var(--accent)" : "1.5px solid var(--border-strong)",
    } as Partial<CSSStyleDeclaration>);
    ref.check.replaceChildren();
    if (checked) ref.check.appendChild(icon("check", 12, { color: "var(--fg-on-accent)" } as any));

    // 图标
    const iconSig = `${a.id}|${a.iconUrl || ""}|${a.color}|${a.monogram}`;
    if (!ref.iconHolder.firstChild || ref.iconHolder.getAttribute("data-icon-sig") !== iconSig) {
      ref.iconHolder.replaceChildren(appIcon(a, 22, 6));
      ref.iconHolder.setAttribute("data-icon-sig", iconSig);
    }

    // 名称
    ref.name.textContent = a.name;
    ref.name.style.fontWeight = checked ? "600" : "450";
    ref.name.style.color = muted ? "var(--fg-3)" : "var(--fg-1)";

    // CPU
    ref.cpu.textContent = fmtCpu(a.cpu);
    ref.cpu.style.color = a.cpu >= 10 ? "var(--metric-cpu)" : "var(--fg-3)";
  }

  // ============================================================
  //  键盘：↑↓ 移动 cursor · ␣ 勾选 · ⌘⏎ 结束所选 · ⌘F 搜索 · ⌘, 偏好 · Esc 返回/清空
  // ============================================================
  private installKeys(): void {
    window.addEventListener("keydown", (e) => {
      const mod = e.metaKey || e.ctrlKey;

      if (this.confirmLayer.firstChild) {
        if (e.key === "Escape") { e.preventDefault(); this.cancelConfirm(); return; }
        if (e.key === "Enter") {
          e.preventDefault();
          const buttons = Array.from(this.confirmLayer.querySelectorAll("button"));
          (buttons[buttons.length - 1] as HTMLButtonElement | undefined)?.click();
          return;
        }
      }

      // ⌘, 偏好设置（任意视图可切换）
      if (mod && e.key === ",") {
        e.preventDefault();
        this.s.view === "settings" ? this.closeSettings() : this.openSettings();
        return;
      }

      if (this.s.view === "settings") {
        if (e.key === "Escape" || e.key === "Enter") { e.preventDefault(); this.closeSettings(); }
        return;
      }

      if (this.s.view === "timer") {
        if (e.key === "Escape") { e.preventDefault(); this.closeTimer(); }
        if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
          e.preventDefault();
          this.openTimer(this.s.timerTab === "countdown" ? "schedule" : "countdown");
        }
        return;
      }

      // 浮层菜单打开时，Esc 关闭它
      if (e.key === "Escape" && this.menuLayer.firstChild) { e.preventDefault(); this.closeMenu(); return; }

      // ⌘F 搜索
      if ((mod && e.key.toLowerCase() === "f") || (!mod && e.key === "/")) {
        e.preventDefault();
        this.searchInput.focus();
        return;
      }

      // ⌘⏎ 结束所选
      if (mod && e.key === "Enter") {
        e.preventDefault();
        this.killSelected();
        return;
      }

      // 在搜索框打字时，只处理导航/勾选/取消，其余交给输入框
      const inSearch = document.activeElement === this.searchInput;

      if (e.key === "ArrowDown" || (!inSearch && e.key.toLowerCase() === "j")) {
        e.preventDefault();
        this.moveCursor(1);
      } else if (e.key === "ArrowUp" || (!inSearch && e.key.toLowerCase() === "k")) {
        e.preventDefault();
        this.moveCursor(-1);
      } else if (e.key === " ") {
        if (inSearch) return; // 搜索框里空格是输入空格
        e.preventDefault();
        this.toggleCursorRow();
      } else if (e.key === "Escape") {
        if (this.s.query) { e.preventDefault(); this.s.query = ""; this.searchInput.value = ""; this.s.cursor = 0; this.updateList(); }
      }
    });

    // 点击 popover 空白处：关闭浮层菜单
    this.popover.addEventListener("click", () => this.closeMenu());
  }
}

// 启动
const rootEl = document.getElementById("tray")!;
new TrayApp(rootEl).start();
