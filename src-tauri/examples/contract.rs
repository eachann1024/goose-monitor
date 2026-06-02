// 验证 Rust command 返回值序列化后的 JSON 字段名与前端 TS 契约一致。
use std::thread;

#[path = "../src/process.rs"]
mod process;
#[path = "../src/kill.rs"]
mod kill;

fn main() {
    let mut sys = process::new_system();
    thread::sleep(process::MINIMUM_CPU_UPDATE_INTERVAL);
    process::refresh(&mut sys);
    let mut idle = process::IdleTracker::new();
    idle.update(&sys);

    let rows = process::list_by_category(&sys, &idle, "all");
    let row = rows.into_iter().find(|r| !r.helpers.is_empty()).unwrap_or_else(|| {
        // 没有多进程组时取第一个
        process::list_by_category(&sys, &idle, "all").into_iter().next().expect("有进程")
    });
    let row_json = serde_json::to_value(&row).unwrap();
    let stats_json = serde_json::to_value(&process::system_stats(&sys)).unwrap();
    let kill_json = serde_json::to_value(&kill::KillResult { ok: true, killed: vec![1, 2], error: None }).unwrap();

    // 前端 AppRow 期望的字段
    let row_need = ["id", "name", "monogram", "color", "procs", "cpu", "mem", "pid", "path", "helpers", "allPids", "idleMinutes"];
    let stats_need = ["cpuPercent", "memUsedMb", "memTotalMb"];
    let kill_need = ["ok", "killed"];

    let mut ok = true;
    for k in row_need {
        if row_json.get(k).is_none() { println!("✗ AppRow 缺字段: {k}"); ok = false; }
    }
    // helper 字段
    if let Some(h) = row_json.get("helpers").and_then(|h| h.as_array()).and_then(|a| a.first()) {
        for k in ["name", "role", "cpu", "mem", "pid"] {
            if h.get(k).is_none() { println!("✗ Helper 缺字段: {k}"); ok = false; }
        }
    }
    for k in stats_need {
        if stats_json.get(k).is_none() { println!("✗ SystemStats 缺字段: {k}"); ok = false; }
    }
    for k in kill_need {
        if kill_json.get(k).is_none() { println!("✗ KillResult 缺字段: {k}"); ok = false; }
    }

    println!("AppRow 示例 JSON keys: {:?}", row_json.as_object().unwrap().keys().collect::<Vec<_>>());
    println!("SystemStats JSON: {}", stats_json);
    println!("KillResult JSON: {}", kill_json);
    println!("{}", if ok { "✅ 前后端 JSON 契约一致" } else { "❌ 契约不一致" });
    if !ok { std::process::exit(1); }
}
