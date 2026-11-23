/**
 * 大纲视图的章节结构操作（ARC-009 §12「区块删除把手」的大纲侧替身，E7）。
 *
 * 三条口径决定了这里为什么能**零协议变更**：
 * 1. `document.edit` 的语义本来就是「把 `[startLine,endLine]` 闭区间的行换成
 *    `newText`」（ARC-009 §5.1），插入与删除只是 `newText` 的组合方式不同，
 *    Host 的阶梯（版本复判、范围复判、真的落盘）一个字都不用改；
 * 2. 分节边界沿用 `section-metrics.ts` 已钉死的相邻标题口径 —— 但兄弟节的边界
 *    取**下一个同级或更高级标题**（`level <= 本节`），不是「下一个任意标题」：
 *    后者会把新节插进本节的子节中间，用户看到的「在其后新增」就名不副实；
 * 3. 新增行由这里的调用方直接拼 ATX 前缀（`#` × level），不走编辑单元的
 *    `composeNewText` marker 继承 —— 那套规则只会给同级，级别必须是入参。
 *
 * **坐标空间**（TASK-13-01-05 的同一条坑，大纲侧第一次踩到）：
 * `OutlineItem.position` 是 markdown-core 透传的 AST 原始行号，相对**剥掉
 * frontmatter 的 body**；而 `document.edit` 要的是文件绝对行。带 frontmatter 的
 * 文档不补偿就会整体前移，写回改到隔壁几行去。补偿只在这一层做一次
 * （{@link bodyLineOffsetOf}），消费方一律拿绝对行。
 *
 * 行尾保持：`text.split("\n")` 在 CRLF 文档里把 `\r` 留在**行内容末尾**；锚点行
 * 自带的 `\r` 与拼接用的 `\n` 合成回原行的 EOL，而插入行的 `\r` 必须自己补上
 * （含最后一行）—— 与 `composeNewText` 的 crlf 写法同一约定，两条例子共用
 * 同一条按行替换算法（夹具 `handleEdit` 与 Host 的 `lineAt().text.length` 终点），
 * 约定不一致会让大纲入口与把手入口对同一文档写出两种行尾。
 */
import type { OutlineItem } from "@readora/markdown-core";

/** 三个动作的语义都是「相对这一节」：在其后新增、新增子节、删除整节。 */
export type SectionOpAction = "add-sibling-after" | "add-child" | "delete-section";

/** 一条写回请求的最小充分形状，字段与 `DocumentEditPayload` 的对应键同名。 */
export interface SectionOpPlan {
  range: { startLine: number; endLine: number };
  newText: string;
}

export interface SectionOpPreview {
  action: SectionOpAction;
  plan: SectionOpPlan;
  /** 该动作实际会动到的行数（删除确认文案用；新增类为插入行数，恒为 1）。 */
  affectedLines: number;
  /** 本节子树里的子节数（只有删除确认在意，新增类也一并交出）。 */
  childCount: number;
}

/**
 * 新章节的默认标题。
 *
 * 不插入空标题（`## ` 后无文字）：目录行会多出一条读不出名字的空条目，
 * 比一个可改的占位标题更误导。
 */
export const DEFAULT_SECTION_TITLE = "新章节";

/** 标题最深六级（CommonMark ATX 的硬上限），子节超限就停在六级。 */
const MAX_HEADING_LEVEL = 6;

/**
 * frontmatter 占掉的行数：首行 `---` 且能找到闭合围栏时为 `闭合行 + 1`。
 *
 * 与 markdown-core `extractFrontmatter` 的判据逐字对齐（首行 trim 后为 `---`，
 * 闭合为 `---` 或 `...`，找不到闭合整段当正文、偏移 0）。不 import 那份实现是
 * 因为它没出门面（ARC-002 §3.3 的暴露纪律），而这里的用法只需要这一个数字；
 * 两套判据一旦漂移，e2e 的 frontmatter 夹具会立刻把写回打到错行上暴露出来。
 */
