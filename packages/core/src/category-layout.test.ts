import { describe, expect, test } from "bun:test";
import { layoutForCat, metricHdrLabel } from "./category-layout";

describe("列表表头", () => {
  test("分组计数使用准确文案", () => {
    expect(metricHdrLabel("procs")).toBe("进程数");
  });

  test("常规视图无行内操作列，网络固定为下载/上传/CPU/内存", () => {
    expect(layoutForCat("all").gridTemplate.split(" ")).toHaveLength(5);
    expect(layoutForCat("gui").metrics).toEqual(["procs", "cpu", "mem"]);
    expect(layoutForCat("net").metrics).toEqual(["download", "upload", "cpu", "mem"]);
    expect(metricHdrLabel("download")).toBe("下载");
    expect(metricHdrLabel("upload")).toBe("上传");
  });

});
