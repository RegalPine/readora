/**
 * Footnote：`[^label]` 引用与 `[^label]: 定义` 的识别（PRD-001 F01-017，M10）。
 *
 * 分工与 math / wiki-link 同构（见 math.ts、wiki-link.ts 头注），三层各司其职：
 * - 本模块：两条 markdown-it 规则（认引用、认定义）+ 标签形状判定；
 * - `ast.ts`：把命中的 token 落成 `footnoteReference` / `footnoteDefinition` 节点，
 *   「这条引用有没有对应的定义、排第几号」不在这里决定；
 * - `processors.ts`：`footnote` 处理器收定义、编号、配对，并把脚注区挂到文档末尾。
 *
 * **为什么必须自持规则，而不是「靠 markdown-it 默认 preset」**：实测默认
 * preset 里没有任何 footnote 规则（AUD-001 §4.4 的「依赖隐式行为」判断成立），
 * 而 `[^note]: 正文` 会被 `reference` 规则当成链接引用定义吞掉、`[^note]` 会被
 * `link` 规则解析成 shortcut 引用，产物是 `<a href="正文">^note</a>` ——
 * 定义行从正文消失、正文被塞进 href。这不是「没渲染成脚注」，是内容损坏。
 * 于是插入位置是硬约束：
 * - 块级规则装在 `reference` **之前**（先把 `[^label]:` 认领掉，`reference` 就
 *   无从登记那个标签）；`code` / `fence` 等仍排在前面，4 空格缩进的写法照旧是
 *   代码块，本规则不抢。
 * - 行内规则装在 wiki-link **之前**（即 footnote → wikiLink → link），于是
 *   `state.env.defs` 里没有那个标签，`link` 也拿不到它。
 *
 * 标签字符集：不含空白、方括号与控制字符，长度 1～`FOOTNOTE_MAX_LABEL`。
 * 判不出来一律 `return false` 交回原规则 —— 与 math「没有闭合就按散文处理」
 * 同一条底线：绝不吞正文（ARC-002 §14.3 第 5 条）。
 */
import type { StateBlock, StateInline } from "markdown-it";

/** 规则名（与 `readora.math_span` / `readora.wiki_link` 同一前缀口径）。 */
export const FOOTNOTE_REF_RULE_NAME = "readora.footnote_ref";
export const FOOTNOTE_DEF_RULE_NAME = "readora.footnote_def";

/** Token 类型：`ast.ts` 按这些名字识别，规则与 AST 之间只有这一层耦合。 */
export const FOOTNOTE_REF_TOKEN = "footnote_ref";
export const FOOTNOTE_DEF_OPEN_TOKEN = "footnote_def_open";
export const FOOTNOTE_DEF_CLOSE_TOKEN = "footnote_def_close";

/** token / 节点上的标签属性名。 */
export const FOOTNOTE_LABEL_ATTR = "footnoteLabel";

/** 单个标签的长度上限：再长就不像脚注标签，更像在塞句子。 */
export const FOOTNOTE_MAX_LABEL = 64;

/** 脚注区条目上限：与图表源码上限同一量级的「有上限、超限降级不假装」。 */
export const FOOTNOTE_MAX_ITEMS = 200;

/**
 * 锚点前缀：`id` 里带连字符，既不会与 document 具名属性冲突（DOMPurify 的
 * SANITIZE_DOM 因此不会剥离），也不会被 `getElementById` 之外的选择器语义误读。
 */
export const FOOTNOTE_ANCHOR_PREFIX = "readora-fn-";
export const FOOTNOTE_REF_ANCHOR_PREFIX = "readora-fnref-";

const OPEN_BRACKET = 0x5b;
const CARET = 0x5e;
const CLOSE_BRACKET = 0x5d;
const COLON = 0x3a;

function isLabelChar(code: number): boolean {
  // 空白、方括号、控制字符与高位代理都不算标签字符：前者会撕裂配对，
  // 后者在本管线里没有稳定语义。
  return code > 0x20 && code !== OPEN_BRACKET && code !== CLOSE_BRACKET && code < 0x7f;
}

export interface FootnoteLabelMatch {
  /** 闭合 `]` 之后的位置。 */
  readonly end: number;
  /** 含定界符的原始源码 `[^label]`，未配对时按字面量输出。 */
  readonly raw: string;
  readonly label: string;
}

/**
 * 从 `pos`（必须指向 `[`）扫描一条 `[^label]`。
 *
 * 不跨行（行内规则里 `src` 就是单段行内文本，块级规则单独按行取），
 * 标签内不允许空白与方括号；不满足即返回 null 交回原规则。
 */
