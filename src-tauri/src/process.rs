//! 进程枚举 + Helper 合并 + 系统资源统计。
//! 跨平台：sysinfo 提供 pid/ppid/name/cpu/mem/exe。合并策略按"应用分组"，
//! 把 Electron Helper / 子进程归并到代表进程下，汇总 CPU + 内存。

use serde::Serialize;
use std::collections::HashMap;
use std::path::Path;
use std::time::Instant;
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, RefreshKind, System};

/// 低占用阈值：CPU 严格低于此值视为「空闲」。
const IDLE_CPU_THRESHOLD: f32 = 1.0;

/// 进程空闲时长追踪器：记录每个 pid 自上次「活跃（CPU>=阈值）」以来的起点。
/// 由后台刷新线程每秒调一次 `update`；`idle_minutes` 查询某 pid 已空闲多久。
/// pid 复用风险可接受：复用后 CPU 一旦活跃即清零，最坏只是少清理一轮。
#[derive(Default)]
pub struct IdleTracker {
    /// pid -> 进入低占用的起始时刻（仍处于低占用才有值）。
    since: HashMap<u32, Instant>,
}

impl IdleTracker {
    pub fn new() -> Self {
        Self { since: HashMap::new() }
    }

    /// 用最新一轮进程快照推进空闲计时：
    /// - CPU < 阈值且此前无记录 → 记下当前时刻为空闲起点；
    /// - CPU >= 阈值 → 移除记录（重新活跃）；
    /// - 已消失的 pid → 清理。
    pub fn update(&mut self, sys: &System) {
        let now = Instant::now();
        let mut alive: std::collections::HashSet<u32> = std::collections::HashSet::new();
        for (pid, p) in sys.processes() {
            let id = pid.as_u32();
            alive.insert(id);
            if p.cpu_usage() < IDLE_CPU_THRESHOLD {
                self.since.entry(id).or_insert(now);
            } else {
                self.since.remove(&id);
            }
        }
        // 清掉已退出的进程，避免 map 无限增长
        self.since.retain(|pid, _| alive.contains(pid));
    }

    /// 某 pid 已连续空闲的分钟数（无记录即 0）。
    pub fn idle_minutes(&self, pid: u32) -> f64 {
        match self.since.get(&pid) {
            Some(t) => t.elapsed().as_secs_f64() / 60.0,
            None => 0.0,
        }
    }
}

/// 子进程明细（合并展示用）。
#[derive(Serialize, Clone)]
pub struct Helper {
    pub name: String,
    pub role: String,
    pub cpu: f32,
    pub mem: f64, // MB
    pub pid: u32,
}

/// 一行 = 一个应用 / 进程组。字段与前端 AppRow 对齐。
#[derive(Serialize, Clone)]
pub struct AppRow {
    pub id: String,
    pub name: String,
    pub monogram: String,
    pub color: String,
    pub procs: u32,
    pub cpu: f32,
    pub mem: f64, // MB
    pub pid: u32,
    pub path: String,
    /// 用于提取应用图标的真实可执行文件路径。
    ///
    /// Windows 应用会按可执行文件所在目录分组，`path` 因而可能是目录；图标提取器则必须
    /// 收到 `.exe`。此字段只供 Rust 后端使用，不暴露给前端。
    #[serde(skip)]
    #[allow(dead_code)] // examples 只验证序列化契约，不执行 lib.rs 中的图标提取流程
    pub(crate) icon_source_path: String,
    pub helpers: Vec<Helper>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sys: Option<bool>,
    #[serde(rename = "iconUrl", skip_serializing_if = "Option::is_none")]
    pub icon_url: Option<String>,
    #[serde(rename = "allPids")]
    pub all_pids: Vec<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub port: Option<String>,
    /// 该进程组连续低占用（CPU<1%）的累计分钟数。供「自动清理」判断空闲时长。
    /// 取组内成员中最小者（任一成员活跃即视为整组未空闲），保守不误伤。
    #[serde(rename = "idleMinutes")]
    pub idle_minutes: f64,
}

#[derive(Serialize, Clone)]
pub struct SystemStats {
    #[serde(rename = "cpuPercent")]
    pub cpu_percent: f32,
    #[serde(rename = "memUsedMb")]
    pub mem_used_mb: f64,
    #[serde(rename = "memTotalMb")]
    pub mem_total_mb: f64,
}

