/**
 * P03 AST Builder 单测（ARC-002 §4，验收 RND-AC-002）。
 *
 * 锁定三件事：节点类型映射正确、位置信息完整、节点 ID 稳定可复现。
 */
import { describe, expect, it } from "vitest";
import { buildAst } from "../ast";
import { countSourceLines } from "../normalize";
import { createMarkdownParser } from "../parser";
import type { MarkdownNode } from "../types";

const RICH_SOURCE = [
  "# 标题",
  "",
  "段落 **粗** 与 [链接](https://example.com) 与 ![图](https://example.com/a.png)。",
  "",
  "- 项目一",
  "- 项目二",
  "  - 嵌套",
  "",
  "1. 有序一",
  "2. 有序二",
  "",
  "> 引用",
  ">",
  "> > 嵌套引用",
  "",
  "| a | b |",
  "| :-- | --: |",
  "| 1 | 2 |",
  "",
  "```python",
  "print(1)",
  "```",
  "",
  "---",
  "",
  "任务：",
  "",
  "- [x] 已完成",
  "- [ ] 未完成",
  ""
].join("\n");

function ast(source = RICH_SOURCE): ReturnType<typeof buildAst> {
  const tokens = createMarkdownParser().parse(source);
  return buildAst(tokens, "doc-ast", countSourceLines(source));
}

function walk(node: MarkdownNode, visit: (current: MarkdownNode) => void): void {
  visit(node);
  for (const child of node.children ?? []) {
    walk(child, visit);
  }
}

/** 收集全部文本节点值，用于验证软换行折叠成 "\n" 文本节点。 */
function textValues(node: MarkdownNode): string[] {
  const values: string[] = [];
  walk(node, (current) => {
    if (current.type === "text" && typeof current.value === "string") {
      values.push(current.value);
    }
  });
  return values;
}

function typesOf(document: ReturnType<typeof buildAst>): Set<string> {
  const found = new Set<string>();
  walk(document, (node) => found.add(node.type));
  return found;
}

function findFirst(document: ReturnType<typeof buildAst>, type: string): MarkdownNode | undefined {
  let result: MarkdownNode | undefined;
  walk(document, (node) => {
    if (!result && node.type === type) {
      result = node;
    }
  });
  return result;
}

describe("buildAst 节点类型（RND-AC-002）", () => {
  it("富文本样例覆盖全部 M2 节点类型", () => {
    const found = typesOf(ast());
    for (const expected of [
      "document",
      "heading",
      "paragraph",
      "text",
      "strong",
      "link",
      "image",
      "list",
      "listItem",
      "blockquote",
      "table",
      "tableRow",
      "tableCell",
      "codeBlock",
      "thematicBreak"
    ]) {
      expect(found.has(expected), expected).toBe(true);
    }
  });

  it("行内码与删除线映射到冻结类型", () => {
    const document = ast("行内 `code` 与 ~~删除~~\n");
    const types = typesOf(document);
    expect(types.has("inlineCode")).toBe(true);
    expect(types.has("delete")).toBe(true);
  });

  it("硬换行映射 break，软换行折叠为文本换行", () => {
    expect(typesOf(ast("a  \nb\n")).has("break")).toBe(true);
    const soft = ast("a\nb\n");
    expect(typesOf(soft).has("break")).toBe(false);
    // softbreak 生成独立的 "\n" 文本节点，拼接后与原文一致
    expect(textValues(soft)).toEqual(["a", "\n", "b"]);
    expect(textValues(soft).join("")).toBe("a\nb");
  });

  it("任务列表在 AST 层打标（markdown-it 原生不支持）", () => {
    const document = ast("- [x] done\n- [ ] todo\n");
    const items = (document.children?.[0]?.children ?? []).filter(
      (node) => node.type === "listItem"
    );
    expect(items[0]?.attributes?.["task"]).toBe(true);
    expect(items[0]?.attributes?.["checked"]).toBe(true);
    expect(items[1]?.attributes?.["checked"]).toBe(false);
    // 标记从正文中剥离，避免渲染出字面 [x]
    expect(JSON.stringify(items[0])).not.toContain("[x]");
  });

  it("tight 列表项不产生隐藏 paragraph 节点", () => {
    const document = ast("- 一\n- 二\n");
    const item = findFirst(document, "listItem");
    const kinds = new Set((item?.children ?? []).map((child) => child.type));
    expect(kinds.has("paragraph")).toBe(false);
    expect(kinds.has("text")).toBe(true);
  });

  it("表格单元格保留表头与对齐信息", () => {
    const document = ast();
    const cells = (findFirst(document, "tableRow")?.children ?? []).filter(
      (node) => node.type === "tableCell"
    );
    expect(cells[0]?.attributes?.["header"]).toBe(true);
    expect(cells[0]?.attributes?.["align"]).toBe("left");
    expect(cells[1]?.attributes?.["align"]).toBe("right");
  });

  it("围栏代码块语言标识进入 attributes.lang，内容保留在 value", () => {
    const block = findFirst(ast(), "codeBlock");
    expect(block?.attributes?.["lang"]).toBe("python");
    expect(block?.value).toBe("print(1)\n");
  });

  it("无语言围栏与缩进代码块 lang 缺省", () => {
    expect(findFirst(ast("```\nx\n```\n"), "codeBlock")?.attributes?.["lang"]).toBeUndefined();
    // markdown-it 已剥掉缩进代码块的 4 空格缩进，value 存去缩进后的正文
    const indented = findFirst(ast("    indented\n"), "codeBlock");
    expect(indented?.attributes?.["lang"]).toBeUndefined();
    expect(indented?.value).toBe("indented\n");
  });
});

