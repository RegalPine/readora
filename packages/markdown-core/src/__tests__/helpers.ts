/**
 * 测试公用夹具：统一 RenderRequest 构造与最小 RendererContext，避免各 spec 重复字段。
 */
import {
  createRendererRegistry,
  renderMarkdown,
  type MarkdownRenderResult,
  type MarkdownNode,
  type RenderPipelineOptions,
  type RendererContext,
  type RendererRegistry
} from "../index";
import { DEFAULT_PARSER_OPTIONS } from "../types";

export const DOCUMENT_ID = "doc-test";
export const DOCUMENT_URI = "file:///vault/doc-test.md";

export function render(text: string, options: RenderPipelineOptions = {}): MarkdownRenderResult {
  return renderMarkdown(
    {
      documentId: DOCUMENT_ID,
      documentUri: DOCUMENT_URI,
      version: 1,
      text
    },
    options
  );
}

/** 单节点渲染入口：不走完整管线，用于 Registry / 渲染器级断言。 */
export function renderNode(
  node: MarkdownNode,
  registry: RendererRegistry = createRendererRegistry()
): { html: string; diagnostics: MarkdownRenderResult["diagnostics"] } {
  const context: RendererContext = {
    options: DEFAULT_PARSER_OPTIONS,
    documentId: DOCUMENT_ID,
    documentUri: DOCUMENT_URI,
    theme: "light",
    render: (current) => registry.render(current, context),
    renderChildren: (current) => registry.renderChildren(current, context)
  };
  return registry.render(node, context);
}

export function renderChildren(
  node: MarkdownNode,
  registry: RendererRegistry = createRendererRegistry()
): { html: string; diagnostics: MarkdownRenderResult["diagnostics"] } {
  const context: RendererContext = {
    options: DEFAULT_PARSER_OPTIONS,
    documentId: DOCUMENT_ID,
    documentUri: DOCUMENT_URI,
    theme: "light",
    render: (current) => registry.render(current, context),
    renderChildren: (current) => registry.renderChildren(current, context)
  };
  return registry.renderChildren(node, context);
}

/** 只渲染一段 Markdown 的 HTML，便于结构断言（仍然经过完整管线与 sanitize）。 */
export function htmlOf(source: string): string {
  return render(source).html;
}
