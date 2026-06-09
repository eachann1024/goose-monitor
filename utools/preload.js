/* ProcKill uTools preload —— 在 Node 环境实现进程枚举 / 合并 / kill。
   暴露 window.services 给前端 bridge 调用。源码保持可读（uTools 审核要求，不混淆）。 */
const { execSync, execFileSync, execFile } = require("node:child_process");
const { promisify } = require("node:util");
const os = require("node:os");
const path = require("node:path");

const execFileAsync = promisify(execFile);

const IS_WIN = process.platform === "win32";
const IS_MAC = process.platform === "darwin";

// uTools 启动的 Node 进程常继承空 locale（LANG/LC_ALL 为空）。此时 BSD `ps` 会对进程名/路径里
// 的非 ASCII 字节做 vis(3) 转义，把「企业微信」(UTF-8 E4 BC 81…) 字面输出成 `M-dM-<M^A…`，
// 前端直接显示这串乱码。强制一个 UTF-8 locale 即可让 ps 原样透传 UTF-8 字节。
// mac 用一定存在的 en_US.UTF-8；Linux 用更通用的 C.UTF-8。Windows 走 PowerShell，不受影响。
const UNIX_ENV = IS_WIN ? process.env : {
  ...process.env,
  LC_ALL: IS_MAC ? "en_US.UTF-8" : "C.UTF-8",
  LANG: IS_MAC ? "en_US.UTF-8" : "C.UTF-8",
};

// 异步跑 shell 命令（不阻塞事件循环）。失败抛错由调用方兜底。
function shAsync(cmd, args, maxBuffer) {
  return execFileAsync(cmd, args, {
    encoding: "utf8",
    maxBuffer: maxBuffer || 32 * 1024 * 1024,
    env: UNIX_ENV,
  }).then((r) => r.stdout);
}

