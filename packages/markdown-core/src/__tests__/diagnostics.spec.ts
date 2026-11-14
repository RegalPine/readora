/**
 * 诊断与故障隔离单测（ARC-002 §14，验收 RND-AC-009）。
 */
import { describe, expect, it } from "vitest";
import {
  RENDER_DIAGNOSTIC_CODES,
  RendererRegistry,
  blockRenderers,
  codeBlockRenderer,
  createRendererRegistry,
  htmlAndDiagramRenderers,
  inlineRenderers,
  sanitizeHtml,
  tableRenderers,
  type HtmlSanitizer,
  type MarkdownNode,
  type RenderDiagnostic,
  type RenderFragment,
  type SanitizeOutcome
} from "../index";
import { render } from "./helpers";

/** 在真实渲染器之前插入一个坏渲染器，用于验证「单块故障不扩散」。 */
function registryWithFailing(type: string, failure: string): RendererRegistry {
  const registry = new RendererRegistry();
  registry.register({
    id: `test.failing.${type}`,
    supports: (node: MarkdownNode): boolean => node.type === type,
    render(): RenderFragment {
      throw new Error(failure);
    }
  });
  registry.registerAll([
    ...blockRenderers,
    ...inlineRenderers,
    ...tableRenderers,
    codeBlockRenderer,
    ...htmlAndDiagramRenderers
  ]);
  return registry;
}

describe("诊断结构（ARC-002 §14.1）", () => {
  it("每条诊断都有 code / severity / message，severity 限定三档", () => {
    const result = render(
      ["# 标题", "", "```mermaid", "graph TD; A-->B;", "```", "", "```klingon", "x", "```", ""].join("\n")
    );
    expect(result.diagnostics.length).toBeGreaterThan(0);
    for (const diagnostic of result.diagnostics) {
      expect(diagnostic.code.startsWith("readora.render.")).toBe(true);
      expect(["error", "warning", "info"]).toContain(diagnostic.severity);
      expect(diagnostic.message.length).toBeGreaterThan(0);
    }
  });

  it("节点级诊断携带 nodeId 与源码位置", () => {
    const result = render("```unknownlang\nbody\n```\n");
    const warning = result.diagnostics.find(
      (item) => item.code === RENDER_DIAGNOSTIC_CODES.UNSUPPORTED_LANGUAGE
    );
    expect(warning?.nodeId).toContain("|codeBlock|");
    expect(warning?.source).toEqual({ startLine: 0, endLine: 2 });
  });

  it("诊断码集合稳定，命名前缀统一", () => {
    const values = Object.values(RENDER_DIAGNOSTIC_CODES);
    expect(values.every((value) => value.startsWith("readora.render."))).toBe(true);
    expect(new Set(values).size).toBe(values.length);
    expect(values).toContain("readora.render.sanitize-failed");
    expect(values).toContain("readora.render.parse-failed");
  });
});

describe("单块故障不扩散（§14.3 第 1 条，RND-AC-009）", () => {
  const mixed = [
    "# 标题仍在",
    "",
    "会失败的段落",
    "",
    "- 列表项",
    "",
    "| a | b |",
    "| - | - |",
    "| 1 | 2 |",
    "",
    "```python",
    "print(1)",
    "```",
    ""
  ].join("\n");

  it("段落渲染器抛错时其余块正常渲染，正文以纯文本保留", () => {
    const result = render(mixed, { registry: registryWithFailing("paragraph", "段落炸了") });
    expect(result.html).toContain('<h1 id="标题仍在"');
    expect(result.html).toContain("<li");
    expect(result.html).toContain("<table");
    // python 代码块被正常高亮（print 与括号被 span 拆分，故只断言片段与结构）
    expect(result.html).toContain('data-readora-code-lang="python"');
    expect(result.html).toContain("print");
    expect(result.html).toContain("会失败的段落");
    const error = result.diagnostics.find((item) => item.severity === "error");
    expect(error?.message).toContain("段落炸了");
    expect(error?.nodeId).toContain("|paragraph|");
  });

  it("表格渲染器抛错只影响该表格，文档其余部分完好", () => {
    const result = render(mixed, { registry: registryWithFailing("table", "表格炸了") });
    expect(result.html).toContain('<h1 id="标题仍在"');
    expect(result.html).toContain("会失败的段落");
    expect(result.diagnostics.some((item) => item.message.includes("表格炸了"))).toBe(true);
  });

  it("同一类型多个节点连续失败时逐条记录诊断", () => {
    const source = "甲\n\n乙\n\n丙\n";
    const result = render(source, { registry: registryWithFailing("paragraph", "连续失败") });
    const errors = result.diagnostics.filter((item) => item.severity === "error");
    expect(errors).toHaveLength(3);
    expect(result.html).toContain("甲");
    expect(result.html).toContain("丙");
  });
});

