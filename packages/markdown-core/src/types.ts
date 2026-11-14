/**
 * markdown-core 数据类型（ARC-002 §4 / §6 / §11 / §12 / §14）。
 *
 * 本包运行于 Webview（IMP-001 §4.2），禁止依赖 VS Code API 与 node: 内置模块。
 */

/** ARC-002 §4.3 冻结的第一阶段节点类型。 */
export const CORE_NODE_TYPES = [
  "document",
  "heading",
  "paragraph",
  "text",
  "emphasis",
  "strong",
  "link",
  "image",
  "list",
  "listItem",
  "blockquote",
  "codeBlock",
  "inlineCode",
  "table",
  "thematicBreak",
  "htmlBlock",
  "mathBlock",
  "mathInline",
  "diagramBlock",
  "wikiLink",
  "frontmatter"
] as const;

/**
 * 表格行 / 单元格、删除线与换行的节点类型未列入 ARC-002 §4.3 冻结表，
 * 但 §7.2（删除线）与 §7.5（表格）是硬性渲染要求，无法在既有类型上表达。
 * 因此作为内部实现扩展登记，不改变对外 MarkdownRenderResult 契约；
 * 文档治理轮需在 ARC-002 §4.2 补齐或明确允许实现扩展。
 *
 * M10 追加脚注四类（PRD-001 F01-017）：同一口径 —— 对外契约不变，
 * 偏差登记在 README「偏差登记（M10）」。脚注区的标题不是 heading 节点，
 * 于是目录（extractOutline）不会多出一条「脚注」。
 */
export const EXTENSION_NODE_TYPES = [
  "tableRow",
  "tableCell",
  "delete",
  "break",
  "footnoteDefinition",
  "footnoteReference",
  "footnoteSection",
  "footnoteItem"
] as const;

export type CoreNodeType = (typeof CORE_NODE_TYPES)[number];
export type ExtensionNodeType = (typeof EXTENSION_NODE_TYPES)[number];
export type MarkdownNodeType = CoreNodeType | ExtensionNodeType;

export interface SourcePosition {
  startLine: number;
  startColumn?: number;
  endLine: number;
  endColumn?: number;
}

export interface MarkdownNode {
  id: string;
  type: MarkdownNodeType;
  position?: SourcePosition;
  children?: MarkdownNode[];
  value?: string;
  attributes?: Record<string, unknown>;
}

export interface MarkdownDocument extends MarkdownNode {
  type: "document";
  children: MarkdownNode[];
}

/** ARC-002 §14.1 诊断级别。 */
export type DiagnosticSeverity = "info" | "warning" | "error";

/** ARC-002 §14.2 诊断结构。 */
export interface RenderDiagnostic {
  code: string;
  severity: DiagnosticSeverity;
  message: string;
  source?: SourcePosition;
  nodeId?: string;
}

/** ARC-002 §12.1 大纲条目。 */
export interface OutlineItem {
  id: string;
  title: string;
  level: number;
  anchor: string;
  position?: SourcePosition;
}

/**
 * ARC-002 §12.1 文档元数据。
 *
 * `properties` 是 M6（STORY-06-02）加的完整属性名单：前三个槽位是给应用层用的
 * 归一化视图（标题、摘要、标签），卡片要展示的是作者写下的每一个键。
 */
export interface DocumentMetadata {
  title?: string;
  description?: string;
  tags: string[];
  properties: readonly FrontmatterProperty[];
}

/**
 * Frontmatter 属性值的类型（STORY-06-02 / PRD-003 §4.6 属性卡片）。
 *
 * 分类只看字面量形态，不做任何求值：见 frontmatter.ts 的 classifyFrontmatterValue。
 */
export type FrontmatterValueKind = "text" | "number" | "boolean" | "date" | "list";

export interface FrontmatterProperty {
  /** 原始键名（区分大小写，Obsidian 口径）；metadata 的归一化不看这里。 */
  key: string;
  kind: FrontmatterValueKind;
  /** 展示文本：始终是去掉引号后的原文字面量，日期与数字都不重新格式化。 */
  text: string;
  /** 仅 kind === "list" 有值：每个条目都是去引号后的原文。 */
  items?: readonly string[];
}

/** ARC-002 §12.1 统一渲染结果；应用层不得重复解析 HTML（§12.2）。 */
export interface MarkdownRenderResult {
  documentId: string;
  version: number;
  html: string;
  outline: OutlineItem[];
  diagnostics: RenderDiagnostic[];
  metadata: DocumentMetadata;
}

/** ARC-002 §3.3 Parser 选项。 */
export interface MarkdownParserOptions {
  html: boolean;
  linkify: boolean;
  typographer: boolean;
  breaks: boolean;
}

/** IMP-001 §8.2 冻结的初始配置。 */
export const DEFAULT_PARSER_OPTIONS: MarkdownParserOptions = {
  html: false,
  linkify: true,
  typographer: false,
  breaks: false
};

export type ResolvedRenderTheme = "light" | "dark";

/**
 * ARC-002 §6.3 RendererContext。
 * IMP-001 §8.3 的 resolveAsset 属资源解析（M3），M2 不提供，避免虚构能力。
 * render / renderChildren 由 Registry 注入：§6.3 未定义遍历入口，
 * 容器渲染器需要它才能递归产出子节点，属实现必需的上下文扩展。
 */
export interface RendererContext {
  options: MarkdownParserOptions;
  documentId: string;
  documentUri: string;
  theme: ResolvedRenderTheme;
  render(node: MarkdownNode): RenderFragment;
  renderChildren(node: MarkdownNode): RenderFragment;
}

/** ARC-002 §6.3 渲染片段。 */
export interface RenderFragment {
  html: string;
  diagnostics: RenderDiagnostic[];
}

/** ARC-002 §6.3 渲染器接口；所有渲染器必须经 Registry 注册（IMP-001 §8.3）。 */
export interface MarkdownRenderer {
  readonly id: string;
  supports(node: MarkdownNode): boolean;
  render(node: MarkdownNode, context: RendererContext): RenderFragment;
}

/** ARC-002 §11.3 安全策略。 */
export interface SanitizationPolicy {
  allowHtml: boolean;
  allowSvg: boolean;
  allowExternalLinks: boolean;
  allowedUrlSchemes: string[];
}

export interface SanitizeOutcome {
  html: string;
  diagnostics: RenderDiagnostic[];
}

/** ARC-002 §11.3 Sanitizer 接口。 */
export interface HtmlSanitizer {
  sanitize(html: string, policy: SanitizationPolicy): SanitizeOutcome;
}

export interface RenderRequest {
  documentId: string;
  documentUri: string;
  version: number;
  text: string;
  theme?: ResolvedRenderTheme;
  options?: Partial<MarkdownParserOptions>;
}
