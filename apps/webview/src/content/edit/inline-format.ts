/**
 * 行内格式化的动作层（ARC-009 §6.3，E3）。
 *
 * **纯字符串**：进来的是一段「单元读法下的文本」和两个下标，出去的是新文本与
 * 新选区。没有 DOM、没有 `Range`、没有桥消息 —— 于是这一层的每条规则都能在 jsdom
 * 之外被穷举断言，包括最容易写坏文件的那几条（跨行、空行段、代码段内）。
 *
 * 作用在**文本空间**而不是源空间是本轮的核心取舍（ADR-009-11）：ARC-009 §6.2 的
 * 判据已经保证形态 A 下「渲染文本 == 逐行剥掉 marker 的源」，而提交只经
 * `composeNewText` 把 `markers[i]` 补回去 —— 于是往渲染文本的同偏移插 `**`，与往
 * 源串的同偏移插 `**`，出来的字节全等（这条等价性由 `source-text.spec.ts` 那九例
 * 钉住，不在这里重证）。形态 B 更直接：文本就是源串。
 *
 * 四条规则（§6.3 + 决策 2）落在这个文件里，一条都不留到 DOM 层：
 * 1. **跨行逐行包**：选区按文本行切开，每行各包一对。`- **一\n- 二**` 会终结列表项，
 *    `**a\n\nb**` 跨空段会造出一个不是 emphasis 的东西 —— 语义从「一个 emphasis
 *    覆盖两行」变成「两个 emphasis 各覆盖一行」，渲染上可能有可见差异，但源永远平衡；
 * 2. **空行段跳过**：`trim()` 后长度为 0 的那一段不包（两行引用之间那条 `>` 是典型例）；
 * 3. **形态 B 在行首 marker 之后插入**：长度取 `markerLengthOf`，全仓只有那一处定义；
 * 4. **代码段内屏蔽**：`bold`/`italic`/`strike`/`link` 落在已有 code span 里就是纯
 *    字面噪声（在 `` `x` `` 里插 `**` 不会被解析成加粗），一律 `blocked`。
 *
 * 解包有两种形状（外层正好是那对标记、选区本身就是 `**foo**` 整段）都解；
 * **部分重叠一律按 wrap 处理**（不硬拆别人的标记），因为拆一半会留下孤立的 `**`。
 */
import { markerLengthOf, type EditBlockType, type EditMode } from "./source-text";

/** 六个动作。`code` 指行内代码（不是代码块，代码块属 E4）。 */
export type InlineAction = "bold" | "italic" | "strike" | "code" | "link" | "footnote";

/** 需要成对标记的四个动作共用一条代码路径；差别只在标记字面量。 */
const WRAPPERS: Readonly<
  Record<"bold" | "italic" | "strike" | "code", { open: string; close: string }>
> = {
  bold: { open: "**", close: "**" },
  italic: { open: "*", close: "*" },
  strike: { open: "~~", close: "~~" },
  code: { open: "`", close: "`" }
};

export type BlockedReason = "inside-code" | "empty";

/**
 * 一条要落到 DOM 的替换，下标指**输入文本**。
 *
 * 为什么把逐条替换交出去而不是只给新文本：接管层要按「从后往前」一条条写回 DOM，
 * 每一条都只动一行 —— 对 `list` 来说这意味着不会跨过 `<li>` 边界，整块拼平会把
 * 列表结构拆掉（拆完之后按 `list` 读回是空串，那是一次空提交）。整段拼平在这轮
 * 不是优化，是错实现。
 */
export interface FormatEdit {
  from: number;
  to: number;
  insert: string;
}

export type FormatOutcome =
  /** 改动已算出：`from`/`to` 是**新文本**里的选区下标，供还原选区与再点一次解包。 */
  | { kind: "applied"; text: string; from: number; to: number; multiline: boolean; edits: FormatEdit[] }
  /** §6.3 降级：不动结构，只在能映射的那一端插一对标记，光标落在两个标记之间。 */
  | { kind: "degraded"; text: string; caret: number; edit: FormatEdit }
  /** 什么都不做（调用方据此决定要不要提示）。 */
  | { kind: "blocked"; reason: BlockedReason };

