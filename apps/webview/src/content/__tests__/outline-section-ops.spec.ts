/**
 * 章节结构操作的纯函数取证（outline-section-ops）。
 *
 * 行号全部对 `DOC` 逐行数出来，改动夹具必须重数 —— 这些数字就是判据本身：
 * frontmatter 补偿错一行、边界取成「下一个任意标题」，都会精确地反映在
 * `range` / `newText` 的断言上，不需要靠渲染侧兜圈子。
 *
 * 写回后的文本用与夹具 Host 同一条算法（按行切片拼接）在页内复算，
 * 断的是「计划落进文件后的样子」，不是计划字符串的长相。
 */
import { describe, expect, test } from "vitest";
import type { OutlineItem } from "@readora/markdown-core";
import {
  DEFAULT_SECTION_TITLE,
  bodyLineOffsetOf,
  sectionOpPreview
} from "../outline-section-ops";

/**
 * 带 frontmatter 的夹具（文件绝对行号，0 基）：
 * 0  ---
 * 1  title: Sections
 * 2  ---
 * 3
 * 4  # Guide
 * 5
 * 6  Intro paragraph.
 * 7
 * 8  ## Alpha
 * 9
 * 10 Alpha body.
 * 11
 * 12 ### Alpha child
 * 13
 * 14 Child body.
 * 15
 * 16 ## Beta
 * 17
 * 18 Beta body.
 */
const DOC_LINES = [
  "---",
  "title: Sections",
  "---",
  "",
  "# Guide",
  "",
  "Intro paragraph.",
  "",
  "## Alpha",
  "",
  "Alpha body.",
  "",
  "### Alpha child",
  "",
  "Child body.",
  "",
  "## Beta",
  "",
  "Beta body."
];
const DOC = DOC_LINES.join("\n");

/** `extractOutline` 透传的是 **body 相对**行号（body 从文件第 3 行起）。 */
function heading(title: string, level: number, bodyLine: number): OutlineItem {
  return {
    id: `n-${title}`,
    title,
    level,
    anchor: title.toLowerCase().replace(/\s+/g, "-"),
    position: { startLine: bodyLine, endLine: bodyLine }
  };
}

const ITEMS: OutlineItem[] = [
  heading("Guide", 1, 1),
  heading("Alpha", 2, 5),
  heading("Alpha child", 3, 9),
  heading("Beta", 2, 13)
];

/** 与夹具 `handleEdit` / VS Code `WorkspaceEdit` 同一条按行替换算法。 */
function applyPlan(text: string, plan: { range: { startLine: number; endLine: number }; newText: string }): string {
  const lines = text.split("\n");
  return [
    ...lines.slice(0, plan.range.startLine),
    ...plan.newText.split("\n"),
    ...lines.slice(plan.range.endLine + 1)
  ].join("\n");
}

describe("bodyLineOffsetOf（frontmatter 坐标补偿）", () => {
  test("无 frontmatter 恒为 0", () => {
    expect(bodyLineOffsetOf("# Title\n\nbody\n")).toBe(0);
  });

  test("--- 与 ... 两种闭合都算，偏移取闭合行的下一行", () => {
    expect(bodyLineOffsetOf("---\ntitle: x\n---\nbody")).toBe(3);
    expect(bodyLineOffsetOf("---\ntitle: x\n...\nbody")).toBe(3);
  });

  test("未闭合整段当正文：偏移 0（与 extractFrontmatter 同判据）", () => {
    expect(bodyLineOffsetOf("---\ntitle: x\nbody")).toBe(0);
  });

  test("CRLF 不影响判据（\\r 被 trim 吃掉）", () => {
    expect(bodyLineOffsetOf("---\r\ntitle: x\r\n---\r\nbody")).toBe(3);
  });
});

describe("add-sibling-after / add-child", () => {
  test("在其后新增：落在子树末行之后、下一同级标题之前（不是子节之后）", () => {
    const preview = sectionOpPreview({ text: DOC, items: ITEMS, index: 1, action: "add-sibling-after" });
    expect(preview).not.toBeNull();
    // Alpha 的子树到第 15 行（含子节），新节插在 Beta（16）之前。
    expect(preview!.plan).toEqual({
      range: { startLine: 15, endLine: 15 },
      newText: `\n## ${DEFAULT_SECTION_TITLE}`
    });
    expect(preview!.childCount).toBe(1);
  });

  test("新增子节：同一落点，级别 +1", () => {
    const preview = sectionOpPreview({ text: DOC, items: ITEMS, index: 0, action: "add-child" });
    expect(preview).not.toBeNull();
    // Guide 是唯一 H1，子树直到文档末行 18。
    expect(preview!.plan).toEqual({
      range: { startLine: 18, endLine: 18 },
      newText: `Beta body.\n## ${DEFAULT_SECTION_TITLE}`
    });
  });

  test("H6 的子节钳在六级，不会写出七个 #", () => {
    const items = [heading("Deep", 6, 0)];
    const text = "###### six\nlast";
    const preview = sectionOpPreview({ text, items, index: 0, action: "add-child" });
    expect(preview!.plan.newText).toBe(`last\n###### ${DEFAULT_SECTION_TITLE}`);
  });

  test("title 覆盖生效，纯空白回落到默认标题", () => {
    const text = "# A\nbody";
    const items = [heading("A", 1, 0)];
    expect(
      sectionOpPreview({ text, items, index: 0, action: "add-sibling-after", title: "  Design  " })!.plan.newText
    ).toBe(`body\n# Design`);
    expect(
      sectionOpPreview({ text, items, index: 0, action: "add-sibling-after", title: "   " })!.plan.newText
    ).toBe(`body\n# ${DEFAULT_SECTION_TITLE}`);
  });

  test("写回后逐字节：锚点行原样，新标题独占一行，其余行不动", () => {
    const preview = sectionOpPreview({ text: DOC, items: ITEMS, index: 1, action: "add-sibling-after" })!;
    const next = applyPlan(DOC, preview.plan).split("\n");
    expect(next[15]).toBe("");
    expect(next[16]).toBe(`## ${DEFAULT_SECTION_TITLE}`);
    expect(next[17]).toBe("## Beta");
    // 第 15 行之前与第 17 行之后一个字节都没变
    expect(next.slice(0, 15)).toEqual(DOC_LINES.slice(0, 15));
    expect(next.slice(17)).toEqual(DOC_LINES.slice(16));
  });

  test("CRLF 文档：锚点行原样落回，插入行自带 \\r，整篇行尾不混用", () => {
    const crlf = DOC_LINES.join("\r\n");
    const preview = sectionOpPreview({ text: crlf, items: ITEMS, index: 1, action: "add-sibling-after" })!;
    const next = applyPlan(crlf, preview.plan).split("\n");
    // split("\n") 口径下 `\r` 是行内容的尾巴：锚点行未动，新行自己带尾。
    expect(next[15]).toBe("\r");
    expect(next[16]).toBe(`## ${DEFAULT_SECTION_TITLE}\r`);
    expect(next[17]).toBe("## Beta\r");
    expect(next.length).toBe(DOC_LINES.length + 1);
  });
});

