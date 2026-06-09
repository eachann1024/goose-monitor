/* ProcKill 主应用 —— 原生 TS 复刻设计稿（紧凑专家版 + 行内进程树 + Helper 合并）。
   由 bridge 驱动真实数据；浏览器无后端时走动态 mock。

   渲染策略（关键，去闪烁）：
   - 骨架（header/sidebar/main/footer/滚动区）只 mount() 一次，永不销毁。
   - 之后所有刷新走 update*()，只改文本/样式/类，不重建 DOM。
   - 列表用 id→节点 的增量 diff：复用已有行、新增缺失行、移除消失行、
     只移动真正错位的节点。轮询刷新时 DOM 身份不变 → 数值跳动但绝不闪烁。 */
import "./styles_guard";
import { detectBridge, type PlatformBridge } from "./bridge";
import type { AppRow, CategoryId, SystemStats } from "./types";
import { CATEGORIES, fmtMem, fmtCpu, modKeyLabel, isModKey } from "./shared";
import { icon } from "./icons";
import { appIcon, meter, kbd, h, highlight } from "./atoms";
// 应用品牌图标（鹅的监控）——vite 处理为可用 URL，用于 uTools 插件标签等品牌位
import BRAND_ICON_URL from "../assets/app-icon.png";

type SortKey = "mem" | "cpu" | "procs" | "name";
type SortDir = "asc" | "desc";

const SORTS: [SortKey, string][] = [
  ["mem", "内存"], ["cpu", "CPU"], ["procs", "进程数"], ["name", "名称"],
];

// 行网格列宽（复刻设计稿 v5 compact COLS）
const COLS = "16px 1fr 52px 96px 110px 56px";
const REFRESH_MS = 2000;

interface State {
  cat: CategoryId;
  sortKey: SortKey;
  sortDir: SortDir;
  sel: number;
  expanded: Set<string>;
  dialogApp: AppRow | null;
  dontRemind: boolean;
  menuOpen: boolean;
  query: string;
  searchOn: boolean;
  list: AppRow[]; // 当前分类的原始（未排序未过滤）列表
  stats: SystemStats | null;
  loading: boolean;
  theme: "dark" | "light"; // 当前主题
  themeAuto: boolean;      // 是否跟随系统/uTools（未手动切换时为 true）
}

// 一行复用的节点引用集合（增量更新时按需改这些子节点）。
interface RowRefs {
  wrap: HTMLElement;      // 整组容器（主行 + 展开的 helper 行）
  row: HTMLElement;       // 主行
  caret: HTMLElement;     // 展开箭头容器
  nameLine: HTMLElement;  // 名称行（含端口）
  pathLine: HTMLElement;  // 路径行
  procWrap: HTMLElement;  // 进程数单元
  cpuVal: HTMLElement; cpuMeter: HTMLElement;
  memVal: HTMLElement; memMeter: HTMLElement;
  pidCell: HTMLElement;
  helperBox: HTMLElement; // helper 行的挂载容器
  iconHolder: HTMLElement;
  signature: string;      // 上次渲染用的内容指纹，跳过无变化的更新
}

class ProcKillApp {
  private bridge: PlatformBridge;
  private root: HTMLElement;
  private s: State;
  private refreshTimer: number | null = null;
  // 仅在用户主动改变选中项（键盘上下导航）时置 true，updateList 据此把选中项滚入视野一次。
  // 轮询刷新不置位 → 不会在用户下滑时把列表强行拉回顶部。
  private pendingScrollToSel = false;
  // 请求序号：每次发起 load/polling 自增并捕获当时的分类，返回时校验仍是最新请求且分类未变，
  // 否则丢弃——防止快速切分类时较慢的旧请求乱序返回，把旧分类数据写进当前分类标题下。
  private loadSeq = 0;
  // 刚 kill 掉的进程组 id → 遮罩到期时间（performance.now ms）。
  // 防两类“复活”：① kill 时已在途的 list 响应整包写回；② 真实后端进程退出有延迟，
  // 下一两次刷新仍可能列出它。在落列表前过滤掉这些 id，短时遮罩后自动失效。
  private recentlyKilled = new Map<string, number>();
  private static readonly KILL_MASK_MS = 4000;

  // ---- 持久骨架节点引用（mount 后填充，永不为 null）----
  private win!: HTMLElement;
  private titleText!: HTMLElement;
  private countBadge!: HTMLElement;
  private sortBtnLabel!: Text;
  private sortBtnArrow!: SVGElement | HTMLElement;
  private sortBtn!: HTMLElement;
  private sortMenuWrap!: HTMLElement;
  private categoryBtns: Record<string, { btn: HTMLElement; label: HTMLElement; key: HTMLElement }> = {};
  // 分类快捷键角标：默认隐藏，按住主修饰键（mac=⌘ / win·linux=Ctrl）时整体显示。
  private navKbds: HTMLElement[] = [];
  private footerStats!: HTMLElement;
  private searchBar!: HTMLElement;
  private searchInput!: HTMLInputElement;
  private scroll!: HTMLElement;
  private emptyEl!: HTMLElement;
  private footerSelName!: HTMLElement;
  private footerKillBtn!: HTMLElement;
  private dialogLayer!: HTMLElement;     // 弹窗挂载层（持久，内容按需填充）
  private cpuHdr!: HTMLElement; private memHdr!: HTMLElement;
  private themeBtn!: HTMLElement;        // 主题切换按钮
  private searchBadge!: HTMLElement;     // uTools 模式下：搜索栏左侧「鹅的监控」插件标签
  private searchTakeover!: HTMLElement;  // uTools 模式下：「uTools 输入框已接管」标识

  // 是否运行在 uTools 环境（用于叠加 uTools 专属视觉）
  private get isUtools(): boolean { return this.bridge.name === "utools"; }

  // 列表行复用表
  private rows = new Map<string, RowRefs>();

  constructor(root: HTMLElement) {
    this.root = root;
    this.bridge = detectBridge();
    // uTools 插件窗口高度由宿主动态决定，height:100% 链可能塌缩导致列表滚不动；
    // 打上标记后 CSS 改用 100vh 固定视口高度，确保滚动区能正确收敛并响应滚轮。
    if (this.bridge.name === "utools") document.body.classList.add("utools");
    const { theme, auto } = this.resolveInitialTheme();
    this.s = {
      cat: "gui",
      sortKey: "mem",
      sortDir: "desc",
      sel: 0,
      expanded: new Set(),
      dialogApp: null,
      dontRemind: this.bridge.getPref("pk_dont_remind") === "1",
      menuOpen: false,
      query: "",
      searchOn: false,
      list: [],
      stats: null,
      loading: true,
      theme,
      themeAuto: auto,
    };
    this.applyTheme();
  }

  // 初始主题：① 用户存过偏好 → 用它（非 auto）；② uTools 环境 → 跟随 uTools；
  // ③ 否则跟随系统 prefers-color-scheme。② ③ 视为 auto，会随宿主主题变化。
  private resolveInitialTheme(): { theme: "dark" | "light"; auto: boolean } {
    const saved = this.bridge.getPref("pk_theme");
    if (saved === "dark" || saved === "light") return { theme: saved, auto: false };
    const u = (window as any).utools;
    if (this.isUtools && typeof u?.isDarkColors === "function") {
      return { theme: u.isDarkColors() ? "dark" : "light", auto: true };
    }
    const prefersLight = window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches;
    return { theme: prefersLight ? "light" : "dark", auto: true };
  }

