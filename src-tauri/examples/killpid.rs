// 真实 kill 测试：接收命令行 PID，用 kill_group（kill_tree）杀掉。
use std::env;

#[path = "../src/kill.rs"]
mod kill;

fn main() {
    let pid: u32 = env::args().nth(1).expect("用法: killpid <pid>").parse().expect("pid");
    let res = kill::kill_group(&[pid]);
    println!("ok={} killed={:?} err={:?}", res.ok, res.killed, res.error);
    if !res.ok {
        std::process::exit(1);
    }
}