describe("buildAst 位置信息（ARC-002 §4.1）", () => {
  it("块级节点均带 startLine / endLine", () => {
    const document = ast();
    const missing: string[] = [];
    walk(document, (node) => {
      const blockLevel = ["heading", "paragraph", "list", "blockquote", "table", "codeBlock", "thematicBreak"];
      if (blockLevel.includes(node.type) && !node.position) {
        missing.push(node.id);
      }
    });
    expect(missing).toEqual([]);
  });

  it("document 根节点覆盖全文行范围", () => {
    const document = ast("# a\n\nb\n");
    expect(document.position).toEqual({ startLine: 0, endLine: 2 });
  });

  it("endLine 不小于 startLine（单行块）", () => {
    const heading = findFirst(ast("# 单行\n"), "heading");
    expect(heading?.position).toEqual({ startLine: 0, endLine: 0 });
  });
});

describe("buildAst 节点 ID（ARC-002 §4.4）", () => {
  it("ID 组成为 文档标识|类型|起始行|序号", () => {
    const heading = findFirst(ast("# 标题\n"), "heading");
    expect(heading?.id).toMatch(/^doc-ast\|heading\|0\|\d+$/);
  });

  it("同一输入两次构建 ID 完全一致（禁止随机 ID）", () => {
    expect(JSON.stringify(ast())).toBe(JSON.stringify(ast()));
  });

  it("文档标识参与 ID，不同文档不冲突", () => {
    const tokens = createMarkdownParser().parse("# 标题\n");
    const other = buildAst(tokens, "doc-other", 2);
    expect(other.children?.[0]?.id.startsWith("doc-other|heading|")).toBe(true);
  });

  it("ID 在整棵树内唯一", () => {
    const document = ast();
    const seen = new Set<string>();
    const duplicates: string[] = [];
    walk(document, (node) => {
      if (seen.has(node.id)) {
        duplicates.push(node.id);
      }
      seen.add(node.id);
    });
    expect(duplicates).toEqual([]);
  });
});

describe("buildAst 兜底行为（ARC-002 §14.3 第 5 条）", () => {
  it("未知块级容器透明穿透，内容不丢", () => {
    const document = buildAst(
      [
        {
          type: "mystery_open",
          nesting: 1,
          map: [0, 1],
          content: "",
          children: null,
          attrGet: () => null
        }
      ] as unknown as Parameters<typeof buildAst>[0],
      "doc-ast",
      1
    );
    expect(JSON.stringify(document)).toContain("doc-ast|document");
  });

  it("未闭合容器不会让栈越界", () => {
    const document = ast("> 引用\n\n- 列表\n");
    expect(document.children?.length).toBeGreaterThan(0);
  });
});

describe("buildAst 脚注与块属性（M10）", () => {
  // 这两条是「token 不再走 default 穿透」的回归防线：default 分支会把未知容器
  // 拆成透明段落，脚注定义的内容因此会变成正文，F01-017 外表上仍然「没报错」。
  it("footnote token 落成脚注节点，不是透明段落", () => {
    const document = ast("引 [^a]。\n\n[^a]: 定义。\n");
    expect(typesOf(document).has("footnoteDefinition")).toBe(true);
    expect(typesOf(document).has("footnoteReference")).toBe(true);
    const definition = findFirst(document, "footnoteDefinition");
    expect(definition?.attributes?.["label"]).toBe("a");
    expect(definition?.children && definition.children.length).toBeGreaterThan(0);
    const reference = findFirst(document, "footnoteReference");
    // value 保留 `[^label]` 原文：处理器判不成时摘掉标记就是字面量显示
    expect(reference?.value).toBe("[^a]");
    expect(textValues(document).join("")).not.toContain("[^a]: 定义");
  });

  it("白名单块属性从 token.attrs 搬进节点 attributes（原键名字符串值）", () => {
    const document = ast("# 标题 {align=center}\n\n正文\n");
    const heading = findFirst(document, "heading");
    expect(heading?.attributes?.["align"]).toBe("center");
    expect(heading?.attributes?.["level"]).toBe(1);
    // 不在白名单里的键不会进 AST（attrs 规则不记录，AST 也不拾取）
    expect(JSON.stringify(heading?.attributes ?? {})).not.toContain("json");
  });

  it("围栏与图片的属性各自落到对应节点", () => {
    const document = ast('```js {filename="app.js"}\nx\n```\n\n![图](a.png){width=50%}\n');
    expect(findFirst(document, "codeBlock")?.attributes?.["filename"]).toBe("app.js");
    expect(findFirst(document, "codeBlock")?.attributes?.["lang"]).toBe("js");
    expect(findFirst(document, "image")?.attributes?.["width"]).toBe("50%");
  });
});