  private applyTheme(): void {
    document.body.setAttribute("data-theme", this.s.theme);
    if (this.win) this.win.setAttribute("data-theme", this.s.theme);
  }

  // 手动切换主题：固定为所选值并持久化，脱离 auto。
  private toggleTheme(): void {
    this.s.theme = this.s.theme === "dark" ? "light" : "dark";
    this.s.themeAuto = false;
    this.bridge.setPref("pk_theme", this.s.theme);
    this.applyTheme();
    this.update();
  }

  // 跟随系统主题变化，仅在用户未手动锁定（auto）时生效。
  // 注意：uTools 主题不在这里注册 onPluginEnter（会覆盖 preload 已注册的带词进入回调）；
  // 改为在 __prockillEnter 钩子被调用时顺带校准 uTools 主题（见 installUtoolsHooks）。
  private installThemeWatch(): void {
    if (!window.matchMedia) return;
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    const onChange = () => {
      if (!this.s.themeAuto || this.isUtools) return;
      this.s.theme = mq.matches ? "light" : "dark";
      this.applyTheme();
      this.update();
    };
    mq.addEventListener?.("change", onChange);
  }

  // auto 模式下，从 uTools 同步一次主题（在每次进入插件时调用）。
  private syncUtoolsTheme(): void {
    if (!this.s.themeAuto || !this.isUtools) return;
    const u = (window as any).utools;
    if (typeof u?.isDarkColors === "function") {
      const next = u.isDarkColors() ? "dark" : "light";
      if (next !== this.s.theme) { this.s.theme = next; this.applyTheme(); }
    }
  }

  // 切换排序列时重置方向：名称默认升序（A→Z），数字列默认降序（大→小）。
  private setSortKey(key: SortKey): void {
    this.s.sortKey = key;
    this.s.sortDir = key === "name" ? "asc" : "desc";
  }

  // ---------- 派生数据 ----------
  private sortList(list: AppRow[]): AppRow[] {
    const { sortKey, sortDir } = this.s;
    const s = [...list].sort((a, b) => {
      if (sortKey === "name") return a.name.localeCompare(b.name);
      return ((b as any)[sortKey] || 0) - ((a as any)[sortKey] || 0);
    });
    if (sortKey === "name") return sortDir === "asc" ? s : s.reverse();
    return sortDir === "asc" ? s.reverse() : s;
  }

  private get filtered(): AppRow[] {
    const q = this.s.query.trim().toLowerCase();
    const base = this.s.list;
    if (!q) return base;
    // 搜索范围：应用名 + 路径 + 每个 Helper 的名称/角色 + PID（搜 "GPU"/PID 都能命中）
    return base.filter((a) => {
      const hay =
        a.name + " " + a.path + " " + a.pid + " " +
        a.helpers.map((hp) => hp.name + " " + hp.role + " " + hp.pid).join(" ");
      return hay.toLowerCase().includes(q);
    });
  }

  private visibleCache: AppRow[] | null = null;
  private get visible(): AppRow[] {
    if (this.visibleCache) return this.visibleCache;
    this.visibleCache = this.sortList(this.filtered);
    return this.visibleCache;
  }
  private invalidateVisible(): void { this.visibleCache = null; }

  private get selApp(): AppRow | null {
    const v = this.visible;
    return v[Math.min(this.s.sel, v.length - 1)] || null;
  }

  // ---------- 数据加载 ----------
  async load(initial = false): Promise<void> {
    const seq = ++this.loadSeq;
    const cat = this.s.cat;
    try {
      const [list, stats] = await Promise.all([
        this.bridge.listProcesses(cat),
        this.bridge.systemStats(),
      ]);
      // 期间又发起了新请求 / 分类已切走 → 丢弃这份过期结果，避免串台。
      if (seq !== this.loadSeq || cat !== this.s.cat) return;
      this.s.list = this.maskKilled(list);
      this.s.stats = stats;
      this.s.loading = false;
      this.update();
    } catch (e) {
      if (seq !== this.loadSeq || cat !== this.s.cat) return;
      console.error("[ProcKill] load failed", e);
      this.s.loading = false;
      this.update();
    } finally {
      if (initial) this.startPolling();
    }
  }

  private startPolling(): void {
    if (this.refreshTimer != null) return;
    this.refreshTimer = window.setInterval(() => {
      if (this.s.dialogApp) return;     // 弹窗打开时不刷新，避免选中态跳动
      if (document.hidden) return;      // 窗口隐藏/最小化时不刷新
      const seq = ++this.loadSeq;
      const cat = this.s.cat;
      Promise.all([this.bridge.listProcesses(cat), this.bridge.systemStats()])
        .then(([list, stats]) => {
          // 丢弃过期/串台的轮询结果（期间手动刷新或切了分类）
          if (seq !== this.loadSeq || cat !== this.s.cat) return;
          this.s.list = this.maskKilled(list);
          this.s.stats = stats;
          this.update();
        })
        .catch(() => {});
    }, REFRESH_MS);
  }

  // ---------- 操作 ----------
  private async doKill(app: AppRow): Promise<void> {
    const before = this.visible.length;
    const res = await this.bridge.killProcess(app);
    this.s.dialogApp = null;
    if (res.ok) {
      // ① 让所有在途 load/polling 响应失效（它们仍含被 kill 的进程，回来会整包写回使其复活）
      ++this.loadSeq;
      // ② 短时遮罩该 id：真实后端进程退出有延迟，接下来一两次刷新仍可能列出它
      this.recentlyKilled.set(app.id, performance.now() + ProcKillApp.KILL_MASK_MS);
      this.s.list = this.s.list.filter((a) => a.id !== app.id);
      const after = before - 1;
      if (this.s.sel >= after) this.s.sel = Math.max(0, after - 1);
    } else {
      this.toast(`结束失败：${res.error || "权限不足或进程已退出"}`);
    }
    this.update();
  }

  // 过滤掉处于遮罩期内的、刚被 kill 的进程；顺便清理已过期的遮罩项。
  private maskKilled(list: AppRow[]): AppRow[] {
    if (this.recentlyKilled.size === 0) return list;
    const now = performance.now();
    for (const [id, until] of this.recentlyKilled) {
      if (now >= until) this.recentlyKilled.delete(id);
    }
    if (this.recentlyKilled.size === 0) return list;
    return list.filter((a) => !this.recentlyKilled.has(a.id));
  }

  private tryKill(app: AppRow | null): void {
    if (!app) return;
    if (this.s.dontRemind) this.doKill(app);
    else { this.s.dialogApp = app; this.update(); }
  }

  private toggleExpand(app: AppRow | null): void {
    if (!app || !app.helpers.length) return;
    const n = this.s.expanded;
    n.has(app.id) ? n.delete(app.id) : n.add(app.id);
    this.update();
  }

