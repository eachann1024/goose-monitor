//! 结束进程及其子进程树。用 kill_tree 跨平台递归杀（不依赖外部 kill/taskkill 命令）。

use serde::Serialize;

#[derive(Serialize)]
pub struct KillResult {
    pub ok: bool,
    pub killed: Vec<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// 对一组 PID（合并组的所有进程）逐个结束进程树。
/// 只有所有目标都成功或已确认退出时才返回成功；部分失败会如实返回错误。
pub fn kill_group(pids: &[u32]) -> KillResult {
    let mut killed: Vec<u32> = Vec::new();
    let mut uncertain: Vec<u32> = Vec::new();
    let mut errors: Vec<String> = Vec::new();

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
                            // Windows 的权限拒绝也可能被依赖库归入该分支，稍后重新枚举确认。
                            uncertain.push(process_id);
                        }
                    }
                }
            }
            Err(e) => {
                errors.push(format!("PID {pid}: {e}"));
            }
        }
    }

    if !uncertain.is_empty() {
        let mut sys = sysinfo::System::new();
        sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
        for pid in uncertain {
            if sys.process(sysinfo::Pid::from_u32(pid)).is_some() {
                errors.push(format!("PID {pid}: 进程仍在运行，可能权限不足"));
            } else {
                killed.push(pid);
            }
        }
    }

    killed.sort_unstable();
    killed.dedup();

    if !errors.is_empty() {
        KillResult {
            ok: false,
            killed,
            error: Some(errors.join("；")),
        }
    } else if killed.is_empty() {
        KillResult {
            ok: false,
            killed,
            error: Some("没有进程被结束（目标可能已变化）".into()),
        }
    } else {
        KillResult {
            ok: true,
            killed,
            error: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_only_protected_targets() {
        let result = kill_group(&[0, 1, std::process::id()]);
        assert!(!result.ok);
        assert!(result.killed.is_empty());
        assert!(result.error.is_some());
    }
}