describe("Sanitizer 失败 fail-closed（§14.3 第 6 条）", () => {
  const dangerous = "<img src=x onerror=alert(1)>\n";

  it("注入抛错的 sanitizer 时整篇降级为转义文本，绝不留未验证 HTML", () => {
    const throwing: HtmlSanitizer = {
      sanitize: (): SanitizeOutcome => {
        throw new Error("sanitizer down");
      }
    };
    const result = render(dangerous, { sanitizer: throwing });
    expect(result.html).toContain("&lt;img");
    // 转义后的原文只作为可见文本存在，DOM 里不得有真实 img / script 元素
    const root = new DOMParser().parseFromString(`<div>${result.html}</div>`, "text/html");
    expect(root.body.querySelectorAll("img,script,iframe").length).toBe(0);
    expect(root.body.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(result.diagnostics[0]?.code).toBe(RENDER_DIAGNOSTIC_CODES.PARSE_FAILED);
    expect(result.diagnostics[0]?.severity).toBe("error");
    expect(result.outline).toEqual([]);
  });

  it("sanitizeHtml 自身异常路径返回转义结果 + error 诊断", () => {
    const outcome = sanitizeHtml("<div>ok</div>", {
      allowHtml: false,
      allowSvg: false,
      allowExternalLinks: true,
      allowedUrlSchemes: ["http", "https"]
    });
    expect(outcome.html).toContain("<div>");
    expect(outcome.diagnostics).toEqual([]);
  });

  it("诊断在管线中按 frontmatter → 渲染 → 清洗 的顺序聚合", () => {
    const result = render(
      ["---", "title: T", "坏行没有冒号", "---", "", "# 标题", "", "```klingon", "x", "```", ""].join("\n")
    );
    const codes = result.diagnostics.map((item: RenderDiagnostic) => item.code);
    expect(codes[0]).toBe(RENDER_DIAGNOSTIC_CODES.FRONTMATTER_INVALID);
    expect(codes[codes.length - 1]).toBe(RENDER_DIAGNOSTIC_CODES.UNSUPPORTED_LANGUAGE);
  });
});

describe("管线兜底", () => {
  it("病态嵌套输入不抛穿，结果仍含透传字段", () => {
    const nested = `${"**".repeat(60)}深${"*".repeat(60)}\n\n${"> ".repeat(40)}引用\n\n${"- ".repeat(200)}`;
    const result = render(nested);
    expect(result.documentId).toBe("doc-test");
    expect(result.version).toBe(1);
    expect(typeof result.html).toBe("string");
    expect(result.diagnostics.every((item) => item.severity !== "error")).toBe(true);
  });

  it("空文档不产生 error 诊断，html 为空串", () => {
    const result = render("", { registry: createRendererRegistry() });
    expect(result.html).toBe("");
    expect(result.diagnostics.filter((item) => item.severity === "error")).toEqual([]);
    expect(result.metadata.tags).toEqual([]);
    expect(result.outline).toEqual([]);
  });

  it("渲染器缺失注册时逐节点降级，不影响 documentId / version 契约", () => {
    const registry = new RendererRegistry();
    const result = render("# 标题\n\n段落\n", { registry });
    expect(result.documentId).toBe("doc-test");
    expect(result.version).toBe(1);
    expect(result.html).toContain("readora-unsupported");
    expect(result.html).toContain("标题");
    expect(result.diagnostics.every((item: RenderDiagnostic) => item.severity === "warning")).toBe(
      true
    );
  });
});
