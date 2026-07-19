# 鹅的监控 · 跨平台进程管理器

键盘优先的「能结束进程的活动监视器」。一份前端，三处运行：**独立桌面应用（Tauri）**、**uTools 插件**、**浏览器预览**。完整复刻 `prockill-design` 设计稿（紧凑专家版 + 行内进程树 + Helper 合并 + uTools 工具栈接入 + 菜单栏 popover）。

> 内部标识符仍沿用 `prockill`（localStorage key、uTools 插件 id、Tauri identifier），仅展示名为「鹅的监控」。

> 灵感来自 [fkill](https://github.com/sindresorhus/fkill)，是它的图形化、按应用分组的版本。视觉参考 macOS 活动监视器 × Raycast × Linear。

## 核心功能

- **按应用分组**：Chrome / VS Code / Electron 等会派生大量 `*/Helper` 子进程，ProcKill 把它们归并到父应用下，汇总 CPU + 内存，列表读起来是你认识的应用而非几十条神秘进程。`␣` / 双击 / `→` 展开查看每个 Helper 的角色 / CPU / 内存 / PID。
- **真实进程数据**：应用图标（占位字形方块）、名称、合并进程数、CPU%、内存、运行路径、PID。
- **分类栏**：`界面应用 / 全部进程 / CPU 占用 / 内存占用 / 网络·端口 / 后台服务`，鼠标点击或 `⌘1–6`（Windows/Linux 用 `Ctrl1–6`）切换；切换后自动选中第一项。
- **排序**：右上角按 内存 / CPU / 进程数 / 名称 升降序。
- **键盘流**：`↑↓` 移动，`←→` 折叠/展开，`⏎` 结束进程，`⌘F` / `/` 搜索，`⌘R` 刷新。
- **首杀确认**：首次按 `⏎` 弹确认框，含「以后不再提醒」复选框；勾选后后续直接结束。结束父进程会连带杀掉其所有合并的子进程（进程树）。

### uTools 模式 · 接入工具栈

- **全局唤起**：在 uTools 主输入框搜 `chrome` / `结束进程` / `内存` 等已注册关键词，鹅的监控作为工具栈命令浮现（关键词见 `utools/plugin.json` 的 `cmds`）。
- **subInput 接管**：进入插件后，uTools 顶部输入框被 `utools.setSubInput` 接管为本插件搜索框（accent 高亮环 +「uTools 输入框已接管」标识）；全局搜索词自动带入（`setSubInputValue`）并实时展开过滤，命中子串用品牌色高亮。
- 实现：`utools/preload.js` 注册 `onPluginEnter`（带词进入）+ `setSubInput`（实时过滤）；前端 `main.ts` 提供 `__prockillEnter` / `__prockillSubInput` 钩子，preload 与页面共享 `window`。

### Tauri 模式 · 菜单栏（状态栏）popover

状态栏图标下挂的 326px popover（无边框 / 透明 / 置顶 / 失焦自动收起），包含以下视图：

- **应用列表**：搜索、键盘/鼠标多选、批量结束和明确的失败反馈。
- **清理线**：按闲置时长展示候选应用，默认关闭；只有用户明确开启后才会自动执行，豁免按稳定应用身份持久化。
- **定时退出**：一次性倒计时和每日/工作日计划；倒计时按真实截止时间计算，系统睡眠后不会漂移。
- **偏好设置**：主题、结束前二次确认和开机自启。

自动清理只接受后端保守标记的真实 GUI 应用。目前 macOS 支持 `/Applications` 与用户 `Applications` 下的 `.app`；Windows/Linux 因缺少可靠窗口身份判断，不会后台自动结束宽泛路径下的进程。手动结束仍可在主窗口和应用列表中使用。

偏好用 `bridge.setPref` 持久化（`pk_tray_*`）；开机自启走 `tauri-plugin-autostart`（命令 `set_autostart`）。

## 架构

「Core + Adapter」分层，同一份前端跑在不同宿主：

```
packages/core/          共享前端（原生 TS，零框架运行时依赖）
  index.html            主窗口入口
  tray.html             菜单栏 popover 窗口入口（Tauri 用 ?popover=1 加载）
  src/
    main.ts             主应用：渲染 + 键盘 + 轮询刷新 + uTools 接管钩子
    tray.ts             菜单栏 popover：应用列表 / 清理线 / 定时退出 / 偏好设置
    atoms.ts            UI 原子：AppIcon / Meter / Kbd / highlight
    shared.ts           分类/格式化/合并辅助（纯逻辑）
    icons.ts            内联 Lucide SVG
    bridge/
      index.ts          环境探测：__TAURI__ → tauri，utools+services → utools，否则 browser
      tauri.ts          Tauri 实现：invoke Rust
      utools.ts         uTools 实现：调 window.services
      browser.ts        浏览器 mock（假数据 + 假关闭，用于预览）
  styles/
    tokens.css          设计 token（深/浅主题，来自设计稿）
    app.css             主窗口外壳：窗口/滚动条/动画
    tray.css            菜单栏 popover 外壳：透明窗 / 桌面场景预览 / 动画

src-tauri/              Tauri 后端（Rust）
  src/
    process.rs          sysinfo 枚举 + Helper 合并 + 系统资源
    kill.rs             kill_tree 杀进程树
    icon.rs             三平台应用图标抓取与缓存
    lib.rs              Tauri 命令 + 常驻 System 后台刷新线程 + 菜单栏 tray 图标/popover/自启

utools/                 uTools 适配
  preload.js            Node 实现进程枚举/合并/kill（ps / PowerShell / pkill / taskkill）
  plugin.json           uTools 插件清单

scripts/build-utools.mjs   组装 uTools 插件目录 utools-dist/
```

特权操作（进程枚举、kill）全部走 bridge 抽象接口 `PlatformBridge`，UI 零改动即可切换宿主。

## 开发 / 构建

```bash
bun install

# 1) 浏览器预览（mock 数据，可演示全部交互）
bun run dev                 # → http://127.0.0.1:5173  （?full=1 铺满，?boxed=1 强制窗框）
                            #   菜单栏 popover 预览：http://127.0.0.1:5173/tray.html（含桌面场景）

# 2) 独立桌面应用（Tauri，真实进程 + 真实 kill）
bun run tauri:dev           # 开发

# 3) uTools 插件
bun run build:utools        # → utools-dist/，在 uTools 开发者工具按目录加载，或打包 .upx
```

### 出安装包（按宿主平台）

Tauri 原生包依赖各自 OS 的打包工具链，**无法跨 OS 交叉编译**，须在对应系统（或 CI runner）上构建。
每条命令带平台守卫，在错误宿主上会直接报错退出并给出指引：

```bash
bun run build:mac           # 在 macOS 上 → .app / .dmg
bun run build:win           # 在 Windows 上 → .exe (NSIS)
bun run build:linux         # 在 Linux  上 → .AppImage / .deb
```

发布全平台包：在 GitHub Actions 用 macOS / windows / linux 三个 runner 分别跑对应命令，再汇总产物（本地单机只能产出当前系统的包）。

## 平台说明

| 能力 | Tauri | uTools |
|---|---|---|
| 进程枚举 | sysinfo | `ps`(mac/Linux) / PowerShell(Win) |
| CPU% | sysinfo 连续采样（准确） | `ps %cpu` / 负载估算 |
| 杀进程树 | kill_tree（Win 用 Win32 API） | `pkill -P` + SIGKILL / `taskkill /T /F` |
| 图标 | sips(mac) / PowerShell+System.Drawing(Win) / hicolor 主题(Linux) | sips(mac)，其余平台字形降级 |
| 偏好持久化 | localStorage | `utools.dbStorage` |
| 菜单栏 popover | tray-icon + 隐藏 tray 窗口 | —（uTools 用工具栈接入替代） |
| 工具栈 / 全局搜索 | —（独立窗口） | `onPluginEnter` + `setSubInput` 接管 |
| 开机自启 | `tauri-plugin-autostart` | uTools 宿主管理 |

uTools preload 运行在 Node 16 CommonJS，源码保持可读（uTools 审核要求，不混淆）。

## 安全与发布约束

- 自动清理默认关闭，必须由用户明确开启；系统/后台进程和未被后端标记为可自动清理的应用始终排除。
- 应用豁免与计划任务保存稳定身份，不保存瞬时 PID。
- 结束请求会在后端用最新进程快照复核分组与 PID，并保护鹅的监控自身及祖先进程，避免 PID 复用或过期列表导致误杀。
- uTools 构建会强制检查 Chromium 108 不支持的现代颜色语法，并验证插件 logo 不超过 256×256。
- `bun run check` 会校验版本一致性、前端逻辑测试和 uTools 构建；Rust 端由三平台 CI 执行格式、测试和 Clippy。
- 当前安装包通过 GitHub Release 直接分发，未配置 Apple Developer ID 公证或 Windows 代码签名时，系统可能显示来源/信誉警告；正式对外发布前需在仓库 Secrets 中接入签名凭据。
- `macOSPrivateApi` 用于透明菜单栏窗口，因此当前构建面向 GitHub/直接分发，不走 Mac App Store。