const PALETTE = [
  "#4488F4", "#2C8FE0", "#A259FF", "#5A1F5C", "#2496ED", "#1DB954", "#3A3A3A", "#2BB673",
  "#FA4D6A", "#26A2F0", "#F5B544", "#3FB6C9", "#9B8CFF", "#F2555A", "#3DD68C",
];
function colorFor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}
function monogramFor(name) {
  const cleaned = name.replace(/\.(app|exe)$/i, "").trim();
  const words = cleaned.split(/[\s\-_]+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  const w = words[0] || cleaned;
  return w.slice(0, w.length >= 2 ? 2 : 1);
}
function inferRole(procName, isMain) {
  if (isMain) return "主进程";
  const n = procName.toLowerCase();
  if (n.includes("gpu")) return "GPU";
  if (n.includes("renderer")) return "渲染进程";
  if (n.includes("plugin") || n.includes("extension")) return "扩展宿主";
  if (n.includes("network")) return "网络服务";
  if (n.includes("crashpad") || n.includes("crash")) return "崩溃监控";
  if (n.includes("utility")) return "工具进程";
  if (n.includes("helper")) return "辅助进程";
  return "子进程";
}
function appBundle(exe) {
  if (!exe) return null;
  const idx = exe.indexOf(".app/");
  if (idx >= 0) {
    const bundle = exe.slice(0, idx + 4);
    return { bundle, name: path.basename(bundle, ".app") };
  }
  if (exe.endsWith(".app")) return { bundle: exe, name: path.basename(exe, ".app") };
  return null;
}
function isSystemPath(exe, name) {
  if (!exe) return true;
  if (name === "kernel_task") return true;
  if (IS_WIN) return /\\windows\\/i.test(exe) || /\\system32\\/i.test(exe);
  // mac / linux 系统守护进程目录（与 src-tauri/src/process.rs is_system_path 对齐）
  return exe.startsWith("/usr/sbin/") || exe.startsWith("/usr/libexec/") ||
    exe.startsWith("/sbin/") || exe.startsWith("/System/") ||
    exe.startsWith("/Library/") || exe.startsWith("/lib/") || exe.startsWith("/bin/");
}

// 判断是否界面应用（与 src-tauri/src/process.rs is_gui 对齐）。
// 关键：macOS 大量系统守护进程也住在 .app bundle 内（如 XProtect、liquiddetectiond、
// com.apple.* 的 XPC/扩展服务），但它们装在 /System/、/Library/、/usr/ 下，并非用户应用。
// 仅凭 .app 子串匹配会把它们误判为界面应用 → 漏进 gui 列表。故系统/库目录下的 .app
// 一律不算用户 GUI 应用。
function isGui(exe) {
  if (!exe) return false;
  if (exe.includes(".app/") || exe.endsWith(".app")) {
    const inSystemDir = exe.startsWith("/System/") ||
      exe.startsWith("/Library/") || exe.startsWith("/usr/");
    return !inSystemDir;
  }
  if (IS_WIN) {
    const low = exe.toLowerCase();
    return low.includes("\\program files") ||
      (low.endsWith(".exe") && (low.includes("\\users\\") || low.includes("\\appdata\\")));
  }
  // Linux 界面应用常见安装位置，排除工具链/CLI 常驻的 .../bin/ 目录。
  const isToolchain = exe.includes("/bin/") &&
    (exe.includes("homebrew") || exe.includes("/rh/") || exe.includes("/node") ||
     exe.includes("python") || exe.includes("ruby"));
  if (isToolchain) return false;
  return exe.includes("/snap/") || exe.includes("/opt/") ||
    exe.includes("/.local/share/applications") || exe.includes("/usr/share/applications");
}

/* ---- 真实应用图标抓取（与 Tauri src-tauri/src/icon.rs 同源逻辑的 Node 版）----
   macOS：定位 .app bundle → 读 Info.plist 的 CFBundleIconFile（PlistBuddy）→ sips 转
          64×64 PNG → base64 data URL，交前端 <img> 显示真实图标；失败缓存 null 降级字形方块。
   Windows / Linux：暂未实现真实抓取，缓存 null 降级。
   缓存按 bundle/exe 路径去重，含「已失败」负缓存，避免每次刷新重复跑 sips（开销大）。 */
const fs = require("node:fs");
const ICON_CACHE = new Map(); // path -> data URL | null（null=已尝试且失败）

function bundleRootMac(p) {
  if (!p) return null;
  const idx = p.indexOf(".app/");
  if (idx >= 0) return p.slice(0, idx + 4);
  if (p.endsWith(".app")) return p;
  return null;
}

// 在 bundle 内定位主图标 .icns：① 读 Info.plist 的 CFBundleIconFile；② 退化为 Resources 下第一个 .icns。
async function locateIcns(bundle) {
  const resources = path.join(bundle, "Contents/Resources");
  const plist = path.join(bundle, "Contents/Info.plist");
  if (fs.existsSync(plist)) {
    try {
      const name = (await shAsync("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleIconFile", plist], 1 << 20)).trim();
      if (name) {
        const fname = /\.icns$/i.test(name) ? name : name + ".icns";
        const candidate = path.join(resources, fname);
        if (fs.existsSync(candidate)) return candidate;
      }
    } catch (_) { /* 无该键或解析失败，走退化 */ }
  }
  try {
    for (const f of fs.readdirSync(resources)) {
      if (/\.icns$/i.test(f)) return path.join(resources, f);
    }
  } catch (_) { /* Resources 不存在 */ }
  return null;
}

// 临时文件名唯一序号：缓存检查与抓取之间存在窗口，同一 icns 可能被并发抓取两次，
// 唯一序号保证各写各的临时文件，避免并发 sips 写同一文件互相污染读到半截 PNG。
let TMP_SEQ = 0;

// 用系统 sips 把 .icns 转 64×64 PNG 临时文件，读回 base64（sips 不支持写 stdout）。
async function icnsToDataUrl(icns) {
  const tmp = path.join(os.tmpdir(), "prockill-icon-" + simpleHash(icns) + "-" + (TMP_SEQ++) + ".png");
  try {
    await shAsync("sips", ["-s", "format", "png", "-z", "64", "64", icns, "--out", tmp], 1 << 20);
    const buf = fs.readFileSync(tmp);
    return "data:image/png;base64," + buf.toString("base64");
  } catch (_) {
    return null;
  } finally {
    try { fs.unlinkSync(tmp); } catch (_) {}
  }
}

