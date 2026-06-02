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

type View = "default" | "settings";

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
    };
    this.applyTheme();
  }

  // 读取数值偏好，校验落在允许集合内，否则回退默认。
  private readNumPref(key: string, def: number, allowed: number[]): number {
    const raw = this.bridge.getPref(key);
    const n = raw == null ? NaN : Number(raw);
    return allowed.includes(n) ? n : def;
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
    if (this.s.confirmKill && !this.previewScene) {
      const ok = window.confirm(
        `结束所选 ${targets.length} 个应用？\n这将强制结束它们及合并的子进程，未保存的内容可能会丢失。`,
      );
      if (!ok) return;
    }
    await this.doKill(targets);
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
    this.popover.appendChild(this.bodyDefault);
    this.popover.appendChild(this.bodySettings);

    // 浮层（EditPill 下拉等）—— 绝对定位在 popover 内，默认空。
    this.menuLayer = h("div");
    this.popover.appendChild(this.menuLayer);

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
        background: light ? "rgba(91,124,250,0.16)" : "rgba(91,124,250,0.28)",
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
    Object.assign(popover.style, { position: "absolute", top: "36px", right: "20px", width: TRAY_W + "px" } as Partial<CSSStyleDeclaration>);

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

    body.appendChild(h("div", { style: { padding: "12px 12px 6px" }, children: [this.killBtn, searchBar] }));

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
    const body = h("div", { style: { flex: "1", display: "none", flexDirection: "column", minHeight: "0" } });

    // header
    const back = h("button", {
      attrs: { title: "返回　Esc" },
      style: { width: "30px", height: "30px", display: "grid", placeItems: "center", borderRadius: "8px", border: "none", background: "transparent", color: "var(--fg-2)", cursor: "pointer" },
      on: { click: () => this.closeSettings() },
      children: [icon("arrow-left", 17)],
    });
    body.appendChild(h("div", {
      style: { height: "46px", flex: "none", display: "flex", alignItems: "center", gap: "8px", padding: "0 8px", borderBottom: "1px solid var(--border-1)" },
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

    body.appendChild(h("div", { style: { padding: "6px 0 2px" }, children: [
      h("div", { className: "t-label", style: { padding: "10px 14px 4px" }, text: "自动清理" }),
      this.setRow("zap", "var(--warn)", "空闲应用自动结束", "满足下列条件的应用自动 Quit", cleanSwitch),
      // 可定义条件（缩进 53px 与父行图标对齐）
      h("div", { style: { display: "flex", flexDirection: "column", gap: "8px", padding: "0 12px 14px 53px" }, children: [
        h("div", { style: { display: "flex", alignItems: "center", gap: "10px" }, children: [
          h("span", { className: "t-xs", style: { color: "var(--fg-3)", width: "58px", flex: "none" }, text: "空闲超过" }),
          idlePill,
        ] }),
        h("div", { style: { display: "flex", alignItems: "center", gap: "10px" }, children: [
          h("span", { className: "t-xs", style: { color: "var(--fg-3)", width: "58px", flex: "none" }, text: "且 CPU" }),
          cpuPill,
        ] }),
      ] }),

      h("div", { style: { height: "1px", background: "var(--border-1)", margin: "2px 12px 6px" } }),

      this.setRow("check", null, "结束前二次确认", "批量结束时弹出确认（含「不再提醒」）", confirmSwitch),
      this.setRow("moon-star", null, "开机时随系统启动", "", autostartSwitch),
    ] }));

    // 弹性占位：把 footer 顶到卡片底部
    body.appendChild(h("div", { style: { flex: "1", minHeight: "0" } }));

    // footer：完成 ⏎
    const doneKbd = h("span", {
      style: {
        display: "inline-flex", alignItems: "center", justifyContent: "center", minWidth: "18px",
        height: "18px", padding: "0 5px", borderRadius: "5px", background: "rgba(255,255,255,0.22)",
        font: "var(--t-mono-sm)", color: "#fff",
      },
      text: "⏎",
    });
    body.appendChild(h("footer", {
      style: { marginTop: "auto", height: "48px", flex: "none", display: "flex", alignItems: "center", padding: "0 12px", borderTop: "1px solid var(--border-1)", background: "var(--bg-sidebar)" },
      children: [
        h("span", { className: "t-xs", style: { color: "var(--fg-3)" }, text: "更改即时生效" }),
        h("button", {
          style: { marginLeft: "auto", height: "32px", padding: "0 12px 0 16px", borderRadius: "9px", border: "none", cursor: "pointer", background: "var(--accent)", color: "var(--fg-on-accent)", font: "var(--t-base)", fontWeight: "700", display: "inline-flex", alignItems: "center", gap: "8px" },
          on: { click: () => this.closeSettings() },
          children: [document.createTextNode("完成 "), doneKbd],
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

  // 开关
  private switch(on: boolean, onToggle: (on: boolean) => void): HTMLElement {
    const knob = h("span", { style: { width: "16px", height: "16px", borderRadius: "999px", background: "#fff", boxShadow: "0 1px 2px rgba(0,0,0,0.3)" } });
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
    this.bodyDefault.style.display = settings ? "none" : "flex";
    this.bodySettings.style.display = settings ? "flex" : "none";
    const target = settings ? this.bodySettings : this.bodyDefault;
    target.classList.remove("tray-fade"); void target.offsetWidth; target.classList.add("tray-fade");
  }

  private updateKillBtn(): void {
    const n = this.s.selected.size;
    const has = n > 0;
    Object.assign(this.killBtn.style, {
      background: has ? "var(--danger)" : "var(--bg-elev)",
      color: has ? "#fff" : "var(--fg-3)",
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
    if (checked) ref.check.appendChild(icon("check", 12, { color: "#fff" } as any));

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

      // 浮层菜单打开时，Esc 关闭它
      if (e.key === "Escape" && this.menuLayer.firstChild) { e.preventDefault(); this.closeMenu(); return; }

      // ⌘F 搜索
      if (mod && e.key.toLowerCase() === "f") {
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

      if (e.key === "ArrowDown") {
        e.preventDefault();
        this.moveCursor(1);
      } else if (e.key === "ArrowUp") {
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
