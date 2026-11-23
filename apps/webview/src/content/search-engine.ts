/**
 * 文档内搜索（ARC-007 §9，ADR-007-05：只搜当前文档）。
 *
 * 三条来自 §9.4 的硬约束决定了这里的实现形状：
 * 1. 匹配只走文本节点，命中位置还原成 DOM Range —— 不把用户输入拼进 HTML，
 *    也不改渲染产物字符串；
 * 2. 由渲染引擎生成的图形化子树（图表 SVG）不进匹配范围：SVG 里的 `<text>`
 *    不是文档散文，且高亮插进字形容器会破坏引擎自身的定位结构。
 *    公式（MathML）同理，但本仓库 Math 属 M6 预留、当前不产出该子树，
 *    因此排除集只覆盖图表，公式位以 MATH_EXCLUDED_SELECTOR 预留；
 *    公式渲染失败会降级成普通源码文本，不在任何排除子树内，仍然可搜（§9.4 末句）；
 * 3. 高亮必须可逐字符还原：`clearHighlights` 之后 `root.textContent` 与搜索前全等。
 *
 * 代码块参与匹配（它也是文档文本）；交互层自己生成的节点（复制按钮、状态提示）
 * 不属文档内容，由 ATTACHED_EXCLUDED_SELECTOR 排除，免得「Copy」被当成命中。
 */

/** §9.2 搜索选项。 */
export interface SearchOptions {
  query: string;
  caseSensitive: boolean;
}

/** §9.2 单条命中：position 是拼接文本里的字符偏移，headingId 取最近的前置标题。 */
export interface SearchMatch {
  id: string;
  text: string;
  position: number;
  headingId?: string;
}

/** §9.2 搜索结果：必须携带文档版本，供 §9.4 第 3 条的失效判定。 */
export interface SearchResult {
  documentId: string;
  documentVersion: number;
  matches: SearchMatch[];
  activeMatchIndex: number;
}

export const SEARCH_HIT_CLASS = "readora-search-hit";
export const SEARCH_HIT_ID_ATTRIBUTE = "data-readora-search-id";
/** 高亮上写的版本标记：与正文容器的版本不符即丢弃旧结果。 */
export const SEARCH_HIT_VERSION_ATTRIBUTE = "data-readora-search-version";
export const SEARCH_ACTIVE_ATTRIBUTE = "data-readora-search-active";
/** 正文容器上的版本标记（MarkdownContent 写入）。 */
export const DOCUMENT_VERSION_ATTRIBUTE = "data-readora-document-version";

/**
 * 图形化子树：引擎生成，不进匹配范围（§9.4 末段）。
 *
 * 选择器必须对上 diagram-layer 的真实产物：包裹层 `.readora-diagram`
 * （含 `data-readora-diagram-state`）+ 容器 `.readora-diagram-container`，
 * 其中既有渲染出的 `<svg>`，也可能留着未渲染/失败时的源码 `<pre>` 与错误卡片；
 * 三者都不是文档散文，整个包裹层一起排除。属性写法一并保留，兼容
 * `[data-readora-diagram-container]` 形态的宿主模板。
 */
export const DIAGRAM_EXCLUDED_SELECTOR =
  ".readora-diagram, .readora-diagram-container, [data-readora-diagram-container], svg";
/** M6 公式落地后并入：`[data-readora-math], math`。留空即不参与选择器拼接。 */
export const MATH_EXCLUDED_SELECTOR = "";
/**
 * 交互层附加节点：不是文档内容。
 *
 * `.readora-code-editor`（M8）为什么必须排除：CodeMirror 只渲染视口内的行，而它旁边
 * 的 `<pre>` 是同一份源码的完整副本，并且已经在可搜范围内。不排这个宿主会让每处
 * 命中数两遍（还数不准）；排了宿主不动 pre，则一行代码都不少。
 * 选择器对的是 code-editor-layer 写下的真实 class（同一个坑已在图表层踩过一次）。
 * `.readora-edit-conflict`（E2）同一条理由：卡片里是**未提交的输入**与几个动作
 * 按钮，它们不是文档内容，进索引就会让「命中计数」与文件里的字对不上。
 */
export const ATTACHED_EXCLUDED_SELECTOR =
  "button, .readora-diagram-toolbar, .readora-image-hint, .readora-inline-note, .readora-code-editor, .readora-edit-conflict";
/** 上一轮高亮自身：重新搜索前必然先清，这里再兜一层防二次命中。 */
export const SEARCH_HIT_SELECTOR = `mark[${SEARCH_HIT_ID_ATTRIBUTE}]`;

/** 命中上限：超长文档一次搜索到此即截断，不阻塞主线程（§13）。 */
export const MAX_SEARCH_HITS = 5000;
/** 短查询门槛：1 个字符就全表扫描代价高、噪声大（PRD-002 §10.3 亦按 2 字起算）。 */
export const MIN_QUERY_LENGTH = 2;
/** 截断后的计数展示口径。 */
export const TRUNCATED_COUNT_LABEL = "999+";

