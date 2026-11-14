/**
 * 渲染器共用小工具：统一 RenderFragment 与诊断构造，外加块属性的输出形状。
 *
 * 块属性（`attrs.ts` 白名单）在这里只完成「值 → data-*」的一步搬运：
 * **渲染层不写 `style`**（Sanitizer 把 style 限域在公式子树内），
 * 尺寸也不在这里生效 —— `data-readora-width|height` 由 Webview 接管层落地，
 * 那两层本来就是这些元素 src / 样式的唯一作者。
 */
import { ALIGN_ATTR, FILENAME_ATTR, HEIGHT_ATTR, WIDTH_ATTR, isDelimitedSizeValue } from "../attrs";
import type {
  DiagnosticSeverity,
  MarkdownNode,
  RenderDiagnostic,
  RenderFragment
} from "../types";

export function fragment(
  html: string,
  diagnostics: readonly RenderDiagnostic[] = []
): RenderFragment {
  return { html, diagnostics: [...diagnostics] };
}

export function diagnostic(
  node: MarkdownNode,
  code: string,
  severity: DiagnosticSeverity,
  message: string
): RenderDiagnostic {
  return {
    code,
    severity,
    message,
    nodeId: node.id,
    ...(node.position ? { source: node.position } : {})
  };
}

/** 属性值安全输出：转义并去除换行，避免属性注入。 */
export function attr(value: string): string {
  return value.replace(/[\r\n]+/g, " ");
}

/**
 * `align` → ` data-align="…"`。
 *
 * 值在渲染这一层再校一次：节点属性可能被外部直接构造（白盒测试、后续增量渲染），
 * 而 `data-align` 的取值只有三种，写进 CSS 的也只有三种 —— 多写一个就是死选择器。
 */
export function alignAttribute(node: MarkdownNode): string {
  const align = node.attributes?.[ALIGN_ATTR];
  return align === "left" || align === "center" || align === "right" ? ` data-align="${align}"` : "";
}

/** `width` / `height` → `data-readora-width|height`：形状不合法就当没写过。 */
export function sizeAttributes(node: MarkdownNode): string {
  const parts: string[] = [];
  for (const [name, attribute] of [
    ["data-readora-width", WIDTH_ATTR],
    ["data-readora-height", HEIGHT_ATTR]
  ] as const) {
    const value = node.attributes?.[attribute];
    if (typeof value === "string" && isDelimitedSizeValue(value)) {
      parts.push(` ${name}="${attr(value)}"`);
    }
  }
  return parts.join("");
}

/** `filename` 的读取入口：形状判定只有 `attrs.ts` 一份作者。 */
export function filenameValue(node: MarkdownNode): string {
  const value = node.attributes?.[FILENAME_ATTR];
  return typeof value === "string" ? value : "";
}
