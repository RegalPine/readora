/**
 * 块级渲染器（ARC-002 §7.1 / §7.3 / §7.4 / §7.2 段落）。
 *
 * 只输出语义结构与必要 class，视觉样式归视觉系统（§7.5 末段）。
 * 任务列表为展示态（F01-016），不产出可交互控件。
 *
 * M10：块级尾随 `{align=…}` 在这里落成 `data-align`（attrs.ts 白名单），
 * 由 markdown.css 的块级选择器生效 —— 渲染器不碰 style，Sanitizer 限域一行都不改。
 */
import { escapeHtml } from "../escape";
import { readBoolean, readNumber, readString } from "../nodes";
import type { MarkdownNode, MarkdownRenderer, RenderFragment, RendererContext } from "../types";
import { alignAttribute, attr, fragment } from "./support";

function children(node: MarkdownNode, context: RendererContext): RenderFragment {
  return context.renderChildren(node);
}

export const headingRenderer: MarkdownRenderer = {
  id: "readora.renderer.heading",
  supports: (node) => node.type === "heading",
  render(node, context) {
    const level = readNumber(node, "level") ?? 1;
    const anchor = readString(node, "anchor") ?? "";
    const inner = children(node, context);
    // id 之外再写一份 data-readora-heading 镜像：DOMPurify 的 SANITIZE_DOM
    // 会剥离与 document 具名属性冲突的 id（如标题「Images」→ id="images"），
    // 应用层按镜像兜底定位，锚点跳转才不会哑（ARC-002 §7.1）。
    return fragment(
      `<h${level} id="${attr(anchor)}" class="readora-heading readora-heading--h${level}" data-readora-heading="${attr(anchor)}"${alignAttribute(node)}>${inner.html}</h${level}>`,
      inner.diagnostics
    );
  }
};

export const paragraphRenderer: MarkdownRenderer = {
  id: "readora.renderer.paragraph",
  supports: (node) => node.type === "paragraph",
  render(node, context) {
    const inner = children(node, context);
    return fragment(`<p class="readora-paragraph"${alignAttribute(node)}>${inner.html}</p>`, inner.diagnostics);
  }
};

export const blockquoteRenderer: MarkdownRenderer = {
  id: "readora.renderer.blockquote",
  supports: (node) => node.type === "blockquote",
  render(node, context) {
    const inner = children(node, context);
    return fragment(
      `<blockquote class="readora-blockquote"${alignAttribute(node)}>${inner.html}</blockquote>`,
      inner.diagnostics
    );
  }
};

function taskMarker(node: MarkdownNode): string {
  const checked = readBoolean(node, "checked") === true;
  return `<span class="readora-task-marker" data-readora-task="${checked ? "checked" : "unchecked"}" aria-hidden="true">${checked ? "☑" : "☐"}</span>`;
}

export const listRenderer: MarkdownRenderer = {
  id: "readora.renderer.list",
  supports: (node) => node.type === "list",
  render(node, context) {
    const ordered = readBoolean(node, "ordered") === true;
    const inner = children(node, context);
    const start = readNumber(node, "start");
    const hasTask = (node.children ?? []).some((item) => readBoolean(item, "task") === true);
    const className = `readora-list${hasTask ? " readora-list--task" : ""}`;
    const startAttribute = ordered && start !== undefined && start !== 1 ? ` start="${start}"` : "";
    const tag = ordered ? "ol" : "ul";
    return fragment(
      `<${tag} class="${className}"${startAttribute}${alignAttribute(node)}>${inner.html}</${tag}>`,
      inner.diagnostics
    );
  }
};

export const listItemRenderer: MarkdownRenderer = {
  id: "readora.renderer.listItem",
  supports: (node) => node.type === "listItem",
  render(node, context) {
    const inner = children(node, context);
    const isTask = readBoolean(node, "task") === true;
    const marker = isTask ? taskMarker(node) : "";
    const className = isTask ? "readora-list-item readora-task-item" : "readora-list-item";
    const aria = isTask
      ? ` aria-label="${readBoolean(node, "checked") === true ? "completed task" : "incomplete task"}"`
      : "";
    return fragment(
      `<li class="${className}"${aria}${alignAttribute(node)}>${marker}${inner.html}</li>`,
      inner.diagnostics
    );
  }
};

export const thematicBreakRenderer: MarkdownRenderer = {
  id: "readora.renderer.thematicBreak",
  supports: (node) => node.type === "thematicBreak",
  render: () => fragment('<hr class="readora-thematic-break" />')
};

/** 文本节点：转义输出，保留换行（HTML 折叠空白由 CSS 处理）。 */
export const textRenderer: MarkdownRenderer = {
  id: "readora.renderer.text",
  supports: (node) => node.type === "text",
  render: (node) => fragment(escapeHtml(node.value ?? ""))
};

export const blockRenderers: readonly MarkdownRenderer[] = [
  headingRenderer,
  paragraphRenderer,
  blockquoteRenderer,
  listRenderer,
  listItemRenderer,
  thematicBreakRenderer,
  textRenderer
];
