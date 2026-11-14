/**
 * @readora/markdown-core 门面（ARC-002 §2.1 管线顺序 P01 → P08）。
 *
 * 对外只暴露 renderMarkdown 与配套类型：应用层不得自行重复解析 Markdown
 * （ARC-002 §12.2），也不得跳过 Sanitizer 直接使用渲染产物。
 *
 * 本包运行于 Webview：禁止依赖 VS Code API 与 node: 内置模块（IMP-001 §4.3）。
 */
import { buildAst } from "./ast";
import { rejectedAttributeStrings } from "./attrs";
import { RENDER_DIAGNOSTIC_CODES } from "./diagnostics";
import { escapeHtml } from "./escape";
import { extractFrontmatter } from "./frontmatter";
import { countSourceLines, normalizeSource } from "./normalize";
import { extractOutline } from "./outline";
import { createMarkdownParser } from "./parser";
import { runProcessors } from "./processors";
import { blockRenderers } from "./renderers/blocks";
import { codeBlockRenderer } from "./renderers/code";
import { footnoteRenderers } from "./renderers/footnote";
import { htmlAndDiagramRenderers } from "./renderers/html";
import { inlineRenderers } from "./renderers/inline";
import { mathRenderer } from "./renderers/math";
import { wikiLinkRenderer } from "./renderers/wiki-link";
import { tableRenderers } from "./renderers/table";
import { RendererRegistry } from "./registry";
import { DEFAULT_SANITIZATION_POLICY, sanitizeHtml } from "./sanitizer";
import {
  DEFAULT_PARSER_OPTIONS,
  type DocumentMetadata,
  type HtmlSanitizer,
  type MarkdownDocument,
  type MarkdownParserOptions,
  type MarkdownRenderResult,
  type RenderDiagnostic,
  type RenderFragment,
  type RendererContext,
  type RenderRequest,
  type SanitizationPolicy
} from "./types";

export * from "./types";
export { RENDER_DIAGNOSTIC_CODES } from "./diagnostics";
export { classifyImageSrc, classifyLink } from "./links";
export type { ImageKind, LinkClassification, LinkKind } from "./links";
export { createAnchorRegistry, extractOutline, slugifyHeading } from "./outline";
export { countSourceLines, normalizeSource } from "./normalize";
export { buildAst } from "./ast";
// createMarkdownParser / getParser 不进门面：ARC-002 §3.3 只暴露内部抽象、
// §12.2 禁止应用层自行重复解析，Parser 只在管线内部使用（白盒测试直接引 ../parser）。
export { escapeHtml } from "./escape";
export { RendererRegistry } from "./registry";
export { DEFAULT_SANITIZATION_POLICY, htmlSanitizer, sanitizeHtml } from "./sanitizer";
export {
  PROCESSORS,
  PROCESSOR_ORDER,
  REGISTERED_PROCESSOR_NAMES,
  RESERVED_PROCESSORS,
  runProcessors
} from "./processors";
export type { Processor, ProcessorName } from "./processors";
// PLAIN_TEXT_LANGUAGES 一并出门面：Webview 侧的代码编辑器接管层（M8）要用同一个
// 「无后缀族不算缺失语言」的判断对齐两边的语法表，各抄一份清单必然漂移。
export { PLAIN_TEXT_LANGUAGES, highlightCode, isLanguageRegistered, supportedLanguages } from "./highlight";
export type { HighlightOutcome } from "./highlight";
export { blockRenderers } from "./renderers/blocks";
export { inlineRenderers } from "./renderers/inline";
export { tableRenderers } from "./renderers/table";
export { codeBlockRenderer } from "./renderers/code";
export { mathRenderer } from "./renderers/math";
export { WIKI_LINK_CLASS, wikiLinkRenderer } from "./renderers/wiki-link";
export {
  KATEX_OPTIONS,
  MATH_BLOCK_RULE_NAME,
  MATH_CONTAINER_CLASS,
  MATH_INLINE_RULE_NAME,
  MATH_SOURCE_MAX_LENGTH,
  isRenderableMath,
  renderMathExpression,
  type MathDisplay,
  type MathRenderOutcome
} from "./math";
export {
  WIKI_LINK_ATTRIBUTE,
  WIKI_LINK_MAX_LENGTH,
  WIKI_LINK_RULE_NAME,
  WIKI_LINK_TOKEN,
  isResolvableWikiTarget,
  scanWikiLink,
  wikiLinkLabel,
  wikiLinkRule,
  type WikiLinkMatch
} from "./wiki-link";
export { htmlAndDiagramRenderers } from "./renderers/html";
export {
  FOOTNOTES_CLASS,
  FOOTNOTE_BACKREF_CLASS,
  FOOTNOTE_ITEM_CLASS,
  FOOTNOTE_NODE_TYPES,
  FOOTNOTE_REF_CLASS,
  footnoteRenderers
} from "./renderers/footnote";
// 脚注规则常量出门面：Webview 与测试要按同一套 class / 锚点前缀写断言，
// 各写一份字面量必然漂移（与 WIKI_LINK_CLASS / MATH_* 同一口径）。
export {
  FOOTNOTE_ANCHOR_PREFIX,
  FOOTNOTE_DEF_OPEN_TOKEN,
  FOOTNOTE_DEF_RULE_NAME,
  FOOTNOTE_LABEL_ATTR,
  FOOTNOTE_MAX_ITEMS,
  FOOTNOTE_MAX_LABEL,
  FOOTNOTE_REF_ANCHOR_PREFIX,
  FOOTNOTE_REF_RULE_NAME,
  FOOTNOTE_REF_TOKEN,
  footnoteAnchor,
  footnoteRefAnchor,
  isUsableFootnoteLabel,
  scanFootnoteLabel
} from "./footnote";
// 块属性：白名单常量与尺寸形状判定出门面。isDelimitedSizeValue 是 Webview 接管层
// 落地 width / height 前的复查入口 —— 正则只有一份作者（attrs.ts）。
export {
  ALIGN_ATTR,
  ATTR_ENV_KEY,
  ATTR_RULE_NAME,
  CODE_BLOCK_ATTR,
  FILENAME_ATTR,
  HEADER_ATTR,
  HEIGHT_ATTR,
  WIDTH_ATTR,
  isAllowedFilenameValue,
  isDelimitedSizeValue,
  parseAttributeString,
  whitelistedAttributes
} from "./attrs";
// CSV 门面导出：CSV_LANGUAGES 让 Webview / Host 与处理器共用同一张语言表；
// isDelimitedSizeValue 从 attrs 导出（见上），尺寸正则不允许两边各写一份。
export { CSV_LANGUAGES, delimiterFor } from "./csv";

