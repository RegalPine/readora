/**
 * 数学公式渲染器（IMP-001 §10.3 第 4 条，M6 / STORY-06-01）。
 *
 * 输出形态固定为
 * `<span class="readora-math readora-math--inline|block" data-readora-math-status="ok|error">`，
 * 其中 `readora-math` 类名同时是 sanitizer 判定「这段富标记属于公式作用域」的锚点
 * （见 sanitizer 的 MATH_MARKUP_SCOPE）：KaTeX 依赖大量内联 `style`，而这些属性
 * 对文档自带的 HTML 必须不可达，二者靠这个类名而不是靠运气区分。
 *
 * 降级内容是**这条公式自身的源码**（可见、可复制），并附 warning 诊断；
 * 单条公式失败不得影响整篇（§10.2 第 2 条），所以这里绝不抛穿。
 */
import { escapeHtml } from "../escape";
import { RENDER_DIAGNOSTIC_CODES } from "../diagnostics";
import {
  MATH_CONTAINER_CLASS,
  MATH_ROOT_ATTRIBUTE,
  renderMathExpression,
  type MathDisplay
} from "../math";
import type { MarkdownRenderer } from "../types";
import { attr, diagnostic, fragment } from "./support";

function sourceOf(node: { attributes?: Record<string, unknown>; value?: string }): string {
  const fromAttributes = node.attributes?.source;
  if (typeof fromAttributes === "string") {
    return fromAttributes;
  }
  return node.value ?? "";
}

export const mathRenderer: MarkdownRenderer = {
  id: "readora.renderer.math",
  supports: (node) => node.type === "mathInline" || node.type === "mathBlock",
  render(node) {
    const display: MathDisplay = node.type === "mathBlock" ? "block" : "inline";
    const source = sourceOf(node);
    const container = `<span class="${MATH_CONTAINER_CLASS} ${MATH_CONTAINER_CLASS}--${display}" ${MATH_ROOT_ATTRIBUTE}="${display}"`;
    const outcome = renderMathExpression(source, display);
    if (outcome.ok) {
      return fragment(`${container} data-readora-math-status="ok">${outcome.html}</span>`);
    }
    return fragment(
      `${container} data-readora-math-status="error" data-readora-math-source="${attr(
        escapeHtml(source)
      )}">${escapeHtml(source)}</span>`,
      [
        diagnostic(
          node,
          RENDER_DIAGNOSTIC_CODES.MATH_FAILED,
          "warning",
          `Math expression degraded to its source: ${(outcome.message ?? "unknown error").slice(0, 200)}`
        )
      ]
    );
  }
};
