/**
 * 数学公式：定界符识别与 KaTeX 渲染（IMP-001 §10.1 ～ §10.3，EPIC-06 / STORY-06-01）。
 *
 * 分工与 IMP-001 §10.3 一致，三层各司其职：
 * - 本模块：markdown-it 规则（认 `$…$` / `$$…$$`，以及 LaTeX 传统的 `\(…\)` / `\[…\]`）
 *   + KaTeX 调用 + 有效性判定；
 * - `ast.ts`：把命中的 token 落成**带 mathSource 标记的 text 节点**，而不是直接落
 *   mathInline / mathBlock —— 归类是 AST 处理阶段的职责（§5.3 顺序 Frontmatter →
 *   Heading → Code Block → Math → Wiki Link → Asset）；
 * - `processors.ts`：`readora.ast.math` 处理器把标记节点归为 mathInline 或 mathBlock，
 *   判定不成立的表达式摘掉标记即原样还原为散文。
 *
 * 「不成立」有两级：
 * 1. 规则层不匹配（货币写法 `$100 和 $200`、跨行行内式、空表达式）—— 从未成为公式；
 * 2. 渲染层失败（KaTeX ParseError / 超过 maxSize）—— 是公式但渲不出来，
 *    降级内容是这条公式**自身的源码**，文档其余部分照常渲染（§10.2 第 2 条）。
 *
 * 定界符分两族，拒判口径故意不同：`$` 族要让路给「钱」（开/闭界符紧贴空白即弃）；
 * `\(` / `\[` 族没有这种歧义，套同一组空白拒判只会误伤 `\( a+b \)` 这种合法写法。
 */
import katex from "katex";
import type { StateBlock, StateInline } from "markdown-it";

/** 规则名（IMP-001 §10.3 点名 `readora.math_span`；块级同前缀）。 */
export const MATH_INLINE_RULE_NAME = "readora.math_span";
export const MATH_BLOCK_RULE_NAME = "readora.math_block";

/** Token 类型：`ast.ts` 按这两个名字识别，规则与 AST 之间只有这一层耦合。 */
export const MATH_SPAN_TOKEN = "math_span";
export const MATH_BLOCK_TOKEN = "math_block";

/** 公式源码在 text 节点上的标记属性（处理器据此归类，判定不成立时整对删除）。 */
export const MATH_SOURCE_ATTR = "mathSource";
export const MATH_DISPLAY_ATTR = "mathDisplay";

const DOLLAR = 0x24;
const BACKSLASH = 0x5c;
const NEWLINE = 0x0a;
const SPACE = 0x20;
const TAB = 0x09;
const OPEN_PAREN = 0x28;
const OPEN_BRACKET = 0x5b;

/**
 * KaTeX 渲染选项（IMP-001 §10.3）。
 *
 * - `throwOnError: false` + `strict: false`：单条公式的解析错误不得炸掉整篇；
 * - `trust: false`：默认就关，`\href` / `\includegraphics` / `\url` 这类能读文件、
 *   能发请求的命令一律按不可信命令处理（§10.2 第 1 条）；
 * - `output: "html"`：不产 MathML。MathML 标签不在净化白名单里，留着只会生成
 *   一堆被剥空的 `<span class="katex-mathml">`，反而丢掉可读文本；
 * - `maxSize`：KaTeX 该参数以 ex 计，取 32 ≈ 480px（正文 15px 字号下的排版上限）。
 *   `\rule{100m}{100m}` 这类请求会走 KaTeX 的 SizeError → 按失败降级（§10.3 第 3 条）。
 *   这是 docs 未给换算口径处采用的一致近似，README 偏差登记。
 */
export const KATEX_OPTIONS = {
  throwOnError: false,
  strict: false,
  trust: false,
  output: "html",
  maxSize: 32,
  maxExpand: 1000
} as const;

/** 公式类型（与节点类型 mathInline / mathBlock 同名，也写进 data 属性）。 */
export type MathDisplay = "inline" | "block";

export interface MathRenderOutcome {
  ok: boolean;
  html: string;
  message?: string;
}

function isSpaceOrTab(code: number): boolean {
  return code === SPACE || code === TAB;
}

/**
 * 定界符对。`open` 会写进 `token.markup`，AST 层用 {@link isDisplayMathMarkup} 反查
 * display 语义，于是「同一族在独占一行与夹在句中两种写法」分别落 mathBlock / mathInline。
 */
interface MathDelimiters {
  open: string;
  close: string;
  display: boolean;
  /** `$` 系专属：为「钱」让路，要求开界符后与闭界符前都不紧跟空白。 */
  rejectAdjacentSpace: boolean;
}

