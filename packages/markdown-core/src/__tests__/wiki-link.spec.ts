/**
 * Wiki Link 单测（IMP-001 §12.2 / ARC-002 §5.3，STORY-06-03）。
 *
 * 覆盖四层，每层都只锁自己的事：
 * 1. 规则层（scanWikiLink / 分词）：`[[…]]` 的认领边界，以及它不吃掉合法 Markdown；
 * 2. AST 层：命中后是「带 wikiTarget 标记的 text」，归类尚未发生；
 * 3. 处理器层：可跳转 → wikiLink 节点；不可跳转 → 摘标记、原文按字面量显示；
 * 4. 渲染 + 净化层：产物只有 `data-readora-wikilink`，**没有 href**，
 *    且这个属性在 sanitize 之后仍然在（否则点击通道就是断的）。
 */
import { describe, expect, it } from "vitest";
import { buildAst } from "../ast";
import { countSourceLines, normalizeSource } from "../normalize";
import { createMarkdownParser } from "../parser";
import { runProcessors } from "../processors";
import { type MarkdownDocument, type MarkdownNode } from "../index";
import {
  WIKI_LINK_MAX_LENGTH,
  isResolvableWikiTarget,
  scanWikiLink,
  wikiLinkLabel
} from "../wiki-link";
import { htmlOf, render } from "./helpers";

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

/** 走完「分词 → AST → 处理器」但不渲染：用来分别断言两阶段的职责。 */
function processed(source: string, options: { classify?: boolean } = {}): MarkdownDocument {
  const tokens = createMarkdownParser().parse(normalizeSource(source));
  const document = buildAst(tokens, "doc-wiki", countSourceLines(source));
  return options.classify === false ? document : runProcessors(document);
}

describe("规则层：什么算一条 `[[…]]`", () => {
  it("目标与别名按第一个 `|` 分割，取第一个 `]]` 闭合", () => {
    expect(scanWikiLink("[[Note|我的笔记]]", 0)).toMatchObject({
      target: "Note",
      alias: "我的笔记",
      raw: "[[Note|我的笔记]]"
    });
    // 第三个 `|` 属于别名，不是新的分隔位。
    expect(scanWikiLink("[[a|b|c]]", 0)).toMatchObject({ target: "a", alias: "b|c" });
  });

  it("定界符内外空白被裁掉，空目标不认", () => {
    expect(scanWikiLink("[[  Note  ]]", 0)?.target).toBe("Note");
    expect(scanWikiLink("[[]]", 0)).toBeNull();
    expect(scanWikiLink("[[   |别名]]", 0)).toBeNull();
    expect(scanWikiLink("[未闭合", 0)).toBeNull();
  });

  it("不跨行：多段落之间不该被一条引用连起来", () => {
    expect(scanWikiLink("[[第一行\n第二行]]", 0)).toBeNull();
  });

  it("超长不认（拒绝把数据塞进一条引用的写法）", () => {
    const huge = `[[${"x".repeat(WIKI_LINK_MAX_LENGTH + 1)}]]`;
    expect(scanWikiLink(huge, 0)).toBeNull();
  });

  it("合法 Markdown 链接不被劫持，代码片段里的方括号原样保留", () => {
    // `[text](url)` 里没有 `]]`，规则不认领，`link` 规则照旧生效。
    const link = htmlOf("参见 [文档](https://example.com/a)\n");
    expect(link).toContain("readora-link--external");
    expect(link).not.toContain("readora-wikilink");

    // 反引号规则在 markdown-it 默认顺序里排在 link 之前，本规则插在其后，
    // 所以代码片段的内容早在分词阶段就成了 code_inline，轮不到 `[[`。
    const code = htmlOf("`[[Not a link]]`\n");
    expect(code).toContain('class="readora-inline-code"');
    expect(code).toContain("[[Not a link]]");
    expect(code).not.toContain("readora-wikilink");
  });
});