  private setCat(cat: CategoryId): void {
    if (cat === this.s.cat) return;
    this.s.cat = cat;
    this.s.sel = 0;
    this.s.menuOpen = false;
    this.s.loading = true;
    // 立刻清掉旧分类数据，否则 update() 会用旧 list 渲染、在新标题下短暂闪现旧分类行；
    // 若随后 load() 失败，旧数据还会永久残留。清空后进入加载态，新数据到了再 diff 填充。
    this.s.list = [];
    this.clearAllRows();
    this.update();
    this.load();
  }

  // 设置搜索词并展开搜索框（uTools 带词进入 / 子输入框驱动）。
  private setSearch(query: string, focus: boolean): void {
    this.s.searchOn = true;
    this.s.query = query;
    this.s.sel = 0;
    this.update();
    if (focus) window.setTimeout(() => this.searchInput?.focus(), 0);
  }

  private toast(msg: string): void {
    let t = document.getElementById("pk-toast");
    if (!t) {
      t = h("div", { attrs: { id: "pk-toast" }, style: {
        position: "absolute", bottom: "52px", left: "50%", transform: "translateX(-50%)",
        background: "var(--bg-elev)", border: "1px solid var(--border-2)",
        color: "var(--fg-1)", font: "var(--t-sm)", padding: "8px 14px",
        borderRadius: "8px", boxShadow: "var(--shadow-pop)", zIndex: "60",
        maxWidth: "60%", textAlign: "center", transition: "opacity .25s",
      } });
      this.win.appendChild(t);
    }
    t.textContent = msg;
    t.style.opacity = "1";
    window.setTimeout(() => { if (t) t.style.opacity = "0"; }, 2600);
  }

  // ---------- 键盘 ----------
  /** 按住主修饰键时显示分类角标，松开/失焦时隐藏。 */
  private setNavKbdVisible(on: boolean): void {
    for (const k of this.navKbds) k.style.visibility = on ? "visible" : "hidden";
  }

  private installKeys(): void {
    // 修饰键按下/松开切换角标显隐；窗口失焦兜底复位，防止角标卡在显示态。
    window.addEventListener("keydown", (e) => { if (isModKey(e)) this.setNavKbdVisible(true); });
    window.addEventListener("keyup", (e) => { if (!isModKey(e)) this.setNavKbdVisible(false); });
    window.addEventListener("blur", () => this.setNavKbdVisible(false));

    window.addEventListener("keydown", (e) => {
      const mod = isModKey(e);
      const s = this.s;
      if (s.dialogApp) {
        const dlg = s.dialogApp;
        if (e.key === "Escape") { e.preventDefault(); s.dialogApp = null; this.update(); }
        else if (e.key === "Enter") { e.preventDefault(); this.doKill(dlg); }
        return;
      }
      // ⌘1–6 / Ctrl1–6 切分类（Windows/Linux 用 Ctrl，已由 e.ctrlKey 覆盖）
      if (mod && e.key >= "1" && e.key <= "6") {
        e.preventDefault();
        const c = CATEGORIES[+e.key - 1];
        if (c) this.setCat(c.id);
        return;
      }
      // ⌘F / Ctrl+F / "/" 搜索
      if ((mod && e.key.toLowerCase() === "f") || e.key === "/") {
        e.preventDefault();
        this.setSearch(s.query, true);
        return;
      }
      // 在搜索框里打字时不拦截普通键（除导航/取消/确认）
      if (
        document.activeElement === this.searchInput &&
        !["Escape", "Enter", "ArrowDown", "ArrowUp"].includes(e.key)
      ) return;

      const v = this.visible;
      if (e.key === "ArrowDown" || e.key.toLowerCase() === "j") {
        e.preventDefault();
        s.sel = Math.min(v.length - 1, s.sel + 1);
        this.pendingScrollToSel = true;
        this.update();
      } else if (e.key === "ArrowUp" || e.key.toLowerCase() === "k") {
        e.preventDefault();
        s.sel = Math.max(0, s.sel - 1);
        this.pendingScrollToSel = true;
        this.update();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        const a = this.selApp;
        if (a && a.helpers.length && !s.expanded.has(a.id)) this.toggleExpand(a);
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        const a = this.selApp;
        if (a && s.expanded.has(a.id)) this.toggleExpand(a);
      } else if (e.key === " ") {
        e.preventDefault();
        this.toggleExpand(this.selApp);
      } else if (e.key === "Enter") {
        e.preventDefault();
        this.tryKill(this.selApp);
      } else if (e.key === "r" && mod) {
        e.preventDefault();
        this.load();
      } else if (e.key === "Escape") {
        if (s.query || document.activeElement === this.searchInput) {
          s.query = ""; this.searchInput?.blur();
          this.update();
        }
      }
    });
  }

  // uTools 工具栈钩子：带词进入 / 顶部子输入框驱动搜索。
  private installUtoolsHooks(): void {
    const w = window as any;
    // 进入插件：先按 uTools 当前主题校准（auto 模式），再带词进入。
    w.__prockillEnter = (keyword: string) => {
      this.syncUtoolsTheme();
      this.setSearch(typeof keyword === "string" ? keyword : "", true);
    };
    // uTools 顶部子输入框实时驱动过滤（text 可能为空 → 清空过滤）。
    w.__prockillSubInput = (text: string) => {
      const q = typeof text === "string" ? text : "";
      this.s.searchOn = true;
      this.s.query = q;
      this.s.sel = 0;
      this.update();
    };
  }

  // ============================================================
  //  骨架挂载（只跑一次）
  // ============================================================
  private mount(): void {
    this.win = h("div", {
      className: "win",
      attrs: { "data-theme": this.s.theme },
      on: { click: () => { if (this.s.menuOpen) { this.s.menuOpen = false; this.update(); } } },
    });

    this.win.appendChild(this.buildHeader());
    this.win.appendChild(this.buildCategoryTabs());
    this.win.appendChild(this.buildMain());

    this.win.appendChild(this.buildFooter());

    // 弹窗层（持久，默认隐藏）
    this.dialogLayer = h("div");
    this.win.appendChild(this.dialogLayer);

    this.root.appendChild(this.win);
  }