export function excludedSelector(): string {
  return [
    DIAGRAM_EXCLUDED_SELECTOR,
    MATH_EXCLUDED_SELECTOR,
    ATTACHED_EXCLUDED_SELECTOR,
    SEARCH_HIT_SELECTOR
  ]
    .filter((part) => part.length > 0)
    .join(", ");
}

/** 命中文本落在某个文本节点里的哪一段。 */
export interface MatchSegment {
  node: Text;
  start: number;
  end: number;
  /** 该片段在拼接文本里的全局起点：高亮按它倒序应用，见 applyHighlights。 */
  offset: number;
}

export interface SearchOutcome {
  result: SearchResult;
  /** 与 result.matches 同序的片段（跨节点命中会有多段，高亮时逐段包裹）。 */
  segments: Map<string, MatchSegment[]>;
}

interface TextSegment {
  node: Text;
  /** 该节点在拼接文本里的起点。 */
  offset: number;
  /** 文档顺序上最近一个已出现标题的锚点（§9.2 的 headingId 来源）。 */
  heading?: string;
}

/** 标题锚点：渲染器同时写 id 与 data-readora-heading，后者在 id 被剥离时兜底。 */
function headingAnchor(element: Element): string | null {
  const mirror = element.getAttribute("data-readora-heading");
  if (typeof mirror === "string" && mirror.length > 0) {
    return mirror;
  }
  return element.id.length > 0 ? element.id : null;
}

/**
 * 文档顺序收集可搜文本节点，同时拼出待匹配的字符串。
 *
 * 「最近标题」跟着遍历走：段落不在 `<h2>` 里面，所以它属于前面最近出现的那个
 * 小节，而不是祖先 —— 这点决定了 §9.2 的 headingId 能不能用在跨节命中上。
 */
function collectText(
  root: HTMLElement,
  excluded: string
): { text: string; segments: TextSegment[] } {
  const segments: TextSegment[] = [];
  let buffer = "";
  let heading: string | undefined;

  const walk = (node: Node): void => {
    if (node.nodeType === 3) {
      const text = (node as Text).data;
      if (text.length === 0) {
        return;
      }
      const segment: TextSegment = { node: node as Text, offset: buffer.length };
      if (heading) {
        segment.heading = heading;
      }
      segments.push(segment);
      buffer += text;
      return;
    }
    if (node.nodeType !== 1) {
      return;
    }
    const element = node as HTMLElement;
    if (element.matches(excluded)) {
      return;
    }
    if (/^H[1-6]$/u.test(element.tagName)) {
      const anchor = headingAnchor(element);
      if (anchor) {
        heading = anchor;
      }
    }
    for (let child = element.firstChild; child; child = child.nextSibling) {
      walk(child);
    }
  };

  walk(root);
  return { text: buffer, segments };
}

/** 命中起点落在哪个文本段里（决定它的 headingId）。 */
function segmentAt(
  segments: readonly TextSegment[],
  position: number
): TextSegment | undefined {
  let owner: TextSegment | undefined;
  for (const segment of segments) {
    if (segment.offset > position) {
      break;
    }
    owner = segment;
  }
  return owner;
}

/** 把 [from, to) 的字符区间映射回各文本节点的局部区间。 */
function findSegments(
  segments: readonly TextSegment[],
  from: number,
  length: number
): MatchSegment[] {
  const to = from + length;
  const out: MatchSegment[] = [];
  for (const segment of segments) {
    const nodeEnd = segment.offset + segment.node.data.length;
    if (nodeEnd <= from) {
      continue;
    }
    if (segment.offset >= to) {
      break;
    }
    const start = Math.max(from, segment.offset) - segment.offset;
    const end = Math.min(to, nodeEnd) - segment.offset;
    if (end > start) {
      out.push({
        node: segment.node,
        start,
        end,
        offset: Math.max(from, segment.offset)
      });
    }
  }
  return out;
}

const EMPTY_OUTCOME = (
  documentId: string,
  documentVersion: number
): SearchOutcome => ({
  result: { documentId, documentVersion, matches: [], activeMatchIndex: -1 },
  segments: new Map()
});

