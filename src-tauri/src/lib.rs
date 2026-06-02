//! ProcKill Tauri 后端入口：暴露 list_processes / system_stats / kill_process 命令。
//! 常驻一个 sysinfo System 实例，由后台线程定时刷新，保证 CPU% 采样连续准确。

mod icon;
mod kill;
mod process;

use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use sysinfo::System;

use kill::KillResult;
use process::{AppRow, SystemStats};

/// 共享状态：被后台线程持续刷新的 System。
struct AppState {
    sys: Arc<Mutex<System>>,
}

#[tauri::command]
fn list_processes(state: tauri::State<AppState>, category: String) -> Vec<AppRow> {
    // Mutex 中毒（某次持锁线程 panic）不应让整个 UI 崩溃 —— 恢复内部数据继续用。
    let sys = state.sys.lock().unwrap_or_else(|e| e.into_inner());
    let mut rows = process::list_by_category(&sys, &category);
    // 填充图标（当前返回 None，前端降级字形方块）
    for r in rows.iter_mut() {
        if r.icon_url.is_none() {
            r.icon_url = icon::icon_data_url(&r.path);
        }
    }
    rows
}

#[tauri::command]
fn system_stats(state: tauri::State<AppState>) -> SystemStats {
    let sys = state.sys.lock().unwrap_or_else(|e| e.into_inner());
    process::system_stats(&sys)
}

#[tauri::command]
fn kill_process(pid: u32, pids: Vec<u32>) -> KillResult {
    let targets = if pids.is_empty() { vec![pid] } else { pids };
    kill::kill_group(&targets)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let sys = Arc::new(Mutex::new(process::new_system()));

    // 后台刷新线程：每秒刷新一次，CPU% 因连续采样而准确。
    {
        let sys_bg = sys.clone();
        thread::spawn(move || loop {
            thread::sleep(Duration::from_millis(1000).max(process::MINIMUM_CPU_UPDATE_INTERVAL));
            // 中毒也恢复，保证刷新不会因一次 panic 永久停摆
            let mut s = sys_bg.lock().unwrap_or_else(|e| e.into_inner());
            process::refresh(&mut s);
        });
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(AppState { sys })
        .invoke_handler(tauri::generate_handler![
            list_processes,
            system_stats,
            kill_process
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
