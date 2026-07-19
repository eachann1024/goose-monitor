//! ProcKill Tauri 后端入口：暴露 list_processes / system_stats / kill_process 命令。
//! 常驻一个 sysinfo System 实例，由后台线程定时刷新，保证 CPU% 采样连续准确。
//!
//! 菜单栏（状态栏）模式：注册一个 tray 图标，左键点击在状态栏下方切换 popover
//! 窗口（无边框/透明/置顶/不进任务栏，加载 tray.html）。popover 失焦自动收起。

mod icon;
mod kill;
mod process;

use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use sysinfo::System;
use tauri::{
    tray::{TrayIconBuilder, TrayIconEvent},
    Manager, WebviewWindow,
};

use kill::KillResult;
use process::{AppRow, IdleTracker, SystemStats};

/// 共享状态：被后台线程持续刷新的 System，以及进程空闲时长追踪器。
struct AppState {
    sys: Arc<Mutex<System>>,
    idle: Arc<Mutex<IdleTracker>>,
}

#[tauri::command]
fn list_processes(state: tauri::State<AppState>, category: String) -> Vec<AppRow> {
    // 先在锁内只做进程枚举/合并（纯计算，很快），随即在块结束处释放 sys/idle 两把锁。
    let mut rows = {
        // Mutex 中毒（某次持锁线程 panic）不应让整个 UI 崩溃 —— 恢复内部数据继续用。
        let sys = state.sys.lock().unwrap_or_else(|e| e.into_inner());
        let idle = state.idle.lock().unwrap_or_else(|e| e.into_inner());
        process::list_by_category(&sys, &idle, &category)
    };
    // 图标抓取首次会 spawn 外部进程（sips/PlistBuddy/powershell，每个数百 ms），
    // 必须在释放锁之后做——否则首屏 N 个未缓存应用会持锁数秒，阻塞后台刷新线程与后续 IPC。
    // icon_data_url 内部带进程内缓存（含负缓存）与单飞去重，重复刷新基本零开销。
    for r in rows.iter_mut() {
        if r.icon_url.is_none() {
            r.icon_url = icon::icon_data_url(&r.icon_source_path);
        }
    }
    rows
}

#[tauri::command]
fn system_stats(state: tauri::State<AppState>) -> SystemStats {
    let sys = state.sys.lock().unwrap_or_else(|e| e.into_inner());
    process::system_stats(&sys)
}

// 注：自动清理（空闲应用自动结束）由前端 tray.ts::maybeAutoClean 直接基于轮询到的列表
// （含 AppRow.idleMinutes）过滤后发起 kill_process —— 统一从前端一处发起，遵守二次确认/
// 不再提醒等偏好。故后端不再单独暴露 auto_clean_scan 命令（曾有，已删，避免两套并存的清理路径）。