const DOLLAR_INLINE: MathDelimiters = { open: "$", close: "$", display: false, rejectAdjacentSpace: true };
const DOLLAR_BLOCK: MathDelimiters = { open: "$$", close: "$$", display: true, rejectAdjacentSpace: true };
const TEX_INLINE: MathDelimiters = { open: "\\(", close: "\\)", display: false, rejectAdjacentSpace: false };
const TEX_BLOCK: MathDelimiters = { open: "\\[", close: "\\]", display: true, rejectAdjacentSpace: false };

/** 块级规则认领的行首前缀（两字符）。 */
const BLOCK_DELIMITERS: readonly MathDelimiters[] = [DOLLAR_BLOCK, TEX_BLOCK];

const DISPLAY_MATH_MARKUP = new Set([DOLLAR_BLOCK.open, TEX_BLOCK.open]);

/** token.markup → 是否 display：`$$` 与 `\[` 归块级。 */
export function isDisplayMathMarkup(markup: string | undefined): boolean {
  return markup !== undefined && DISPLAY_MATH_MARKUP.has(markup);
}

/**
 * 行内定界符扫描（`$…$`、`$$…$$`、`\(…\)` 共用；单行 `\[…\]` 亦走这里）。
 *
 * 三条拒判规则都为了让「钱」不被当成公式：开界符后紧跟空白、闭界符前紧跟空白、
 * 内容跨越换行，任意一条命中就放弃（`$100 和 $200` 里的第二个 `$` 前面是空格）。
 * 后两条对 `\(` 族同样成立，第一条由 `rejectAdjacentSpace` 关掉。
 */
function scanDelimitedMath(
  src: string,
  start: number,
  delim: MathDelimiters
): { end: number; content: string; display: boolean } | null {
  const contentStart = start + delim.open.length;
  if (contentStart >= src.length) {
    return null;
  }
  const next = src.charCodeAt(contentStart);
  if (next === NEWLINE) {
    return null;
  }
  if (delim.rejectAdjacentSpace && isSpaceOrTab(next)) {
    return null;
  }
  let pos = contentStart;
  while (pos < src.length) {
    const code = src.charCodeAt(pos);
    if (code === NEWLINE) {
      return null;
    }
    // 先认闭界符再跳转义：`\)` / `\]` 本身以反斜杠开头，先跳两格会永远扫不到结尾。
    if (src.startsWith(delim.close, pos)) {
      const before = src.charCodeAt(pos - 1);
      if (!delim.rejectAdjacentSpace || !isSpaceOrTab(before)) {
        const content = src.slice(contentStart, pos);
        // 空表达式（`$ $`、`$$$$`、`\(\)`）没有渲染意义，交给散文。
        return content.trim() === "" ? null : { end: pos + delim.close.length, content, display: delim.display };
      }
    }
    // 跳过转义对：`\$` 不成界、`\alpha` 不进闭界符判定。上面的闭界符优先于这一行，
    // 因此 `\)` / `\]` 能正常收尾；`x \\)` 这类「换行 + 右括号」仍按内容处理。
    if (code === BACKSLASH) {
      pos += 2;
      continue;
    }
    pos += 1;
  }
  return null;
}

/** 行内规则入口：按当前位置的字符选出定界符族，选不出即交回后续规则。 */
function inlineDelimitersAt(src: string, pos: number): MathDelimiters | null {
  const code = src.charCodeAt(pos);
  if (code === DOLLAR) {
    return src.charCodeAt(pos + 1) === DOLLAR ? DOLLAR_BLOCK : DOLLAR_INLINE;
  }
  if (code === BACKSLASH) {
    const inner = src.charCodeAt(pos + 1);
    if (inner === OPEN_PAREN) {
      return TEX_INLINE;
    }
    return inner === OPEN_BRACKET ? TEX_BLOCK : null;
  }
  return null;
}

/** markdown-it 行内规则：装到 `escape` 之前（顺序不可调换，见 parser.ts 注记）。 */
export function mathInlineRule(state: StateInline, silent: boolean): boolean {
  const delim = inlineDelimitersAt(state.src, state.pos);
  if (!delim) {
    return false;
  }
  const found = scanDelimitedMath(state.src, state.pos, delim);
  if (!found) {
    return false;
  }
  if (!silent) {
    const token = state.push(MATH_SPAN_TOKEN, "", 0);
    token.content = found.content;
    token.markup = delim.open;
    token.level = state.level;
  }
  state.pos = found.end;
  return true;
}