export interface InlineInput {
  action: InlineAction;
  /** 单元文本：形态 A 是渲染文本，形态 B 是源串本身。 */
  text: string;
  /** 选区两端；`null` = 这一端映射不出来（走 {@link FormatOutcome} 的 degraded 支）。 */
  from: number | null;
  to: number | null;
  type: EditBlockType;
  mode: EditMode;
  /** `link` 动作的目标地址；空白按 `blocked: "empty"` 处理。 */
  url?: string | undefined;
  /** 整篇文档文本，只用于算脚注编号（决策 6）；缺省退回本单元文本。 */
  documentText?: string | undefined;
}

/**
 * 一次替换：把**输入**文本的 `[start, end)` 换成 `insert`。
 *
 * `localTo` 是新选区右端相对 `start` 的偏移（新选区左端一律是 `start`），
 * 于是多段替换的位移可以由「前面各段的净增量」累加出来，不需要回头重算下标。
 */
interface Splice {
  start: number;
  end: number;
  insert: string;
  localTo: number;
}

interface LineSpan {
  /** 行首的绝对下标（`insideCodeSpan` 用）。 */
  lineStart: number;
  start: number;
  end: number;
  /** 本行的插入下限（形态 B = 行首 marker 之后，形态 A = 行首）。 */
  base: number;
}

function lineStartsOf(text: string): number[] {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\n") {
      starts.push(index + 1);
    }
  }
  return starts;
}

function lineIndexOf(lineStarts: readonly number[], index: number): number {
  let line = 0;
  for (let i = 0; i < lineStarts.length; i += 1) {
    if ((lineStarts[i] as number) <= index) {
      line = i;
    } else {
      break;
    }
  }
  return line;
}

/**
 * 未转义反引号的奇偶：奇数即「这个下标落在一个 code span 里」。
 *
 * 只数**本行之内**（`lineStart` 起算），因为 code span 不跨行；`\`` 算转义，跳过它
 * 后面的那个字符。这一条判据故意保守（不解析 fence、不管多反引号定界），保守的
 * 方向是「不插」—— 宁可少做一个加粗，也不往文件里写一对不会生效的 `**`。
 */
export function insideCodeSpan(text: string, lineStart: number, index: number): boolean {
  let count = 0;
  let cursor = Math.max(0, Math.min(lineStart, text.length));
  const stop = Math.max(cursor, Math.min(index, text.length));
  for (; cursor < stop; cursor += 1) {
    const char = text[cursor] as string;
    if (char === "\\") {
      cursor += 1;
      continue;
    }
    if (char === "`") {
      count += 1;
    }
  }
  return count % 2 === 1;
}

/**
 * 这个选区该解包还是该包裹（部分重叠按 wrap）。
 *
 * 「已经包着」的两种形状都算 unwrap，具体拆哪一对由 {@link unwrapSplice} 决定；
 * 本函数只回答「还要不要再插一对」，也是工具条上 `aria-pressed` 的判据来源。
 */
export function detectWrap(
  text: string,
  from: number,
  to: number,
  marker: string
): "unwrap" | "wrap" {
  const outer =
    from >= marker.length &&
    text.slice(from - marker.length, from) === marker &&
    text.slice(to, to + marker.length) === marker;
  const inner =
    to > from &&
    to - from >= marker.length * 2 &&
    text.slice(from, from + marker.length) === marker &&
    text.slice(to - marker.length, to) === marker;
  return outer || inner ? "unwrap" : "wrap";
}

/** 行内链接 `[label](url)` 的解包：只认「整段就是一个链接」这一种形状。 */
const LINK_SHAPE = /^\[([^\]]*)\]\((.*)\)$/u;

