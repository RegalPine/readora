/**
 * P04 / P05 Processor 链单测（ARC-002 §5.3 固定顺序、§7.1 锚点、§10.2 图形识别）。
 */
import { describe, expect, it } from "vitest";
import { buildAst } from "../ast";
import { countSourceLines } from "../normalize";
import { createMarkdownParser } from "../parser";
import {
  PROCESSORS,
  PROCESSOR_ORDER,
  REGISTERED_PROCESSOR_NAMES,
  RESERVED_PROCESSORS,
  runProcessors
} from "../processors";
import type { MarkdownDocument, MarkdownNode } from "../types";

function documentOf(source: string): MarkdownDocument {
  const tokens = createMarkdownParser().parse(source);
  return buildAst(tokens, "doc-proc", countSourceLines(source));
}

/**
 * CommonMark 不产出 7 级标题（`#######` 是段落），层级钳制只能在
 * Processor 入口验证，故手工构造越界层级的 AST。
 */
function documentWithHeadings(levels: number[]): MarkdownDocument {
  const children: MarkdownNode[] = levels.map((level, index) => ({
    id: `doc-proc|heading|${index}|${index + 1}`,
    type: "heading",
    position: { startLine: index, endLine: index },
    attributes: { level },
    children: [{ id: `doc-proc|text|${index}|${index + 1}`, type: "text", value: `${level} 级` }]
  }));
  return { id: "doc-proc|document|0|0", type: "document", children };
}

function walk(node: MarkdownNode, visit: (current: MarkdownNode) => void): void {
  visit(node);
  for (const child of node.children ?? []) {
    walk(child, visit);
  }
}

function allOf(document: MarkdownDocument, type: string): MarkdownNode[] {
  const found: MarkdownNode[] = [];
  walk(document, (node) => {
    if (node.type === type) {
      found.push(node);
    }
  });
  return found;
}

describe("Processor 顺序不变量（ARC-002 §5.3）", () => {
  it("声明顺序冻结为 frontmatter → heading → codeBlock → csv → math → wikiLink → footnote → asset", () => {
    // M10 新插两个槽位（README「偏差登记（M10）」）：csv 紧跟 codeBlock（它改写的
    // 就是 codeBlock 节点），footnote 排在 wikiLink 之后、asset 之前（要同时改写行内与块级）。
    expect(PROCESSOR_ORDER).toEqual([
      "frontmatter",
      "heading",
      "codeBlock",
      "csv",
      "math",
      "wikiLink",
      "footnote",
      "asset"
    ]);
  });

  it("已注册实现按同一顺序，未落地能力只占位不注册", () => {
    expect(PROCESSORS.map((processor) => processor.name)).toEqual(REGISTERED_PROCESSOR_NAMES);
    // 仍然只剩 asset 未注册：它由 Image Renderer 与 Host 承担（§5.1 注记），
    // 不是一条「还没做完」的待办。名单而不是数字，将来变化时会报出「少了谁」。
    expect(REGISTERED_PROCESSOR_NAMES).toEqual([
      "frontmatter",
      "heading",
      "codeBlock",
      "csv",
      "math",
      "wikiLink",
      "footnote"
    ]);
    expect(RESERVED_PROCESSORS).toEqual(["asset"]);
    for (const reserved of RESERVED_PROCESSORS) {
      expect(REGISTERED_PROCESSOR_NAMES).not.toContain(reserved);
    }
  });

  it("数学公式处理器把标记节点归类为 mathInline / mathBlock（IMP-001 §10.3）", () => {
    const document = runProcessors(documentOf("行内 $x^2$ 与块级\n\n$$\n\\int_0^1 x\n$$\n"));
    expect(allOf(document, "mathInline").map((node) => node.attributes?.source)).toEqual(["x^2"]);
    expect(allOf(document, "mathBlock").map((node) => node.attributes?.source)).toEqual([
      "\\int_0^1 x"
    ]);
    // 归类后不再是 text 节点，id 的类型段同步替换（ARC-002 §4.2 id 携带类型）
    expect(allOf(document, "text").some((node) => "mathSource" in (node.attributes ?? {}))).toBe(false);
    for (const node of [...allOf(document, "mathInline"), ...allOf(document, "mathBlock")]) {
      expect(node.id).toContain("|math");
    }
  });

  it("不成立的表达式摘掉标记即原样还原为散文", () => {
    const document = runProcessors(documentOf("总价 $100 和 $200 都还是文本。\n"));
    expect(allOf(document, "mathInline")).toHaveLength(0);
    expect(allOf(document, "text").map((node) => node.value).join("")).toContain(
      "总价 $100 和 $200"
    );
  });
});

