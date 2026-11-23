/**
 * 区块源文本的换算层（ARC-009 §6.2 / §9.1，E2）。
 *
 * 这一层回答两个问题，且**只有这两个问题**：
 * 1. 「这个区块的源文本长什么样、前缀是什么」—— `parseBlockSource`；
 * 2. 「用户在界面上改完的那段文字，写回文件应该是什么字节」—— `composeNewText`。
 *
 * 判据只有一条（ARC-009 §6.2 的「条件式所见即所得」）：
 *
 * > `readEditableText(block, type) === parseBlockSource(source, type).lines.join("\n")`
 *
 * 相等说明渲染没有丢信息，界面上看到的就是源里去掉前缀的那些字，于是可以放心
 * 让用户「改字」，提交时把前缀补回去（形态 A）。不相等说明渲染抹掉了标记
 * （`**粗**` 变成「粗」、`` `x` `` 掉了反引号、任务列表混进 `☐`），此时如果还按
 * 形态 A 提交，就是一次 DOM→源的反解析 —— 正是 ARC-009 §9.4 明令不做的事。于是
 * 回落**形态 B**：直接把源文本原样交给用户改（含 `#` / `>` / `-` 前缀），提交时
 * 一字不补。
 *
 * 两种形态的差别记在 DOM 上（`data-readora-edit="text|source"`），测试也按它断言，
 * 不在这里藏状态。
 *
 * 后半截函数（`readEditableText` / `renderedTextOf` / `canUseWysiwyg`）只**读** DOM，
 * 不写、不持状态，所以 jsdom 与 Chromium 走同一份代码、同一条断言；前半截是
 * 纯字符串换算，连 DOM 类型都不碰。
 */
import { SOURCE_RANGE_PATTERN } from "@readora/markdown-core";

/** 认领的顶层区块类型（ARC-009 §6.1 + §6.2 E4/E5/E6 源码型）。 */
export type EditBlockType = "paragraph" | "heading" | "blockquote" | "list" | "codeBlock" | "diagramBlock" | "table" | "mathBlock";

/** 单元挂在哪一种编辑形态上：改字（补前缀）或改源（原样写回）。 */
export type EditMode = "text" | "source";

export interface BlockSource {
  /** 剥掉前缀之后的每一行；`lines.join("\n")` 就是形态 A 的判据左半边。 */
  lines: string[];
  /** 每一行被剥掉的原串，逐字符记住，提交时按行号补回去。 */
  markers: string[];
  type: EditBlockType;
  /** 有序列表首行的编号；无序 / 非列表为 `null`。 */
  orderedStart: number | null;
  /**
   * 源是 CRLF 行尾（任一行带 `\r` 就算）。
   *
   * 单独记一个布尔而不是把 `\r` 掺进 marker：marker 是**行首前缀**，
   * `\r` 属于行尾，混在一起补前缀时会把回车插到内容前面。
   */
  crlf: boolean;
}

/** 顶层区块 → 类型的认领表：命中标签名 **和** class 两个条件才算认领。 */
const CLAIMED: ReadonlyArray<{ selector: string; type: EditBlockType }> = [
  { selector: "p.readora-paragraph", type: "paragraph" },
  { selector: "h1.readora-heading", type: "heading" },
  { selector: "h2.readora-heading", type: "heading" },
  { selector: "h3.readora-heading", type: "heading" },
  { selector: "h4.readora-heading", type: "heading" },
  { selector: "h5.readora-heading", type: "heading" },
  { selector: "h6.readora-heading", type: "heading" },
  { selector: "blockquote.readora-blockquote", type: "blockquote" },
  { selector: "ul.readora-list", type: "list" },
  { selector: "ol.readora-list", type: "list" },
  { selector: "div.readora-code-block", type: "codeBlock" },
  { selector: "div.readora-diagram", type: "diagramBlock" },
  { selector: "div.readora-table-scroll", type: "table" },
  { selector: "span.readora-math--block", type: "mathBlock" }
];

/** 认领表的合并选择器：接管层每轮扫描用它取候选，再用 {@link blockTypeOf} 定型。 */
export const EDITABLE_BLOCK_SELECTOR = CLAIMED.map((entry) => entry.selector).join(", ");