export function scanFootnoteLabel(src: string, pos: number): FootnoteLabelMatch | null {
  if (src.charCodeAt(pos) !== OPEN_BRACKET || src.charCodeAt(pos + 1) !== CARET) {
    return null;
  }
  let cursor = pos + 2;
  while (cursor < src.length && isLabelChar(src.charCodeAt(cursor))) {
    cursor += 1;
  }
  const label = src.slice(pos + 2, cursor);
  if (label.length === 0 || label.length > FOOTNOTE_MAX_LABEL) {
    return null;
  }
  if (src.charCodeAt(cursor) !== CLOSE_BRACKET) {
    return null;
  }
  const end = cursor + 1;
  return { end, raw: src.slice(pos, end), label };
}

/** 标签本身是否可用（处理与「定义存在与否」无关，只看形状）。 */
export function isUsableFootnoteLabel(label: string): boolean {
  if (label.length === 0 || label.length > FOOTNOTE_MAX_LABEL) {
    return false;
  }
  for (let index = 0; index < label.length; index += 1) {
    if (!isLabelChar(label.charCodeAt(index))) {
      return false;
    }
  }
  return true;
}

/** markdown-it 行内规则：装在 wiki-link 之前（理由见头注）。 */
export function footnoteRefRule(state: StateInline, silent: boolean): boolean {
  const found = scanFootnoteLabel(state.src, state.pos);
  if (!found) {
    return false;
  }
  if (!silent) {
    const token = state.push(FOOTNOTE_REF_TOKEN, "", 0);
    // content 存含定界符的原文：处理器判「没有这条定义」时摘掉标记即可原样显示。
    token.content = found.raw;
    token.attrSet(FOOTNOTE_LABEL_ATTR, found.label);
    token.level = state.level;
  }
  state.pos = found.end;
  return true;
}

function lineText(state: StateBlock, line: number): string {
  const begin = state.bMarks[line] ?? 0;
  const shift = state.tShift[line] ?? 0;
  const max = state.eMarks[line] ?? begin + shift;
  return state.src.slice(state.skipSpaces(begin + shift), max);
}

/** 续行的缩进判定：比块的基准缩进多 4 格以上才算挂在定义上（与 code 规则同一口径）。 */
function isContinuation(state: StateBlock, line: number): boolean {
  return (state.sCount[line] ?? 0) - state.blkIndent >= 4;
}

/**
 * markdown-it 块级规则：认 `[^label]: 定义`，含缩进续行。
 *
 * 定义体按行 join 成一个 inline token（续行去掉缩进、空行保留为换行），
 * 于是多段定义在渲染期成为 softbreak 而非新的段落 —— 脚注条目要的是
 * 「一段紧凑的补充说明」，把它拆成两个块级节点只会让列表里的编号跳行。
 */
export function footnoteDefRule(
  state: StateBlock,
  startLine: number,
  endLine: number,
  silent: boolean
): boolean {
  const text = lineText(state, startLine);
  const found = scanFootnoteLabel(text, 0);
  if (!found) {
    return false;
  }
  const afterLabel = text.slice(found.end);
  if (afterLabel.charCodeAt(0) !== COLON) {
    return false;
  }
  if (silent) {
    return true;
  }

  const body: string[] = [afterLabel.slice(1).trim()];
  let nextLine = startLine + 1;
  while (nextLine < endLine) {
    const line = lineText(state, nextLine);
    if (line.length === 0) {
      // 空行之后必须紧跟缩进续行，否则定义到此结束（空行本身留给段落判定）。
      const following = nextLine + 1 < endLine ? lineText(state, nextLine + 1) : "";
      if (following.length === 0 || !isContinuation(state, nextLine + 1)) {
        break;
      }
      body.push("");
      nextLine += 1;
      continue;
    }
    if (!isContinuation(state, nextLine)) {
      break;
    }
    body.push(line);
    nextLine += 1;
  }

  const token = state.push(FOOTNOTE_DEF_OPEN_TOKEN, "", 1);
  token.map = [startLine, nextLine];
  token.attrSet(FOOTNOTE_LABEL_ATTR, found.label);

  const inline = state.push("inline", "", 0);
  inline.content = body.join("\n").trim();
  inline.map = [startLine, nextLine];
  inline.children = [];

  state.push(FOOTNOTE_DEF_CLOSE_TOKEN, "", -1);
  state.line = nextLine;
  return true;
}

/**
 * 锚点生成：编号与「同一脚注的第 N 次引用」共同决定 id，
 * 于是重复引用同一脚注不会产生第二个同名 `id`（HTML 里 id 必须唯一）。
 */
export function footnoteAnchor(index: number): string {
  return `${FOOTNOTE_ANCHOR_PREFIX}${index}`;
}

export function footnoteRefAnchor(index: number, occurrence: number): string {
  return occurrence <= 1
    ? `${FOOTNOTE_REF_ANCHOR_PREFIX}${index}`
    : `${FOOTNOTE_REF_ANCHOR_PREFIX}${index}-${occurrence}`;
}
