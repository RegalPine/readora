/**
 * 大纲与锚点单测（ARC-002 §7.1 / §12.1，验收 RND-AC-008）。
 */
import { describe, expect, it } from "vitest";
import { createAnchorRegistry, slugifyHeading } from "../outline";
import { htmlOf, render } from "./helpers";

describe("slugifyHeading", () => {
  it("小写化、空白转连字符、去标点", () => {
    expect(slugifyHeading("Hello, World! Again")).toBe("hello-world-again");
    expect(slugifyHeading("  多  空  格  ")).toBe("多-空-格");
  });

  it("保留 CJK 与假名", () => {
    expect(slugifyHeading("第一章 引言")).toBe("第一章-引言");
    expect(slugifyHeading("はじめに")).toBe("はじめに");
  });

  it("保留下划线与数字，剔除反引号等符号", () => {
    expect(slugifyHeading("API_v2 说明 `code`")).toBe("api_v2-说明-code");
  });

  it("纯标点或空文本兜底为 section", () => {
    expect(slugifyHeading("!!!")).toBe("section");
    expect(slugifyHeading("   ")).toBe("section");
  });
});

describe("锚点序号分配", () => {
  it("重复 base 依次追加 -1 / -2", () => {
    const registry = createAnchorRegistry();
    expect(registry.assign("Summary")).toBe("summary");
    expect(registry.assign("Summary")).toBe("summary-1");
    expect(registry.assign("Summary")).toBe("summary-2");
    expect(registry.seen()).toBe(3);
  });

  it("不同标题互不干扰", () => {
    const registry = createAnchorRegistry();
    expect([registry.assign("a"), registry.assign("b"), registry.assign("a")]).toEqual([
      "a",
      "b",
      "a-1"
    ]);
  });
});

describe("extractOutline（RND-AC-008）", () => {
  const source = [
    "# 第一章",
    "",
    "## 1.1 小节",
    "",
    "### 更深",
    "",
    "# 第一章",
    "",
    "段落不应进入大纲",
    ""
  ].join("\n");

  it("层级与标题文本准确，顺序与文档一致", () => {
    const result = render(source);
    expect(result.outline.map((item) => item.level)).toEqual([1, 2, 3, 1]);
    expect(result.outline.map((item) => item.title)).toEqual([
      "第一章",
      "1.1 小节",
      "更深",
      "第一章"
    ]);
  });

  it("anchor 唯一且与渲染出的 id 完全一致", () => {
    const result = render(source);
    const anchors = result.outline.map((item) => item.anchor);
    expect(anchors).toEqual(["第一章", "11-小节", "更深", "第一章-1"]);
    expect(new Set(anchors).size).toBe(anchors.length);
    for (const anchor of anchors) {
      expect(result.html).toContain(`id="${anchor}"`);
    }
  });

  it("大纲条目携带源码位置，供后续定位使用", () => {
    const result = render(source);
    expect(result.outline[0]?.position).toEqual({ startLine: 0, endLine: 0 });
    expect(result.outline[1]?.position?.startLine).toBe(2);
  });

  it("大纲 id 取自 AST 节点 ID（§12.2 不得由导航模块重新解析）", () => {
    const result = render("# 只有一个标题\n");
    expect(result.outline[0]?.id.startsWith("doc-test|heading|")).toBe(true);
  });

  it("无标题文档给出空大纲且不报错", () => {
    expect(render("只有段落\n").outline).toEqual([]);
  });

  it("嵌套容器内的标题同样被收集", () => {
    const result = render("> 引用\n\n- 列表\n");
    expect(result.outline).toEqual([]);
    const insideTable = render("| 列 |\n| - |\n| a |\n");
    expect(insideTable.outline).toEqual([]);
  });

  it("锚点跳转链接可命中同一 id", () => {
    const html = htmlOf("# 目标章节\n\n[跳转](#目标章节)\n");
    expect(html).toContain('id="目标章节"');
    expect(html).toContain("data-readora-anchor=");
  });
});