export function blockTypeOf(block: Element): EditBlockType | null {
  for (const entry of CLAIMED) {
    if (block.matches(entry.selector)) {
      return entry.type;
    }
  }
  return null;
}

/** `"s:e"` → 行区间；形状不对一律返回 `null`（不猜、不就近取整）。 */
export function parseRangeKey(
  rangeKey: string
): { startLine: number; endLine: number } | null {
  if (!SOURCE_RANGE_PATTERN.test(rangeKey)) {
    return null;
  }
  const [start, end] = rangeKey.split(":");
  const startLine = Number(start);
  const endLine = Number(end);
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || endLine < startLine) {
    return null;
  }
  return { startLine, endLine };
}

/**
 * 按 E0 的口径切出区块源文本。
 *
 * 与 markdown-core 同一条坐标约定：`rangeKey` 是**文件绝对行**、0 基、闭区间，
 * `endLine` 已被 `trimToContentEnd` 收缩到最后一行非空行，所以这里直接 slice，
 * 不再做任何尾随空行处理（多切一行就会在写回时吃掉区块间的分隔空行）。
 */
export function sliceBlockSource(documentText: string, rangeKey: string): string | null {
  const range = parseRangeKey(rangeKey);
  if (!range) {
    return null;
  }
  const lines = documentText.split("\n");
  if (range.endLine >= lines.length) {
    return null;
  }
  return lines.slice(range.startLine, range.endLine + 1).join("\n");
}

const HEADING_MARKER = /^(\s*#{1,6})(\s*)/u;
const QUOTE_MARKER = /^(\s*)(>\s?)/u;
const LIST_MARKER = /^(\s*)(?:([-*+])|(\d{1,9})([.)]))(\s+|$)/u;

/**
 * 逐行剥前缀。
 *
 * 三处刻意的保守：
 * - **段落不剥行首空白**：段落里的缩进是内容的一部分，这里不剥；但 CommonMark
 *   解析时已经把行首空白去掉了，于是缩进段落的判据天然不成立 → 形态 B；
 * - **`\r` 不计入 lines、另记 `crlf`**：渲染器拿到的是已把行尾归一化成 `\n` 的文本
 *   （CommonMark 规定），所以判据两边都不该带 `\r`；写回时再按 `crlf` 补回去，
 *   Windows 文档既走得上形态 A，也不会被改行尾风格；
 * - **匹配不上就整行当内容**：列表的续行、引用里的懒延续都走这条路，前缀为空，
 *   写回自然原样落回去。
 */
export function parseBlockSource(source: string, type: EditBlockType): BlockSource {
  const lines: string[] = [];
  const markers: string[] = [];
  let crlf = false;
  for (const raw of source.split("\n")) {
    const carriage = raw.endsWith("\r") ? "\r" : "";
    if (carriage.length > 0) {
      crlf = true;
    }
    const line = carriage.length > 0 ? raw.slice(0, -1) : raw;
    const matched = matchMarker(line, type);
    markers.push(matched.marker);
    lines.push(matched.content);
  }
  return { lines, markers, type, orderedStart: orderedStartOf(markers), crlf };
}

function matchMarker(line: string, type: EditBlockType): { marker: string; content: string } {
  const pattern =
    type === "heading" ? HEADING_MARKER : type === "blockquote" ? QUOTE_MARKER : type === "list" ? LIST_MARKER : null;
  if (!pattern) {
    return { marker: "", content: line };
  }
  const match = pattern.exec(line);
  if (!match) {
    return { marker: "", content: line };
  }
  return { marker: match[0], content: line.slice(match[0].length) };
}

/** 首行 marker 的数字部分；无序列表或解析不出来的都是 `null`。 */
function orderedStartOf(markers: readonly string[]): number | null {
  const first = markers[0];
  if (first === undefined) {
    return null;
  }
  const match = /^\s*(\d{1,9})[.)]/u.exec(first);
  return match ? Number(match[1]) : null;
}