/// 一个原始进程的精简视图。
struct RawProc {
    pid: u32,
    #[allow(dead_code)] // 预留：父子关系精细合并
    ppid: u32,
    name: String,
    exe: String,
    cpu: f32,
    mem_mb: f64,
}

/// 调色板（与前端 colorFor 一致，保证同名同色）。
const PALETTE: [&str; 15] = [
    "#4488F4", "#2C8FE0", "#A259FF", "#5A1F5C", "#2496ED", "#1DB954", "#3A3A3A", "#2BB673",
    "#FA4D6A", "#26A2F0", "#F5B544", "#3FB6C9", "#9B8CFF", "#F2555A", "#3DD68C",
];

fn color_for(name: &str) -> String {
    let mut h: u32 = 0;
    for b in name.bytes() {
        h = h.wrapping_mul(31).wrapping_add(b as u32);
    }
    PALETTE[(h as usize) % PALETTE.len()].to_string()
}

fn monogram_for(name: &str) -> String {
    let cleaned = name
        .trim_end_matches(".app")
        .trim_end_matches(".exe")
        .trim();
    let words: Vec<&str> = cleaned.split([' ', '-', '_']).filter(|w| !w.is_empty()).collect();
    if words.len() >= 2 {
        let a = words[0].chars().next().unwrap_or('?');
        let b = words[1].chars().next().unwrap_or('?');
        return format!("{}{}", a, b).to_uppercase();
    }
    let w = words.first().copied().unwrap_or(cleaned);
    let chars: Vec<char> = w.chars().collect();
    if chars.len() >= 2 {
        chars[..2].iter().collect()
    } else {
        chars.iter().collect()
    }
}

fn infer_role(proc_name: &str, is_main: bool) -> String {
    if is_main {
        return "主进程".to_string();
    }
    let n = proc_name.to_lowercase();
    if n.contains("gpu") {
        "GPU"
    } else if n.contains("renderer") {
        "渲染进程"
    } else if n.contains("plugin") || n.contains("extension") {
        "扩展宿主"
    } else if n.contains("network") {
        "网络服务"
    } else if n.contains("crashpad") || n.contains("crash") {
        "崩溃监控"
    } else if n.contains("utility") {
        "工具进程"
    } else if n.contains("helper") {
        "辅助进程"
    } else {
        "子进程"
    }
    .to_string()
}

/// 从可执行路径提取 macOS .app bundle 根（用于把 Helper 归并到主应用）。
/// 例：/Applications/Google Chrome.app/Contents/Frameworks/.../Chrome Helper
///  → /Applications/Google Chrome.app ，显示名 "Google Chrome"
fn app_bundle(exe: &str) -> Option<(String, String)> {
    // 找到最外层 ".app" 段
    if let Some(idx) = exe.find(".app/") {
        let bundle = &exe[..idx + 4]; // 含 .app
        let name = Path::new(bundle)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("App")
            .to_string();
        return Some((bundle.to_string(), name));
    }
    if exe.ends_with(".app") {
        let name = Path::new(exe)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("App")
            .to_string();
        return Some((exe.to_string(), name));
    }
    // Windows：Electron 应用（Slack/VSCode/Discord 等）的主程序与 Helper 在同一目录，
    // 按可执行文件所在目录分组，使 Helper 合并到主应用下。
    if cfg!(target_os = "windows") && exe.to_lowercase().ends_with(".exe") {
        let p = Path::new(exe);
        if let (Some(dir), Some(stem)) = (
            p.parent().and_then(|d| d.to_str()),
            p.file_stem().and_then(|s| s.to_str()),
        ) {
            // 仅对用户安装目录下的应用做目录合并，避免把 System32 一堆 exe 全归一组
            let low = exe.to_lowercase();
            if low.contains("\\users\\") || low.contains("\\appdata\\") || low.contains("\\program files") {
                return Some((dir.to_string(), stem.to_string()));
            }
        }
    }
    None
}