describe("两阶段职责：AST 只标记，处理器才归类", () => {
  it("AST 阶段是带 wikiTarget 标记的 text，值仍是 `[[…]]` 原文", () => {
    const document = processed("[[Note]]\n", { classify: false });
    const marked = allOf(document, "text").filter((node) => node.attributes?.wikiTarget);
    expect(marked.map((node) => node.value)).toEqual(["[[Note]]"]);
    expect(allOf(document, "wikiLink")).toEqual([]);
  });

  it("可跳转目标归为 wikiLink 节点，节点 ID 的类型段同步替换", () => {
    const document = processed("参见 [[Note|我的笔记]]。\n");
    const [node] = allOf(document, "wikiLink");
    expect(node?.attributes).toEqual({ target: "Note", label: "我的笔记" });
    expect(node?.id).toContain("|wikiLink|");
  });

  it("不可跳转的写法摘掉标记，按字面量显示，正文一个字不丢", () => {
    const html = htmlOf("[[http://example.com]] 与 [[/etc/passwd]] 与 [[Note#章节]]。\n");
    expect(html).not.toContain("readora-wikilink");
    // 三条原样可见：不撒谎的前提是「看得见自己写错了什么」。
    expect(html).toContain("[[http://example.com]]");
    expect(html).toContain("[[/etc/passwd]]");
    expect(html).toContain("[[Note#章节]]");
  });

  it("目标为绝对路径、scheme、盘符、锚点、块引用时都不可跳转", () => {
    for (const target of [
      "/abs/Note",
      "\\abs\\Note",
      "file:///vault/Note.md",
      "mailto:a@b.c",
      "C:\\vault\\Note",
      "Note#Section",
      "Note^block"
    ]) {
      expect(isResolvableWikiTarget(target), target).toBe(false);
    }
    // 相对路径与 `..` 留给 Host 判边界，这里不拒（vault 内跨目录是常规写法）。
    for (const target of ["Note", "notes/Archive", "../sibling/Note", "带 空格 的笔记"]) {
      expect(isResolvableWikiTarget(target), target).toBe(true);
    }
  });

  it("显示文本：别名优先，缺省用目标原文", () => {
    expect(wikiLinkLabel("Note", "我的笔记")).toBe("我的笔记");
    expect(wikiLinkLabel("Note", "")).toBe("Note");
  });
});

describe("渲染与净化：只有 data 属性，没有 href", () => {
  it("产物是带定位属性的链接，且不含 href", () => {
    const html = htmlOf("[[Note|我的笔记]]\n");
    expect(html).toContain('class="readora-link readora-link--wikilink"');
    expect(html).toContain('data-readora-wikilink="Note"');
    expect(html).toContain(">我的笔记</a>");
    expect(html).not.toContain("href=");
  });

  it("属性值经 sanitize 后仍在：点击通道的两端都读得到它", () => {
    // 这一条不是形式检查 —— 若 DOMPurify 把 data-* 剥掉，正文里就只剩一个
    // 按下去没有任何反应的 `<a>`。目标名带空格与引号都要活下来。
    const result = render('![[带 空格 "引号"]]\n');
    expect(result.html).toContain("readora-wikilink");
    const holder = /data-readora-wikilink="([^"]*)"/.exec(result.html)?.[1];
    expect(holder).toBe("带 空格 &quot;引号&quot;");
  });

  it("目标里的 `<` 不会变成结构：属性与文本都是转义后的字面量", () => {
    const html = htmlOf("[[<img src=x onerror=alert(1)>]]\n");
    // 真正要证明的是「没有生成元素」：`<img` 一个都不许出现。
    expect(html).not.toMatch(/<img\b/i);
    expect(html.match(/data-readora-wikilink="([^"]*)"/u)?.[1]).toBe(
      "&lt;img src=x onerror=alert(1)&gt;"
    );
    // `onerror=alert(1)` 作为**可见文本**留着是对的：作者写了什么就得看得见什么，
    // 把它删掉才是丢内容。它出现在属性值与文本节点里，两处都不是属性/标签位。
    expect((html.match(/<img\b/giu) ?? []).length).toBe(0);
  });

  it("一条文档里多处引用各自成链，顺序与源码一致", () => {
    const html = htmlOf("[[A]] 与 [[B|乙]] 与 [[A]]\n");
    const matches = [...html.matchAll(/data-readora-wikilink="([^"]*)"/g)].map((m) => m[1]);
    expect(matches).toEqual(["A", "B", "A"]);
  });

  it("wiki 引用与文档内锚点、图片共存时各走各的通道", () => {
    const html = htmlOf("![图](pic.png) 见 [[Note]] 与 [顶部](#top)\n");
    expect(html).toContain("readora-wikilink");
    expect(html).toContain("data-readora-anchor");
    expect(html).toContain("data-readora-image");
  });

  it("渲染管线不因 wiki 引用产生诊断，也不影响大纲", () => {
    const result = render("---\ntitle: T\n---\n\n# 标题\n\n[[Note]]\n");
    expect(result.diagnostics.filter((item) => item.severity === "error")).toEqual([]);
    expect(result.outline.map((item) => item.title)).toEqual(["标题"]);
  });
});