/**
 * 单独一行的前缀长度（E3 的逐行包裹要用）。
 *
 * 与 {@link parseBlockSource} 走同一个 `matchMarker`，于是「行内容从哪里开始」这件事
 * 全仓只有一处定义：ARC-009 §6.3 的降级规则要求形态 B 把标记插在 `- ` / `> ` **之后**，
 * 自己再数一遍 `#` 就会有两套口径。段落恒为 0（这一段是内容的一部分，不剥）。
 */
export function markerLengthOf(line: string, type: EditBlockType): number {
  return matchMarker(line, type).marker.length;
}

const ORDERED_MARKER_DIGITS = /^(\s*)(\d{1,9})([.)])(\s*)/u;

/**
 * 形态 A 的提交组装：把用户改过的行逐条补回原前缀。
 *
 * marker 复用规则（ARC-009 §6.2）：
 * - 行数不变 → 第 i 行复用 `markers[i]` **原串**，于是缩进、`-`/`*`/`+`、`> ` 的
 *   字面差异全部保留，没动过的那一行字节完全不变；
 * - 行数变多 → 新增行复用**最后一行**的 marker；有序列表例外，复用最后一行 marker
 *   的符号形状并按 `orderedStart + i` 续号；
 * - 行数变少 → 多余 marker 丢弃（不补空行，空行会改变下一区块的解析）。
 *
 * **不重排既有编号**：GFM 只认首行编号与 `start`，把 `1./2./3.` 重写成连续数字
 * 会让用户没碰过的行改字节，违反 §15-3「未编辑区块逐字节不变」。
 */
export function composeNewText(text: string, src: BlockSource): string {
  const input = text.split("\n");
  const lastMarker = src.markers[src.markers.length - 1] ?? "";
  const out: string[] = [];
  for (let index = 0; index < input.length; index += 1) {
    let marker = index < src.markers.length ? src.markers[index] : lastMarker;
    if (src.orderedStart !== null && index >= src.markers.length) {
      marker = nextOrderedMarker(lastMarker, src.orderedStart + index);
    }
    out.push(`${marker}${input[index]}${src.crlf ? "\r" : ""}`);
  }
  return out.join("\n");
}

function nextOrderedMarker(lastMarker: string, value: number): string {
  // 四段拆开重建：缩进 / 数字 / 括号 / 括号后的空白（CRLF 的 `\r` 落在最后一组里）。
  const match = ORDERED_MARKER_DIGITS.exec(lastMarker);
  if (!match) {
    return lastMarker;
  }
  return `${match[1]}${value}${match[3]}${match[4]}`;
}

const BLOCK_LEVEL_TAGS = new Set([
  "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "DD", "DIV", "DL", "DT",
  "FIELDSET", "FIGURE", "FOOTER", "FORM", "H1", "H2", "H3", "H4", "H5", "H6",
  "HEADER", "HR", "LI", "MAIN", "NAV", "OL", "P", "PRE", "SECTION", "TABLE",
  "TD", "TH", "TR", "UL"
]);

const TEXT_NODE = 3;
const ELEMENT_NODE = 1;

/** 读回侧的一条内容单元：DOM 里的一个文本节点，或结构造成的合成换行。 */
export type TextSlot =
  | { kind: "text"; node: Text }
  | { kind: "synthetic"; text: string };

/**
 * 「单元读法下的文本」与它的 DOM 坐标。
 *
 * E2 只需要把 DOM 读成一段文本；E3 还要反过来问「这段文本的第 k 个字在 DOM 的哪
 * 里」（行内格式化要把选区换算成偏移）。两件事**必须共用同一次遍历**：判据说相等、
 * 提交读一条路径、选区读另一条路径，就会算出「包裹插在了隔壁字上」这种写坏文件的
 * 结果。于是这里把遍历降级成唯一的一份实现（`createEditableTextModel`），
 * {@link readEditableText} 只是它的一句 `.text()`，而 `selection-map.ts` 用的是同一个
 * 模型上的两张表。
 */