export function bodyLineOffsetOf(text: string): number {
  const lines = text.split("\n");
  if ((lines[0] ?? "").trim() !== "---") {
    return 0;
  }
  for (let index = 1; index < lines.length; index += 1) {
    const line = (lines[index] ?? "").trim();
    if (line === "---" || line === "...") {
      return index + 1;
    }
  }
  return 0;
}

/** 新标题那一行的字面量：`#` × level + 单空格 + 标题。 */
function headingLineOf(level: number, title: string): string {
  return `${"#".repeat(Math.min(MAX_HEADING_LEVEL, Math.max(1, level)))} ${title}`;
}

/**
 * 为一个动作算出写回计划；算不出来就返回 `null`（调用方禁用入口，不猜）。
 *
 * `null` 的三种情形都有实义：目标节没有 `position`（没有可靠行范围就没有
 * 「改哪几行」的答案，与把手侧「无 range 不认领」同一条判断）；起始行越界
 * （大纲比源文新了一帧，等回声重来）；`index` 指不到有效条目。
 *
 * 无 `position` 的后续标题**不参与边界与子节计数**：切不出它的行号，把它算进
 * 「含 M 个子节」就是在报一个数不出来的数；它对边界线的影响止步于「看不见」，
 * 删除区间仍按可见边界收口 —— 罕见形状下宁可少删不越界。
 */
export function sectionOpPreview(args: {
  text: string;
  items: readonly OutlineItem[];
  index: number;
  action: SectionOpAction;
  /** 新章节标题的覆盖值（当前 UI 不暴露输入，留作下一步「重命名式新增」的缝）。 */
  title?: string;
}): SectionOpPreview | null {
  const { text, items, index, action } = args;
  const lines = text.split("\n");
  const offset = bodyLineOffsetOf(text);
  const item = items[index];
  const position = item?.position;
  if (!item || !position) {
    return null;
  }
  const startLine = position.startLine + offset;
  if (startLine < 0 || startLine >= lines.length) {
    return null;
  }

  // 子树边界：下一个同级或更高级标题的行首；没有就是文档末行。
  let boundaryLine = -1;
  let childCount = 0;
  for (let next = index + 1; next < items.length; next += 1) {
    const entry = items[next];
    const entryLine = entry?.position?.startLine;
    if (entry === undefined || entryLine === undefined) {
      continue;
    }
    if (entry.level <= item.level) {
      boundaryLine = entryLine + offset;
      break;
    }
    childCount += 1;
  }
  const endLine = boundaryLine >= 0 ? Math.max(startLine, boundaryLine - 1) : lines.length - 1;

  if (action === "delete-section") {
    return {
      action,
      plan: { range: { startLine, endLine }, newText: "" },
      affectedLines: endLine - startLine + 1,
      childCount
    };
  }

  // 两个新增动作都落在**子树末行之后**：「新增子节」去本节内容的末尾而不是
  // 紧贴标题 —— 插在标题后面会把本节原有正文整体划进新子节的范围。
  const level =
    action === "add-child"
      ? Math.min(MAX_HEADING_LEVEL, item.level + 1)
      : item.level;
  const heading = headingLineOf(level, args.title?.trim() || DEFAULT_SECTION_TITLE);
  const anchorLine = lines[endLine] ?? "";
  // CRLF 文档：插入行（含最后一行）补 `\r`，与 `composeNewText` 同一约定；
  // 锚点行自己的 `\r` 已在行尾，拼接用的 `\n` 直接凑成它原样的 EOL。
  const crlf = anchorLine.endsWith("\r");
  return {
    action,
    // 替换子树末行本身，newText = 原行 + 换行 + 新标题行：锚点行的字节原样保留，
    // 新行成为它之后的第一行。契约规定 `newText` 不含尾随换行（§16.3 第 3 条），
    // 这里也遵守 —— 换行写在两行**之间**。
    plan: {
      range: { startLine: endLine, endLine },
      newText: `${anchorLine}\n${heading}${crlf ? "\r" : ""}`
    },
    affectedLines: 1,
    childCount
  };
}