/** 所有渲染器统一经 Registry 注册（IMP-001 §8.3）。 */
export function createRendererRegistry(): RendererRegistry {
  return new RendererRegistry().registerAll([
    ...blockRenderers,
    ...inlineRenderers,
    ...tableRenderers,
    ...footnoteRenderers,
    codeBlockRenderer,
    mathRenderer,
    wikiLinkRenderer,
    ...htmlAndDiagramRenderers
  ]);
}

/** 轻量内容指纹（FNV-1a）：供应用层跳过同内容重复渲染，不承担安全职责。 */
export function computeContentHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export interface RenderPipelineOptions {
  policy?: SanitizationPolicy;
  sanitizer?: HtmlSanitizer;
  registry?: RendererRegistry;
}

function emptyMetadata(): DocumentMetadata {
  return { tags: [], properties: [] };
}

function resolveParserOptions(request: RenderRequest): MarkdownParserOptions {
  return { ...DEFAULT_PARSER_OPTIONS, ...(request.options ?? {}) };
}

/** 管线整体抛穿时的兜底：整篇以转义纯文本呈现，并给出 error 诊断。 */
function failureResult(request: RenderRequest, error: unknown): MarkdownRenderResult {
  const message = error instanceof Error ? error.message : String(error);
  const diagnostics: RenderDiagnostic[] = [
    {
      code: RENDER_DIAGNOSTIC_CODES.PARSE_FAILED,
      severity: "error",
      message: `Markdown pipeline failed, document rendered as escaped text: ${message.slice(0, 200)}`
    }
  ];
  return {
    documentId: request.documentId,
    version: request.version,
    html: `<pre class="readora-plain">${escapeHtml(request.text)}</pre>`,
    outline: [],
    diagnostics,
    metadata: emptyMetadata()
  };
}

/**
 * 被拒的 `{…}` → info 诊断（attrs.ts 通过 markdown-it env 交出记录）。
 *
 * 「为什么我的花括号没生效」必须可取证：整串保留在正文里是结果，
 * 原因不写进诊断就只剩用户自己猜。行号沿用 AST 的 0-based 口径（ast.ts positionOf）。
 */
function attrsRejectionDiagnostics(env: Record<string, unknown>): RenderDiagnostic[] {
  return rejectedAttributeStrings(env).map((entry) => ({
    code: RENDER_DIAGNOSTIC_CODES.ATTRS_REJECTED,
    severity: "info",
    message: `Attribute list {${entry.raw}} does not match the render whitelist; the braces stay in the text untouched.`,
    ...(entry.line === undefined ? {} : { source: { startLine: entry.line, endLine: entry.line } })
  }));
}

/** 完整管线：normalize → frontmatter → parse → AST → processors → render → sanitize。 */
export function renderMarkdown(
  request: RenderRequest,
  options: RenderPipelineOptions = {}
): MarkdownRenderResult {
  try {
    const normalized = normalizeSource(request.text);
    const frontmatter = extractFrontmatter(normalized);
    const parserOptions = resolveParserOptions(request);

    const env: Record<string, unknown> = {};
    const tokens = createMarkdownParser(parserOptions).parse(frontmatter.body, env);
    const lineCount = countSourceLines(frontmatter.body);
    // 处理器也会产出诊断（脚注没配对、csv 不成表、脚注区截断）：
    // 走 sink 而不是抛穿，§14.3 第 1 条「诊断不得打断整篇渲染」。
    const processorDiagnostics: RenderDiagnostic[] = [];
    const document: MarkdownDocument = runProcessors(
      buildAst(tokens, request.documentId, lineCount, parserOptions),
      processorDiagnostics
    );

    const registry = options.registry ?? createRendererRegistry();
    const context: RendererContext = {
      options: parserOptions,
      documentId: request.documentId,
      documentUri: request.documentUri,
      theme: request.theme ?? "light",
      render: (node): RenderFragment => registry.render(node, context),
      renderChildren: (node): RenderFragment => registry.renderChildren(node, context)
    };

    const assembled = registry.renderChildren(document, context);
    const policy = options.policy ?? DEFAULT_SANITIZATION_POLICY;
    const sanitized = options.sanitizer
      ? options.sanitizer.sanitize(assembled.html, policy)
      : sanitizeHtml(assembled.html, policy);

    return {
      documentId: request.documentId,
      version: request.version,
      html: sanitized.html,
      outline: extractOutline(document),
      diagnostics: [
        ...frontmatter.diagnostics,
        ...attrsRejectionDiagnostics(env),
        ...processorDiagnostics,
        ...assembled.diagnostics,
        ...sanitized.diagnostics
      ],
      metadata: frontmatter.metadata
    };
  } catch (error) {
    return failureResult(request, error);
  }
}