/** ATX 前缀：缩进 + `#` 组 + **非空**的空白组（`#` 后没空白就不是 ATX 标题）。 */
const ATX_MARKER = /^(\s*)(#{1,6})(\s+)/u;

function unwrapSplice(text: string, span: LineSpan, marker: { open: string; close: string }): Splice | null {
  const { start, end } = span;
  const body = text.slice(start, end);
  // 形 1：标记在选区外侧（选中的是 `**foo**` 里的 foo）—— 拆外面那一对。
  // `base` 那道夹取是必需的：不卡它就会把形态 B 的 `- ` / `> ` 当成 open 拆掉。
  if (
    start - marker.open.length >= span.base &&
    text.slice(start - marker.open.length, start) === marker.open &&
    text.slice(end, end + marker.close.length) === marker.close
  ) {
    const at = start - marker.open.length;
    return {
      start: at,
      end: end + marker.close.length,
      insert: body,
      localTo: body.length
    };
  }
  // 形 2：选区整段就是 `**foo**` —— 拆里面那一对。
  if (
    body.length >= marker.open.length + marker.close.length &&
    body.startsWith(marker.open) &&
    body.endsWith(marker.close)
  ) {
    const inner = body.slice(marker.open.length, body.length - marker.close.length);
    return { start, end, insert: inner, localTo: inner.length };
  }
  return null;
}

function wrapSplice(text: string, span: LineSpan, open: string, close: string): Splice {
  const body = text.slice(span.start, span.end);
  return {
    start: span.start,
    end: span.end,
    insert: `${open}${body}${close}`,
    localTo: open.length + body.length + close.length
  };
}

function clampPair(from: number | null, to: number | null, length: number): {
  start: number;
  end: number;
} | null {
  if (from === null || to === null) {
    return null;
  }
  let start = Math.max(0, Math.min(from, length));
  let end = Math.max(0, Math.min(to, length));
  if (end < start) {
    [start, end] = [end, start];
  }
  return { start, end };
}

/** 降级（§6.3）：只插一对字面标记，不动结构，光标落在两个标记之间。 */
function degrade(text: string, anchor: number, open: string, close: string): FormatOutcome {
  const at = Math.max(0, Math.min(anchor, text.length));
  const insert = `${open}${close}`;
  return {
    kind: "degraded",
    text: `${text.slice(0, at)}${insert}${text.slice(at)}`,
    caret: at + open.length,
    edit: { from: at, to: at, insert }
  };
}

/** 把互不重叠的替换拼成最终文本，并累加位移算出新选区。 */
function assemble(text: string, splices: readonly Splice[]): { text: string; from: number; to: number } {
  const ordered = [...splices].sort((a, b) => a.start - b.start);
  let out = "";
  let cursor = 0;
  let delta = 0;
  let from = 0;
  let to = 0;
  ordered.forEach((splice, index) => {
    out += text.slice(cursor, splice.start) + splice.insert;
    const shift = splice.start + delta;
    if (index === 0) {
      from = shift;
    }
    if (index === ordered.length - 1) {
      to = shift + splice.localTo;
    }
    delta += splice.insert.length - (splice.end - splice.start);
    cursor = splice.end;
  });
  out += text.slice(cursor);
  return { text: out, from, to };
}

/**
 * 动作本体。
 *
 * 输入下标指**输入文本**，输出 `from`/`to` 指**输出文本**；中间没有别的状态，
 * 位移由 {@link assemble} 累加，所以「先算所有段、再一次拼」是本文件唯一的顺序。
 */
export function applyInlineAction(input: InlineInput): FormatOutcome {
  const { action, text, type, mode } = input;
  const length = text.length;

  // 脚注引用：不参与包裹/解包，只在选区末尾（或光标处）插一段 `[^n]`（决策 6）。
  if (action === "footnote") {
    const anchor = input.to ?? input.from;
    if (anchor === null || anchor === undefined) {
      return { kind: "blocked", reason: "empty" };
    }
    const marker = `[^${nextFootnoteLabel(input.documentText ?? text)}]`;
    const at = Math.max(0, Math.min(anchor, length));
    return {
      kind: "applied",
      text: `${text.slice(0, at)}${marker}${text.slice(at)}`,
      from: at,
      to: at + marker.length,
      multiline: false,
      edits: [{ from: at, to: at, insert: marker }]
    };
  }

  const open = action === "link" ? "[" : markersOf(action).open;
  const close = action === "link" ? `](${(input.url ?? "").trim()})` : markersOf(action).close;
  if (action === "link" && (input.url ?? "").trim().length === 0) {
    // 没有 URL 就退化成插入 `[...]()`：那是损坏的链接语法，宁可不写。
    return { kind: "blocked", reason: "empty" };
  }

  const bounds = clampPair(input.from, input.to, length);
  if (!bounds) {
    // 有一端映射不出来 → §6.3 的降级：只插字面标记，不动结构。
    const anchor = input.from ?? input.to;
    if (anchor === null || anchor === undefined) {
      return { kind: "blocked", reason: "empty" };
    }
    return degrade(text, anchor, open, close);
  }
  if (bounds.start === bounds.end) {
    // 空选区：包不出东西，退化成分开的一对标记 + 光标居中（编辑器的通行行为）。
    return degrade(text, bounds.start, open, close);
  }

  const lineStarts = lineStartsOf(text);
  const lines = text.split("\n");
  const fromLine = lineIndexOf(lineStarts, bounds.start);
  const toLine = lineIndexOf(lineStarts, Math.max(bounds.start, bounds.end - 1));
  const marker = markersOf(action);
  const spans: LineSpan[] = [];
  for (let line = fromLine; line <= toLine; line += 1) {
    const content = lines[line] ?? "";
    const lineStart = lineStarts[line] as number;
    // 形态 B 的行首是字面 marker（`> ` / `- ` / `### `），插入点不得越过它。
    const base = mode === "source" ? lineStart + markerLengthOf(content, type) : lineStart;
    const start = Math.max(bounds.start, base);
    const end = Math.min(bounds.end, lineStart + content.length);
    if (end <= start) {
      // 选区在这一行里只擦过换行符，或整段都在 marker 之内 —— 没有可包的内容。
      continue;
    }
    if (text.slice(start, end).trim().length === 0) {
      continue;
    }
    if (action !== "code" && (insideCodeSpan(text, lineStart, start) || insideCodeSpan(text, lineStart, end))) {
      return { kind: "blocked", reason: "inside-code" };
    }
    spans.push({ lineStart, start, end, base });
  }
  if (spans.length === 0) {
    return { kind: "blocked", reason: "empty" };
  }

  const splices: Splice[] = [];
  for (const span of spans) {
    if (action === "link") {
      const body = text.slice(span.start, span.end);
      const whole = LINK_SHAPE.exec(body);
      if (whole) {
        const label = whole[1] as string;
        splices.push({ start: span.start, end: span.end, insert: label, localTo: label.length });
        continue;
      }
      splices.push(wrapSplice(text, span, open, close));
      continue;
    }
    const unwrapped =
      detectWrap(text, span.start, span.end, marker.open) === "unwrap"
        ? unwrapSplice(text, span, marker)
        : null;
    if (unwrapped) {
      splices.push(unwrapped);
      continue;
    }
    // `code` 自己也要屏蔽嵌套：已经在一个 code span 里再插一对反引号是错的写法。
    if (action === "code" && insideCodeSpan(text, span.lineStart, span.start)) {
      return { kind: "blocked", reason: "inside-code" };
    }
    splices.push(wrapSplice(text, span, open, close));
  }

  const assembled = assemble(text, splices);
  return {
    kind: "applied",
    text: assembled.text,
    from: assembled.from,
    to: assembled.to,
    // 逐条替换按输入下标升序给出；接管层反过来从后往前写，前面的下标才不会位移。
    edits: [...splices]
      .sort((a, b) => a.start - b.start)
      .map((splice) => ({ from: splice.start, to: splice.end, insert: splice.insert })),
    // 跨行才需要那句「按行分别加粗」的说明（决策 2 第 4 条）；单行不提示。
    multiline: spans.length > 1
  };
}

function markersOf(action: InlineAction): { open: string; close: string } {
  if (action === "link" || action === "footnote") {
    return { open: "", close: "" };
  }
  return WRAPPERS[action];
}

/**
 * 下一个可用的脚注标签（决策 6：只插引用，不写定义行）。
 *
 * 「文档里已用**数字**标签最大值 +1」而不是「区块序号」：定义行 `[^1]: …` 与引用
 * `[^1]` 共用同一套编号，只看引用会撞号。命名标签（`[^note]`）不参与取号 —— 它
 * 与数字号段可以共存。没有数字标签时从 1 起。
 */
export function nextFootnoteLabel(documentText: string): string {
  let max = 0;
  const pattern = /\[\^(\d+)\]/gu;
  for (let match = pattern.exec(documentText); match; match = pattern.exec(documentText)) {
    const value = Number(match[1]);
    if (Number.isFinite(value) && value > max) {
      max = value;
    }
  }
  return String(max + 1);
}

/**
 * 换 heading 级别（决策 5 的形态 A 支路：只改 `markers[0]`，DOM 一个字符都不动）。
 *
 * 保留 `#` 之后的**原空白组**与行首缩进，于是 `##␣␣标题` 改级别后还是两个空格。
 * 返回 `null` 就是不猜：解析不出 ATX marker（setext 的 `====`、`#` 后无空格的
 * `#Title`）时改级别会写出一个不再是标题的行 —— 工具条据此把六枚按钮置 `disabled`。
 */
export function withHeadingLevel(
  marker: string,
  level: 1 | 2 | 3 | 4 | 5 | 6
): string | null {
  const match = ATX_MARKER.exec(marker);
  if (!match) {
    return null;
  }
  return `${match[1]}${"#".repeat(level)}${match[3]}`;
}