  private buildHeader(): HTMLElement {
    const s = this.s;

    const brand = appIcon({ id: "__brand", name: "鹅的监控", monogram: "鹅", color: "#F5B544", procs: 1, cpu: 0, mem: 0, pid: 0, path: "", helpers: [], iconUrl: BRAND_ICON_URL } as AppRow, 18, 5);
    // 视图标题用衬线显示体(Newsreader + Noto Serif SC),复刻 goose-run 暖极简标题
    this.titleText = h("span", { style: { font: "600 16px/22px var(--font-serif)", color: "var(--fg-1)", whiteSpace: "nowrap" }, text: "鹅的监控" });
    this.countBadge = h("span", {
      style: {
        font: "var(--t-mono-sm)", color: "var(--fg-3)",
      },
    });
    const titleWrap = h("div", { style: { display: "flex", alignItems: "center", gap: "8px", minWidth: "0" }, children: [brand, this.titleText, this.countBadge] });

    // 排序按钮
    this.sortBtnArrow = icon("arrow-down-wide-narrow", 13, { color: "var(--fg-2)" } as any);
    this.sortBtnLabel = document.createTextNode("");
    this.sortBtn = h("button", {
      style: {
        display: "inline-flex", alignItems: "center", gap: "5px", height: "28px",
        padding: "0 9px", borderRadius: "7px",
        background: "var(--bg-elev)", border: "1px solid var(--border-1)", color: "var(--fg-1)",
        font: "var(--t-sm)", cursor: "pointer", whiteSpace: "nowrap",
      },
      on: { click: (e) => { e.stopPropagation(); s.menuOpen = !s.menuOpen; this.update(); } },
    });
    this.sortBtn.appendChild(this.sortBtnArrow);
    this.sortBtn.appendChild(this.sortBtnLabel);
    this.sortBtn.appendChild(icon("chevron-down", 13, { color: "var(--fg-3)" } as any));

    this.sortMenuWrap = h("div", { style: { position: "relative" }, children: [this.sortBtn] });

    const searchBtn = h("button", {
      attrs: { title: "搜索 ⌘F" },
      style: {
        width: "28px", height: "28px", display: "grid", placeItems: "center",
        borderRadius: "7px", background: "transparent", border: "1px solid transparent",
        color: "var(--fg-2)", cursor: "pointer",
      },
      on: { click: (e) => { e.stopPropagation(); this.setSearch(s.query, true); } },
      children: [icon("search", 15)],
    });

    const refreshBtn = h("button", {
      attrs: { title: "刷新 ⌘R" },
      style: {
        width: "28px", height: "28px", display: "grid", placeItems: "center",
        borderRadius: "7px", background: "transparent", border: "1px solid transparent",
        color: "var(--fg-2)", cursor: "pointer",
      },
      on: { click: (e) => { e.stopPropagation(); this.load(); } },
      children: [icon("refresh", 15)],
    });

    // 主题切换按钮（深色显示太阳=点击转浅色，浅色显示月亮=点击转深色）；图标内容由 updateHeader 维护
    this.themeBtn = h("button", {
      attrs: { title: "切换主题" },
      style: {
        width: "28px", height: "28px", display: "grid", placeItems: "center",
        borderRadius: "7px", background: "transparent", border: "1px solid transparent",
        color: "var(--fg-2)", cursor: "pointer",
      },
      on: { click: (e) => { e.stopPropagation(); this.toggleTheme(); } },
    });

    const right = h("div", {
      style: { display: "flex", alignItems: "center", gap: "8px" },
      children: [this.sortMenuWrap, searchBtn, this.themeBtn, refreshBtn],
    });

    return h("header", {
      style: {
        height: "42px", flex: "none", display: "flex", alignItems: "center",
        justifyContent: "space-between", padding: "0 12px 0 16px",
        borderBottom: "1px solid var(--border-1)", background: "var(--bg-panel)",
        position: "relative", zIndex: "5",
      },
      children: [titleWrap, right],
    });
  }

  private buildSortMenu(): HTMLElement {
    const s = this.s;
    const menu = h("div", {
      style: {
        position: "absolute", right: "0", top: "34px", width: "168px",
        background: "var(--bg-elev)", border: "1px solid var(--border-2)",
        borderRadius: "10px", boxShadow: "var(--shadow-pop)", padding: "5px", zIndex: "20",
      },
      on: { click: (e) => e.stopPropagation() },
    });
    for (const [k, l] of SORTS) {
      const btn = h("button", {
        style: {
          display: "flex", width: "100%", alignItems: "center", gap: "8px",
          height: "30px", padding: "0 9px", borderRadius: "7px", border: "none",
          cursor: "pointer", background: k === s.sortKey ? "var(--bg-row-sel)" : "transparent",
          color: "var(--fg-1)", font: "var(--t-sm)", textAlign: "left",
        },
        on: { click: () => { this.setSortKey(k); s.menuOpen = false; this.update(); } },
        children: [h("span", { style: { flex: "1" }, text: l })],
      });
      if (k === s.sortKey) btn.appendChild(icon("check", 14, { color: "var(--accent)" } as any));
      menu.appendChild(btn);
    }
    menu.appendChild(h("div", { style: { height: "1px", background: "var(--border-1)", margin: "5px 0" } }));
    const dirBtn = h("button", {
      style: {
        display: "flex", width: "100%", alignItems: "center", gap: "8px",
        height: "30px", padding: "0 9px", borderRadius: "7px", border: "none",
        cursor: "pointer", background: "transparent", color: "var(--fg-2)",
        font: "var(--t-sm)", textAlign: "left",
      },
      on: { click: () => { s.sortDir = s.sortDir === "desc" ? "asc" : "desc"; this.update(); } },
    });
    dirBtn.appendChild(icon("arrow-down-wide-narrow", 13, {
      transform: s.sortDir === "asc" ? "scaleY(-1)" : "none",
    } as any));
    dirBtn.appendChild(document.createTextNode(
      (s.sortDir === "desc" ? "降序 ↓" : "升序 ↑") + "（点击切换）",
    ));
    menu.appendChild(dirBtn);
    return menu;
  }

  private buildCategoryTabs(): HTMLElement {
    const s = this.s;
    const tabs = h("div", {
      style: {
        height: "34px", flex: "none", display: "flex", alignItems: "center", gap: "4px",
        padding: "0 12px", borderBottom: "1px solid var(--border-1)",
        background: "var(--bg-sidebar)", overflow: "hidden",
      },
    });
    this.navKbds = [];
    const kbdWide = modKeyLabel !== "⌘";
    for (const c of CATEGORIES) {
      const labelText = c.label.replace(" 占用", "").replace("网络 / 端口", "网络").replace("界面应用", "界面").replace("全部进程", "全部");
      const label = h("span", { style: { font: "var(--t-sm)", color: "var(--fg-2)", whiteSpace: "nowrap" }, text: labelText });
      const key = kbd(`${modKeyLabel}${c.key}`, kbdWide);
      key.style.visibility = "hidden";
      this.navKbds.push(key);
      const btn = h("button", {
        style: {
          display: "inline-flex", alignItems: "center", gap: "6px", height: "24px",
          padding: "0 9px", borderRadius: "7px", border: "1px solid transparent",
          cursor: "pointer", textAlign: "left", background: "transparent", flex: "none",
        },
        on: {
          click: () => this.setCat(c.id),
          mouseenter: () => { if (c.id !== s.cat) btn.style.background = "var(--bg-row-hover)"; },
          mouseleave: () => { if (c.id !== s.cat) btn.style.background = "transparent"; },
        },
        children: [label, key],
      });
      this.categoryBtns[c.id] = { btn, label, key };
      tabs.appendChild(btn);
    }
    return tabs;
  }