/// 判断是否界面应用（在 .app bundle 内 / Program Files / Electron app 目录 / Linux 应用目录）。
fn is_gui(exe: &str) -> bool {
    if exe.contains(".app/") || exe.ends_with(".app") {
        // macOS 大量系统守护进程也住在 .app bundle 内（如 XProtect、liquiddetectiond、
        // AccessibilityVisualsAgent），但它们装在 /System/ 或 /Library/ 下，并非用户应用。
        // 仅凭 .app 会把它们误判为界面应用 → 进入 gui 列表 → 被自动清理误杀。
        // 故系统/库目录下的 .app 一律不算用户 GUI 应用，交回 is_system_path 标记为系统进程。
        let in_system_dir = exe.starts_with("/System/")
            || exe.starts_with("/Library/")
            || exe.starts_with("/usr/");
        return !in_system_dir;
    }
    if cfg!(target_os = "windows") {
        let low = exe.to_lowercase();
        // 注意运算符优先级：用显式括号分组，避免 && 误吞 ||
        return low.contains("\\program files")
            || (low.ends_with(".exe")
                && (low.contains("\\users\\") || low.contains("\\appdata\\")));
    }
    if cfg!(target_os = "linux") {
        // Linux 界面应用常见安装位置。排除工具链/CLI 常驻的 .../bin/ 目录，
        // 避免把 /opt/homebrew/bin/node、/opt/rh/.../bin/ruby 误判为界面应用。
        let is_toolchain = exe.contains("/bin/")
            && (exe.contains("homebrew") || exe.contains("/rh/") || exe.contains("/node") || exe.contains("python") || exe.contains("ruby"));
        if is_toolchain {
            return false;
        }
        return exe.contains("/snap/")
            || exe.contains("/opt/")
            || exe.contains("/.local/share/applications")
            || exe.contains("/usr/share/applications");
    }
    false
}

/// 是否系统/后台进程（路径在系统目录或无可执行路径）。
fn is_system_path(exe: &str, name: &str) -> bool {
    if exe.is_empty() || name == "kernel_task" {
        return true;
    }
    if cfg!(target_os = "windows") {
        let low = exe.to_lowercase();
        return low.contains("\\windows\\") || low.contains("\\system32\\");
    }
    // mac / linux 系统守护进程目录
    exe.starts_with("/usr/sbin/")
        || exe.starts_with("/usr/libexec/")
        || exe.starts_with("/sbin/")
        || exe.starts_with("/System/")
        || exe.starts_with("/Library/")
        || exe.starts_with("/lib/")
        || exe.starts_with("/bin/")
}

/// 采集原始进程列表（已做两次 CPU 采样）。
fn collect_raw(sys: &System) -> Vec<RawProc> {
    let mut out = Vec::new();
    for (pid, p) in sys.processes() {
        let exe = p
            .exe()
            .map(|x| x.to_string_lossy().to_string())
            .unwrap_or_default();
        let name = p.name().to_string_lossy().to_string();
        out.push(RawProc {
            pid: pid.as_u32(),
            ppid: p.parent().map(|x| x.as_u32()).unwrap_or(0),
            name,
            exe,
            cpu: p.cpu_usage(),
            mem_mb: p.memory() as f64 / 1024.0 / 1024.0,
        });
    }
    out
}

