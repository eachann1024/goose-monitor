/** 主列表列布局：每个分类 tab 一套列（对齐 macOS 活动监视器思路）。 */
import type { CategoryId } from "./types";

export type MetricCol = "procs" | "cpu" | "mem" | "download" | "upload" | "path";

export interface CategoryColumnLayout {
  readonly gridTemplate: string;
  readonly nameHdr: string;
  readonly metrics: readonly MetricCol[];
}

const DEFAULT: CategoryColumnLayout = {
  gridTemplate: "16px minmax(140px,1fr) 56px 90px 104px",
  nameHdr: "进程 / PID",
  metrics: ["procs", "cpu", "mem"],
};

export const LAYOUT_BY_CAT: Record<CategoryId, CategoryColumnLayout> = {
  all: DEFAULT,
  gui: DEFAULT,
  mem: {
    gridTemplate: DEFAULT.gridTemplate,
    nameHdr: "进程 / PID",
    metrics: ["procs", "cpu", "mem"],
  },
  cpu: {
    gridTemplate: DEFAULT.gridTemplate,
    nameHdr: "进程 / PID",
    metrics: ["procs", "cpu", "mem"],
  },
  net: {
    gridTemplate: "16px minmax(140px,1fr) 86px 86px 72px 86px",
    nameHdr: "进程 / PID",
    metrics: ["download", "upload", "cpu", "mem"],
  },
  bg: {
    gridTemplate: "16px minmax(110px,1fr) minmax(120px,1.25fr) 90px 104px",
    nameHdr: "名称",
    metrics: ["path", "cpu", "mem"],
  },
};

export function layoutForCat(cat: CategoryId): CategoryColumnLayout {
  return LAYOUT_BY_CAT[cat];
}

export function metricHdrLabel(m: MetricCol): string {
  switch (m) {
    case "procs": return "进程数";
    case "cpu": return "CPU";
    case "mem": return "内存";
    case "download": return "下载";
    case "upload": return "上传";
    case "path": return "路径";
  }
}
