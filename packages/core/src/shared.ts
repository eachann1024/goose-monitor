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

/** 运行平台（WebView 下 userAgent 可靠：Tauri/uTools 均基于系统 WebView）。 */
export type Platform = "mac" | "win" | "linux";

export const platform: Platform = (() => {
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  if (/Mac|iPhone|iPad/i.test(ua)) return "mac";
  if (/Win/i.test(ua)) return "win";
  return "linux";
})();

/** 主修饰键字形：mac 用 ⌘，Windows/Linux 用 Ctrl（各自键盘上的实际按键）。 */
export const modKeyLabel: string = platform === "mac" ? "⌘" : "Ctrl";

/** 判断键盘事件是否按下了本平台的主修饰键。 */
export const isModKey = (e: KeyboardEvent | MouseEvent): boolean =>
  platform === "mac" ? e.metaKey : e.ctrlKey;

/** 内存格式化：<1024MB 显示 MB，否则 GB（两位小数）。 */
export const fmtMem = (mb: number): string =>
  mb >= 1024 ? (mb / 1024).toFixed(2) + " GB" : Math.round(mb) + " MB";

/** CPU 一位小数 + %。 */
export const fmtCpu = (n: number): string => n.toFixed(1) + "%";

export const sumCpu = (list: AppRow[]): number =>
  list.reduce((a, x) => a + x.cpu, 0);
export const sumMem = (list: AppRow[]): number =>
  list.reduce((a, x) => a + x.mem, 0);

/** 搜索归一化：大小写不敏感，并忽略常见分隔符。 */
export function normalizeSearchText(text: string): string {
  return text.toLowerCase().replace(/[\s._\-/:：\\]+/g, "");
}

function isAsciiWordQuery(text: string): boolean {
  return /^[a-z0-9]+$/.test(normalizeSearchText(text));
}

function fuzzyPartScore(text: string, query: string): number {
  const hay = normalizeSearchText(text);
  const needle = normalizeSearchText(query);
  if (!needle) return 0;
  if (!hay) return Number.POSITIVE_INFINITY;
  if (hay === needle) return 0;
  const index = hay.indexOf(needle);
  if (index === 0) return 4 + (hay.length - needle.length) * 0.01;
  if (index > 0) return 20 + index + (hay.length - needle.length) * 0.01;
  if (isAsciiWordQuery(query)) return Number.POSITIVE_INFINITY;

  let pos = 0;
  let first = -1;
  let last = -1;
  for (let i = 0; i < needle.length; i++) {
    pos = hay.indexOf(needle[i], pos);
    if (pos < 0) return Number.POSITIVE_INFINITY;
    if (first < 0) first = pos;
    last = pos;
    pos += 1;
  }
  return 80 + first + (last - first);
}

/** 模糊匹配：拉丁字母/数字必须连续命中；中文等非拉丁查询保留按字符顺序命中（如 企微 -> 企业微信）。 */
export function fuzzyIncludes(text: string, query: string): boolean {
  return Number.isFinite(fuzzyPartScore(text, query));
}

/** 搜索相关性分数，越小越匹配；不命中返回 Infinity。 */
export function fuzzyMatchScore(text: string, query: string): number {
  const parts = query.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return 0;
  let score = 0;
  for (const part of parts) {
    const partScore = fuzzyPartScore(text, part);
    if (!Number.isFinite(partScore)) return Number.POSITIVE_INFINITY;
    score += partScore;
  }
  return score;
}

/** 搜索支持空格分词；每个词都要在同一段文本里模糊命中。 */
export function fuzzyMatch(text: string, query: string): boolean {
  return Number.isFinite(fuzzyMatchScore(text, query));
}

/** 返回原始 text 中应高亮的字符位置；优先连续子串，否则退化为非连续字符高亮。 */
export function fuzzyMatchRanges(text: string, query: string): [number, number][] {
  const parts = query.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return [];
  const ranges: [number, number][] = [];
  const lower = text.toLowerCase();

  for (const part of parts) {
    const needle = normalizeSearchText(part);
    if (!needle) continue;
    let from = 0;
    let matched = false;
    const rawNeedle = part.toLowerCase();
    let index = lower.indexOf(rawNeedle, from);
    while (index >= 0) {
      ranges.push([index, index + part.length]);
      matched = true;
      from = index + part.length;
      index = lower.indexOf(rawNeedle, from);
    }
    if (matched || isAsciiWordQuery(part)) continue;

    let pos = 0;
    const local: [number, number][] = [];
    for (let i = 0; i < needle.length; i++) {
      pos = lower.indexOf(needle[i], pos);
      if (pos < 0) break;
      local.push([pos, pos + 1]);
      pos += 1;
    }
    if (local.length === needle.length) ranges.push(...local);
  }

  if (ranges.length <= 1) return ranges;
  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: [number, number][] = [ranges[0]];
  for (const [start, end] of ranges.slice(1)) {
    const last = merged[merged.length - 1];
    if (start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

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