export interface EditableTextModel {
  slots: TextSlot[];
  /** 文本长度（归一化之后：零宽字符不计）。 */
  length: number;
  /** 归一化之后的文本，与 {@link readEditableText} 逐字符相同。 */
  text(): string;
  /** 文本点 → 下标；不在本模型走过的子树里（包括被剔掉的节点）即 `null`。 */
  offsetOfText(node: Text, charOffset: number): number | null;
  /** 元素点（父节点 + 第几个子节点之前）→ 下标。 */
  offsetOfElement(parent: Element, childIndex: number): number | null;
  /**
   * 下标 → 可选落点；优先给文本点，落不中才给元素点。
   *
   * 返回 `null` 只有一种情形：目标下标**落在合成换行的内部**（`blockquote` 段间
   * 那条 `"\n\n"` 的中间一格、块级边界那对 `"\n"` 的两端之间）。那些字符在 DOM 里
   * 不是一个位置而是一段结构，没有语义正确的落点，宁缺不错 —— 调用方（E3 的选区
   * 还原）拿不到落点就走 ARC-009 §6.3 的降级路径，而不是猜一个。
   * 文本位置（可被选区端点指到的那些下标）全量可达，这一点由
   * `selection-map.spec.ts` 的往返用例钉住。
   */
  pointAt(index: number): { node: Node; offset: number } | null;
}

interface Builder {
  slots: TextSlot[];
  /**
   * 每个文本节点的下标表，**存绝对下标**：`prefixes[i]` = 该节点第 i 个单元在整块
   * 文本里的位置。存相对值的话 `pointAt` 的反查（`indexOf(绝对目标)`）只有第一个
   * 节点能命中，选区换算会整体错位。
   */
  textIndices: Map<Text, number[]>;
  /** 每个走过一遍子节点的元素：`boundaries[i]` = 第 i 个子节点之前的下标。 */
  elementIndices: Map<Element, number[]>;
  index: number;
}

function pushSynthetic(b: Builder, text: string): void {
  if (text.length === 0) {
    return;
  }
  b.slots.push({ kind: "synthetic", text });
  b.index += text.length;
}

function pushText(b: Builder, node: Text): void {
  const value = node.nodeValue ?? "";
  const start = b.index;
  // 按 UTF-16 单元递推而不是 `for…of`：DOM 的 offset 就是代码单元下标，
  // 而代理对（表情符号）占两个单元却只贡献一个字符。
  const prefixes: number[] = [start];
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index] as string;
    // U+00A0 归一化成普通空格是等长替换（计 1）；U+200B 被剔除（计 0）。
    prefixes.push((prefixes[index] as number) + (char === "\u200b" ? 0 : 1));
  }
  b.textIndices.set(node, prefixes);
  b.slots.push({ kind: "text", node });
  b.index = prefixes[prefixes.length - 1] as number;
}

/** 逐子节点遍历并留下边界下标；`skip` 就是尾部那个占位 `<br>` 那条规则。 */
function walkChildrenSlots(
  b: Builder,
  element: HTMLElement,
  skip: (child: Node, index: number, children: Node[]) => boolean = () => false
): void {
  const children = Array.from(element.childNodes);
  const boundaries: number[] = [];
  children.forEach((child, index) => {
    boundaries[index] = b.index;
    if (skip(child, index, children)) {
      return;
    }
    walkInlineSlots(b, child);
  });
  boundaries[children.length] = b.index;
  b.elementIndices.set(element, boundaries);
}

/** `textContent` 语义的遍历：只收文本节点，`<br>` 与块级边界都不算换行。 */
function walkTextContentSlots(b: Builder, element: Element): void {
  const children = Array.from(element.childNodes);
  const boundaries: number[] = [];
  children.forEach((child, index) => {
    boundaries[index] = b.index;
    if (child.nodeType === TEXT_NODE) {
      pushText(b, child as Text);
    } else if (child.nodeType === ELEMENT_NODE) {
      walkTextContentSlots(b, child as Element);
    }
  });
  boundaries[children.length] = b.index;
  b.elementIndices.set(element, boundaries);
}

