/**
 * Wiki Link：`[[目标]]` / `[[目标|别名]]` 的识别与判定（IMP-001 §12.2，STORY-06-03）。
 *
 * 分工与数学公式同构（见 math.ts 头注），三层各司其职：
 * - 本模块：markdown-it 行内规则（认 `[[…]]`）+ 「这算不算一个可跳转目标」的判定；
 * - `ast.ts`：把命中的 token 落成**带 wikiTarget 标记的 text 节点**，归类交给处理器；
 * - `processors.ts`：`readora.ast.wikiLink` 处理器把标记节点归为 wikiLink，
 *   判定不成立时摘掉标记，节点仍是原来的 text、value 仍是 `[[…]]` 源码本身，
 *   于是「不是一个链接」的写法（空目标、scheme、绝对路径）就按字面量显示。
 *
 * 规则装在 `link` **之前**（parser.ts）：`[` 在 markdown-it 的 text 终止符表里，
 * 而 `link` 规则会把 `[[x](y)]` 这类合法 Markdown 链接按嵌套方括号解析；
 * 先于它消费 `[[` 才能同时保住两种写法的语义。反引号规则排在 `link` 之前，
 * 所以代码片段里的 `[[…]]` 不会被本规则劫持 —— 这是可断言的，不是巧合。
 *
 * 为什么这里就要拒掉 scheme 与绝对路径：渲染产物只有一个 `data-readora-wikilink`
 * 属性，Webview 不拼本地路径也不判权限（IMP-001 §12.2），真正的解析与存在性检查
 * 在 Host。但「`[[http://example.com]]` 该不该长成一个跨文档链接」是渲染语义问题：
 * 答案是不该 —— 它要么是一条普通链接，要么什么都不是。留在这一层判定，
 * 是为了让 View 侧不可能把可疑字符串呈现成「可点击的文档名」。
 */
import type { StateInline } from "markdown-it";

/** 规则名（与 `readora.math_span` 同一前缀口径，IMP-001 §10.3 点名式命名）。 */
export const WIKI_LINK_RULE_NAME = "readora.wiki_link";

/** Token 类型：`ast.ts` 按这个名字识别，规则与 AST 之间只有这一层耦合。 */
export const WIKI_LINK_TOKEN = "wiki_link";

/** text 节点上的标记属性；处理器归类成功后它们换成节点自己的 attributes。 */
export const WIKI_TARGET_ATTR = "wikiTarget";
export const WIKI_ALIAS_ATTR = "wikiAlias";

/** 渲染产物上的定位属性：Webview 的事件委托只读它，绝不读 href（§12.2）。 */
export const WIKI_LINK_ATTRIBUTE = "data-readora-wikilink";

const OPEN_BRACKET = 0x5b;
/** 单条引用的源码上限：再长就不像文档名，更像是在塞数据。 */
export const WIKI_LINK_MAX_LENGTH = 1_024;

export interface WikiLinkMatch {
  /** 消费到的下一个位置（闭合 `]]` 之后）。 */
  readonly end: number;
  /** 含定界符的原始源码，降级为散文时按字面量输出。 */
  readonly raw: string;
  readonly target: string;
  readonly alias: string;
}

/**
 * 从 `pos`（必须指向 `[`）扫描一条 `[[…]]`。
 *
 * 取**第一个** `]]` 为闭合，别名以第一个 `|` 分割（Obsidian / MediaWiki 口径）：
 * 于是 `[[a|b|c]]` 的目标是 `a`、别名是 `b|c`，而不是把第三个 `|` 也吞掉。
 * 不跨行、不嵌套、空目标一律不认。
 */
export function scanWikiLink(src: string, pos: number): WikiLinkMatch | null {
  if (src.charCodeAt(pos) !== OPEN_BRACKET || src.charCodeAt(pos + 1) !== OPEN_BRACKET) {
    return null;
  }
  const start = pos + 2;
  const close = src.indexOf("]]", start);
  if (close < 0) {
    return null;
  }
  const inner = src.slice(start, close);
  if (inner.length === 0 || inner.includes("\n") || src.slice(pos, close + 2).length > WIKI_LINK_MAX_LENGTH) {
    return null;
  }
  const bar = inner.indexOf("|");
  const target = (bar < 0 ? inner : inner.slice(0, bar)).trim();
  const alias = bar < 0 ? "" : inner.slice(bar + 1).trim();
  if (target.length === 0) {
    return null;
  }
  return { end: close + 2, raw: src.slice(pos, close + 2), target, alias };
}

/** markdown-it 行内规则：装到 `link` 之前（理由见头注）。 */
export function wikiLinkRule(state: StateInline, silent: boolean): boolean {
  const found = scanWikiLink(state.src, state.pos);
  if (!found) {
    return false;
  }
  if (!silent) {
    const token = state.push(WIKI_LINK_TOKEN, "", 0);
    // content 存**含定界符的原文**（同 math 的口径）：判定不成立时 AST 直接把它
    // 当普通 text 输出，`[[…]]` 一个字都不丢。target / alias 走 attrs 搬运。
    token.content = found.raw;
    token.attrSet(WIKI_TARGET_ATTR, found.target);
    token.attrSet(WIKI_ALIAS_ATTR, found.alias);
    token.level = state.level;
  }
  state.pos = found.end;
  return true;
}

/** scheme 形态：`http:`、`file:`、`mailto:`，以及 Windows 盘符 `C:`。 */
const SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:/i;
const DRIVE_PATTERN = /^[a-z]:[\\/]/i;

/**
 * 「可跳转目标」的判定（处理器的唯一依据）。
 *
 * 拒掉六类：空、超长、带 scheme（含盘符）、以 `/` 或 `\` 开头的绝对路径、
 * 含 `#`（标题锚点）、含 `^`（块引用）。
 * 前四类是语义或权限问题；后两类是**能力边界**：本批只有「打开目标文档」这一条
 * 通道（document.navigate），跨文档定位到某个标题要 Host 侧的下发时序配合
 * （ARC-004 §8 的 state.restore 只在同一篇文档内成立）。与其把 `[[Note#节]]`
 * 做成一个「打开文档但落点不对」的链接，不如让它按字面量显示 —— 后者不撒谎。
 * 这一条已登记进 README 的未纳入清单。
 *
 * `..` 不在这里拒：vault 内的 `[[../sibling/Note]]` 是 Obsidian 的常规写法，
 * 是否越出工作区由 Host 的 resolveReference + canonicalFileUri 把关（ARC-008 §16.1），
 * 那里有真正的文件系统边界可以证明。
 */
export function isResolvableWikiTarget(target: string): boolean {
  const trimmed = target.trim();
  if (trimmed.length === 0 || trimmed.length > WIKI_LINK_MAX_LENGTH) {
    return false;
  }
  if (SCHEME_PATTERN.test(trimmed) || DRIVE_PATTERN.test(trimmed)) {
    return false;
  }
  if (trimmed.startsWith("/") || trimmed.startsWith("\\")) {
    return false;
  }
  return !trimmed.includes("#") && !trimmed.includes("^");
}

/** 显示文本：别名优先，别名与目标都取原文（不做大小写美化，Obsidian 口径）。 */
export function wikiLinkLabel(target: string, alias: string): string {
  return alias.length > 0 ? alias : target;
}