describe("delete-section", () => {
  test("区间取整个子树 [标题行, 下一同级标题前一行]", () => {
    const preview = sectionOpPreview({ text: DOC, items: ITEMS, index: 2, action: "delete-section" });
    expect(preview!.plan).toEqual({ range: { startLine: 12, endLine: 15 }, newText: "" });
    expect(preview!.affectedLines).toBe(4);
    expect(preview!.childCount).toBe(0);
  });

  test("含子节的节被整体删除：子树到边界为止", () => {
    const preview = sectionOpPreview({ text: DOC, items: ITEMS, index: 1, action: "delete-section" });
    expect(preview!.plan.range).toEqual({ startLine: 8, endLine: 15 });
    expect(preview!.childCount).toBe(1);
    const next = applyPlan(DOC, preview!.plan);
    // Alpha 的标题、正文与子节整体消失，Beta 起一字不动。
    expect(next).not.toContain("Alpha");
    expect(next).toContain("## Beta");
  });

  test("末节删除到文档末行", () => {
    const preview = sectionOpPreview({ text: DOC, items: ITEMS, index: 3, action: "delete-section" });
    expect(preview!.plan.range).toEqual({ startLine: 16, endLine: 18 });
  });

  test("写回后：整节消失，残留换行在旧位置留下一个空行（设计内行为）", () => {
    const preview = sectionOpPreview({ text: DOC, items: ITEMS, index: 2, action: "delete-section" })!;
    const lines = applyPlan(DOC, preview.plan).split("\n");
    // `newText=""` 按行替换后会占一行空位，而 endLine 自己的换行仍在契约外
    // （§16.3 第 3 条）—— 两个叠在一起就是旧位置的一个空行，解析无害。
    expect(lines).toEqual([
      ...DOC_LINES.slice(0, 12),
      "",
      ...DOC_LINES.slice(16)
    ]);
  });
});

describe("null 的诚实边界", () => {
  test("目标节没有 position：没有可靠行范围就不给计划", () => {
    const items: OutlineItem[] = [{ id: "x", title: "No pos", level: 1, anchor: "no-pos" }];
    expect(sectionOpPreview({ text: DOC, items, index: 0, action: "delete-section" })).toBeNull();
  });

  test("起始行越界（大纲比源文新一帧）：等回声重来，不猜", () => {
    const items = [heading("Ghost", 1, 999)];
    expect(sectionOpPreview({ text: DOC, items, index: 0, action: "add-sibling-after" })).toBeNull();
  });

  test("index 指不到条目", () => {
    expect(sectionOpPreview({ text: DOC, items: ITEMS, index: 4, action: "delete-section" })).toBeNull();
    expect(sectionOpPreview({ text: DOC, items: ITEMS, index: -1, action: "delete-section" })).toBeNull();
  });

  test("无 position 的后续标题不参与边界与子节计数（宁可少删不越界）", () => {
    const items: OutlineItem[] = [
      ITEMS[0]!,
      ITEMS[1]!,
      { id: "ghost", title: "Ghost", level: 2, anchor: "ghost" },
      ITEMS[2]!,
      ITEMS[3]!
    ];
    const preview = sectionOpPreview({ text: DOC, items, index: 1, action: "delete-section" });
    // 边界仍是有 position 的 Beta（abs 16）→ end 15；Ghost 不计入 childCount。
    expect(preview!.plan.range).toEqual({ startLine: 8, endLine: 15 });
    expect(preview!.childCount).toBe(1);
  });

  test("相邻标题无空行：end 钳在 [start, boundary-1]，不产生倒挂区间", () => {
    const text = "## A\n## B";
    const items = [heading("A", 2, 0), heading("B", 2, 1)];
    const preview = sectionOpPreview({ text, items, index: 0, action: "delete-section" });
    expect(preview!.plan.range).toEqual({ startLine: 0, endLine: 0 });
    // 同一条残留换行规则：删后的首行位置留一个空行，不产生倒挂也不吞邻居。
    expect(applyPlan(text, preview!.plan)).toBe("\n## B");
  });
});
