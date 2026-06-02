//! 结束进程及其子进程树。用 kill_tree 跨平台递归杀（不依赖外部 kill/taskkill 命令）。

use serde::Serialize;

#[derive(Serialize)]
pub struct KillResult {
    pub ok: bool,
    pub killed: Vec<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// 对一组 PID（合并组的所有进程）逐个杀进程树。
/// 任意一个成功即视为该应用被结束；收集所有真正被杀的 PID。
pub fn kill_group(pids: &[u32]) -> KillResult {
    let mut killed: Vec<u32> = Vec::new();
    let mut last_err: Option<String> = None;

    let self_pid = std::process::id();
    // 防自杀 + 保护关键系统进程（PID 0=调度器 / 1=launchd|systemd）
    let targets: Vec<u32> = pids
        .iter()
        .copied()
        .filter(|&p| p != self_pid && p > 1)
        .collect();
    if targets.is_empty() {
        return KillResult {
            ok: false,
            killed,
            error: Some("目标为空（已排除 ProcKill 自身或受保护的系统进程）".into()),
        };
    }

    for &pid in &targets {
        match kill_tree::blocking::kill_tree(pid) {
            Ok(outputs) => {
                for o in outputs {
                    match o {
                        kill_tree::Output::Killed { process_id, .. } => {
                            killed.push(process_id);
                        }
                        kill_tree::Output::MaybeAlreadyTerminated { process_id, .. } => {
                            // 进程可能已退出，也算目标已不在
                            killed.push(process_id);
                        }
                    }
                }
            }
            Err(e) => {
                last_err = Some(format!("{e}"));
            }
        }
    }

    killed.sort_unstable();
    killed.dedup();

    if killed.is_empty() {
        KillResult {
            ok: false,
            killed,
            error: last_err.or_else(|| Some("没有进程被结束（可能权限不足或已退出）".into())),
        }
    } else {
        KillResult { ok: true, killed, error: None }
    }
}
