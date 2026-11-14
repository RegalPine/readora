/**
 * P06 Renderer Registry 单测（ARC-002 §6，验收 RND-AC-003）。
 */
import { describe, expect, it } from "vitest";
import {
  RendererRegistry,
  createRendererRegistry,
  blockRenderers,
  codeBlockRenderer,
  footnoteRenderers,
  htmlAndDiagramRenderers,
  inlineRenderers,
  mathRenderer,
  tableRenderers,
  wikiLinkRenderer
} from "../index";
import type { MarkdownNode, RenderFragment } from "../types";
import { renderChildren, renderNode } from "./helpers";

function node(type: string, extra: Partial<MarkdownNode> = {}): MarkdownNode {
  // 有意构造未知类型节点以验证降级路径，MarkdownNodeType 在此处只做记录用途。
  return { id: `doc|${type}|0|1`, type: type as MarkdownNode["type"], ...extra };
}

describe("注册与查找（ARC-002 §6.2）", () => {
  it("默认注册表覆盖全部产出节点类型（含 M6 的 math 与 wikiLink）", () => {
    const registry = createRendererRegistry();
    const covered = [
      "heading",
      "paragraph",
      "text",
      "blockquote",
      "list",
      "listItem",
      "thematicBreak",
      "emphasis",
      "strong",
      "delete",
      "inlineCode",
      "break",
      "link",
      "image",
      "table",
      "tableRow",
      "tableCell",
      "codeBlock",
      "htmlBlock",
      "diagramBlock",
      "mathInline",
      "mathBlock",
      "wikiLink",
      "footnoteDefinition",
      "footnoteReference",
      "footnoteSection",
      "footnoteItem"
    ];
    for (const type of covered) {
      expect(registry.find(node(type)), type).toBeDefined();
    }
    // 脚注四类必须命中自己的渲染器，而不是走「未知节点」降级：
    // 降级会把脚注区拆成一段文本，F01-017 就静默失效。
    for (const type of ["footnoteDefinition", "footnoteReference", "footnoteSection", "footnoteItem"]) {
      expect(registry.find(node(type))?.id, type).toBe(`readora.renderer.${type}`);
    }
  });

  it("查找取首个 supports 命中", () => {
    const registry = new RendererRegistry();
    const first: MarkdownRendererLike = {
      id: "first",
      supports: (current) => current.type === "paragraph",
      render: () => ({ html: "FIRST", diagnostics: [] })
    };
    const second: MarkdownRendererLike = {
      id: "second",
      supports: (current) => current.type === "paragraph",
      render: () => ({ html: "SECOND", diagnostics: [] })
    };
    registry.register(first).register(second);
    // 子节点 text 无匹配渲染器 → 降级 span，因此只断言首个命中者在前。
    expect(renderNode(node("paragraph", { children: [node("text", { value: "x" })] }), registry).html.startsWith("FIRST")).toBe(true);
  });

  it("重复 id 注册直接抛错，防止静默覆盖", () => {
    const registry = createRendererRegistry();
    const existing = registry.ids[0] ?? "";
    expect(existing).not.toBe("");
    expect(() =>
      registry.register({
        id: existing,
        supports: () => true,
        render: (): RenderFragment => ({ html: "", diagnostics: [] })
      })
    ).toThrow(/Duplicate renderer id/);
  });

  it("ids 完整暴露已注册渲染器（IMP-001 §8.3 统一注册可核查）", () => {
    const registry = createRendererRegistry();
    const expected = [
      ...blockRenderers,
      ...inlineRenderers,
      ...tableRenderers,
      ...footnoteRenderers,
      codeBlockRenderer,
      mathRenderer,
      wikiLinkRenderer,
      ...htmlAndDiagramRenderers
    ].map((renderer) => renderer.id);
    expect(registry.ids).toEqual(expected);
    expect(new Set(registry.ids).size).toBe(registry.ids.length);
  });
});

interface MarkdownRendererLike {
  id: string;
  supports(node: MarkdownNode): boolean;
  render(node: MarkdownNode): RenderFragment;
}

describe("未匹配节点降级（ARC-002 §14.3 第 5 条，RND-AC-003）", () => {
  it("未知节点类型不抛穿，产出降级结构与 warning 诊断", () => {
    const result = renderNode(node("mysterySyntax", { value: "<raw>content</raw>" }));
    expect(result.html).toContain("readora-unsupported");
    expect(result.html).toContain("data-readora-node-type=\"mysterySyntax\"");
    expect(result.html).toContain("&lt;raw&gt;content&lt;/raw&gt;");
    expect(result.html).not.toContain("<raw>");
    expect(result.diagnostics[0]?.severity).toBe("warning");
    expect(result.diagnostics[0]?.message).toContain("mysterySyntax");
    expect(result.diagnostics[0]?.nodeId).toBe("doc|mysterySyntax|0|1");
  });

  it("未知节点带子内容时子内容仍被渲染，正文不丢", () => {
    const registry = new RendererRegistry();
    registry.register({
      id: "test.partial",
      supports: (current) => current.type === "emphasis",
      render: (current) => ({
        html: `<EM>${current.children?.map((child) => child.value ?? "").join("")}</EM>`,
        diagnostics: []
      })
    });
    const result = renderNode(
      node("container", { children: [node("emphasis", { children: [node("text", { value: "hi" })] })] }),
      registry
    );
    expect(result.html).toContain("hi");
  });

  it("渲染器抛异常被节点级隔离，降级为文本并给出 error 诊断", () => {
    const registry = new RendererRegistry();
    registry.register({
      id: "test.throwing",
      supports: (current) => current.type === "paragraph",
      render(): RenderFragment {
        throw new Error("boom");
      }
    });
    const result = renderNode(node("paragraph", { value: "text-body" }), registry);
    expect(result.html).toBe("text-body");
    expect(result.diagnostics[0]?.severity).toBe("error");
    expect(result.diagnostics[0]?.message).toContain("boom");
  });

  it("renderChildren 汇总全部子节点诊断且保持顺序", () => {
    const registry = new RendererRegistry();
    const marker = (label: string, type: string): MarkdownRendererLike => ({
      id: `test.${label}`,
      supports: (current) => current.type === type,
      render: () => ({
        html: label,
        diagnostics: [{ code: `test.${label}`, severity: "info", message: label }]
      })
    });
    registry.register(marker("A", "paragraph")).register(marker("B", "blockquote"));
    const result = renderChildren(
      node("document", { children: [node("paragraph"), node("blockquote")] }),
      registry
    );
    expect(result.html).toBe("AB");
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["test.A", "test.B"]);
  });
});
