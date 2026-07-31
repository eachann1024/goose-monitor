import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const main = readFileSync(resolve(import.meta.dir, "main.ts"), "utf8");
const css = readFileSync(resolve(import.meta.dir, "../styles/app.css"), "utf8");

describe("高密度列表与键盘焦点", () => {
  test("主行与 Helper 行使用紧凑高度", () => {
    expect(main).toContain('padding: "0 12px", height: "38px"');
    expect(main).toContain('padding: "0 12px", height: "24px"');
    expect(main).not.toContain('padding: "0 12px", height: "44px"');
  });

  test("选中状态使用组卡片轻底（无描边），且 hover 不盖过 selected", () => {
    // 不再用 inline 强制 transparent/none 抹掉选中样式
    expect(main).not.toContain('ref.row.style.background = "transparent"');
    expect(main).not.toContain('ref.row.style.boxShadow = "none"');
    // 主行与 wrap 打 data-sel，CSS 负责可见选中态
    expect(main).toContain('ref.row.setAttribute("data-sel", "1")');
    expect(main).toContain('ref.wrap.setAttribute("data-sel", "1")');
    expect(main).toContain('className: "pk-app-group"');
    expect(css).toContain("var(--bg-row-sel)");
    // 圆角轻底、无描边；不用通栏死灰条 / 硬左线
    expect(css).toContain(".pk-app-group[data-sel]::before");
    expect(css).toContain("border-radius: 8px");
    expect(css).not.toContain("inset 0 0 0 1px var(--border-1)");
    expect(css).not.toContain("inset 2px 0 0 var(--accent)");
    // selected 与 selected:hover 同规则，保证 hover 不盖过 selected
    expect(css).toContain(".pk-process-row[data-sel],\n.pk-process-row[data-sel]:hover");
    expect(css).not.toContain(".pk-process-row:focus-within {\n  box-shadow:");
  });

  test("列表接收键盘时不显示整框焦点线", () => {
    const globalFocus = css.indexOf("button:focus-visible, input:focus-visible, [tabindex]:focus-visible");
    const listFocus = css.indexOf(".scroll[tabindex]:focus-visible");
    expect(globalFocus).toBeGreaterThanOrEqual(0);
    expect(listFocus).toBeGreaterThan(globalFocus);
    expect(css.slice(listFocus, listFocus + 100)).toContain("outline: none");
  });
});