function simpleHash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

// 取一个应用路径的真实图标 data URL，命中缓存（含负缓存）即返回。失败返回 null。
async function iconDataUrl(appPath) {
  if (!appPath) return null;
  if (ICON_CACHE.has(appPath)) return ICON_CACHE.get(appPath);
  let result = null;
  if (IS_MAC) {
    const bundle = bundleRootMac(appPath);
    if (bundle) {
      const icns = await locateIcns(bundle);
      if (icns) result = await icnsToDataUrl(icns);
    }
  }
  // Windows 可用 win-icon-extractor，Linux 解析 .desktop + 主题图标（后续）。
  ICON_CACHE.set(appPath, result);
  return result;
}

// 给一批行并发补充真实图标（仅 GUI/非 sys 行；sys 行用字形方块即可）。
// 已带缓存，重复刷新基本零开销；首轮并发抓取，单个失败不影响其它行。
async function attachIcons(rows) {
  if (!IS_MAC) return rows; // 目前仅 macOS 抓真实图标
  await Promise.all(rows.map(async (r) => {
    if (r.sys) return;
    const url = await iconDataUrl(r.path);
    if (url) r.iconUrl = url;
  }));
  return rows;
}

/* ---- 采集原始进程（异步，不阻塞事件循环）---- */
async function rawProcsUnix() {
  // macOS 的 `-o comm=` 输出干净的完整可执行路径（含 .app/），单列即可。
  // Linux 的 `comm` 截断成短名，所以额外取 `args`（完整命令行）拿路径：
  //   name 用 comm（稳定短名），exe 用 args 整串（含路径，路径带空格也不丢，
  //   因为 appBundle/is_gui 都是子串匹配，不依赖精确切分）。
  if (IS_MAC) {
    const out = await shAsync("ps", ["-axwwo", "pid=,ppid=,pcpu=,rss=,comm="], 32 * 1024 * 1024);
    const list = [];
    for (const line of out.split("\n")) {
      const m = line.match(/^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(.*)$/);
      if (!m) continue;
      const exe = m[5].trim();
      list.push({
        pid: +m[1], ppid: +m[2], cpu: parseFloat(m[3]) || 0,
        memMb: (+m[4]) / 1024, exe, name: path.basename(exe) || exe,
      });
    }
    return list;
  }
  // Linux：comm 在前（无空格短名），args 在后（含路径的完整命令行）
  const out = await shAsync("ps", ["-axwwo", "pid=,ppid=,pcpu=,rss=,comm=,args="], 32 * 1024 * 1024);
  const list = [];
  for (const line of out.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    if (!m) continue;
    const name = m[5].trim();           // comm，稳定短名
    const exe = (m[6] || "").trim() || name; // args 整串，保留路径（含空格）
    list.push({
      pid: +m[1], ppid: +m[2], cpu: parseFloat(m[3]) || 0,
      memMb: (+m[4]) / 1024, exe, name,
    });
  }
  return list;
}
async function rawProcsWin() {
  // 进程基础信息（路径/父子/内存）来自 Win32_Process；
  // CPU% 来自 Win32_PerfFormattedData_PerfProc_Process 的 PercentProcessorTime（已格式化，
  // 无需两次采样），按 IDProcess 关联。再除以逻辑核数归一到 0-100。
  const ps = [
    // 强制 stdout 为 UTF-8：否则 Win PowerShell 默认用控制台代码页（如 GBK/936）输出，
    // 中文进程名（如「企业微信」）的 UTF-8 字节会被 Node 的 utf8 解码读成乱码
    // （表现为 M-dM-<M-^A… 这类 latin1 风格高位字节）。与下方 shAsync 的 encoding:"utf8" 对齐。
    // try/catch：stdout 被重定向到管道（execFile 即如此）时，PS 5.x 设 OutputEncoding 可能抛
    // 「handle is invalid」，吞掉即可，不让采集整体失败。
    "try { [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false) } catch {};",
    "$OutputEncoding = [Text.UTF8Encoding]::new($false);",
    "$cores = (Get-CimInstance Win32_ComputerSystem).NumberOfLogicalProcessors;",
    "if (-not $cores) { $cores = 1 }",
    "$perf = @{};",
    // 排除 _Total / Idle 伪实例（IDProcess=0，值为 ~100*cores），避免污染真实进程
    "Get-CimInstance Win32_PerfFormattedData_PerfProc_Process | Where-Object { $_.IDProcess -gt 0 } | ForEach-Object { $perf[[int]$_.IDProcess] = [double]$_.PercentProcessorTime };",
    "Get-CimInstance Win32_Process | ForEach-Object {",
    "  $c = $perf[[int]$_.ProcessId]; if (-not $c) { $c = 0 }",
    "  [pscustomobject]@{ pid=$_.ProcessId; ppid=$_.ParentProcessId; mem=$_.WorkingSetSize; exe=$_.ExecutablePath; name=$_.Name; cpu=[math]::Round($c / $cores, 1) }",
    "} | ConvertTo-Json -Compress",
  ].join(" ");
  const out = await shAsync("powershell", ["-NoProfile", "-Command", ps], 64 * 1024 * 1024);
  let arr = JSON.parse(out);
  if (!Array.isArray(arr)) arr = [arr];
  return arr.map((p) => ({
    pid: p.pid, ppid: p.ppid || 0, cpu: p.cpu || 0,
    memMb: (p.mem || 0) / 1024 / 1024,
    exe: p.exe || "", name: p.name || "",
  }));
}
async function rawProcs() {
  try {
    return IS_WIN ? await rawProcsWin() : await rawProcsUnix();
  } catch (e) {
    console.error("[ProcKill] rawProcs failed", e);
    return [];
  }
}

