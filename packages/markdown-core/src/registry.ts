/**
 * P06 Renderer Registry（ARC-002 §6）。
 *
 * 所有渲染器必须经 Registry 注册（IMP-001 §8.3）；查找取首个 supports 命中。
 * 未匹配节点走降级渲染：转义输出 + warning 诊断，绝不抛穿整篇（§14.3 第 5 条）。
 */
import { escapeHtml } from "./escape";
import { RENDER_DIAGNOSTIC_CODES } from "./diagnostics";
import { textOf } from "./nodes";
import type {
  MarkdownNode,
  MarkdownRenderer,
  RenderFragment,
  RendererContext
} from "./types";

export class RendererRegistry {
  private readonly renderers: MarkdownRenderer[] = [];

  register(renderer: MarkdownRenderer): this {
    if (this.renderers.some((existing) => existing.id === renderer.id)) {
      throw new Error(`Duplicate renderer id: ${renderer.id}`);
    }
    this.renderers.push(renderer);
    return this;
  }

  registerAll(renderers: readonly MarkdownRenderer[]): this {
    for (const renderer of renderers) {
      this.register(renderer);
    }
    return this;
  }

  find(node: MarkdownNode): MarkdownRenderer | undefined {
    return this.renderers.find((renderer) => renderer.supports(node));
  }

  get ids(): string[] {
    return this.renderers.map((renderer) => renderer.id);
  }

  /** 渲染单节点；异常在节点级隔离，返回降级片段（§14.3 第 1、5 条）。 */
  render(node: MarkdownNode, context: RendererContext): RenderFragment {
    const renderer = this.find(node);
    if (!renderer) {
      return fallbackFragment(node);
    }
    try {
      return renderer.render(node, context);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        html: fallbackHtml(node),
        diagnostics: [
          {
            code: RENDER_DIAGNOSTIC_CODES.UNKNOWN_NODE,
            severity: "error",
            message: `Renderer "${renderer.id}" failed, degraded to plain text: ${message.slice(0, 200)}`,
            nodeId: node.id,
            ...(node.position ? { source: node.position } : {})
          }
        ]
      };
    }
  }

  renderChildren(node: MarkdownNode, context: RendererContext): RenderFragment {
    const fragments = (node.children ?? []).map((child) => this.render(child, context));
    return {
      html: fragments.map((fragment) => fragment.html).join(""),
      diagnostics: fragments.flatMap((fragment) => fragment.diagnostics)
    };
  }
}

function fallbackHtml(node: MarkdownNode): string {
  // 容器节点降级时仍保留其纯文本，避免整段正文丢失（§14.3 第 5 条）。
  return escapeHtml(node.value ?? textOf(node));
}

function fallbackFragment(node: MarkdownNode): RenderFragment {
  return {
    html: `<span class="readora-unsupported" data-readora-node-type="${escapeHtml(node.type)}">${fallbackHtml(node)}</span>`,
    diagnostics: [
      {
        code: RENDER_DIAGNOSTIC_CODES.UNKNOWN_NODE,
        severity: "warning",
        message: `No renderer registered for node type "${node.type}"; content degraded to text.`,
        nodeId: node.id,
        ...(node.position ? { source: node.position } : {})
      }
    ]
  };
}
