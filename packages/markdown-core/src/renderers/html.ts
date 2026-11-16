/**
 * 受控 HTML 渲染器（ARC-002 §11.2）。
 *
 * Parser 以 html:false 运行（§3.4），行内 / 块级 HTML token 只作为文本进入 AST，
 * 这里一律转义为可见文本并给出 warning：默认不执行 Markdown 中的任意 HTML。
 * 真正的「受控 HTML 放行」需要独立的白名单决策，本批不开口子。
 */
import { escapeHtml } from "../escape";
import { RENDER_DIAGNOSTIC_CODES } from "../diagnostics";
import type { MarkdownRenderer } from "../types";
import { attr, diagnostic, filenameValue, fragment, sizeAttributes } from "./support";

export const htmlBlockRenderer: MarkdownRenderer = {
  id: "readora.renderer.htmlBlock",
  supports: (node) => node.type === "htmlBlock",
  render(node) {
    const raw = node.value ?? "";
    return fragment(
      `<div class="readora-html-block" data-readora-html-state="escaped"><pre class="readora-html-source">${escapeHtml(raw)}</pre></div>`,
      [
        diagnostic(
          node,
          RENDER_DIAGNOSTIC_CODES.HTML_BLOCK_DISABLED,
          "warning",
          "Raw HTML in Markdown is disabled and was escaped."
        )
      ]
    );
  }
};

/**
 * 图形占位渲染器（ARC-002 §10.2）。
 *
 * Markdown 层只负责识别 mermaid 并保留源码，SVG 生成归 ARC-003 / diagram-core（M3）；
 * 本批展示源码 + 说明，不假装已渲染。
 *
 * M10 围栏属性只交事实，不做行为：`code_block=true` → 初始展开全部源码，
 * `filename=…` → 卡片展示文件名，尺寸 → `data-readora-width|height`。
 * **具体生效在 diagram 接管层**（M3 已接管的卡片 chrome 就在 webview），
 * 本层多写一个 `class` 就是一个会与接管层打架的作者。
 */
export const diagramBlockRenderer: MarkdownRenderer = {
  id: "readora.renderer.diagramBlock",
  supports: (node) => node.type === "diagramBlock",
  render(node) {
    const source = node.value ?? "";
    const filename = filenameValue(node);
    const codeBlockAttribute =
      node.attributes?.["code_block"] === "true" ? ' data-readora-diagram-code-block="true"' : "";
    const filenameAttribute =
      filename.length > 0 ? ` data-readora-diagram-filename="${attr(escapeHtml(filename))}"` : "";
    const diagramId = node.attributes?.["diagram_id"];
    const idAttribute = typeof diagramId === "string" ? ` id="${attr(escapeHtml(diagramId))}"` : "";
    const diagramTitle = node.attributes?.["diagram_title"];
    const titleAttribute = typeof diagramTitle === "string" ? ` data-readora-diagram-title="${attr(escapeHtml(diagramTitle))}"` : "";
    return fragment(
      `<div class="readora-diagram" data-readora-diagram-state="pending"${idAttribute}${titleAttribute}${codeBlockAttribute}${filenameAttribute}${sizeAttributes(node)}>` +
        `<p class="readora-diagram-note">Diagram rendering lands in M3 (ARC-003). Source is kept below.</p>` +
        `<pre class="readora-diagram-source"><code class="hljs">${escapeHtml(source)}</code></pre>` +
        `</div>`,
      [
        diagnostic(
          node,
          RENDER_DIAGNOSTIC_CODES.DIAGRAM_DEFERRED,
          "info",
          "Mermaid block recognized; rendering delegated to diagram-core (M3)."
        )
      ]
    );
  }
};

export const htmlAndDiagramRenderers: readonly MarkdownRenderer[] = [
  htmlBlockRenderer,
  diagramBlockRenderer
];