/** 只算匹配、不动 DOM（§9.1 的普通文本搜索与大小写敏感切换）。 */
export function searchInDocument(
  root: HTMLElement,
  options: SearchOptions,
  documentVersion: number,
  documentId: string
): SearchOutcome {
  if (options.query.trim().length < MIN_QUERY_LENGTH) {
    return EMPTY_OUTCOME(documentId, documentVersion);
  }
  const excluded = excludedSelector();
  const { text, segments } = collectText(root, excluded);
  const needle = options.caseSensitive ? options.query : options.query.toLowerCase();
  const haystack = options.caseSensitive ? text : text.toLowerCase();

  const matches: SearchMatch[] = [];
  const map = new Map<string, MatchSegment[]>();
  let hit = haystack.indexOf(needle);
  while (hit !== -1) {
    const id = `hit-${matches.length.toString(36)}`;
    const match: SearchMatch = {
      id,
      text: text.slice(hit, hit + needle.length),
      position: hit
    };
    const headingId = segmentAt(segments, hit)?.heading;
    if (headingId) {
      match.headingId = headingId;
    }
    matches.push(match);
    map.set(id, findSegments(segments, hit, needle.length));
    if (matches.length >= MAX_SEARCH_HITS) {
      break;
    }
    hit = haystack.indexOf(needle, hit + needle.length);
  }

  return {
    result: {
      documentId,
      documentVersion,
      matches,
      activeMatchIndex: matches.length > 0 ? 0 : -1
    },
    segments: map
  };
}

/**
 * 插入高亮：逐段 `surroundContents`，于是跨节点命中拆成同 id 的多个 mark。
 * 返回插入的 mark 数（≥ 命中数，两者不该被断言成相等）。
 *
 * 应用顺序必须是「全局文本位置倒序」：同一个文本节点可能被多条命中共用，
 * 先包前面的片段会把后面的字符整段搬进 mark，节点长度一变，后面片段的局部
 * 偏移就越界（§9.4 第 4 条「高亮不得破坏原始 DOM 结构」的前提是可还原）。
 */
export function applyHighlights(
  root: HTMLElement,
  outcome: SearchOutcome,
  documentVersion: number
): number {
  const doc = root.ownerDocument;
  const parts: Array<{ id: string; segment: MatchSegment }> = [];
  for (const match of outcome.result.matches) {
    for (const segment of outcome.segments.get(match.id) ?? []) {
      parts.push({ id: match.id, segment });
    }
  }
  parts.sort((left, right) => right.segment.offset - left.segment.offset);

  let inserted = 0;
  for (const { id, segment } of parts) {
    const range = doc.createRange();
    range.setStart(segment.node, segment.start);
    range.setEnd(segment.node, segment.end);
    const mark = doc.createElement("mark");
    mark.className = SEARCH_HIT_CLASS;
    mark.setAttribute(SEARCH_HIT_ID_ATTRIBUTE, id);
    mark.setAttribute(SEARCH_HIT_VERSION_ATTRIBUTE, String(documentVersion));
    range.surroundContents(mark);
    inserted += 1;
  }
  return inserted;
}

/** 现存高亮属于哪个版本：与当前版本不符即丢弃旧结果（§9.4 第 3 条）。 */
export function highlightVersion(root: HTMLElement): number | null {
  const mark = root.querySelector<HTMLElement>(SEARCH_HIT_SELECTOR);
  const raw = mark?.getAttribute(SEARCH_HIT_VERSION_ATTRIBUTE);
  if (raw === null || raw === undefined) {
    return null;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

/** 还原：把 mark 里的文本退回去，再 normalize 合并相邻文本节点。 */
export function clearHighlights(root: HTMLElement): void {
  const marks = Array.from(root.querySelectorAll(SEARCH_HIT_SELECTOR)).reverse();
  if (marks.length === 0) {
    return;
  }
  for (const node of marks) {
    const mark = node as HTMLElement;
    const parent = mark.parentNode;
    if (!parent) {
      continue;
    }
    while (mark.firstChild) {
      parent.insertBefore(mark.firstChild, mark);
    }
    parent.removeChild(mark);
  }
  root.normalize();
}

/**
 * 把某个命中设为活动项并滚到视口中线（§9.1「点击结果定位」/ PRD-002 §10.3）。
 * 同一命中的多个片段共享 active 标记，其余片段一律复位。
 */
export function activateMatch(root: HTMLElement, matchId: string): boolean {
  let found = false;
  for (const node of root.querySelectorAll(`[${SEARCH_HIT_ID_ATTRIBUTE}]`)) {
    const mark = node as HTMLElement;
    if (mark.getAttribute(SEARCH_HIT_ID_ATTRIBUTE) === matchId) {
      mark.setAttribute(SEARCH_ACTIVE_ATTRIBUTE, "true");
      mark.scrollIntoView?.({ behavior: "smooth", block: "center" });
      found = true;
    } else {
      mark.removeAttribute(SEARCH_ACTIVE_ATTRIBUTE);
    }
  }
  return found;
}

/** 是否已达截断阈值（计数位改口显示 999+）。 */
export function isTruncated(total: number): boolean {
  return total >= MAX_SEARCH_HITS;
}

/** 计数位文案：无结果由面板另给提示，这里只管数字。 */
export function formatMatchCount(total: number): string {
  return isTruncated(total) ? TRUNCATED_COUNT_LABEL : String(total);
}
