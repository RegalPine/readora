/**
 * 行内渲染器（ARC-002 §7.2 / §7.6）。
 *
 * 链接跳转一律由应用层接管，渲染器只打标记不调用任何宿主 API（§7.6 末段）：
 * - external：写 href（http/https）并标 data-readora-external，点击交 Host；
 * - anchor：写 href="#slug" 并标 data-readora-anchor，本地滚动；
 * - relative：不写 href、不做路径拼接（IMP-001 §12.2），标 data-readora-relative；
 * - blocked（javascript:/file:/vscode:/data: 等）：降级为纯文本 + warning 诊断。
 *
 * 图片只产出惰性标记，不写 src：本地资源解析与远程图片授权属 M3
 * （ARC-008 §8.1 默认不自动加载远程图片）。
 */
import { escapeHtml } from "../escape";
import { classifyImageSrc, classifyLink } from "../links";
import { RENDER_DIAGNOSTIC_CODES } from "../diagnostics";
import { readString } from "../nodes";
import type { MarkdownRenderer } from "../types";
import { attr, diagnostic, fragment, sizeAttributes } from "./support";

export const emphasisRenderer: MarkdownRenderer = {
  id: "readora.renderer.emphasis",
  supports: (node) => node.type === "emphasis",
  render(node, context) {
    const inner = context.renderChildren(node);
    return fragment(`<em class="readora-emphasis">${inner.html}</em>`, inner.diagnostics);
  }
};

export const strongRenderer: MarkdownRenderer = {
  id: "readora.renderer.strong",
  supports: (node) => node.type === "strong",
  render(node, context) {
    const inner = context.renderChildren(node);
    return fragment(`<strong class="readora-strong">${inner.html}</strong>`, inner.diagnostics);
  }
};

export const deleteRenderer: MarkdownRenderer = {
  id: "readora.renderer.delete",
  supports: (node) => node.type === "delete",
  render(node, context) {
    const inner = context.renderChildren(node);
    return fragment(`<del class="readora-delete">${inner.html}</del>`, inner.diagnostics);
  }
};

export const inlineCodeRenderer: MarkdownRenderer = {
  id: "readora.renderer.inlineCode",
  supports: (node) => node.type === "inlineCode",
  render: (node) =>
    fragment(`<code class="readora-inline-code">${escapeHtml(node.value ?? "")}</code>`)
};

export const breakRenderer: MarkdownRenderer = {
  id: "readora.renderer.break",
  supports: (node) => node.type === "break",
  render: () => fragment('<br class="readora-break" />')
};

export const linkRenderer: MarkdownRenderer = {
  id: "readora.renderer.link",
  supports: (node) => node.type === "link",
  render(node, context) {
    const inner = context.renderChildren(node);
    const rawHref = readString(node, "href");
    const classification = classifyLink(rawHref);
    const title = readString(node, "title");
    const titleAttribute = title ? ` title="${attr(escapeHtml(title))}"` : "";

    if (classification.kind === "external") {
      return fragment(
        `<a class="readora-link readora-link--external" href="${attr(escapeHtml(classification.href))}" rel="noopener noreferrer nofollow"${titleAttribute} data-readora-external="${attr(escapeHtml(classification.href))}">${inner.html}</a>`,
        inner.diagnostics
      );
    }
    if (classification.kind === "anchor") {
      const anchor = attr(escapeHtml(classification.href));
      return fragment(
        `<a class="readora-link readora-link--anchor" href="#${anchor}"${titleAttribute} data-readora-anchor="${anchor}">${inner.html}</a>`,
        inner.diagnostics
      );
    }
    if (classification.kind === "relative") {
      return fragment(
        `<span class="readora-link readora-link--inert" role="link" tabindex="-1" aria-disabled="true"${titleAttribute} data-readora-relative="${attr(escapeHtml(classification.href))}">${inner.html}</span>`,
        inner.diagnostics
      );
    }
    return fragment(inner.html, [
      ...inner.diagnostics,
      diagnostic(
        node,
        RENDER_DIAGNOSTIC_CODES.LINK_SCHEME_BLOCKED,
        "warning",
        `Link scheme is not allowed and was rendered as plain text: ${classification.href.slice(0, 120)}`
      )
    ]);
  }
};

export const imageRenderer: MarkdownRenderer = {
  id: "readora.renderer.image",
  supports: (node) => node.type === "image",
  render(node) {
    const src = readString(node, "src");
    const alt = readString(node, "alt") ?? "";
    const title = readString(node, "title");
    const kind = classifyImageSrc(src);
    const diagnostics = [
      diagnostic(
        node,
        RENDER_DIAGNOSTIC_CODES.IMAGE_DEFERRED,
        "info",
        kind === "remote"
          ? "Remote image is not loaded by default; resource policy lands in M3."
          : "Local image resolution lands in M3."
      )
    ];
    const titleAttribute = title ? ` title="${attr(escapeHtml(title))}"` : "";
    // 真实 <img> 语义结构存在但不带 src：Sanitizer 全局禁止 src 属性，
    // 因此本层既不发起远程请求也不拼接本地路径（ARC-008 §8.1、IMP-001 §12.2）；
    // 原 src 只作为 data 标记留给 M3 的 resource.resolve。
    // 尺寸同样只留 data 标记：`![…](…){width=60%}` 的 width / height 由 image 接管层
    // 在赋值 src 的同一通道里落到 img.style，渲染器不写 style。
    return fragment(
      `<span class="readora-image readora-image--${kind}" data-readora-image="${attr(escapeHtml(src ?? ""))}" data-readora-image-state="pending"${sizeAttributes(node)}>` +
        `<img class="readora-image-element" alt="${attr(escapeHtml(alt))}"${titleAttribute}>` +
        `<span class="readora-image-label">${escapeHtml(alt) || "image"}</span>` +
        `<span class="readora-image-hint">图片加载待资源解析（M3）</span>` +
        `</span>`,
      diagnostics
    );
  }
};

export const inlineRenderers: readonly MarkdownRenderer[] = [
  emphasisRenderer,
  strongRenderer,
  deleteRenderer,
  inlineCodeRenderer,
  breakRenderer,
  linkRenderer,
  imageRenderer
];
