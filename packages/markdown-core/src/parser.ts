/**
 * P02 Markdown Parser（ARC-002 §3 / IMP-001 §8.2）。
 *
 * markdown-it 实例不对外暴露（ARC-002 §3.3）：外部只能拿到 Token 流。
 * 配置固定为 html:false / linkify:true / typographer:false / breaks:false。
 */
import MarkdownItCtor from "markdown-it";
import type { MarkdownIt as MarkdownItInstance, Token as MarkdownItToken } from "markdown-it";
import { ATTR_RULE_NAME, attrsRule } from "./attrs";
import {
  FOOTNOTE_DEF_RULE_NAME,
  FOOTNOTE_REF_RULE_NAME,
  footnoteDefRule,
  footnoteRefRule
} from "./footnote";
import {
  mathBlockRule,
  mathInlineRule,
  MATH_BLOCK_RULE_NAME,
  MATH_INLINE_RULE_NAME
} from "./math";
import { WIKI_LINK_RULE_NAME, wikiLinkRule } from "./wiki-link";
import { DEFAULT_PARSER_OPTIONS, type MarkdownParserOptions } from "./types";

export type Token = MarkdownItToken;

const instances = new Map<string, MarkdownItInstance>();

function cacheKey(options: MarkdownParserOptions): string {
  return [options.html, options.linkify, options.typographer, options.breaks].join("|");
}

/**
 * 数学公式规则的插入位置是规范要求的，不是实现偏好（IMP-001 §10.3）：
 *
 * - inline 必须排在 `escape` **之前**。markdown-it 的 escape 规则在分词阶段就会把
 *   `\,`、`\%`、`\{`、`\_` 以及矩阵行尾的 `\\` 写成普通文本，等到 AST 再识别
 *   只能拿到损坏的源码；`$` 本身在 text 规则的终止符表内，所以规则本身能被触发，
 *   但触发顺序决定的是「谁先消费反斜杠」。
 * - block 必须排在 `paragraph` **之前**并带同样的 alt 链，否则 `$$…$$` 会被
 *   段落规则先吃掉，且在引用块 / 列表里行为不一致（alt 缺省时嵌套容器内不生效）。
 */
function installMathRules(md: MarkdownItInstance): void {
  md.inline.ruler.before("escape", MATH_INLINE_RULE_NAME, mathInlineRule);
  md.block.ruler.before("paragraph", MATH_BLOCK_RULE_NAME, mathBlockRule, {
    alt: ["paragraph", "reference", "blockquote", "list"]
  });
}

/**
 * Wiki Link 规则的插入位置同样是规范要求的（IMP-001 §12.2 / ARC-002 §5.3）：
 *
 * 必须排在 `link` **之前**。`[` 在 markdown-it 的 text 终止符表内，所以 `[[` 一定会
 * 走到规则分发；若让 `link` 先跑，`[[Note]](x)` 这类「链接文本里带方括号」的合法
 * Markdown 会按它的规则解析，而 `[[Note]]` 只会落成一段普通文本加一个失败的链接。
 * 排在它前面即可「是 wiki 引用就认领，不是就原样交回」。
 *
 * 不必担心吃掉代码片段：`backticks` 在 markdown-it 默认顺序里就排在 `link` 之前，
 * 本规则插在两者之间，`\`[[Not a link]]\`` 里的内容早在分词阶段已成为 code_inline。
 */
function installWikiLinkRule(md: MarkdownItInstance): void {
  md.inline.ruler.before("link", WIKI_LINK_RULE_NAME, wikiLinkRule);
}

/**
 * Footnote 规则的插入位置同样是规范要求的（M10，理由见 footnote.ts 头注）：
 *
 * - 块级必须排在 `reference` **之前**。markdown-it 会把 `[^note]: 正文` 当成
 *   链接引用定义收下（定义行从正文消失），然后 `[^a]` 又被 `link` 认成 shortcut
 *   引用 —— 产物就是一个 href 装着脚注正文的链接。先于 `reference` 认领即可断掉这条链。
 * - 行内必须排在 wiki-link 之前（即 footnote → wikiLink → link）：
 *   定义没被登记，`link` 也就无从把 `[^note]` 配成引用。
 *   `ruler.before(…)` 以**规则名**作锚点，因此 wiki 规则必须先完成注册；
 *   错一个顺序不是静默降级，是 `Parser rule not found` 直接抛穿到兜底分支。
 *
 * `code` / `fence` 仍排在前面：4 空格缩进的 `[^a]: x` 照旧是代码块，本规则不抢。
 */
function installFootnoteRules(md: MarkdownItInstance): void {
  md.block.ruler.before("reference", FOOTNOTE_DEF_RULE_NAME, footnoteDefRule, {
    alt: ["paragraph", "reference", "blockquote", "list"]
  });
  md.inline.ruler.before(WIKI_LINK_RULE_NAME, FOOTNOTE_REF_RULE_NAME, footnoteRefRule);
}

/**
 * 块属性装在 core 的 `inline` **之后**：此时行内 children 已就位，
 * 而 linkify / replacements 还没改写文本节点 —— 尾随 `{…}` 要从文本节点里摘掉，
 * 早一步（行内解析前）拿不到 children，晚一步（replacements 后）改的字就不是自己改的。
 */
function installAttrsRule(md: MarkdownItInstance): void {
  md.core.ruler.after("inline", ATTR_RULE_NAME, attrsRule);
}

function createInstance(options: MarkdownParserOptions): MarkdownItInstance {
  const md = new MarkdownItCtor({
    html: options.html,
    linkify: options.linkify,
    typographer: options.typographer,
    breaks: options.breaks
  });
  installMathRules(md);
  installWikiLinkRule(md);
  // wiki 规则先注册：footnote 的行内规则以它的规则名为锚点（上面注释）。
  installFootnoteRules(md);
  installAttrsRule(md);
  return md;
}

/** 按配置复用实例：Webview 内多次渲染不应重复构造 Parser。 */
export function getParser(options: MarkdownParserOptions = DEFAULT_PARSER_OPTIONS): MarkdownItInstance {
  const key = cacheKey(options);
  const cached = instances.get(key);
  if (cached) {
    return cached;
  }
  const created = createInstance(options);
  instances.set(key, created);
  return created;
}

export interface MarkdownParser {
  /** env 是 markdown-it 的旁路容器：本管线用它接 attrs 规则的被拒记录（attrs.ts）。 */
  parse(source: string, env?: Record<string, unknown>): Token[];
}

export function createMarkdownParser(
  options: MarkdownParserOptions = DEFAULT_PARSER_OPTIONS
): MarkdownParser {
  return {
    parse(source: string, env: Record<string, unknown> = {}): Token[] {
      return getParser(options).parse(source, env);
    }
  };
}

/** 供依赖兼容性测试使用：确认扩展语法入口未被误开。 */
export function parserOptionsOf(
  options: MarkdownParserOptions = DEFAULT_PARSER_OPTIONS
): MarkdownParserOptions {
  return { ...options };
}