function lineRange(state: StateBlock, line: number): { start: number; max: number } {
  const begin = state.bMarks[line] ?? 0;
  const shift = state.tShift[line] ?? 0;
  return { start: state.skipSpaces(begin + shift), max: state.eMarks[line] ?? begin + shift };
}

/**
 * markdown-it 块级规则：只认「整行以 `$$` 或 `\[` 开头」的块。
 *
 * 单行 `$$…$$` / `\[…\]` 也走这里（KaTeX 语义就是 display），不再退回行内通道，
 * 于是同一份源码在「独占一行」与「夹在句中」两种写法下分别落 mathBlock / mathInline。
 */
export function mathBlockRule(
  state: StateBlock,
  startLine: number,
  endLine: number,
  silent: boolean
): boolean {
  const { start, max } = lineRange(state, startLine);
  const delim =
    start + 2 > max
      ? undefined
      : BLOCK_DELIMITERS.find((candidate) => state.src.slice(start, start + 2) === candidate.open);
  if (!delim) {
    return false;
  }
  if (silent) {
    return true;
  }

  const firstLineBody = state.src.slice(start + 2, max).trim();
  let lastLine = startLine;
  let content: string;

  if (firstLineBody.endsWith(delim.close)) {
    // 同行闭合：`$$ a=b $$` / `\[ a=b \]`
    content = firstLineBody.slice(0, -delim.close.length).trim();
  } else {
    // 多行块：找独占一行的闭合定界符
    let line = startLine;
    let closed = false;
    const body: string[] = [firstLineBody];
    while (line + 1 < endLine) {
      line += 1;
      const range = lineRange(state, line);
      const text = state.src.slice(range.start, range.max).trim();
      if (text === delim.close || text.endsWith(delim.close)) {
        closed = true;
        lastLine = line;
        const tail = text === delim.close ? "" : text.slice(0, -delim.close.length).trim();
        if (tail !== "") {
          body.push(tail);
        }
        break;
      }
      body.push(text);
    }
    if (!closed) {
      // 没有闭合的定界符：整段按散文处理，绝不吞掉后面的正文（§14.3 第 5 条）。
      return false;
    }
    content = body.join("\n").trim();
  }

  if (content === "") {
    return false;
  }
  const token = state.push(MATH_BLOCK_TOKEN, "", 0);
  token.content = content;
  token.markup = delim.open;
  token.map = [startLine, lastLine + 1];
  state.line = lastLine + 1;
  return true;
}

/**
 * 源码层面的有效性判定（处理器在渲染之前先问一次）。
 *
 * 只挡两类确定不该进 KaTeX 的输入：空串与超出长度上限的源码。
 * 语义合法性交给 KaTeX 自己 —— 自造「公式语法检查器」只会比 KaTeX 更不准。
 */
export const MATH_SOURCE_MAX_LENGTH = 8_000;

export function isRenderableMath(source: string): boolean {
  return source.trim() !== "" && source.length <= MATH_SOURCE_MAX_LENGTH;
}

/** KaTeX 在 throwOnError:false 下用这个类名标记失败产物。 */
const KATEX_ERROR_MARKER = 'class="katex-error"';

/** 渲染一条公式；失败时返回 error 诊断信息，由处理器/渲染器决定降级形态。 */
export function renderMathExpression(
  source: string,
  display: MathDisplay
): MathRenderOutcome {
  if (!isRenderableMath(source)) {
    return {
      ok: false,
      html: "",
      message:
        source.trim() === ""
          ? "Empty math expression"
          : `Math source is ${source.length} characters, above the ${MATH_SOURCE_MAX_LENGTH} limit`
    };
  }
  try {
    const html = katex.renderToString(source, {
      ...KATEX_OPTIONS,
      displayMode: display === "block"
    });
    if (html.includes(KATEX_ERROR_MARKER)) {
      // KaTeX 把 ParseError 直接嵌进 title，长度不可控，只取首行做诊断信息。
      const title = /title="([^"]*)"/u.exec(html)?.[1] ?? "KaTeX parse error";
      return { ok: false, html: "", message: title.split(" at position")[0] ?? title };
    }
    return { ok: true, html };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, html: "", message };
  }
}

/** 公式容器类名与 data 属性名：sanitizer 的 MATH_MARKUP_SCOPE 按类名判定作用域。 */
export const MATH_CONTAINER_CLASS = "readora-math";
export const MATH_ROOT_ATTRIBUTE = "data-readora-math-root";
