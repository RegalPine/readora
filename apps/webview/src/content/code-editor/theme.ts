/**
 * 代码编辑器的配色与外观（PRD-003 §4.2/§4.3 的「代码块贴正文底色」口径延续）。
 *
 * 两条硬约束：
 *
 * 1. **一个色值都不许写死**。CodeMirror 的主题与 HighlightStyle 是 JS 对象，
 *    绕过了 `no-hardcoded-color.spec.ts` 对 CSS 文件的扫描，所以这里全部给
 *    `var(--readora-*)` 字符串：真实颜色由 tokens.css 在元素上求值，切主题只是
 *    `html[data-readora-theme]` 换 class —— 编辑器不需要重建实例，与图表层的
 *    「只切 class，颜色由 CSS 变量求值」（ARC-003 §8.2）同一口径。
 *    `code-editor-theme.spec.ts` 断言这里出现的每个颜色都是 var() 引用，
 *    且引用的名字在 tokens.css 里真实存在。
 * 2. **tag → Token 的映射照抄静态视图的 hljs 类映射**（markdown.css 里 `.hljs-*`
 *    那一段）。两个视图共用同一份源码，搜索命中时块会临时回显静态视图
 *    （markdown.css 的 `:has(.readora-code-pre .readora-search-hit)` 那条）；
 *    映射不一致就会看见配色跳变。
 *    语法色只有 8 路 Token（foreground/comment/keyword/string/number/title/attr/
 *    deletion），没有「绿色/新增」这一路，所以 `inserted` 按静态视图的
 *    `.hljs-addition → string` 走同一色。
 */
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";

/** 本文件引用到的全部 Token 名（单测据此与 tokens.css 双向核对）。 */
export const EDITOR_COLOR_TOKENS: readonly string[] = [
  "--readora-hairline",
  "--readora-syntax-foreground",
  "--readora-syntax-comment",
  "--readora-syntax-keyword",
  "--readora-syntax-string",
  "--readora-syntax-number",
  "--readora-syntax-title",
  "--readora-syntax-attr",
  "--readora-syntax-deletion",
  "--readora-color-text-muted",
  "--readora-color-accent-soft",
  "--readora-color-surface-subtle",
  "--readora-color-border",
  "--readora-color-focus",
  "--readora-danger-background"
];

function varOf(token: string): string {
  if (!EDITOR_COLOR_TOKENS.includes(token)) {
    throw new Error(`代码编辑器引用了未登记的 Token：${token}`);
  }
  return `var(${token})`;
}

/**
 * 语法着色表：与 markdown.css 里 `.hljs-*` 那批选择器一一对应。
 *
 * 覆盖不全是允许的（没命中的 tag 落回 foreground）：宁可少着色，也不能为了
 * 「看起来丰富」去引用第 9 路色值 —— 那会同时踩两条硬约束（新 Token 需过
 * design-tokens 注册表与视觉基线，本批不为编辑器扩表）。
 */
export function readoraHighlightStyle(): HighlightStyle {
  return HighlightStyle.define([
    // .hljs-comment / .hljs-quote（静态视图连斜体一起给，这里同样带 fontStyle）
    { tag: [t.comment, t.lineComment, t.blockComment, t.docComment, t.quote],
      color: varOf("--readora-syntax-comment"),
      fontStyle: "italic" },
    // .hljs-keyword / .hljs-selector-tag / .hljs-doctag
    {
      tag: [
        t.keyword,
        t.modifier,
        t.operatorKeyword,
        t.controlKeyword,
        t.definitionKeyword,
        t.moduleKeyword,
        t.meta,
        t.annotation,
        t.processingInstruction,
        t.list
      ],
      color: varOf("--readora-syntax-keyword")
    },
    // .hljs-string / .hljs-regexp / .hljs-addition
    {
      tag: [t.string, t.character, t.docString, t.regexp, t.escape, t.attributeValue, t.inserted],
      color: varOf("--readora-syntax-string")
    },
    // .hljs-number / .hljs-literal / .hljs-type
    {
      tag: [t.number, t.integer, t.float, t.bool, t.null, t.atom, t.unit, t.color, t.typeName],
      color: varOf("--readora-syntax-number")
    },
    // .hljs-title / .hljs-title.function_ / .hljs-section
    {
      tag: [
        t.function(t.variableName),
        t.definition(t.variableName),
        t.className,
        t.tagName,
        t.heading,
        t.labelName
      ],
      color: varOf("--readora-syntax-title")
    },
    // .hljs-attr / .hljs-attribute / .hljs-variable / .hljs-template-variable
    {
      tag: [t.attributeName, t.propertyName, t.variableName, t.url, t.link, t.namespace],
      color: varOf("--readora-syntax-attr")
    },
    // .hljs-deletion：连底色一起对齐静态视图那条（danger-background 是半透明叠加，不铺面）
    {
      tag: [t.strikethrough, t.deleted, t.invalid],
      color: varOf("--readora-syntax-deletion"),
      background: varOf("--readora-danger-background")
    },
    // 其余一律正文前景：操作符、标点、括号、普通标识符与文本
    {
      tag: [
        t.operator,
        t.arithmeticOperator,
        t.logicOperator,
        t.bitwiseOperator,
        t.compareOperator,
        t.updateOperator,
        t.definitionOperator,
        t.typeOperator,
        t.controlOperator,
        t.derefOperator,
        t.punctuation,
        t.separator,
        t.bracket,
        t.angleBracket,
        t.squareBracket,
        t.paren,
        t.brace,
        t.content,
        t.contentSeparator,
        t.emphasis,
        t.strong,
        t.monospace,
        t.changed,
        t.self,
        t.macroName
      ],
      color: varOf("--readora-syntax-foreground")
    }
  ]);
}