  private buildMain(): HTMLElement {
    const s = this.s;
    const main = h("main", {
      style: {
        // minHeight:0 解除 flex item 默认 min-height:auto，
        // 否则内容超高时 .scroll 会被撑开而非内部滚动（uTools Chromium 严格遵守规范，故仅此处复现）。
        flex: "1", minWidth: "0", minHeight: "0", overflow: "hidden",
        display: "flex", flexDirection: "column",
        background: "var(--bg-panel)",
      },
    });

    // 搜索栏（持久，按 searchOn 显隐）。uTools 环境下叠加「接管」视觉。
    const umode = this.isUtools;
    this.searchInput = h("input", {
      attrs: { placeholder: umode ? "uTools 输入框已接管，输入即过滤…" : "过滤应用或路径…" },
      style: {
        flex: "1", background: "transparent", border: "none", outline: "none",
        color: "var(--fg-1)", font: "var(--t-base)",
      },
      on: { input: (e) => { s.query = (e.target as HTMLInputElement).value; s.sel = 0; this.update(); } },
    }) as HTMLInputElement;

    // uTools 模式不显示搜索栏左侧品牌标签，让搜索框占满整行。
    this.searchBadge = h("span", { style: { display: "none" } });

    // uTools 模式：右侧「uTools 输入框已接管」accent 标识
    this.searchTakeover = h("span", {
      className: "t-xs",
      style: { display: umode ? "inline-flex" : "none", alignItems: "center", color: "var(--fg-3)", fontWeight: "600", flex: "none" },
      text: "uTools 输入框已接管",
    });

    this.searchBar = h("div", {
      style: {
        height: umode ? "40px" : "36px", flex: "none", display: "flex", alignItems: "center",
        gap: "10px", padding: "0 14px", borderBottom: "1px solid var(--border-1)",
      },
      children: [
        this.searchBadge,
        icon("search", 14, { color: "var(--fg-3)" } as any),
        this.searchInput,
        this.searchTakeover,
        h("button", {
          style: { border: "none", background: "transparent", color: "var(--fg-3)", font: "var(--t-xs)", cursor: "pointer", flex: "none" },
          text: "清除 Esc",
          on: { click: () => { s.query = ""; this.searchInput.blur(); this.update(); } },
        }),
      ],
    });
    main.appendChild(this.searchBar);

    // 列头
    const head = h("div", {
      style: {
        display: "grid", gridTemplateColumns: COLS, gap: "6px", alignItems: "center",
        padding: "0 12px", height: "24px", flex: "none", borderBottom: "1px solid var(--border-1)",
      },
    });
    head.appendChild(h("span"));
    head.appendChild(h("span", { className: "t-label", text: "进程 / PID" }));
    head.appendChild(h("span", { className: "t-label", style: { textAlign: "right" }, text: "数" }));
    this.cpuHdr = this.sortHdr("CPU", "cpu");
    this.memHdr = this.sortHdr("内存", "mem");
    head.appendChild(this.cpuHdr);
    head.appendChild(this.memHdr);
    head.appendChild(h("span", { className: "t-label", style: { textAlign: "right" }, text: "操作" }));
    main.appendChild(head);

    // 列表滚动区（持久）
    this.scroll = h("div", {
      className: "scroll",
      attrs: { id: "pk-scroll" },
      style: { flex: "1 1 auto", minHeight: "0", overflowY: "auto" },
    });
    // 空态/加载态提示（持久，按需显隐）
    this.emptyEl = h("div", {
      style: { padding: "40px", textAlign: "center", color: "var(--fg-3)", font: "var(--t-sm)", display: "none" },
    });
    this.scroll.appendChild(this.emptyEl);
    main.appendChild(this.scroll);
    return main;
  }

  private sortHdr(label: string, key: SortKey): HTMLElement {
    const s = this.s;
    const arrow = icon("chevron-down", 11, {} as any);
    const btn = h("button", {
      attrs: { "data-key": key },
      style: {
        border: "none", background: "transparent", cursor: "pointer", textAlign: "right",
        display: "inline-flex", alignItems: "center", justifyContent: "flex-end", gap: "3px",
        padding: "0", font: "var(--t-label)", textTransform: "uppercase",
        letterSpacing: "0.07em", fontWeight: "600", color: "var(--fg-3)",
      },
      on: { click: () => {
        if (s.sortKey === key) s.sortDir = s.sortDir === "desc" ? "asc" : "desc";
        else this.setSortKey(key);
        this.update();
      } },
      children: [document.createTextNode(label), arrow],
    });
    (btn as any).__arrow = arrow;
    return btn;
  }

  private buildFooter(): HTMLElement {
    const hint = (k: string, t: string) =>
      h("span", { style: { display: "inline-flex", alignItems: "center", gap: "6px", flex: "none", whiteSpace: "nowrap" }, children: [
        kbd(k), h("span", { className: "t-xs", style: { color: "var(--fg-3)" }, text: t }),
      ] });

    this.footerSelName = h("span", { className: "t-xs", style: { color: "var(--fg-3)", display: "none" } });
    this.footerStats = h("span", { style: { font: "var(--t-mono-sm)", color: "var(--fg-3)", whiteSpace: "nowrap" }, text: "tauri · utools" });
    this.footerKillBtn = h("span", {
      style: {
        display: "inline-flex", alignItems: "center", gap: "6px", height: "24px",
        padding: "0 9px", borderRadius: "7px", background: "var(--danger)", color: "var(--fg-on-accent)",
        font: "var(--t-xs)", fontWeight: "600", flex: "none", cursor: "default", opacity: "0.5",
      },
      on: { click: () => this.tryKill(this.selApp) },
      children: [document.createTextNode("结束进程 "), kbd("⏎")],
    });

    const right = h("span", {
      style: { marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: "8px", whiteSpace: "nowrap", flex: "none" },
      children: [this.footerStats, this.footerSelName, this.footerKillBtn],
    });

    // 左侧快捷键提示：整组可收缩并裁剪，空间不足时优先保证右侧 stats / 结束进程按钮完整。
    // uTools 窗口偏窄，精简为最关键的几项，避免提示被挤压换行 / 截断。
    const hints = this.isUtools
      ? [hint("j / k", "移动"), hint("␣", "展开/合并"), hint("/", "过滤")]
      : [hint("j / k", "移动"), hint("␣", "展开/合并"), hint("⏎", "结束进程"), hint("/", "过滤"), hint(`${modKeyLabel}1–6`, "分类")];
    const hintsWrap = h("span", {
      style: { display: "flex", alignItems: "center", gap: "14px", flex: "1 1 auto", minWidth: "0", overflow: "hidden" },
      children: hints,
    });

    return h("footer", {
      style: {
        height: "30px", flex: "none", display: "flex", alignItems: "center", gap: "14px",
        padding: "0 12px", borderTop: "1px solid var(--border-1)", background: "var(--bg-sidebar)",
      },
      children: [hintsWrap, right],
    });
  }

  // ============================================================
  //  增量更新（每帧调用，只改变化的部分）
  // ============================================================
  update(): void {
    this.invalidateVisible();
    const v = this.visible;
    const s = this.s;
    // 选中位收敛到有效范围
    if (s.sel >= v.length) s.sel = Math.max(0, v.length - 1);

    this.updateHeader(v);
    this.updateTabs();
    this.updateSearchBar();
    this.updateList(v);
    this.updateFooter();
    this.updateDialog();
  }