/* ---- 合并 ---- */
function merge(raw) {
  const groups = new Map();
  for (const p of raw) {
    const ab = appBundle(p.exe);
    // gui：分组键命中 app bundle 即视为界面进程候选（与后端 collect_raw 一致，
    // 系统目录下 .app 的最终排除交由 listByCategory 的 isGui 把关）；否则按 exe 路径判定。
    let key, display, bundle, gui;
    if (ab) { key = "app:" + ab.bundle; display = ab.name; bundle = ab.bundle; gui = true; }
    else if (p.exe) { key = "exe:" + p.exe; display = p.name; bundle = p.exe; gui = isGui(p.exe); }
    else { key = "name:" + p.name; display = p.name; bundle = ""; gui = false; }
    // 后端口径：is_sys = is_system_path && !gui（住在系统目录但属界面应用的不算系统进程）
    const sys = isSystemPath(p.exe, p.name) && !gui;
    if (!groups.has(key)) groups.set(key, { display, bundle, members: [], sys });
    groups.get(key).members.push(p);
  }
  const rows = [];
  for (const g of groups.values()) {
    if (!g.members.length) continue;
    g.members.sort((a, b) => b.memMb - a.memMb);
    const main = g.members[0];
    const totalCpu = g.members.reduce((a, m) => a + m.cpu, 0);
    const totalMem = g.members.reduce((a, m) => a + m.memMb, 0);
    const allPids = g.members.map((m) => m.pid);
    const helpers = g.members.length > 1
      ? g.members.map((m, i) => ({
          name: m.name, role: inferRole(m.name, i === 0),
          cpu: Math.round(m.cpu * 10) / 10, mem: m.memMb, pid: m.pid,
        }))
      : [];
    rows.push({
      id: "g" + main.pid, name: g.display,
      monogram: monogramFor(g.display), color: colorFor(g.display),
      procs: g.members.length,
      cpu: Math.round(totalCpu * 10) / 10, mem: totalMem,
      pid: main.pid, path: g.bundle || main.exe,
      helpers, sys: g.sys || undefined, allPids,
    });
  }
  return rows;
}

