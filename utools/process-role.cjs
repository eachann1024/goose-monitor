/* uTools 进程角色纯逻辑。独立成 CommonJS，供 preload 与 Bun 测试共同使用。 */
function isGpuProcessCommand(commandLine) {
  if (!commandLine) return false;
  return /(?:^|\s)--type=gpu-process(?=\s|$)/i.test(commandLine);
}

function inferRole(procName, commandLine, isMain) {
  const n = procName.toLowerCase();
  // Windows/Linux 的 Chromium/Electron Helper 常与主进程同名，只能靠命令行区分。
  // 仅用于把 Chromium 图形子进程正确归入其应用树，不形成独立产品分类。
  if (isGpuProcessCommand(commandLine) || n.includes("gpu")) return "GPU";
  if (isMain) return "主进程";
  if (n.includes("renderer")) return "渲染进程";
  if (n.includes("plugin") || n.includes("extension")) return "扩展宿主";
  if (n.includes("network")) return "网络服务";
  if (n.includes("crashpad") || n.includes("crash")) return "崩溃监控";
  if (n.includes("utility")) return "工具进程";
  if (n.includes("helper")) return "辅助进程";
  return "子进程";
}

function linuxExecutableFromCommand(procName, commandLine) {
  const text = String(commandLine || "").trim();
  if (!text) return procName;
  const quoted = text.match(/^(["'])(.*?)\1(?:\s|$)/);
  if (quoted && quoted[2]) return quoted[2];
  return text.match(/^\S+/)?.[0] || procName;
}

function findExecutableTreeRootPid(proc, byPid) {
  let root = proc;
  let parentPid = proc.ppid;
  const seen = new Set();
  while (parentPid > 1 && !seen.has(parentPid)) {
    seen.add(parentPid);
    const parent = byPid.get(parentPid);
    if (!parent || parent.exe !== proc.exe) break;
    root = parent;
    parentPid = parent.ppid;
  }
  return root.pid;
}

module.exports = {
  inferRole,
  isGpuProcessCommand,
  linuxExecutableFromCommand,
  findExecutableTreeRootPid,
};