/// 把原始进程合并为按"应用"分组的 AppRow 列表。
/// `idle` 用于给每组算空闲时长（组内成员最小者，保守）。
fn merge(raw: &[RawProc], idle: &IdleTracker) -> Vec<AppRow> {
    // 分组键：界面进程按 .app bundle；否则按 exe 路径（同一可执行的多实例合并）；
    // 都没有则按进程名。
    struct Group {
        key: String,
        display: String,
        bundle_path: String,
        members: Vec<usize>, // raw 下标
        is_gui: bool,
        is_sys: bool,
    }
    let mut groups: HashMap<String, Group> = HashMap::new();
    let pid_to_idx: HashMap<u32, usize> =
        raw.iter().enumerate().map(|(i, p)| (p.pid, i)).collect();

    for (i, p) in raw.iter().enumerate() {
        let (key, display, bundle, gui) = if let Some((bundle, name)) = app_bundle(&p.exe) {
            (format!("app:{}", bundle), name, bundle, true)
        } else if !p.exe.is_empty() {
            (format!("exe:{}", p.exe), p.name.clone(), p.exe.clone(), is_gui(&p.exe))
        } else {
            (format!("name:{}", p.name), p.name.clone(), String::new(), false)
        };
        let is_sys = is_system_path(&p.exe, &p.name) && !gui;
        let g = groups.entry(key.clone()).or_insert_with(|| Group {
            key,
            display,
            bundle_path: bundle,
            members: Vec::new(),
            is_gui: gui,
            is_sys,
        });
        g.members.push(i);
    }

    let _ = pid_to_idx; // 预留：未来可用父子关系做更精细合并

    let mut rows: Vec<AppRow> = Vec::new();
    for (_, g) in groups {
        if g.members.is_empty() {
            continue;
        }
        // 选代表进程：内存最大者作为"主进程"（通常即主进程；对 Chrome 这类也合理）
        let mut members: Vec<&RawProc> = g.members.iter().map(|&i| &raw[i]).collect();
        members.sort_by(|a, b| b.mem_mb.partial_cmp(&a.mem_mb).unwrap_or(std::cmp::Ordering::Equal));
        let main = members[0];

        let total_cpu: f32 = members.iter().map(|m| m.cpu).sum();
        let total_mem: f64 = members.iter().map(|m| m.mem_mb).sum();
        let all_pids: Vec<u32> = members.iter().map(|m| m.pid).collect();

        // 组空闲时长 = 组内成员最小空闲（任一成员活跃则整组按其计，保守不误伤）。
        let idle_minutes = members
            .iter()
            .map(|m| idle.idle_minutes(m.pid))
            .fold(f64::INFINITY, f64::min);
        let idle_minutes = if idle_minutes.is_finite() { idle_minutes } else { 0.0 };

        // helpers 仅在多进程时构建
        let helpers: Vec<Helper> = if members.len() > 1 {
            members
                .iter()
                .enumerate()
                .map(|(idx, m)| Helper {
                    name: m.name.clone(),
                    role: infer_role(&m.name, idx == 0),
                    cpu: m.cpu,
                    mem: m.mem_mb,
                    pid: m.pid,
                })
                .collect()
        } else {
            Vec::new()
        };

        let path = if !g.bundle_path.is_empty() {
            g.bundle_path.clone()
        } else {
            main.exe.clone()
        };
        // 分组后的展示路径可能不是可执行文件：macOS 是 .app，Windows 是 exe 所在目录。
        // 图标提取必须始终使用组内代表进程的真实可执行路径；macOS 提取器也能从该路径
        // 反向找到 .app bundle，Linux 本来就需要可执行路径。
        let icon_source_path = main.exe.clone();

        rows.push(AppRow {
            id: format!("g{}", main.pid),
            name: g.display.clone(),
            monogram: monogram_for(&g.display),
            color: color_for(&g.display),
            procs: members.len() as u32,
            cpu: (total_cpu * 10.0).round() / 10.0,
            mem: total_mem,
            pid: main.pid,
            path,
            icon_source_path,
            helpers,
            sys: if g.is_sys { Some(true) } else { None },
            icon_url: None,
            all_pids,
            port: None,
            idle_minutes,
        });
        let _ = g.is_gui;
        let _ = g.key;
    }
    rows
}

/// 采集监听端口 → (pid -> port)。mac/linux 用 lsof，windows 用 netstat。
fn listen_ports() -> HashMap<u32, String> {
    use std::process::Command;
    let mut map: HashMap<u32, String> = HashMap::new();
    if cfg!(target_os = "windows") {
        if let Ok(o) = Command::new("netstat").args(["-ano", "-p", "TCP"]).output() {
            let text = String::from_utf8_lossy(&o.stdout);
            for line in text.lines() {
                let parts: Vec<&str> = line.split_whitespace().collect();
                // 格式: TCP  0.0.0.0:5173  0.0.0.0:0  LISTENING  1234
                if parts.len() >= 5 && parts[0] == "TCP" && parts[3].eq_ignore_ascii_case("LISTENING") {
                    if let (Some(port), Ok(pid)) = (
                        parts[1].rsplit(':').next(),
                        parts[4].parse::<u32>(),
                    ) {
                        map.entry(pid).or_insert_with(|| port.to_string());
                    }
                }
            }
        }
    } else if let Ok(o) = Command::new("lsof")
        .args(["-nP", "-iTCP", "-sTCP:LISTEN"])
        .output()
    {
        let text = String::from_utf8_lossy(&o.stdout);
        for line in text.lines() {
            // COMMAND PID USER ... NAME(*:5173 (LISTEN))
            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.len() >= 2 {
                if let Ok(pid) = parts[1].parse::<u32>() {
                    if let Some(addr) = parts.iter().find(|s| s.contains(':')) {
                        if let Some(port) = addr.rsplit(':').next() {
                            let port: String = port.chars().take_while(|c| c.is_ascii_digit()).collect();
                            if !port.is_empty() {
                                map.entry(pid).or_insert(port);
                            }
                        }
                    }
                }
            }
        }
    }
    map
}

