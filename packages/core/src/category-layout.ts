/** 主列表列布局：每个分类 tab 一套列（对齐 macOS 活动监视器思路）。 */
import type { CategoryId } from "./types";

export type MetricCol = "procs" | "cpu" | "mem" | "port" | "path";

export interface CategoryColumnLayout {
  readonly gridTemplate: string;
  readonly nameHdr: string;
  readonly metrics: readonly MetricCol[];
}

const DEFAULT: CategoryColumnLayout = {
  gridTemplate: "16px 1fr 52px 96px 110px 56px",
  nameHdr: "进程 / PID",
  metrics: ["procs", "cpu", "mem"],
};

export const LAYOUT_BY_CAT: Record<CategoryId, CategoryColumnLayout> = {
  gui: DEFAULT,
  all: DEFAULT,
  mem: {
    gridTemplate: "16px 1fr 52px 84px 120px 56px",
    nameHdr: "进程 / PID",
    metrics: ["procs", "cpu", "mem"],
  },
  cpu: {
    gridTemplate: "16px 1fr 52px 120px 84px 56px",
    nameHdr: "进程 / PID",
    metrics: ["procs", "cpu", "mem"],
  },
  net: {
    gridTemplate: "16px 1fr 72px 88px 100px 56px",
    nameHdr: "进程 / 端口",
    metrics: ["port", "cpu", "mem"],
  },
  bg: {
    gridTemplate: "16px minmax(100px,1fr) minmax(120px,1.4fr) 88px 96px 56px",
    nameHdr: "名称",
    metrics: ["path", "cpu", "mem"],
  },
};

export function layoutForCat(cat: CategoryId): CategoryColumnLayout {
  return LAYOUT_BY_CAT[cat];
}

export function metricHdrLabel(m: MetricCol): string {
  switch (m) {
    case "procs": return "数";
    case "cpu": return "CPU";
    case "mem": return "内存";
    case "port": return "端口";
    case "path": return "路径";
  }
}