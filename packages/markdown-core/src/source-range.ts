/**
 * 区块 → 源行范围的 DOM 契约（ARC-002 §12.3 / ARC-009 §4.1，F12 编辑模式的 E0 前置）。
 *
 * 渲染出口原本会把 `MarkdownNode.position` 丢掉 —— AST 阶段一直带着 `token.map`
 * 的行范围，到了 DOM 就没有任何属性能回答「这段内容来自源文件的哪几行」。本模块
 * 只补上这次中途丢失，不新增解析能力（ARC-002 §12.3 首段）。
 *
 * 口径三条，逐条都会决定后续写回改的是哪几行，写错不是显示错误而是改错文件：
 * - **0 基**：直取 `ast.ts` 的 `positionOf`，不在中途换基；
 * - **闭区间**且 `endLine` 不含尾随空行：`positionOf` 已把 `map[1]` 减一，但列表这类
 *   块的 `map` 本身就把区块后的分隔空行圈了进来（实测：`- a`/`- b` 接空行接 `---`
 *   的列表 map 是 `[0, 3]`），所以还要靠 `trimToContentEnd` 收回去。不收回的后果不是
 *   显示错误，而是写回时把分隔空行一并替掉，下一个区块直接贴上来（`---` 紧贴列表项
 *   还会改变解析）。于是本包的口径是：**`endLine` 一律是区块自身的最后一行非空行**；
 * - **相对文件**：管线解析的是剥掉 frontmatter 之后的 body（`frontmatter.ts`），
 *   所以行号必须加回被剥掉的行数，由调用方交出 `lineOffset`。
 *
 * 属性缺失是「此区块不可编辑」的唯一信号：合成节点（`footnoteSection` 等）没有
 * 可靠范围，宁可不标也不能标一个看起来合法的范围出去。
 */
import type { SourcePosition } from "./types";

/** ARC-002 §12.3 规定的属性名；Webview 侧的编辑接管层按同一个常量读。 */
export const SOURCE_RANGE_ATTRIBUTE = "data-readora-source-range";

/** 值形状。本包自己生成取值，命中非法只可能是编程错误（sanitizer 的剥离遍历据此报诊断）。 */
export const SOURCE_RANGE_PATTERN = /^\d+:\d+$/u;

/**
 * 「这一行是不是空行」的惰性判定器（只在真要收缩时才 split）。
 *
 * 越界（`line` 大于文件行数）也算空行：区块后面没有内容了，那些行不必写回。
 */
export function blankLineTester(text: string): (line: number) => boolean {
  let lines: string[] | undefined;
  return (line: number) => {
    lines ??= text.split("\n");
    const value = lines[line];
    return value === undefined || value.trim().length === 0;
  };
}

/**
 * 把 `endLine` 收回到最后一行非空行（body 相对行号，加偏移**之前**执行）。
 *
 * 只动尾端、并且永不跨过 `startLine`：一个块的起始行本身是空行时（理论上不会
 * 发生，真发生就是 map 错了）宁可保留原范围，也不交出一个倒挂的区间。
 */
export function trimToContentEnd(
  endLine: number,
  startLine: number,
  isBlankLine: (line: number) => boolean
): number {
  let end = endLine;
  while (end > startLine && isBlankLine(end)) {
    end -= 1;
  }
  return end;
}

/**
 * `position` + frontmatter 偏移 → `"${startLine}:${endLine}"`。
 *
 * 不可用即返回 `undefined`（调用方据此不输出属性），而不是输出 `-1:-1` 或
 * `NaN:NaN`：那两种写法都会让下游把一个没有范围的区块当成「有范围」去替换源文本。
 *
 * @param isBlankLine 可选的行空白判定；交出它才会做尾随空行收缩（见文件头注）。
 *                    行号全部是**加偏移前**的 body 相对行号，由调用方保证同一坐标空间。
 */
export function sourceRangeValue(
  position: SourcePosition | undefined,
  lineOffset: number,
  isBlankLine?: (line: number) => boolean
): string | undefined {
  if (!position) {
    return undefined;
  }
  const { startLine, endLine } = position;
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine)) {
    return undefined;
  }
  if (startLine < 0 || endLine < startLine) {
    return undefined;
  }
  const trimmed = isBlankLine ? trimToContentEnd(endLine, startLine, isBlankLine) : endLine;
  if (trimmed < startLine) {
    return undefined;
  }
  // 偏移自身不合法就当没有偏移：宁可少标一行也不能凭空平移整篇。
  const offset = Number.isInteger(lineOffset) && lineOffset > 0 ? lineOffset : 0;
  return `${startLine + offset}:${trimmed + offset}`;
}

/**
 * 把范围写进片段**第一个开始标签**的末尾。
 *
 * 只在顶层区块这一层调用（ARC-009 §4.1「只标 `document.children` 一层」），
 * 所以这里面对的是各块级渲染器产出的完整片段：`<p …>…</p>`、`<div …>…</div>`、
 * `<hr … />`，也可能是没有元素的裸转义文本（降级路径）—— 后者无处可挂，原样返回。
 *
 * 扫描是**引号感知**的：现有渲染器的属性值都过了 `escapeHtml`（转义 `>` 与 `"`），
 * 按第一个 `>` 切本来够用，但渲染器新增一个没转义的取值就会静默产出畸形标签。
 * 与其依赖「所有调用方永远转义」，不如把这一次线性扫描写对。
 */
export function decorateFragment(html: string, range: string): string {
  if (html.length === 0 || html.charAt(0) !== "<") {
    return html;
  }
  let inQuotedValue = false;
  for (let index = 1; index < html.length; index += 1) {
    const character = html.charAt(index);
    if (inQuotedValue) {
      if (character === '"') {
        inQuotedValue = false;
      }
      continue;
    }
    if (character === '"') {
      inQuotedValue = true;
      continue;
    }
    if (character !== ">") {
      continue;
    }
    const head = html.slice(0, index);
    // 幂等：已经标过就不再叠一个同名属性。
    if (head.includes(` ${SOURCE_RANGE_ATTRIBUTE}=`)) {
      return html;
    }
    const selfClosing = head.endsWith("/");
    const openTag = (selfClosing ? head.slice(0, -1) : head).replace(/\s+$/u, "");
    const rest = html.slice(index + 1);
    return `${openTag} ${SOURCE_RANGE_ATTRIBUTE}="${range}"${selfClosing ? " />" : ">"}${rest}`;
  }
  // 走到这里说明没有闭合的 `>`：宁可不标，也不修补一个残缺标签。
  return html;
}
