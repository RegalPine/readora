/**
 * 脚注用例（PRD-001 F01-017，M10）。
 *
 * 断言分四层，与 math / wiki-link 同一口径：
 * 1. 规则层：什么才算 `[^label]`，什么必须原样留在正文；
 * 2. 配对层：编号按首次引用顺序、定义可以先写也可以后写、多定义合并；
 * 3. 还原层：判不成就是字面量 + info 诊断，绝不摆一个跳不到的锚点；
 * 4. 产物层：class / 锚点 / 目录不受影响 / 上限截断。
 *
 * 第 1 组里的「link 不吃脚注」是本轮真正的回归防线：
 * 在未装规则之前，`[^note]: 正文` 会被 `reference` 当成链接引用定义吞掉、
 * `[^note]` 会被 `link` 认成 shortcut 引用，产物是 `<a href="正文">^note</a>` ——
 * 那不是「没渲染成脚注」，是内容损坏（AUD-001 §4.4）。
 */
import { describe, expect, it } from "vitest";
import { buildAst } from "../ast";
import { RENDER_DIAGNOSTIC_CODES } from "../diagnostics";
import { renderMarkdown } from "../index";
import { countSourceLines } from "../normalize";
import { createMarkdownParser } from "../parser";
import { runProcessors } from "../processors";
import {
  FOOTNOTE_MAX_ITEMS,
  FOOTNOTE_MAX_LABEL,
  footnoteAnchor,
  footnoteRefAnchor,
  isUsableFootnoteLabel,
  scanFootnoteLabel
} from "../footnote";
import { DOCUMENT_ID, DOCUMENT_URI } from "./helpers";
import type { MarkdownDocument, MarkdownNode } from "../types";

function documentOf(source: string): MarkdownDocument {
  const tokens = createMarkdownParser().parse(source);
  return runProcessors(buildAst(tokens, DOCUMENT_ID, countSourceLines(source)));
}

