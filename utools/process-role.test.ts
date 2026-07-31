import { describe, expect, test } from "bun:test";

const {
  inferRole,
  isGpuProcessCommand,
  linuxExecutableFromCommand,
  findExecutableTreeRootPid,
} = require("./process-role.cjs") as {
  inferRole: (name: string, commandLine: string, isMain: boolean) => string;
  isGpuProcessCommand: (commandLine: string) => boolean;
  linuxExecutableFromCommand: (name: string, commandLine: string) => string;
  findExecutableTreeRootPid: (
    proc: { pid: number; ppid: number; exe: string },
    byPid: Map<number, { pid: number; ppid: number; exe: string }>,
  ) => number;
};

describe("uTools GPU 进程角色识别", () => {
  test("识别大小写不同的 Chromium GPU 参数", () => {
    expect(isGpuProcessCommand('"C:\\Chrome\\chrome.exe" --TYPE=GPU-PROCESS')).toBe(true);
    expect(inferRole("chrome.exe", "chrome.exe --type=gpu-process", false)).toBe("GPU");
  });

  test("缺少命令行和普通 Chrome 不会误判", () => {
    expect(inferRole("chrome.exe", "", false)).toBe("子进程");
    expect(inferRole("chrome.exe", "chrome.exe --type=renderer", false)).toBe("子进程");
    expect(isGpuProcessCommand("chrome.exe --type=gpu-process-old")).toBe(false);
  });

  test("GPU 信号优先于按内存推断的主进程，macOS 名称识别保持不变", () => {
    expect(inferRole("chrome.exe", "chrome.exe --type=gpu-process", true)).toBe("GPU");
    expect(inferRole("Chrome Helper (GPU)", "", false)).toBe("GPU");
  });
});

describe("Linux Chromium 进程归并", () => {
  test("不同 args 保留同一 exe 和根进程；图形子进程仍正确归组", () => {
    const mainCommand = "/opt/google/chrome/chrome --profile-directory=Default";
    const gpuCommand = "/opt/google/chrome/chrome --type=gpu-process --gpu-preferences=abc";
    const main = {
      pid: 100, ppid: 1, name: "chrome", commandLine: mainCommand,
      exe: linuxExecutableFromCommand("chrome", mainCommand),
    };
    const gpu = {
      pid: 101, ppid: 100, name: "chrome", commandLine: gpuCommand,
      exe: linuxExecutableFromCommand("chrome", gpuCommand),
    };
    const byPid = new Map([[main.pid, main], [gpu.pid, gpu]]);
    expect(main.exe).toBe("/opt/google/chrome/chrome");
    expect(gpu.exe).toBe(main.exe);
    expect(findExecutableTreeRootPid(gpu, byPid)).toBe(main.pid);

    const helpers = [main, gpu].map((proc, index) => ({
      name: proc.name,
      role: inferRole(proc.name, proc.commandLine, index === 0),
      cpu: index ? 3 : 1,
      mem: index ? 120 : 240,
      pid: proc.pid,
    }));
    expect(helpers.map((helper) => helper.role)).toEqual(["主进程", "GPU"]);
  });

  test("带引号路径只取可执行文件，macOS 名称角色识别不回归", () => {
    expect(linuxExecutableFromCommand("chrome", "'/opt/Chrome Stable/chrome' --type=gpu-process"))
      .toBe("/opt/Chrome Stable/chrome");
    expect(inferRole("Chrome Helper (GPU)", "", false)).toBe("GPU");
  });
});
