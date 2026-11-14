/**
 * 代码块渲染器（ARC-002 §8）。
 *
 * 职责边界：语言标识、高亮、复制入口与横向滚动容器（§8.1）；
 * 复制动作由 Webview UI 处理（§8.3 第 4 条），渲染器只留 data 标记；
 * 行号与长代码折叠属 V1.1.x（§8.1 范围注记），本批不实现。
 *
 * M10：围栏尾随 `{filename="app.js"}` 在 header 里多一个文件名徽章（attrs.ts 白名单）；
 * 文本走 escapeText，属性走 attr，于是文件名里带引号也注不进属性。
 */
import { RENDER_DIAGNOSTIC_CODES } from "../diagnostics";
import { highlightCode } from "../highlight";
import { readString } from "../nodes";
import type { MarkdownRenderer } from "../types";
import { attr, diagnostic, filenameValue, fragment } from "./support";

export const codeBlockRenderer: MarkdownRenderer = {
  id: "readora.renderer.codeBlock",
  supports: (node) => node.type === "codeBlock",
  render(node) {
    const code = node.value ?? "";
    const language = readString(node, "lang");
    const outcome = highlightCode(code, language);
    const diagnostics = [...(fragmentDiagnostics(node, outcome.kind, outcome.language))];
    const languageLabel = outcome.language.length > 0 ? outcome.language : "text";
    const filename = filenameValue(node);
    const filenameChip =
      filename.length > 0
        ? `<span class="readora-code-filename" title="${attr(escapeText(filename))}">${escapeText(filename)}</span>`
        : "";
    const header =
      `<div class="readora-code-header">` +
      `<span class="readora-code-lang">${attr(escapeText(languageLabel))}</span>${filenameChip}` +
      `<button type="button" class="readora-code-copy" data-readora-copy aria-label="Copy code to clipboard">Copy</button>` +
      `</div>`;

    return fragment(
      `<div class="readora-code-block" data-readora-code-lang="${attr(escapeText(languageLabel))}" data-readora-code-state="${outcome.kind}">` +
        `${header}<pre class="readora-code-pre"><code class="hljs language-${attr(escapeText(languageLabel))}">${outcome.html}</code></pre>` +
        `</div>`,
      diagnostics
    );
  }
};

function fragmentDiagnostics(
  node: Parameters<MarkdownRenderer["render"]>[0],
  kind: string,
  language: string
) {
  if (kind === "unsupported") {
    return [
      diagnostic(
        node,
        RENDER_DIAGNOSTIC_CODES.UNSUPPORTED_LANGUAGE,
        "warning",
        `Syntax highlighting is not available for "${language}"; rendered as plain text.`
      )
    ];
  }
  if (kind === "failed") {
    return [
      diagnostic(
        node,
        RENDER_DIAGNOSTIC_CODES.HIGHLIGHT_FAILED,
        "warning",
        `Highlighting failed for "${language}"; degraded to a plain code block.`
      )
    ];
  }
  return [];
}

function escapeText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