/// 按分类过滤 + 排序裁剪。
pub fn list_by_category(sys: &System, idle: &IdleTracker, category: &str) -> Vec<AppRow> {
    let raw = collect_raw(sys);
    let mut rows = merge(&raw, idle);

    match category {
        "gui" => {
            // 用语义判断：界面应用 = 路径像界面应用 且 非系统进程。
            // 注意不要再额外 `|| path.contains(".app")`——系统守护进程也住在 .app 内，
            // is_gui 已据系统目录把它们排除，绕过去会把它们漏回 gui 列表。
            rows.retain(|r| is_gui(&r.path) && !r.sys.unwrap_or(false));
            // 平台拿不到可靠路径时（如部分 Linux），退化为非系统进程
            if rows.is_empty() {
                rows = merge(&raw, idle);
                rows.retain(|r| !r.sys.unwrap_or(false));
            }
            rows.sort_by(|a, b| b.mem.partial_cmp(&a.mem).unwrap_or(std::cmp::Ordering::Equal));
        }
        "bg" => {
            rows.retain(|r| r.sys.unwrap_or(false));
            rows.sort_by(|a, b| b.mem.partial_cmp(&a.mem).unwrap_or(std::cmp::Ordering::Equal));
        }
        "net" => {
            // 关联监听端口，只保留有端口的进程组
            let ports = listen_ports();
            rows.retain_mut(|r| {
                let hit = r
                    .all_pids
                    .iter()
                    .find_map(|p| ports.get(p).cloned());
                if let Some(port) = hit {
                    r.port = Some(port);
                    true
                } else {
                    false
                }
            });
            rows.sort_by(|a, b| {
                let pa: u32 = a.port.as_deref().unwrap_or("0").parse().unwrap_or(0);
                let pb: u32 = b.port.as_deref().unwrap_or("0").parse().unwrap_or(0);
                pa.cmp(&pb)
            });
        }
        "cpu" => rows.sort_by(|a, b| b.cpu.partial_cmp(&a.cpu).unwrap_or(std::cmp::Ordering::Equal)),
        _ => {
            // all / mem 默认按内存降序
            rows.sort_by(|a, b| b.mem.partial_cmp(&a.mem).unwrap_or(std::cmp::Ordering::Equal));
        }
    }

    rows
}

pub fn system_stats(sys: &System) -> SystemStats {
    let cpu = sys.global_cpu_usage();
    let used = sys.used_memory() as f64 / 1024.0 / 1024.0;
    let total = sys.total_memory() as f64 / 1024.0 / 1024.0;
    SystemStats {
        cpu_percent: (cpu * 10.0).round() / 10.0,
        mem_used_mb: used,
        mem_total_mb: total,
    }
}

/// 创建并完成首次 CPU 采样的 System。调用方应复用此实例。
pub fn new_system() -> System {
    let mut sys = System::new_with_specifics(
        RefreshKind::nothing()
            .with_processes(ProcessRefreshKind::nothing().with_cpu().with_memory().with_exe(sysinfo::UpdateKind::Always))
            .with_cpu(sysinfo::CpuRefreshKind::nothing().with_cpu_usage())
            .with_memory(sysinfo::MemoryRefreshKind::everything()),
    );
    sys.refresh_all();
    sys
}

/// 刷新进程 + CPU（需在两次刷新间隔 >= MINIMUM_CPU_UPDATE_INTERVAL 才准）。
pub fn refresh(sys: &mut System) {
    sys.refresh_processes(ProcessesToUpdate::All, true);
    sys.refresh_cpu_usage();
    sys.refresh_memory();
}

pub use sysinfo::MINIMUM_CPU_UPDATE_INTERVAL;

/// 把 PID 列表转为 sysinfo Pid。
#[allow(dead_code)]
pub fn to_pid(pid: u32) -> Pid {
    Pid::from_u32(pid)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merged_app_keeps_executable_path_for_icon_extraction() {
        let executable = "/Applications/Demo.app/Contents/MacOS/Demo";
        let raw = vec![RawProc {
            pid: 42,
            ppid: 1,
            name: "Demo".into(),
            exe: executable.into(),
            cpu: 0.0,
            mem_mb: 64.0,
        }];

        let rows = merge(&raw, &IdleTracker::new());

        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].path, "/Applications/Demo.app");
        assert_eq!(rows[0].icon_source_path, executable);
        assert!(
            serde_json::to_value(&rows[0])
                .expect("AppRow should serialize")
                .get("icon_source_path")
                .is_none(),
            "backend-only icon source path must not leak into the frontend payload"
        );
    }
}