  private updateHeader(v: AppRow[]): void {
    const s = this.s;
    this.titleText.textContent = "鹅的监控";
    const totalProcs = v.reduce((sum, row) => sum + row.procs, 0);
    const catLabel = CATEGORIES.find((c) => c.id === s.cat)!.label;
    this.countBadge.textContent = `${v.length} 应用 · ${totalProcs} 进程 · ${catLabel}`;

    // 主题按钮：深色态显示太阳（点击切到浅色），浅色态显示月亮（点击切到深色）。仅图标变化时重建。
    const wantIcon = s.theme === "dark" ? "sun" : "moon";
    if (this.themeBtn.getAttribute("data-icon") !== wantIcon) {
      this.themeBtn.replaceChildren(icon(wantIcon, 15));
      this.themeBtn.setAttribute("data-icon", wantIcon);
    }

    this.sortBtnLabel.textContent = SORTS.find((x) => x[0] === s.sortKey)![1];
    this.sortBtn.style.background = s.menuOpen ? "var(--bg-row-sel)" : "var(--bg-elev)";
    (this.sortBtnArrow as HTMLElement).style.transform = s.sortDir === "asc" ? "scaleY(-1)" : "none";

    // 排序菜单显隐：只增删菜单节点，按钮本身不动
    const existing = this.sortMenuWrap.querySelector(".pk-sortmenu") as HTMLElement | null;
    if (s.menuOpen && !existing) {
      const m = this.buildSortMenu();
      m.classList.add("pk-sortmenu");
      this.sortMenuWrap.appendChild(m);
    } else if (!s.menuOpen && existing) {
      existing.remove();
    } else if (s.menuOpen && existing) {
      // 重建菜单内容以反映最新选中/方向（菜单很小，重建无感知）
      const m = this.buildSortMenu();
      m.classList.add("pk-sortmenu");
      existing.replaceWith(m);
    }

    // 列头高亮 + 箭头
    for (const hdr of [this.cpuHdr, this.memHdr]) {
      const key = hdr.getAttribute("data-key") as SortKey;
      const active = s.sortKey === key;
      hdr.style.color = active ? "var(--accent)" : "var(--fg-3)";
      const arrow = (hdr as any).__arrow as HTMLElement;
      arrow.style.display = active ? "" : "none";
      arrow.style.transform = s.sortDir === "asc" ? "scaleY(-1)" : "none";
    }
  }

  private updateTabs(): void {
    const s = this.s;
    for (const c of CATEGORIES) {
      const ref = this.categoryBtns[c.id];
      const on = c.id === s.cat;
      ref.btn.style.background = on ? "var(--bg-row-sel)" : "transparent";
      ref.btn.style.borderColor = on ? "var(--border-2)" : "transparent";
      ref.label.style.color = on ? "var(--fg-1)" : "var(--fg-2)";
    }
    const stats = s.stats;
    const cpuPct = stats ? Math.round(stats.cpuPercent) : 0;
    const memUsed = stats ? stats.memUsedMb : 0;
    if (this.footerStats) this.footerStats.textContent = `${this.bridge.name} · CPU ${cpuPct}% · 内存 ${fmtMem(memUsed)}`;
  }

  private updateSearchBar(): void {
    const s = this.s;
    // uTools 环境：顶部子输入框已由 setSubInput 接管（preload.js），内嵌搜索栏冗余，隐藏之。
    // 过滤仍由 uTools 顶部输入框经 __prockillSubInput 驱动，体验与独立窗口的 uTools 搜索框一致。
    this.searchBar.style.display = this.isUtools ? "none" : "flex";
    // 仅当值不同步时写入，避免打断输入法/光标
    if (this.searchInput.value !== s.query) this.searchInput.value = s.query;
  }

  // 列表增量 diff：复用/新增/移除/重排，只动必要节点。
  private updateList(v: AppRow[]): void {
    const s = this.s;

    // 加载中且无数据：显示加载态，清空行
    if (s.loading && v.length === 0) {
      this.showEmpty("正在读取进程…");
      this.clearAllRows();
      return;
    }
    if (v.length === 0) {
      this.showEmpty(s.query ? "没有匹配的进程" : "没有进程");
      this.clearAllRows();
      return;
    }
    this.emptyEl.style.display = "none";

    const maxCpu = Math.max(1, ...v.map((a) => a.cpu));
    const maxMem = Math.max(1, ...v.map((a) => a.mem));
    const wantIds = new Set(v.map((a) => a.id));

    // 1) 删除已消失的行
    for (const [id, ref] of this.rows) {
      if (!wantIds.has(id)) { ref.wrap.remove(); this.rows.delete(id); }
    }

    // 2) 按目标顺序复用/新建，并就地排序
    let prev: HTMLElement | null = null; // 上一个已就位的 wrap
    v.forEach((a, i) => {
      let ref = this.rows.get(a.id);
      if (!ref) {
        ref = this.buildRow(a);
        this.rows.set(a.id, ref);
      }
      this.updateRow(ref, a, i, s.sel === i, maxCpu, maxMem);

      // 顺序校正：当前 wrap 应紧跟在 prev 之后
      const shouldFollow = prev ? prev.nextSibling : this.scroll.firstChild;
      if (ref.wrap !== shouldFollow) {
        this.scroll.insertBefore(ref.wrap, shouldFollow);
      }
      prev = ref.wrap;
    });

    // 把选中项滚入视野：仅在用户主动改变选中项时滚动一次。
    // 否则轮询刷新会反复把默认选中的首项滚回顶部，打断用户下滑浏览。
    const sel = this.pendingScrollToSel ? this.selApp : null;
    this.pendingScrollToSel = false;
    const el = sel && this.rows.get(sel.id)?.wrap;
    if (el) {
      const cont = this.scroll;
      // 用 getBoundingClientRect 相对容器算偏移，避免依赖 offsetParent 链
      // （wrap/scroll 无定位时 offsetTop 会把 header 等高度算进去，导致滚动错位）。
      const rRect = el.getBoundingClientRect();
      const cRect = cont.getBoundingClientRect();
      const top = rRect.top - cRect.top + cont.scrollTop;
      const bottom = top + rRect.height;
      if (top < cont.scrollTop) cont.scrollTop = top - 8;
      else if (bottom > cont.scrollTop + cont.clientHeight)
        cont.scrollTop = bottom - cont.clientHeight + 8;
    }
  }

  private showEmpty(msg: string): void {
    this.emptyEl.textContent = msg;
    this.emptyEl.style.display = "";
  }
  private clearAllRows(): void {
    for (const [, ref] of this.rows) ref.wrap.remove();
    this.rows.clear();
  }