function walkInlineSlots(b: Builder, node: Node): void {
  if (node.nodeType === TEXT_NODE) {
    pushText(b, node as Text);
    return;
  }
  if (node.nodeType !== ELEMENT_NODE) {
    return;
  }
  const element = node as HTMLElement;
  if (element.tagName === "BR") {
    // 渲染器把软换行写成 `&#10;`（文本里的 \n）或 `<br>`，两种都要还原成换行，
    // 否则多行段落的判据会因为一个换行符而失效。
    pushSynthetic(b, "\n");
    return;
  }
  const blockLevel = BLOCK_LEVEL_TAGS.has(element.tagName);
  if (blockLevel) {
    pushSynthetic(b, "\n");
  }
  walkChildrenSlots(b, element);
  if (blockLevel) {
    pushSynthetic(b, "\n");
  }
}

function directChildrenOfType(element: HTMLElement, tagName: string): HTMLElement[] {
  return Array.from(element.children).filter(
    (child) => child.tagName === tagName
  ) as HTMLElement[];
}

/**
 * 把浏览器在 contenteditable 里留下的两个隐形字符还原成普通写法。
 *
 * `U+00A0`：Chromium 在文本末尾（以及相邻空格处）打进去的是一个不换行空格，而不是
 * 普通空格 —— 它防止 HTML 把尾部空白折叠掉。不换回来就是一次往 Markdown 文件里
 * 塞隐形字符的写回（用户看不出、diff 里也看不出）。`U+200B` 零宽空格同理，它只用来
 * 给光标留落点。
 *
 * 不影响判据的安全性：源里真写了 `&nbsp;` 时，渲染出的是这个字符本体而源行是实体
 * 写法，两者仍然不等 → 回落形态 B（往往安全一侧倒）。
 *
 * 逐字符等价：下标表里 U+00A0 计 1（长度不变）、U+200B 计 0（剔除），与在这里对整个
 * 串做两次 `replace` 是同一件事。
 */
export function normalizeEditableText(value: string): string {
  return value.replace(/\u00a0/g, " ").replace(/\u200b/g, "");
}

/** 尾部那个只为了让光标有落点的 `<br>`：清空一个区块后浏览器必然留一个。 */
function isTrailingBreak(child: Node, index: number, children: Node[]): boolean {
  return (
    index === children.length - 1 &&
    child.nodeType === ELEMENT_NODE &&
    (child as HTMLElement).tagName === "BR"
  );
}

/**
 * 本次读取的唯一遍历本体。
 *
 * 三条规则按类型分派（ARC-009 §6.2）：
 * - `paragraph` / `heading`：遍历子节点，`<br>` 与块级子元素边界算换行；
 * - `blockquote`：直接子 `p` 之间插一条空行（源里 `>` 分段就是空行分隔），**只认
 *   直接子 `p`**：引用里还嵌着列表 / 嵌套引用时读出来必然与源不等，回落形态 B；
 *   单段引用同样走这条路径，于是 `> 一行` 与 `>一行` 都能落形态 A（前缀按原串
 *   留着，没有信息丢失，没有理由让用户去改源）。
 *   直接对 `blockquote` 调段落那套遍历是不行的：`<p>` 算块级边界，会在两端各多
 *   出一个换行，判据永远差那两个字符。
 * - `list`：直接子 `li` 各算一行，`li` 用 `textContent` —— **嵌套列表的文字因此
 *   被计进父项**，判据必然不成立而回落形态 B，不需要任何特判分支。
 *
 * 不用 `innerText`：jsdom 不实现它，用了这套逻辑就只能去浏览器里跑。
 */
export function createEditableTextModel(
  block: HTMLElement,
  type: EditBlockType
): EditableTextModel {
  const b: Builder = {
    slots: [],
    textIndices: new Map(),
    elementIndices: new Map(),
    index: 0
  };
  if (type === "list") {
    const children = Array.from(block.children);
    const boundaries: number[] = [];
    let seen = false;
    children.forEach((child, index) => {
      boundaries[index] = b.index;
      if (child.tagName !== "LI") {
        return;
      }
      if (seen) {
        pushSynthetic(b, "\n");
      }
      seen = true;
      walkTextContentSlots(b, child);
    });
    boundaries[children.length] = b.index;
    b.elementIndices.set(block, boundaries);
  } else if (type === "blockquote" && directChildrenOfType(block, "P").length > 0) {
    const children = Array.from(block.childNodes);
    const boundaries: number[] = [];
    let seen = false;
    children.forEach((child, index) => {
      boundaries[index] = b.index;
      if (child.nodeType !== ELEMENT_NODE || (child as HTMLElement).tagName !== "P") {
        return;
      }
      if (seen) {
        pushSynthetic(b, "\n\n");
      }
      seen = true;
      walkChildrenSlots(b, child as HTMLElement, isTrailingBreak);
    });
    boundaries[children.length] = b.index;
    b.elementIndices.set(block, boundaries);
  } else {
    walkChildrenSlots(b, block, isTrailingBreak);
  }
  return toModel(b);
}

