/**
 * 诊断码常量（ARC-002 §14.2 code 字段）。
 * 统一前缀 readora.render.，不散落裸字符串。
 */
export const RENDER_DIAGNOSTIC_CODES = {
  UNKNOWN_NODE: "readora.render.unknown-node",
  HTML_BLOCK_DISABLED: "readora.render.html-block-disabled",
  UNSUPPORTED_LANGUAGE: "readora.render.unsupported-language",
  HIGHLIGHT_FAILED: "readora.render.highlight-failed",
  DIAGRAM_DEFERRED: "readora.render.diagram-deferred",
  IMAGE_DEFERRED: "readora.render.image-deferred",
  MATH_DEFERRED: "readora.render.math-deferred",
  // M6 KaTeX 落地后取代 math-deferred：invalid 是「源码层就不成立」，
  // failed 是「KaTeX 渲不出来（ParseError / 超过 maxSize）」，两者都只降级本条公式。
  MATH_INVALID: "readora.render.math-invalid",
  MATH_FAILED: "readora.render.math-failed",
  // 公式白名单是限域的（IMP-001 §10.3）：文档自带 HTML 里的公式标签与公式属性
  // 会被后置遍历剥掉，命中时记这条诊断，让「扩了白名单但没扩可达面」可被取证。
  MATH_SCOPE_STRIPPED: "readora.render.math-scope-stripped",
  LINK_SCHEME_BLOCKED: "readora.render.link-scheme-blocked",
  FRONTMATTER_INVALID: "readora.render.frontmatter-invalid",
  // M10 语义三件套：脚注引用找不到定义（按字面量显示）、脚注区超上限截断、
  // `{…}` 看起来是一次属性书写但没过白名单、`csv` 围栏不够成表。
  // 只有 footnote-limit 是 warning（条目确实没渲出来），其余三条都是 info：
  // 内容一字节没丢，只是没获得额外语义。
  FOOTNOTE_UNRESOLVED: "readora.render.footnote-unresolved",
  FOOTNOTE_LIMIT: "readora.render.footnote-limit",
  ATTRS_REJECTED: "readora.render.attrs-rejected",
  CSV_NOT_TABULAR: "readora.render.csv-not-tabular",
  // 源行范围锚点（ARC-002 §12.3）：值形状非法即被剥离。正常渲染不该出现这一条 ——
  // 属性值是本包自己拼的行号，出现就意味着生成侧写错了，所以是 warning 而不是 info。
  SOURCE_RANGE_STRIPPED: "readora.render.source-range-stripped",
  SANITIZE_FAILED: "readora.render.sanitize-failed",
  PARSE_FAILED: "readora.render.parse-failed"
} as const;

export type RenderDiagnosticCode =
  (typeof RENDER_DIAGNOSTIC_CODES)[keyof typeof RENDER_DIAGNOSTIC_CODES];