// 采集监听端口 → { pid: port }。mac/linux 用 lsof，win 用 netstat。
async function listenPorts() {
  const map = new Map();
  try {
    if (IS_WIN) {
      const out = await shAsync("netstat", ["-ano", "-p", "TCP"]);
      for (const line of out.split("\n")) {
        const m = line.match(/^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/i);
        if (m) { const pid = +m[2]; if (!map.has(pid)) map.set(pid, m[1]); }
      }
    } else {
      const out = await shAsync("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN"]);
      for (const line of out.split("\n")) {
        // 格式: COMMAND PID USER ... NAME(*:5173 (LISTEN))
        const m = line.match(/^\S+\s+(\d+)\s+.*:(\d+)\s+\(LISTEN\)/);
        if (m) { const pid = +m[1]; if (!map.has(pid)) map.set(pid, m[2]); }
      }
    }
  } catch (_) { /* lsof/netstat 缺失或无权限，端口为空 */ }
  return map;
}

async function listByCategory(category) {
  let rows = merge(await rawProcs());

  if (category === "net") {
    // 关联监听端口：组内任一 pid 在监听表里则标 port，只保留这些行
    const ports = await listenPorts();
    const withPort = [];
    for (const r of rows) {
      const pids = r.allPids && r.allPids.length ? r.allPids : [r.pid];
      const hit = pids.find((p) => ports.has(p));
      if (hit != null) { r.port = ports.get(hit); withPort.push(r); }
    }
    withPort.sort((a, b) => (+a.port) - (+b.port));
    return await attachIcons(withPort);
  }

  if (category === "gui") {
    // 与 src-tauri/src/process.rs list_by_category 对齐：界面应用 = isGui(路径) 且非系统进程。
    // 不再用宽松的 /\.app/ 子串匹配——系统守护进程（com.apple.* 等）也住在 .app 内，
    // isGui 已据系统目录把它们排除，绕过去会把它们漏回 gui 列表。
    rows = rows.filter((r) => isGui(r.path) && !r.sys);
  } else if (category === "bg") {
    rows = rows.filter((r) => r.sys);
  } else if (category === "cpu") {
    rows.sort((a, b) => b.cpu - a.cpu);
    return await attachIcons(rows);
  }
  rows.sort((a, b) => b.mem - a.mem);
  return await attachIcons(rows);
}

// macOS 下 os.freemem() 不含可回收缓存，显示会几乎占满；改用 vm_stat 更准。
async function macMemUsedMb(totalMb) {
  try {
    const out = await shAsync("vm_stat", []);
    const page = (out.match(/page size of (\d+)/) || [])[1];
    const pageSize = page ? +page : 4096;
    const get = (re) => { const m = out.match(re); return m ? +m[1] : 0; };
    const free = get(/Pages free:\s+(\d+)/);
    const inactive = get(/Pages inactive:\s+(\d+)/);
    const speculative = get(/Pages speculative:\s+(\d+)/);
    const purgeable = get(/Pages purgeable:\s+(\d+)/);
    // 可用 = 空闲 + 不活跃 + 推测 + 可清除
    const availablePages = free + inactive + speculative + purgeable;
    const availableMb = (availablePages * pageSize) / 1024 / 1024;
    return Math.max(0, totalMb - availableMb);
  } catch (_) {
    return totalMb - os.freemem() / 1024 / 1024;
  }
}

async function systemStats() {
  const total = os.totalmem() / 1024 / 1024;
  const cpus = os.cpus();
  // os.loadavg 在 Win 无效；用 1 分钟负载估算占用率（Unix）
  let cpuPercent = 0;
  if (!IS_WIN) {
    const load = os.loadavg()[0];
    cpuPercent = Math.min(100, (load / cpus.length) * 100);
  }
  let memUsed;
  if (IS_MAC) memUsed = await macMemUsedMb(total);
  else memUsed = total - os.freemem() / 1024 / 1024;
  return {
    cpuPercent: Math.round(cpuPercent * 10) / 10,
    memUsedMb: memUsed,
    memTotalMb: total,
  };
}

