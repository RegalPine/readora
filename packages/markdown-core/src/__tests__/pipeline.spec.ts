/**
 * 渲染结果契约单测（ARC-002 §12.1 / §13.1，IMP-001 §8.4）。
 */
import { describe, expect, it } from "vitest";
import { renderMarkdown, type MarkdownRenderResult, type RenderRequest } from "../index";
import { DOCUMENT_ID, DOCUMENT_URI, render } from "./helpers";

const SOURCE = "---\ntitle: 契约\n---\n\n# 章节 A\n\n## 章节 B\n\n正文与 `代码`\n";

describe("MarkdownRenderResult 字段（§12.1）", () => {
  it("六个字段齐备且类型正确", () => {
    const result = render(SOURCE);
    expect(Object.keys(result).sort()).toEqual([
      "diagnostics",
      "documentId",
      "html",
      "metadata",
      "outline",
      "version"
    ]);
    expect(result.documentId).toBe(DOCUMENT_ID);
    expect(typeof result.html).toBe("string");
    expect(Array.isArray(result.outline)).toBe(true);
    expect(Array.isArray(result.diagnostics)).toBe(true);
    expect(Array.isArray(result.metadata.tags)).toBe(true);
  });

  it("documentId / version 原样透传，供应用层做投递门控", () => {
    const request: RenderRequest = {
      documentId: "doc-42",
      documentUri: DOCUMENT_URI,
      version: 7,
      text: "# a\n"
    };
    const result: MarkdownRenderResult = renderMarkdown(request);
    expect(result.documentId).toBe("doc-42");
    expect(result.version).toBe(7);
  });

  it("节点 ID 以 documentId 前缀，跨文档不冲突（§4.4）", () => {
    const result = renderMarkdown({
      documentId: "doc-42",
      documentUri: DOCUMENT_URI,
      version: 1,
      text: "# a\n"
    });
    expect(result.outline[0]?.id.startsWith("doc-42|heading|")).toBe(true);
  });

  it("metadata 与 outline 从同一 AST 产出（§12.2 不重复解析）", () => {
    const result = render(SOURCE);
    expect(result.metadata.title).toBe("契约");
    expect(result.outline.map((item) => item.anchor)).toEqual(["章节-a", "章节-b"]);
  });
});

describe("产物形态约束（IMP-001 §8.4 / ARC-008 §11.1）", () => {
  it("不产出内联 style 与内联事件，样式归 class", () => {
    const result = render(
      "# 标题\n\n<span style=\"color:red\">文字</span>\n\n```js\nlet a=1\n```\n\n| a | b |\n| - | - |\n| 1 | 2 |\n"
    );
    // 只看真实 DOM 结构：转义后的可见文本允许出现 style / on* 字面量
    const root = new DOMParser().parseFromString(`<div>${result.html}</div>`, "text/html");
    const offenders: string[] = [];
    for (const element of Array.from(root.body.querySelectorAll("*"))) {
      for (const name of element.getAttributeNames()) {
        if (name === "style" || /^on[a-z]+$/i.test(name)) {
          offenders.push(`${element.tagName.toLowerCase()}/${name}`);
        }
      }
    }
    expect(offenders).toEqual([]);
    expect(result.html).toContain('class="readora-paragraph"');
    expect(result.html).toContain('class="readora-table"');
  });

  it("产物只使用白名单标签", () => {
    const result = render(SOURCE);
    const root = new DOMParser().parseFromString(`<div>${result.html}</div>`, "text/html");
    const allowed = new Set([
      "DIV",
      "H1",
      "H2",
      "H3",
      "H4",
      "H5",
      "H6",
      "P",
      "BR",
      "HR",
      "STRONG",
      "EM",
      "DEL",
      "CODE",
      "PRE",
      "BLOCKQUOTE",
      "UL",
      "OL",
      "LI",
      "TABLE",
      "THEAD",
      "TBODY",
      "TR",
      "TH",
      "TD",
      "A",
      "SPAN",
      "BUTTON"
    ]);
    const unexpected = Array.from(root.body.querySelectorAll("*"))
      .map((element) => element.tagName)
      .filter((tagName) => !allowed.has(tagName));
    expect(unexpected).toEqual([]);
  });
});

describe("渲染策略（§13.1 第一阶段全量渲染）", () => {
  it("request.options 覆盖 Parser 配置", () => {
    const breaksOn = renderMarkdown({
      documentId: DOCUMENT_ID,
      documentUri: DOCUMENT_URI,
      version: 1,
      text: "a\nb\n",
      options: { breaks: true }
    });
    expect(breaksOn.html).toContain("<br");
    expect(render("a\nb\n").html).not.toContain("<br");
  });

  it("theme 透传给上下文，产物结构不受主题影响（样式归 CSS）", () => {
    const light = renderMarkdown({
      documentId: DOCUMENT_ID,
      documentUri: DOCUMENT_URI,
      version: 1,
      text: "# a\n",
      theme: "light"
    });
    const dark = renderMarkdown({
      documentId: DOCUMENT_ID,
      documentUri: DOCUMENT_URI,
      version: 1,
      text: "# a\n",
      theme: "dark"
    });
    expect(light.html).toBe(dark.html);
  });

  it("同输入全量重渲染得到等价产物（无隐藏状态泄漏）", () => {
    const first = render(SOURCE).html;
    const second = render(SOURCE).html;
    expect(second).toBe(first);
  });
});