  // 新建一行（结构骨架，值由 updateRow 填）。
  private buildRow(a: AppRow): RowRefs {
    const s = this.s;
    const wrap = h("div");

    const caret = h("button", {
      style: {
        width: "16px", height: "16px", display: "grid", placeItems: "center",
        border: "none", background: "transparent", cursor: "pointer", padding: "0",
      },
      on: { click: (e) => { e.stopPropagation(); this.toggleExpand(this.findById(a.id)); } },
    });

    const iconHolder = h("span", { style: { display: "inline-flex" } });
    const nameLine = h("div", { className: "t-sm", style: { color: "var(--fg-1)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", minWidth: "0" } });
    const pathLine = h("span", { style: { font: "var(--t-mono-sm)", color: "var(--fg-3)", flex: "none" } });
    const nameCol = h("div", { style: { display: "flex", alignItems: "center", gap: "8px", minWidth: "0" }, children: [iconHolder, nameLine, pathLine] });

    const procWrap = h("div", { style: { textAlign: "right" } });
    const cpuVal = h("span", { className: "t-mono", style: { fontSize: "11px", minWidth: "44px", textAlign: "right" } });
    const cpuMeter = h("div", { style: { display: "inline-flex", justifyContent: "flex-end", width: "100%" } });
    const cpuCol = h("div", { style: { textAlign: "right", display: "flex", alignItems: "center", justifyContent: "flex-end", gap: "6px" }, children: [cpuMeter, cpuVal] });
    const memVal = h("span", { className: "t-mono", style: { fontSize: "11px", minWidth: "56px", textAlign: "right" } });
    const memMeter = h("div", { style: { display: "inline-flex", justifyContent: "flex-end", width: "100%" } });
    const memCol = h("div", { style: { textAlign: "right", display: "flex", alignItems: "center", justifyContent: "flex-end", gap: "6px" }, children: [memMeter, memVal] });
    const pidCell = h("div", { style: { textAlign: "right", font: "var(--t-mono-sm)", color: "var(--fg-3)" } });

    const row = h("div", {
      style: {
        display: "grid", gridTemplateColumns: COLS, alignItems: "center", gap: "6px",
        padding: "0 12px", height: "30px", cursor: "pointer", position: "relative",
        background: "transparent",
      },
      on: {
        click: () => { this.selectById(a.id); },
        dblclick: () => this.toggleExpand(this.findById(a.id)),
        mouseenter: () => { if (!row.hasAttribute("data-sel")) row.style.background = "var(--bg-row-hover)"; },
        mouseleave: () => { if (!row.hasAttribute("data-sel")) row.style.background = "transparent"; },
      },
      children: [caret, nameCol, procWrap, cpuCol, memCol, pidCell],
    });

    const helperBox = h("div");
    wrap.appendChild(row);
    wrap.appendChild(helperBox);

    return {
      wrap, row, caret, nameLine, pathLine, procWrap,
      cpuVal, cpuMeter, memVal, memMeter, pidCell, helperBox, iconHolder,
      signature: "",
    };
  }

  private findById(id: string): AppRow | null {
    return this.visible.find((a) => a.id === id) || null;
  }
  private selectById(id: string): void {
    const idx = this.visible.findIndex((a) => a.id === id);
    if (idx >= 0) { this.s.sel = idx; this.update(); }
  }

  // 更新一行的内容（只在指纹变化时改 DOM）。
  private updateRow(ref: RowRefs, a: AppRow, index: number, selected: boolean, maxCpu: number, maxMem: number): void {
    const s = this.s;
    const expanded = s.expanded.has(a.id);
    // 指纹：决定是否需要重绘这一行（含值、选中、展开、量尺基准、图标相关、helper 明细）。
    // helper 明细必须纳入：展开态下，即便父级聚合值四舍五入后不变，helper 的 pid/cpu/mem 仍可能变。
    // 图标字段（sys/iconUrl/color/monogram）纳入：真实图标异步补上或同 id 状态变化时要能重画。
    const q = s.query.trim().toLowerCase();
    const sig = [
      a.cpu, a.mem, a.procs, a.pid, a.name, a.path, a.port || "",
      selected ? 1 : 0, expanded ? 1 : 0, maxCpu, maxMem,
      a.sys ? 1 : 0, a.iconUrl || "", a.color, a.monogram,
      q, // 搜索词纳入：改词时已渲染行要重画匹配高亮
      a.helpers.map((hp) => `${hp.pid}:${hp.cpu}:${hp.mem}:${hp.name}:${hp.role}`).join(","),
    ].join("|");
    if (ref.signature === sig) {
      // 仅选中态可能因键盘移动而频繁变；已包含在 sig，无需额外处理
      return;
    }
    ref.signature = sig;

    // 选中态
    ref.row.style.background = selected ? "var(--bg-row-sel)" : "transparent";
    ref.row.style.boxShadow = selected ? "inset 2px 0 0 var(--accent)" : "none";
    if (selected) ref.row.setAttribute("data-sel", "1");
    else ref.row.removeAttribute("data-sel");

    // 展开箭头
    ref.caret.style.cursor = a.helpers.length ? "pointer" : "default";
    ref.caret.replaceChildren();
    if (a.helpers.length > 0) {
      ref.caret.appendChild(icon(expanded ? "chevron-down" : "chevron-right", 13, { color: "var(--fg-3)" } as any));
    }

    // 图标：仅在视觉相关字段（id/sys 尺寸/真实图标/品牌色/字形）变化时重建，平时复用避免重画。
    const iconSig = `${a.id}|${a.sys ? 1 : 0}|${a.iconUrl || ""}|${a.color}|${a.monogram}`;
    if (!ref.iconHolder.firstChild || ref.iconHolder.getAttribute("data-icon-sig") !== iconSig) {
      ref.iconHolder.replaceChildren(appIcon(a, a.sys ? 18 : 18, a.sys ? 5 : 5));
      ref.iconHolder.setAttribute("data-icon-sig", iconSig);
    }

    // 名称 + 端口（搜索时命中子串品牌色高亮）
    ref.nameLine.replaceChildren(highlight(a.name, q));
    if (a.port) {
      ref.nameLine.appendChild(h("span", { style: { font: "var(--t-mono-sm)", color: "var(--metric-net)", marginLeft: "8px" }, text: ":" + a.port }));
    }
    ref.pathLine.replaceChildren(document.createTextNode(String(a.pid)));

    // 进程数
    if (a.procs > 1) {
      ref.procWrap.replaceChildren(h("span", {
        style: {
          font: "var(--t-mono-sm)", color: "var(--accent)",
          whiteSpace: "nowrap",
        },
        text: "×" + a.procs,
      }));
    } else {
      ref.procWrap.replaceChildren(h("span", { style: { font: "var(--t-mono-sm)", color: "var(--fg-3)" }, text: "×1" }));
    }

    // CPU / 内存（数值 + 量尺）
    ref.cpuVal.textContent = fmtCpu(a.cpu);
    ref.cpuMeter.replaceChildren(meter(a.cpu, maxCpu, "var(--metric-cpu)", 3, 34));
    ref.memVal.textContent = fmtMem(a.mem);
    ref.memMeter.replaceChildren(meter(a.mem, maxMem, "var(--metric-mem)", 3, 40));

    ref.pidCell.textContent = selected ? "⏎ kill" : "";

    // 展开的 Helper 行
    if (expanded && a.helpers.length) {
      ref.helperBox.replaceChildren(...a.helpers.map((hp) => this.buildHelperRow(hp, q)));
    } else {
      ref.helperBox.replaceChildren();
    }
  }