function toModel(b: Builder): EditableTextModel {
  const raw: string[] = [];
  for (const slot of b.slots) {
    raw.push(slot.kind === "text" ? slot.node.nodeValue ?? "" : slot.text);
  }
  const text = normalizeEditableText(raw.join(""));
  return {
    slots: b.slots,
    length: b.index,
    text() {
      return text;
    },
    offsetOfText(node, charOffset) {
      const prefixes = b.textIndices.get(node);
      if (!prefixes) {
        return null;
      }
      const clamped = Math.max(0, Math.min(charOffset, prefixes.length - 1));
      return prefixes[clamped] ?? null;
    },
    offsetOfElement(parent, childIndex) {
      const boundaries = b.elementIndices.get(parent);
      if (!boundaries) {
        return null;
      }
      const clamped = Math.max(0, Math.min(childIndex, boundaries.length - 1));
      const value = boundaries[clamped];
      return value === undefined ? null : value;
    },
    pointAt(index) {
      const target = Math.max(0, Math.min(index, b.index));
      // 1）优先落在文本字符上：那里是光标与选区的正常落点。
      let empty: { node: Node; offset: number } | null = null;
      for (const [node, prefixes] of b.textIndices) {
        const position = prefixes.indexOf(target);
        if (position < 0) {
          continue;
        }
        if (prefixes.length > 1) {
          return { node, offset: position };
        }
        // 空文本节点上只有下标没有字符，光标落上去不稳，只当兜底。
        empty ??= { node, offset: position };
      }
      // 2）落不到字符（目标下标正好在两个块级子元素之间）：用一个合法的元素点。
      for (const [element, boundaries] of b.elementIndices) {
        const position = boundaries.indexOf(target);
        if (position >= 0) {
          return { node: element, offset: position };
        }
      }
      return empty;
    }
  };
}

/**
 * 读出一块区块「用户看到的文本」。
 *
 * 分派规则与三条取舍都在 {@link createEditableTextModel} 里，这里只是把模型展成字符串：
 * 判据的左半边、提交读回的文本、挂起恢复比对的草稿，三者从此共用同一条路径。
 */
export function readEditableText(block: HTMLElement, type: EditBlockType): string {
  return createEditableTextModel(block, type).text();
}

/** {@link readEditableText} 的对外名字：判据的左半边。 */
export function renderedTextOf(block: HTMLElement, type: EditBlockType): string {
  return readEditableText(block, type);
}

/** 判据本体：相等才允许形态 A。 */
export function canUseWysiwyg(
  source: string,
  type: EditBlockType,
  block: HTMLElement
): boolean {
  return (
    readEditableText(block, type) === parseBlockSource(source, type).lines.join("\n")
  );
}

export function editModeFor(
  source: string,
  type: EditBlockType,
  block: HTMLElement
): EditMode {
  if (
    type === "codeBlock" || type === "diagramBlock" || type === "table" ||
    type === "mathBlock"
  ) {
    return "source";
  }
  return canUseWysiwyg(source, type, block) ? "text" : "source";
}

const FILE_SCHEME = /^file:/iu;

/**
 * `file:` 前缀判据。
 *
 * 这是 **UX 判据不是安全判据**：权威在 Host 的写回阶梯第 3 步（ARC-009 §5.1），
 * 这里只是决定顶栏那枚按钮要不要禁用、要不要给区块挂把手。判据故意只认
 * `file:` —— `untitled:`（未落盘的新建）与 `vscode-webview:`、`https:` 之类
 * 一律不给编辑入口，因为没有可写回的磁盘文件。
 */
export function isFileSchemeUri(uri: string): boolean {
  return FILE_SCHEME.test(uri);
}