function walk(node: MarkdownNode, collect: (node: MarkdownNode) => void): void {
  collect(node);
  for (const child of node.children ?? []) {
    walk(child, collect);
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

function render(text: string): ReturnType<typeof renderMarkdown> {
  return renderMarkdown({ documentId: DOCUMENT_ID, documentUri: DOCUMENT_URI, version: 1, text });
}

function container(html: string): HTMLElement {
  const dom = new DOMParser().parseFromString(`<div>${html}</div>`, "text/html");
  return dom.body.firstElementChild as HTMLElement;
}

function codesOf(result: ReturnType<typeof renderMarkdown>): string[] {
  return result.diagnostics.map((item) => item.code);
}

describe("脚注规则层（footnote.ts）", () => {
  it("标签形状：[^1] / [^note] 认领，空标签、含空白、含方括号不认", () => {
    expect(scanFootnoteLabel("[^1]", 0)?.label).toBe("1");
    expect(scanFootnoteLabel("[^note]", 0)?.raw).toBe("[^note]");
    expect(scanFootnoteLabel("[^]", 0)).toBeNull();
    expect(scanFootnoteLabel("[^two words]", 0)).toBeNull();
    expect(scanFootnoteLabel("[^a]b]", 0)?.label).toBe("a");
    expect(scanFootnoteLabel("x[^1]", 0)).toBeNull();
    expect(scanFootnoteLabel("x[^1]", 1)?.raw).toBe("[^1]");
  });

  it("超长标签不认，且上限与判定函数同源", () => {
    const longest = `[^${"a".repeat(FOOTNOTE_MAX_LABEL)}]`;
    const tooLong = `[^${"a".repeat(FOOTNOTE_MAX_LABEL + 1)}]`;
    expect(scanFootnoteLabel(longest, 0)?.label).toHaveLength(FOOTNOTE_MAX_LABEL);
    expect(scanFootnoteLabel(tooLong, 0)).toBeNull();
    expect(isUsableFootnoteLabel("a b")).toBe(false);
  });

  it("转义写法 `\\[^1]` 不认成引用", () => {
    const result = render("转义写法 \\[^1] 不是脚注。\n\n[^1]: 定义。\n");
    expect(result.html).not.toContain("readora-footnote-ref");
    expect(result.html).toContain("[^1]");
  });

  it("数字与字母标签都不再被 link 规则吃成 `<a href=\"定义\">`", () => {
    const result = render("见第一处 [^1] 与第二处 [^note]。\n\n[^1]: 第一条。\n[^note]: 第二条。\n");
    expect(result.html).not.toContain("readora-link--external");
    expect(result.html).not.toContain("href=\"第一条");
    expect(container(result.html).querySelectorAll(".readora-footnote-ref")).toHaveLength(2);
  });

  it("`[^label]:` 定义行从正文消失，内容进脚注区", () => {
    const result = render("正文 [^a]。\n\n[^a]: 定义文本。\n");
    const root = container(result.html);
    expect(root.textContent).not.toContain("[^a]: 定义文本");
    expect(root.querySelector(".readora-footnotes")?.textContent).toContain("定义文本");
  });
});

describe("脚注配对与编号（footnote 处理器）", () => {
  it("编号按首次引用顺序，与定义书写顺序无关", () => {
    const document = documentOf("先 [^b] 再 [^a]。\n\n[^a]: A。\n[^b]: B。\n");
    const references = allOf(document, "footnoteReference");
    expect(references.map((node) => node.attributes?.["index"])).toEqual([1, 2]);
    expect(references.map((node) => node.attributes?.["label"])).toEqual(["b", "a"]);
    const items = allOf(document, "footnoteItem");
    expect(items.map((node) => node.attributes?.["index"])).toEqual([1, 2]);
    expect(items.map((node) => node.attributes?.["label"])).toEqual(["b", "a"]);
  });

  it("未被引用的定义仍进脚注区，编号排在已引用条目之后", () => {
    const document = documentOf("只引 [^a]。\n\n[^z]: 没人引。\n[^a]: A。\n");
    const items = allOf(document, "footnoteItem");
    expect(items.map((node) => node.attributes?.["label"])).toEqual(["a", "z"]);
    expect(items.map((node) => node.attributes?.["index"])).toEqual([1, 2]);
  });

  it("定义在引用之后同样配对（两遍扫描）", () => {
    const result = render("引用在后写的定义 [^x]。\n\n[^x]: 定义了。\n");
    expect(result.html).toContain("#readora-fn-1");
    expect(codesOf(result)).not.toContain(RENDER_DIAGNOSTIC_CODES.FOOTNOTE_UNRESOLVED);
  });

  it("同名标签的多条定义合并进同一个条目，内容不丢", () => {
    const document = documentOf("引用 [^d]。\n\n[^d]: 第一段。\n[^d]: 第二段。\n");
    const items = allOf(document, "footnoteItem");
    expect(items).toHaveLength(1);
    expect(allOf(document, "footnoteDefinition")).toHaveLength(0);
    const section = document.children.filter((node) => node.type === "footnoteSection");
    expect(section).toHaveLength(1);
  });

  it("重复引用同一脚注：同编号、不同 refAnchor，id 不撞车", () => {
    const result = render("第一处 [^a]，第二处 [^a]。\n\n[^a]: 定义。\n");
    const refs = [...result.html.matchAll(/id="(readora-fnref-[^"]+)"/g)].map((match) => match[1]);
    expect(refs).toEqual(["readora-fnref-1", "readora-fnref-1-2"]);
    expect(result.html).toContain("href=\"#readora-fn-1\"");
  });

  it("脚注区里的引用也参与编号", () => {
    const document = documentOf("引 [^a]。\n\n[^a]: 内含 [^b]。\n[^b]: B。\n");
    const items = allOf(document, "footnoteItem");
    expect(items.map((node) => node.attributes?.["index"])).toEqual([1, 2]);
  });
});

describe("脚注还原与诊断", () => {
  it("没有定义的引用还原成字面量 + info 诊断", () => {
    const result = render("孤儿引用 [^gone]。\n");
    expect(result.html).toContain("[^gone]");
    expect(result.html).not.toContain("readora-footnote-ref");
    expect(codesOf(result)).toContain(RENDER_DIAGNOSTIC_CODES.FOOTNOTE_UNRESOLVED);
    const diagnostic = result.diagnostics.find(
      (item) => item.code === RENDER_DIAGNOSTIC_CODES.FOOTNOTE_UNRESOLVED
    );
    expect(diagnostic?.severity).toBe("info");
  });

  it("只有定义没有引用时仍然产出脚注区（内容不丢）", () => {
    const result = render("正文没有引用。\n\n[^only]: 只写了定义。\n");
    expect(container(result.html).querySelectorAll(".readora-footnote-item")).toHaveLength(1);
    expect(result.html).toContain("只写了定义");
  });

  it("脚注定义里的公式与链接照常生效", () => {
    const result = render("引 [^m]。\n\n[^m]: 公式 $E=mc^2$ 与[外链](https://example.com)。\n");
    expect(result.html).toContain("readora-math");
    expect(result.html).toContain("readora-link--external");
  });

  it("条目数超上限即截断并记 warning", () => {
    const total = FOOTNOTE_MAX_ITEMS + 5;
    const refs = Array.from({ length: total }, (_unused, index) => `[^f${index}]`).join(" ");
    const defs = Array.from(
      { length: total },
      (_unused, index) => `[^f${index}]: 定义 ${index}。`
    ).join("\n");
    const result = render(`${refs} 正文。\n\n${defs}\n`);
    expect(container(result.html).querySelectorAll(".readora-footnote-item")).toHaveLength(
      FOOTNOTE_MAX_ITEMS
    );
    expect(codesOf(result)).toContain(RENDER_DIAGNOSTIC_CODES.FOOTNOTE_LIMIT);
  });
});

describe("脚注产物结构（renderers/footnote.ts）", () => {
  it("引用与回跳都写 data-readora-anchor，跳转复用既有委托", () => {
    const result = render("引用 [^a]。\n\n[^a]: 定义。\n");
    const root = container(result.html);
    const ref = root.querySelector(".readora-footnote-ref") as HTMLElement;
    expect(ref.getAttribute("data-readora-anchor")).toBe(footnoteAnchor(1));
    expect(ref.id).toBe(footnoteRefAnchor(1, 1));
    const backref = root.querySelector(".readora-footnote-backref") as HTMLElement;
    expect(backref.getAttribute("data-readora-anchor")).toBe(footnoteRefAnchor(1, 1));
    expect(root.querySelector(".readora-footnote-item")?.id).toBe(footnoteAnchor(1));
  });

  it("只用白名单标签：没有 sup / section / style", () => {
    const result = render("引用 [^a]。\n\n[^a]: 定义。\n");
    expect(result.html).not.toContain("<sup");
    expect(result.html).not.toContain("<section");
    expect(result.html).not.toContain("style=");
  });

  it("脚注标题不是 heading 节点：目录不会多出一条「脚注」", () => {
    const result = render("# 章\n\n引用 [^a]。\n\n[^a]: 定义。\n");
    expect(result.outline.map((item) => item.title)).toEqual(["章"]);
  });

  it("文档没有脚注时不产出脚注区", () => {
    const result = render("普通正文。\n");
    expect(result.html).not.toContain("readora-footnotes");
  });
});