  private buildHelperRow(hp: AppRow["helpers"][number], q: string): HTMLElement {
    const hr = h("div", {
      style: {
        display: "grid", gridTemplateColumns: COLS, alignItems: "center", gap: "6px",
        padding: "0 12px", height: "26px", background: "var(--bg-helper-row)",
      },
    });
    hr.appendChild(h("span"));
    const cell = h("div", {
      style: { display: "flex", alignItems: "center", gap: "8px", minWidth: "0", paddingLeft: "16px", position: "relative" },
    });
    cell.appendChild(h("span", { style: { position: "absolute", left: "5px", top: "-13px", width: "1px", height: "26px", background: "var(--border-2)" } }));
    cell.appendChild(h("span", { style: { position: "absolute", left: "5px", top: "13px", width: "9px", height: "1px", background: "var(--border-2)" } }));
    const hName = h("span", { style: { font: "var(--t-mono-sm)", color: "var(--fg-2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } });
    hName.appendChild(highlight(hp.name, q));
    cell.appendChild(hName);
    cell.appendChild(h("span", { style: { font: "var(--t-xs)", color: "var(--fg-3)", padding: "0 5px", borderRadius: "4px", background: "var(--bg-elev)", whiteSpace: "nowrap", flex: "none" }, text: hp.role }));
    hr.appendChild(cell);
    hr.appendChild(h("span"));
    hr.appendChild(h("span", { className: "t-mono", style: { fontSize: "11px", color: "var(--fg-3)", textAlign: "right" }, text: fmtCpu(hp.cpu) }));
    hr.appendChild(h("span", { className: "t-mono", style: { fontSize: "11px", color: "var(--fg-3)", textAlign: "right" }, text: fmtMem(hp.mem) }));
    hr.appendChild(h("span", { style: { font: "var(--t-mono-sm)", color: "var(--fg-3)", textAlign: "right" }, text: String(hp.pid) }));
    return hr;
  }

  private updateFooter(): void {
    const sel = this.selApp;
    if (sel) {
      this.footerSelName.textContent = "已选 " + sel.name;
      this.footerSelName.style.display = "";
      this.footerKillBtn.style.cursor = "pointer";
      this.footerKillBtn.style.opacity = "1";
    } else {
      this.footerSelName.style.display = "none";
      this.footerKillBtn.style.cursor = "default";
      this.footerKillBtn.style.opacity = "0.5";
    }
  }

  // 弹窗：按需在持久层里建/拆，内容随 dontRemind 等更新。
  private updateDialog(): void {
    const app = this.s.dialogApp;
    if (!app) { this.dialogLayer.replaceChildren(); return; }
    this.dialogLayer.replaceChildren(this.buildConfirm(app));
  }

  private buildConfirm(app: AppRow): HTMLElement {
    const s = this.s;
    const scrim = h("div", {
      className: "scrim",
      style: {
        position: "absolute", inset: "0", background: "rgba(20,15,10,0.52)",
        backdropFilter: "blur(3px)", display: "grid", placeItems: "center", zIndex: "50",
      },
      on: { click: () => { s.dialogApp = null; this.update(); } },
    });
    const card = h("div", {
      className: "dialog-card",
      style: {
        width: "372px", borderRadius: "16px", background: "var(--bg-elev)",
        border: "1px solid var(--border-2)", boxShadow: "var(--shadow-pop)", padding: "22px",
      },
      on: { click: (e) => e.stopPropagation() },
    });

    const iconWrap = h("span", { style: { position: "relative" } });
    iconWrap.appendChild(appIcon(app, 46, 12));
    const badge = h("span", {
      style: {
        position: "absolute", right: "-4px", bottom: "-4px", width: "22px", height: "22px",
        borderRadius: "999px", background: "var(--danger)", display: "grid", placeItems: "center",
        border: "2px solid var(--bg-elev)",
      },
      children: [icon("skull", 12, { color: "#fff" } as any)],
    });
    iconWrap.appendChild(badge);

    const titleBox = h("div", { style: { minWidth: "0" }, children: [
      h("div", { style: { font: "var(--t-lg)", color: "var(--fg-1)" }, text: `结束 ${app.name}？` }),
      h("div", { className: "t-path", style: { marginTop: "2px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, text: `PID ${app.pid} · ${app.path}` }),
    ] });

    card.appendChild(h("div", { style: { display: "flex", alignItems: "center", gap: "13px" }, children: [iconWrap, titleBox] }));

    const p = h("p", { style: { margin: "16px 0 0", font: "var(--t-base)", color: "var(--fg-2)", lineHeight: "1.5" } });
    p.appendChild(document.createTextNode("这将强制结束该应用及其合并的 "));
    p.appendChild(h("b", { style: { color: "var(--fg-1)" }, text: `${app.procs} 个进程` }));
    p.appendChild(document.createTextNode("，未保存的内容可能会丢失。"));
    card.appendChild(p);

    const checkbox = h("span", {
      style: {
        width: "18px", height: "18px", borderRadius: "5px",
        background: s.dontRemind ? "var(--accent)" : "var(--bg-panel)",
        border: s.dontRemind ? "none" : "1px solid var(--border-2)",
        display: "grid", placeItems: "center", flex: "none",
      },
    });
    if (s.dontRemind) checkbox.appendChild(icon("check", 13, { color: "#fff" } as any));
    const label = h("label", {
      style: { display: "flex", alignItems: "center", gap: "9px", marginTop: "16px", cursor: "pointer", userSelect: "none" },
      on: { click: () => {
        s.dontRemind = !s.dontRemind;
        this.bridge.setPref("pk_dont_remind", s.dontRemind ? "1" : "0");
        this.update();
      } },
      children: [checkbox, h("span", { style: { font: "var(--t-sm)", color: "var(--fg-2)" }, text: "以后不再提醒，直接结束进程" })],
    });
    card.appendChild(label);

    const cancelBtn = h("button", {
      style: {
        flex: "1", height: "38px", borderRadius: "9px", background: "var(--bg-panel)",
        border: "1px solid var(--border-2)", color: "var(--fg-1)", font: "var(--t-base)",
        fontWeight: "500", cursor: "pointer", display: "inline-flex", alignItems: "center",
        justifyContent: "center", gap: "7px",
      },
      on: { click: () => { s.dialogApp = null; this.update(); } },
      children: [document.createTextNode("取消 "), kbd("Esc")],
    });
    const killBtn = h("button", {
      style: {
        flex: "1.2", height: "38px", borderRadius: "9px", background: "var(--danger)",
        border: "none", color: "#fff", font: "var(--t-base)", fontWeight: "600",
        cursor: "pointer", display: "inline-flex", alignItems: "center", justifyContent: "center", gap: "7px",
      },
      on: { click: () => this.doKill(app) },
      children: [document.createTextNode("结束进程 "), kbd("⏎")],
    });
    card.appendChild(h("div", { style: { display: "flex", gap: "10px", marginTop: "20px" }, children: [cancelBtn, killBtn] }));

    scrim.appendChild(card);
    return scrim;
  }

  start(): void {
    this.mount();
    this.installKeys();
    this.installUtoolsHooks();
    this.installThemeWatch();
    this.update();
    this.load(true);
  }
}

// 启动
const rootEl = document.getElementById("app")!;
const app = new ProcKillApp(rootEl);
app.start();
// 暴露给调试
(window as any).__prockill = app;
