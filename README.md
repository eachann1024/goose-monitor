# ProcKill · 跨平台进程管理器

键盘优先的「能结束进程的活动监视器」。一份前端，三处运行：**独立桌面应用（Tauri）**、**uTools 插件**、**浏览器预览**。完整复刻 `prockill-utools-design-system` 设计稿（紧凑专家版 + 行内进程树 + Helper 合并）。

> 灵感来自 [fkill](https://github.com/sindresorhus/fkill)，是它的图形化、按应用分组的版本。视觉参考 macOS 活动监视器 × Raycast × Linear。

## 核心功能

- **按应用分组**：Chrome / VS Code / Electron 等会派生大量 `*/Helper` 子进程，ProcKill 把它们归并到父应用下，汇总 CPU + 内存，列表读起来是你认识的应用而非几十条神秘进程。`␣` / 双击 / `→` 展开查看每个 Helper 的角色 / CPU / 内存 / PID。
- **真实进程数据**：应用图标（占位字形方块）、名称、合并进程数、CPU%、内存、运行路径、PID。
- **分类栏**：`界面应用 / 全部进程 / CPU 占用 / 内存占用 / 网络·端口 / 后台服务`，鼠标点击或 `⌘1–6`（Windows/Linux 用 `Ctrl1–6`）切换；切换后自动选中第一项。
- **排序**：右上角按 内存 / CPU / 进程数 / 名称 升降序。
- **键盘流**：`↑↓` 移动，`←→` 折叠/展开，`⏎` 结束进程，`⌘F` / `/` 搜索，`⌘R` 刷新。
- **首杀确认**：首次按 `⏎` 弹确认框，含「以后不再提醒」复选框；勾选后后续直接结束。结束父进程会连带杀掉其所有合并的子进程（进程树）。

## 架构

「Core + Adapter」分层，同一份前端跑在不同宿主：

```
packages/core/          共享前端（原生 TS，零框架运行时依赖）
  src/
    main.ts             主应用：渲染 + 键盘 + 轮询刷新
    atoms.ts            UI 原子：AppIcon / Meter / Kbd
    shared.ts           分类/格式化/合并辅助（纯逻辑）
    icons.ts            内联 Lucide SVG
    bridge/
      index.ts          环境探测：__TAURI__ → tauri，utools+services → utools，否则 browser
      tauri.ts          Tauri 实现：invoke Rust
      utools.ts         uTools 实现：调 window.services
      browser.ts        浏览器 mock（假数据 + 假关闭，用于预览）
  styles/
    tokens.css          设计 token（深/浅主题，来自设计稿）
    app.css             窗口/滚动条/动画

src-tauri/              Tauri 后端（Rust）
  src/
    process.rs          sysinfo 枚举 + Helper 合并 + 系统资源
    kill.rs             kill_tree 杀进程树
    icon.rs             图标抓取（预留接口）
    lib.rs              Tauri 命令 + 常驻 System 后台刷新线程

utools/                 uTools 适配
  preload.js            Node 实现进程枚举/合并/kill（ps / PowerShell / pkill / taskkill）
  plugin.json           uTools 插件清单

scripts/build-utools.mjs   组装 uTools 插件目录 utools-dist/
```

特权操作（进程枚举、kill）全部走 bridge 抽象接口 `PlatformBridge`，UI 零改动即可切换宿主。

## 开发 / 构建

```bash
npm install

# 1) 浏览器预览（mock 数据，可演示全部交互）
npm run dev                 # → http://127.0.0.1:5173  （?full=1 铺满，?boxed=1 强制窗框）

# 2) 独立桌面应用（Tauri，真实进程 + 真实 kill）
npm run tauri:dev           # 开发
npm run tauri:build         # 出安装包（.dmg / .msi / .deb / .AppImage）

# 3) uTools 插件
npm run utools:build        # → utools-dist/，在 uTools 开发者工具按目录加载，或打包 .upx
```

## 平台说明

| 能力 | Tauri | uTools |
|---|---|---|
| 进程枚举 | sysinfo | `ps`(mac/Linux) / PowerShell(Win) |
| CPU% | sysinfo 连续采样（准确） | `ps %cpu` / 负载估算 |
| 杀进程树 | kill_tree（Win 用 Win32 API） | `pkill -P` + SIGKILL / `taskkill /T /F` |
| 图标 | 预留（NSWorkspace / win-icon-extractor） | 可用 Electron nativeImage |
| 偏好持久化 | localStorage | `utools.dbStorage` |

uTools preload 运行在 Node 16 CommonJS，源码保持可读（uTools 审核要求，不混淆）。