// 递归收集 pid 的所有后代（Unix；用一次 ps 建父子表，避免 pkill -P 只杀一层）。
function descendantsUnix(rootPids) {
  let childMap = new Map();
  try {
    const out = execSync("ps -axo pid=,ppid=", { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    for (const line of out.split("\n")) {
      const m = line.match(/^\s*(\d+)\s+(\d+)/);
      if (!m) continue;
      const pid = +m[1], ppid = +m[2];
      if (!childMap.has(ppid)) childMap.set(ppid, []);
      childMap.get(ppid).push(pid);
    }
  } catch (_) {}
  const result = new Set();
  const stack = [...rootPids];
  while (stack.length) {
    const p = stack.pop();
    if (result.has(p)) continue;
    result.add(p);
    for (const c of childMap.get(p) || []) if (!result.has(c)) stack.push(c);
  }
  return [...result];
}

function killProcess(pid, pids) {
  const SELF = process.pid;
  let targets = (pids && pids.length) ? pids : [pid];
  // 防自杀 + 保护关键系统进程（PID 0/1）
  targets = targets.filter((p) => p !== SELF && p > 1);
  if (!targets.length) {
    return { ok: false, killed: [], error: "目标为空（已排除自身或受保护的系统进程）" };
  }

  const killed = [];
  let lastErr = null;

  if (IS_WIN) {
    for (const p of targets) {
      try {
        // taskkill /T 递归杀进程树
        execFileSync("taskkill", ["/T", "/F", "/PID", String(p)], { stdio: "ignore" });
        killed.push(p);
      } catch (e) {
        lastErr = String((e && e.message) || e);
      }
    }
  } else {
    // 先递归展开整棵树，再统一 SIGKILL（与 Tauri 的 kill_tree 行为对齐）
    const all = descendantsUnix(targets).filter((p) => p !== SELF && p > 1);
    // 先杀子后杀父，减少重新派生
    all.sort((a, b) => b - a);
    for (const p of all) {
      try {
        process.kill(p, "SIGKILL");
        killed.push(p);
      } catch (e) {
        // ESRCH（已退出）也算目标不在
        if (e && e.code === "ESRCH") killed.push(p);
        else lastErr = String((e && e.message) || e);
      }
    }
  }

  if (!killed.length) return { ok: false, killed, error: lastErr || "没有进程被结束（可能权限不足）" };
  return { ok: true, killed };
}

window.services = {
  listProcesses: (category) => Promise.resolve(listByCategory(category)),
  systemStats: () => Promise.resolve(systemStats()),
  killProcess: (pid, pids) => Promise.resolve(killProcess(pid, pids)),
};

/* ============================================================
   uTools 接入层（仅在 uTools 环境生效，开发态/普通浏览器自动跳过）
   - 监听插件进入：把主输入框带进来的关键词交给前端，触发自动展开搜索框 + 过滤
   - 接管 uTools 子输入框：用户在 uTools 顶部输入框打字 → 实时过滤前端列表
   前端契约（main.ts 实现，挂在 window 上）：
     · window.__prockillEnter(keyword: string)   —— 进入时调用一次，keyword 为初始搜索词（无词时传 ""），期望：展开搜索框并按 keyword 过滤
     · window.__prockillSubInput(text: string)    —— uTools 子输入框每次变化时调用，期望：把 text 同步到搜索框并实时过滤
   注意：preload 与插件页面共享同一个 window，故可直接读写 window.__prockill*。
   ============================================================ */
(function setupUtoolsBridge() {
  // 非 uTools 环境（开发态）utools 不存在，直接返回，不报错
  if (typeof utools === "undefined" || !utools) return;

  // 从带前缀的指令文本里剥出真正的搜索词。
  // 例："杀进程 chrome" -> "chrome"；"prockill: 1234" -> "1234"。
  // 若没有可识别前缀（理论上 regex 已保证有前缀），则原样返回去掉首尾空白。
  function extractKeyword(payload) {
    if (typeof payload !== "string") return "";
    const text = payload.trim();
    // 与 plugin.json 中 prockill-search 的 regex 前缀保持一致
    const m = text.match(/^(?:杀进程|结束进程|进程|内存|prockill|pk|kill)[\s:：]+(\S.*)$/i);
    return (m ? m[1] : text).trim();
  }

  // 把初始关键词交给前端：展开搜索框并过滤。前端钩子可能晚于 preload 注册，
  // 故做一次轮询重试，命中即停（最多约 3 秒），避免进入瞬间钩子尚未挂载而丢词。
  // 用单一 timer + pending 关键词：多次快速进入只保留最后一次，避免并存的多个 timer
  // 让旧关键词在新关键词之后触发、反写出错误状态。
  var enterTimer = null;
  var pendingKeyword = "";
  function pushEnterKeyword(keyword) {
    pendingKeyword = keyword;
    // 钩子已就绪（多数情况：插件已打开后再次带词进入）→ 立即同步调用，无 100ms 延迟
    if (typeof window.__prockillEnter === "function") {
      if (enterTimer !== null) { clearInterval(enterTimer); enterTimer = null; }
      try { window.__prockillEnter(pendingKeyword); } catch (e) { console.error("[ProcKill] __prockillEnter 调用失败", e); }
      return;
    }
    if (enterTimer !== null) return; // 已有 timer 在跑，它会消费最新的 pendingKeyword
    let tries = 0;
    enterTimer = setInterval(() => {
      tries += 1;
      if (typeof window.__prockillEnter === "function") {
        try { window.__prockillEnter(pendingKeyword); } catch (e) { console.error("[ProcKill] __prockillEnter 调用失败", e); }
        clearInterval(enterTimer); enterTimer = null;
      } else if (tries >= 30) {
        clearInterval(enterTimer); enterTimer = null;
      }
    }, 100);
  }

  // 接管 uTools 顶部子输入框为我们的搜索框：顶部输入 → 实时过滤前端列表。
  // 关键：setSubInput 必须在 onPluginEnter 回调内调用、且每次进入都重新设置——
  // uTools 的机制是"进入插件后主输入框才变子输入框"，在 IIFE 顶层提前注册不可靠，
  // 会导致子输入框不显示（参考 goose-note preload.cjs 的实现）。第三参 true=聚焦。
  function installSubInput() {
    if (typeof utools.setSubInput !== "function") return;
    try {
      utools.setSubInput(({ text }) => {
        if (typeof window.__prockillSubInput === "function") {
          try { window.__prockillSubInput(text || ""); } catch (e) { console.error("[ProcKill] __prockillSubInput 调用失败", e); }
        }
      }, "过滤应用或进程…", true);
    } catch (e) {
      console.error("[ProcKill] setSubInput 失败", e);
    }
  }

  // 监听插件进入：text（关键词/无参进入）→ 空词仅展开；regex/over（带词进入）→ 带搜索词
  if (typeof utools.onPluginEnter === "function") {
    utools.onPluginEnter((entry) => {
      // 每次进入都重新接管子输入框（uTools 退出/再进会清掉上次的 subInput）
      installSubInput();
      // 兜底：个别 uTools 版本/异常路径可能传 undefined/null，避免解构直接抛错导致接入失效。
      const { type, payload } = entry || {};
      const keyword = (type === "regex" || type === "over") ? extractKeyword(payload) : "";
      pushEnterKeyword(keyword);
      // 带词进入时预填 uTools 子输入框，让顶部输入框与列表过滤状态一致
      if (keyword && typeof utools.setSubInputValue === "function") {
        try { utools.setSubInputValue(keyword); } catch (e) { /* 子输入框可能尚未就绪，忽略 */ }
      }
    });
  } else {
    // 极少数无 onPluginEnter 的环境，退化为顶层注册一次
    installSubInput();
  }

  // 插件退出时移除子输入框接管，避免残留到其它插件/主界面
  if (typeof utools.onPluginOut === "function") {
    utools.onPluginOut(() => {
      if (typeof utools.removeSubInput === "function") {
        try { utools.removeSubInput(); } catch (e) { /* 忽略 */ }
      }
    });
  }
})();