describe("Heading Processor（ARC-002 §7.1）", () => {
  it("层级规范化并钳制到 1..6", () => {
    const document = runProcessors(documentWithHeadings([7, 4, 0, 2.6]));
    const levels = allOf(document, "heading").map((node) => node.attributes?.["level"]);
    expect(levels).toEqual([6, 4, 1, 2]);
  });

  it("真实文档的标题层级由 CommonMark 决定（最深 6 级）", () => {
    const document = runProcessors(documentOf("###### 六级\n\n####### 不是标题\n"));
    const levels = allOf(document, "heading").map((node) => node.attributes?.["level"]);
    expect(levels).toEqual([6]);
  });

  it("锚点写入 attributes.anchor，标题纯文本写入 attributes.text", () => {
    const document = runProcessors(documentOf("## Getting Started\n"));
    const heading = allOf(document, "heading")[0];
    expect(heading?.attributes?.["anchor"]).toBe("getting-started");
    expect(heading?.attributes?.["text"]).toBe("Getting Started");
  });

  it("重复标题追加序号，锚点全局唯一（RND-AC-008 前置）", () => {
    const document = runProcessors(documentOf("# 摘要\n\n# 摘要\n\n# 摘要\n"));
    const anchors = allOf(document, "heading").map((node) => node.attributes?.["anchor"]);
    expect(anchors).toEqual(["摘要", "摘要-1", "摘要-2"]);
    expect(new Set(anchors).size).toBe(anchors.length);
  });

  it("标点与符号从锚点剔除，CJK 保留", () => {
    const document = runProcessors(documentOf("# Hello, World! 世界。\n"));
    expect(allOf(document, "heading")[0]?.attributes?.["anchor"]).toBe("hello-world-世界");
  });

  it("空标题锚点退化为 heading-{level} 而非空串", () => {
    const document = runProcessors(documentOf("### \n"));
    expect(allOf(document, "heading")[0]?.attributes?.["anchor"]).toBe("heading-3");
  });

  it("嵌套不存在的标题也不影响其它标题锚点", () => {
    const document = runProcessors(documentOf("# a\n\n# a\n\n# b\n"));
    expect(allOf(document, "heading").map((node) => node.attributes?.["anchor"])).toEqual([
      "a",
      "a-1",
      "b"
    ]);
  });
});

describe("Code Block Processor（ARC-002 §10.2）", () => {
  it("mermaid 围栏转成 diagramBlock 并保留源码", () => {
    const document = runProcessors(
      documentOf("```mermaid\ngraph TD; A-->B;\n```\n")
    );
    const diagrams = allOf(document, "diagramBlock");
    expect(diagrams).toHaveLength(1);
    expect(diagrams[0]?.attributes?.["source"]).toBe("graph TD; A-->B;\n");
    expect(diagrams[0]?.value).toBe("graph TD; A-->B;\n");
    expect(allOf(document, "codeBlock")).toHaveLength(0);
  });

  it("diagramBlock 节点 ID 类型段同步更新，位置信息保留", () => {
    const document = runProcessors(documentOf("```mermaid\nx\n```\n"));
    const diagram = allOf(document, "diagramBlock")[0];
    expect(diagram?.id).toContain("|diagramBlock|");
    expect(diagram?.position).toEqual({ startLine: 0, endLine: 2 });
  });

  it("语言标识大小写不敏感", () => {
    const document = runProcessors(documentOf("```Mermaid\nx\n```\n"));
    expect(allOf(document, "diagramBlock")).toHaveLength(1);
  });

  it("非图形语言保持 codeBlock", () => {
    const document = runProcessors(documentOf("```javascript\nconst a = 1;\n```\n"));
    expect(allOf(document, "codeBlock")).toHaveLength(1);
    expect(allOf(document, "diagramBlock")).toHaveLength(0);
  });

  it("容器内的代码块同样被递归处理", () => {
    const document = runProcessors(
      documentOf("> ```mermaid\n> graph TD; A-->B;\n> ```\n")
    );
    expect(allOf(document, "diagramBlock")).toHaveLength(1);
  });
});

describe("runProcessors 契约", () => {
  it("返回同一文档对象（就地加工），不复制整棵树", () => {
    const document = documentOf("# a\n");
    expect(runProcessors(document)).toBe(document);
  });

  it("Frontmatter Processor 在管线前置完成，AST 阶段为无占位实现", () => {
    const frontmatter = PROCESSORS.find((processor) => processor.name === "frontmatter");
    expect(frontmatter).toBeDefined();
    expect(() => runProcessors(documentOf("---\ntitle: x\n---\n\n# a\n"))).not.toThrow();
  });
});
