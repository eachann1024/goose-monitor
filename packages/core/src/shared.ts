/* 共享纯逻辑：分类定义、格式化、颜色/字形生成、Helper 角色推断。
   这些函数不触碰任何平台 API，浏览器/Tauri/uTools 都复用。 */
import type { Category, AppRow } from "./types";

export const CATEGORIES: Category[] = [
  { id: "gui", label: "界面应用", icon: "layout-grid", key: "1" },
  { id: "all", label: "全部进程", icon: "list", key: "2" },
  { id: "cpu", label: "CPU 占用", icon: "cpu", key: "3" },
  { id: "mem", label: "内存占用", icon: "memory-stick", key: "4" },
  { id: "net", label: "网络 / 端口", icon: "wifi", key: "5" },
  { id: "bg", label: "后台服务", icon: "server", key: "6" },
];

/** 内存格式化：<1024MB 显示 MB，否则 GB（两位小数）。 */
export const fmtMem = (mb: number): string =>
  mb >= 1024 ? (mb / 1024).toFixed(2) + " GB" : Math.round(mb) + " MB";

/** CPU 一位小数 + %。 */
export const fmtCpu = (n: number): string => n.toFixed(1) + "%";

export const sumCpu = (list: AppRow[]): number =>
  list.reduce((a, x) => a + x.cpu, 0);
export const sumMem = (list: AppRow[]): number =>
  list.reduce((a, x) => a + x.mem, 0);

/** 颜色加深，用于图标方块渐变。 */
export function shade(hex: string, amt: number): string {
  const n = parseInt(hex.slice(1), 16);
  let r = (n >> 16) + amt,
    g = ((n >> 8) & 255) + amt,
    b = (n & 255) + amt;
  r = Math.max(0, Math.min(255, r));
  g = Math.max(0, Math.min(255, g));
  b = Math.max(0, Math.min(255, b));
  return "#" + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
}

// 一组稳定的品牌色盘，按名称哈希取色，保证同一应用每次同色。
const PALETTE = [
  "#4488F4", "#2C8FE0", "#A259FF", "#5A1F5C", "#2496ED",
  "#1DB954", "#3A3A3A", "#2BB673", "#FA4D6A", "#26A2F0",
  "#F5B544", "#3FB6C9", "#9B8CFF", "#F2555A", "#3DD68C",
];

export function colorFor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

/** 从应用名生成 1-2 字符字形。 */
export function monogramFor(name: string): string {
  const cleaned = name.replace(/\.(app|exe)$/i, "").trim();
  // 取首词的前两个字母（驼峰/空格分隔）
  const words = cleaned.split(/[\s\-_]+/).filter(Boolean);
  if (words.length >= 2) {
    return (words[0][0] + words[1][0]).toUpperCase();
  }
  const w = words[0] || cleaned;
  return w.slice(0, w.length >= 2 ? 2 : 1);
}

/** 从进程名推断 Helper 角色（用于真实进程合并展示）。 */
export function inferRole(procName: string, isMain: boolean): string {
  if (isMain) return "主进程";
  const n = procName.toLowerCase();
  if (n.includes("gpu")) return "GPU";
  if (n.includes("renderer")) return "渲染进程";
  if (n.includes("plugin") || n.includes("extension")) return "扩展宿主";
  if (n.includes("network")) return "网络服务";
  if (n.includes("crashpad") || n.includes("crash")) return "崩溃监控";
  if (n.includes("utility")) return "工具进程";
  if (n.includes("helper")) return "辅助进程";
  return "子进程";
}