/**
 * 编辑器外壳外观。
 *
 * 底色一律 `transparent`：代码块的身份靠等宽字与语法色就够了，铺面就会在正文里
 * 留一块与容器不同色的补丁（这是用户对代码块定下的硬口径，0.7.0 已经把 Token
 * `--readora-code-background` 改成 canvas，编辑器接管后同样不能带回来）。
 * 底色由块所在的画布提供，读起来与静态视图完全一致。
 *
 * 规格写成导出的普通对象而不是直接内联给 `EditorView.theme`：单测要能结构化地
 * 逐条查颜色（拿正则扫源码那种断言本身就很脆，`varOf(...)` 调用形式都认不出来）。
 */
type ThemeSpec = Parameters<typeof EditorView.theme>[0];

export const EDITOR_THEME_SPEC: ThemeSpec = {
  "&": {
    background: "transparent",
    color: varOf("--readora-syntax-foreground"),
    // 高度跟着内容走（代码块在阅读面里不该自带纵向滚动），字号交给宿主 CSS；
    // 不给 height 的话编辑器会顶满父容器，长块短块看上去一样高。
    height: "auto"
  },
  ".cm-scroller": {
    overflowX: "auto",
    // 与静态视图 `.readora-code-pre code` 同一行高（1.55）：两个视图切换不跳行距。
    lineHeight: "1.55"
  },
  ".cm-content": {
    caretColor: varOf("--readora-syntax-foreground"),
    padding: "0"
  },
  ".cm-cursor, .cm-dropCursor": {
    borderLeftColor: varOf("--readora-syntax-foreground")
  },
  // 选中面走 accent-soft：它已经在大纲活动项上被验证过「压得住正文但不刺眼」。
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
    background: varOf("--readora-color-accent-soft")
  },
  // 阅读视图里当前行不铺色：光标每移动一次就换一块底色，比语法色更抢视线。
  ".cm-activeLine, .cm-activeLineGutter": { background: "transparent" },
  ".cm-gutters": {
    background: "transparent",
    color: varOf("--readora-color-text-muted"),
    border: "none",
    borderRight: `var(--readora-hairline) solid ${varOf("--readora-color-border")}`
  },
  ".cm-lineNumbers .cm-gutterElement": {
    color: varOf("--readora-color-text-muted"),
    padding: "0 0.6em"
  },
  ".cm-foldPlaceholder": {
    background: varOf("--readora-color-surface-subtle"),
    color: varOf("--readora-color-text-muted"),
    border: "none",
    padding: "0 0.4em"
  },
  // 键盘进得去就得看得见：焦点环继续走宿主（ARC-006 §6.1 第 7 条）。
  "&.cm-focused": {
    outline: `1px solid ${varOf("--readora-color-focus")}`
  }
};

export function readoraEditorTheme(): ReturnType<typeof EditorView.theme> {
  return EditorView.theme(EDITOR_THEME_SPEC);
}

/** 着色装配：`fallback: true` 让语法自身的 tag 样式（若将来引入）仍有机会覆盖。 */
export function readoraHighlightExtension(): ReturnType<typeof syntaxHighlighting> {
  return syntaxHighlighting(readoraHighlightStyle(), { fallback: true });
}
