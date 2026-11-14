/**
 * 脚注渲染器（ARC-002 §7 补充，M10 / PRD-001 F01-017）。
 *
 * 只用已在 Sanitizer 白名单内的标签与属性（`span / a / div / p / ol / li` 与
 * `id / class / href / aria-label`）：**不引入 `<sup>` / `<section>`**，
 * 上标由 CSS 承担。白名单一行不动，就不需要重新做一次安全评审。
 *
 * 跳转不在这里发生：引用与回跳都写 `data-readora-anchor`，
 * 由 `interactions.ts` 的既有锚点委托处理（`findHeading` 的第一路径是
 * `getElementById`，对非标题 id 同样生效）。因此本文件不产出任何内联脚本，
 * Webview 侧也一行交互代码都不用加。
 *
 * 编号缺失（处理器判「没有这条定义」）时，引用按字面量输出 `[^label]` ——
 * 与 math / wiki-link 同一条口径：不摆一个注定跳不到的 affordance。
 */
import { escapeHtml } from "../escape";
import { readNumber, readString } from "../nodes";
import type { MarkdownNode, MarkdownRenderer } from "../types";
import { alignAttribute, attr, fragment } from "./support";

/** 脚注区的稳定 class：CSS、e2e 与 verify 的产物断言共用同一个名字。 */
export const FOOTNOTES_CLASS = "readora-footnotes";
export const FOOTNOTE_REF_CLASS = "readora-footnote-ref";
export const FOOTNOTE_REF_WRAP_CLASS = "readora-footnote-ref-wrap";
export const FOOTNOTE_ITEM_CLASS = "readora-footnote-item";
export const FOOTNOTE_BACKREF_CLASS = "readora-footnote-backref";

/**
 * 锚点链接：`href` 与 `data-readora-anchor` 两个字段同一个值。
 *
 * `target` 为空时不写 `id`：空 id 是无效 HTML（回跳不需要自己的 id，
 * 只需要能指回去），而 `id=""` 会被下游选择器当成一个具名元素。
 */
function anchorLink(anchor: string, target: string, label: string, text: string, className: string): string {
  const href = `#${attr(escapeHtml(anchor))}`;
  const id = target.length > 0 ? ` id="${attr(escapeHtml(target))}"` : "";
  return (
    `<a class="${className}"${id} href="${href}"` +
    ` data-readora-anchor="${attr(escapeHtml(anchor))}"` +
    ` aria-label="${attr(escapeHtml(label))}">${text}</a>`
  );
}

export const footnoteReferenceRenderer: MarkdownRenderer = {
  id: "readora.renderer.footnoteReference",
  supports: (node) => node.type === "footnoteReference",
  render(node) {
    const index = readNumber(node, "index");
    const anchor = readString(node, "anchor") ?? "";
    const refAnchor = readString(node, "refAnchor") ?? "";
    if (index === undefined || anchor.length === 0 || refAnchor.length === 0) {
      return fragment(escapeHtml(node.value ?? `[^${readString(node, "label") ?? ""}]`));
    }
    const label = `Footnote ${index}`;
    const link = anchorLink(
      anchor,
      refAnchor,
      label,
      `<span class="readora-footnote-marker">${escapeHtml(`[${index}]`)}</span>`,
      `readora-link readora-link--anchor ${FOOTNOTE_REF_CLASS}`
    );
    return fragment(`<span class="${FOOTNOTE_REF_WRAP_CLASS}">${link}</span>`);
  }
};

export const footnoteDefinitionRenderer: MarkdownRenderer = {
  id: "readora.renderer.footnoteDefinition",
  supports: (node) => node.type === "footnoteDefinition",
  render(node, context) {
    // 定义节点正常情况由 footnote 处理器搬进脚注区；单独进 Registry（增量渲染、
    // 白盒测试）时也要有产出，不能落到 unsupported 降级去。
    const inner = context.renderChildren(node);
    return fragment(
      `<div class="readora-footnote-definition"${alignAttribute(node)}>${inner.html}</div>`,
      inner.diagnostics
    );
  }
};

export const footnoteItemRenderer: MarkdownRenderer = {
  id: "readora.renderer.footnoteItem",
  supports: (node) => node.type === "footnoteItem",
  render(node, context) {
    const index = readNumber(node, "index") ?? 0;
    const anchor = readString(node, "anchor") ?? "";
    const backAnchor = readString(node, "backAnchor") ?? "";
    const inner = context.renderChildren(node);
    const backref =
      backAnchor.length === 0 || anchor.length === 0
        ? ""
        : anchorLink(
            backAnchor,
            "",
            `Back to footnote reference ${index}`,
            `<span aria-hidden="true">↩</span>`,
            `readora-link readora-link--anchor ${FOOTNOTE_BACKREF_CLASS}`
          );
    return fragment(
      `<li class="${FOOTNOTE_ITEM_CLASS}"${anchor.length > 0 ? ` id="${attr(escapeHtml(anchor))}"` : ""}${alignAttribute(node)}` +
        `>${inner.html}${backref}</li>`,
      inner.diagnostics
    );
  }
};

export const footnoteSectionRenderer: MarkdownRenderer = {
  id: "readora.renderer.footnoteSection",
  supports: (node) => node.type === "footnoteSection",
  render(node, context) {
    const inner = context.renderChildren(node);
    if (inner.html.length === 0) {
      return fragment("", inner.diagnostics);
    }
    return fragment(
      `<div class="${FOOTNOTES_CLASS}">` +
        `<hr class="readora-thematic-break readora-footnotes-rule" />` +
        `<p class="readora-footnotes-title">脚注</p>` +
        `<ol class="readora-footnotes-list">${inner.html}</ol>` +
        `</div>`,
      inner.diagnostics
    );
  }
};

export const footnoteRenderers: readonly MarkdownRenderer[] = [
  footnoteReferenceRenderer,
  footnoteDefinitionRenderer,
  footnoteItemRenderer,
  footnoteSectionRenderer
];

/** 供测试与 CSS 对齐的节点类型清单。 */
export const FOOTNOTE_NODE_TYPES: readonly MarkdownNode["type"][] = [
  "footnoteDefinition",
  "footnoteReference",
  "footnoteItem",
  "footnoteSection"
];
