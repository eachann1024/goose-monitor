import { describe, expect, test } from "bun:test";
import {
  fmtCpu,
  fmtMem,
  fuzzyMatch,
  fuzzyMatchRanges,
  fuzzyMatchScore,
  normalizeSearchText,
} from "./shared";

describe("进程搜索", () => {
  test("忽略常见路径分隔符和大小写", () => {
    expect(normalizeSearchText("Google.Chrome / Helper_GPU")).toBe("googlechromehelpergpu");
    expect(fuzzyMatch("Google Chrome Helper GPU", "chrome gpu")).toBe(true);
  });

  test("拉丁字母和数字不做跨字符误匹配", () => {
    expect(fuzzyMatch("Google Chrome", "gch")).toBe(false);
    expect(fuzzyMatch("PID 12345", "135")).toBe(false);
  });

  test("中文支持按顺序缩写匹配", () => {
    expect(fuzzyMatch("企业微信", "企微")).toBe(true);
    expect(fuzzyMatchRanges("企业微信", "企微")).toEqual([[0, 1], [2, 3]]);
  });

  test("名称命中比路径命中分数更高", () => {
    expect(fuzzyMatchScore("Chrome", "chrome")).toBeLessThan(
      40 + fuzzyMatchScore("/Applications/Chrome.app", "chrome"),
    );
  });
});

describe("指标格式化", () => {
  test("内存单位边界稳定", () => {
    expect(fmtMem(1023.6)).toBe("1024 MB");
    expect(fmtMem(1024)).toBe("1.00 GB");
  });

  test("CPU 固定一位小数", () => {
    expect(fmtCpu(3)).toBe("3.0%");
  });
});
