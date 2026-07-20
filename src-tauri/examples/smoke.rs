// 冒烟测试（纯枚举，不起后台进程，立即返回）。
use std::thread;

#[allow(dead_code)]
#[path = "../src/process.rs"]
mod process;

fn main() {
    let mut sys = process::new_system();
    thread::sleep(process::MINIMUM_CPU_UPDATE_INTERVAL);
    process::refresh(&mut sys);
    let mut idle = process::IdleTracker::new();
    idle.update(&sys);
    let all = process::list_by_category(&sys, &idle, "all");
    let gui = process::list_by_category(&sys, &idle, "gui");
    let bg = process::list_by_category(&sys, &idle, "bg");
    println!("全部组={} GUI={} 后台={}", all.len(), gui.len(), bg.len());
    let s = process::system_stats(&sys);
    println!(
        "系统 CPU {:.1}%  内存 {:.0}/{:.0}MB",
        s.cpu_percent, s.mem_used_mb, s.mem_total_mb
    );
    println!("内存Top5(合并后):");
    for r in all.iter().take(5) {
        println!(
            "  {:<26} x{:<3} cpu={:>5.1}% mem={:>7.0}MB helpers={} pid={}",
            r.name,
            r.procs,
            r.cpu,
            r.mem,
            r.helpers.len(),
            r.pid
        );
    }
}