#[tauri::command]
fn kill_process(
    state: tauri::State<AppState>,
    id: String,
    snapshot_token: String,
    pids: Vec<u32>,
) -> KillResult {
    // 不信任前端直接提交的 PID。先用最新后端快照重新解析分组，只允许结束仍属于
    // 该行且仍在用户确认时 PID 集合中的进程；PID 已被复用到别组时会被拒绝。
    let targets = {
        let sys = state.sys.lock().unwrap_or_else(|e| e.into_inner());
        let idle = state.idle.lock().unwrap_or_else(|e| e.into_inner());
        let protected = process::current_process_ancestors(&sys);
        let expected: std::collections::HashSet<u32> = pids.into_iter().collect();
        process::list_by_category(&sys, &idle, "all")
            .into_iter()
            .find(|row| row.id == id && row.snapshot_token == snapshot_token)
            .map(|row| {
                row.all_pids
                    .into_iter()
                    .filter(|pid| expected.contains(pid) && !protected.contains(pid))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default()
    };
    if targets.is_empty() {
        return KillResult {
            ok: false,
            killed: Vec::new(),
            error: Some("目标已变化、已退出或属于受保护进程，请刷新后重试".into()),
        };
    }
    kill::kill_group(&targets)
}

/// 设置开机自启（偏好设置里的「开机时随系统启动」开关）。
#[tauri::command]
fn set_autostart(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    use tauri_plugin_autostart::ManagerExt;
    let mgr = app.autolaunch();
    let res = if enabled { mgr.enable() } else { mgr.disable() };
    res.map_err(|e| e.to_string())
}

/// 把 popover 窗口定位到状态栏图标正下方并显示；已显示则隐藏（切换）。
fn toggle_tray_popover(win: &WebviewWindow, tray_rect: Option<(f64, f64, f64, f64)>) {
    let visible = win.is_visible().unwrap_or(false);
    if visible {
        let _ = win.hide();
        return;
    }
    // 依据 tray 图标的屏幕矩形把 popover 摆到其下方、右对齐（macOS 菜单栏惯例）。
    if let Some((x, _y, w, h)) = tray_rect {
        if let Ok(size) = win.outer_size() {
            let scale = win.scale_factor().unwrap_or(1.0);
            let win_w = size.width as f64 / scale;
            // 让 popover 右缘对齐图标右缘（x+w 为图标右缘，减窗宽得左上角 x），顶部紧贴菜单栏下方。
            // 再夹到屏幕可视范围内：左缘不小于 8，右缘不超出屏幕宽度（取图标所在显示器的工作区宽）。
            let mut px = x + w - win_w;
            if let Ok(Some(monitor)) = win.current_monitor() {
                let mon_scale = monitor.scale_factor();
                let mon_w = monitor.size().width as f64 / mon_scale;
                let mon_x = monitor.position().x as f64 / mon_scale;
                // 右缘不超出显示器右边界，左缘不低于显示器左边界 + 8 边距
                px = px.min(mon_x + mon_w - win_w - 8.0).max(mon_x + 8.0);
            } else {
                px = px.max(8.0);
            }
            let py = _y + h + 2.0;
            let _ = win.set_position(tauri::LogicalPosition::new(px, py));
        }
    }
    let _ = win.show();
    let _ = win.set_focus();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let sys = Arc::new(Mutex::new(process::new_system()));
    let idle = Arc::new(Mutex::new(IdleTracker::new()));

    // 后台刷新线程：每秒刷新一次，CPU% 因连续采样而准确；刷新后推进空闲追踪。
    {
        let sys_bg = sys.clone();
        let idle_bg = idle.clone();
        thread::spawn(move || loop {
            thread::sleep(Duration::from_millis(1000).max(process::MINIMUM_CPU_UPDATE_INTERVAL));
            // 中毒也恢复，保证刷新不会因一次 panic 永久停摆
            let mut s = sys_bg.lock().unwrap_or_else(|e| e.into_inner());
            process::refresh(&mut s);
            // 用刚刷新的 CPU 数据推进每个进程的空闲计时
            let mut t = idle_bg.lock().unwrap_or_else(|e| e.into_inner());
            t.update(&s);
        });
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        // 开机自启：参数为可执行文件被自启时附加的命令行参数（这里无）。
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .manage(AppState { sys, idle })
        .setup(|app| {
            // ---- 菜单栏（状态栏）tray 图标 ----
            // 用打包的默认图标作为 tray 图标；点击切换 popover。
            let tray_icon = app.default_window_icon().cloned();
            let mut builder = TrayIconBuilder::with_id("prockill-tray")
                .tooltip("鹅的监控 · 进程管理")
                // 左键点击不弹出菜单，由 on_tray_icon_event 处理显隐
                .show_menu_on_left_click(false);
            if let Some(ic) = tray_icon {
                builder = builder.icon(ic);
            }
            builder
                .on_tray_icon_event(|tray, event| {
                    // 仅响应左键「按下」一次，避免 up/down 各触发一次导致来回闪。
                    if let TrayIconEvent::Click {
                        button: tauri::tray::MouseButton::Left,
                        button_state: tauri::tray::MouseButtonState::Up,
                        rect,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(win) = app.get_webview_window("tray") {
                            // rect.position/size 是 dpi 的 Position/Size 枚举（可能为物理像素）；
                            // 用窗口缩放因子转成逻辑坐标，再交给 set_position（逻辑定位）。
                            let scale = win.scale_factor().unwrap_or(1.0);
                            let pos = rect.position.to_logical::<f64>(scale);
                            let sz = rect.size.to_logical::<f64>(scale);
                            let r = (pos.x, pos.y, sz.width, sz.height);
                            toggle_tray_popover(&win, Some(r));
                        }
                    }
                })
                .build(app)?;

            // popover 失焦自动收起（点窗外 / 切到别的 app）—— 菜单栏惯例。
            if let Some(win) = app.get_webview_window("tray") {
                let w2 = win.clone();
                win.on_window_event(move |ev| {
                    if let tauri::WindowEvent::Focused(false) = ev {
                        let _ = w2.hide();
                    }
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_processes,
            system_stats,
            kill_process,
            set_autostart
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
