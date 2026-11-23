/**
 * DOM 选区端点 ↔ 单元文本下标（ARC-009 §6.3，E3）。
 *
 * E3 的六个格式化动作都落在**文本空间**：先在「用户看到的那段文本」上算出
 * 要插入标记的两个下标，再把标记写进 DOM。于是这一层要来回换算两次，而来回两次
 * 用的必须是**同一份**读法 —— 亦即 `source-text.ts` 里判据与提交共用的那次遍历
 * （`createEditableTextModel`）。另写一条遍历的后果不是不精确，是**错位**：
 * 判据说「渲染文本 == 剥了前缀的源」走路径 A，选区却按路径 B 数格子，
 * `**` 就会插到隔壁那个字上，写回去的是一次损坏的 Markdown。
 *
 * 所以这里只有换算、没有第二套遍历规则：模型在下层，本层只把它的两张表
 * （文本节点下标表 / 元素边界表）按 ARC-009 §6.2 的形态分派暴露出去。
 *
 * 形态分派与 `edit-unit.ts` 的 `textOf` 逐字同形：
 * - 形态 A（`mode === "text"`）：区块里还是渲染产物，按**区块自己的类型**读
 *   （`blockquote` 的段间空行、`list` 的逐项换行都是判据的一部分）；
 * - 形态 B（`mode === "source"`）：`activate` 已把整块换成一个
 *   `createTextNode(source)`（换行是串里的字面 `\n`，用户后续敲回车才产生 `<br>`），
 *   按 `paragraph` 平铺读 = 读用户看到的那串字面 Markdown，且 DOM 偏移与源串偏移
 *   逐格相同（决策 1 的第一条事实）。
 *   这里**不能**用 `type`：源文本里不再有 `<p>` / `<li>` 结构，按 `list` 读会
 *   因为找不到直接子 `LI` 而读出一串空，两个端点都算成 0。
 */
import {
  createEditableTextModel,
  type EditBlockType,
  type EditableTextModel,
  type EditMode
} from "./source-text";

/** DOM 的一个点：容器节点 + 节点内（或子节点序号）偏移。 */
export interface DomPoint {
  node: Node;
  offset: number;
}

/** 一次格式化要作用的选区，两端点按文档顺序（`Range` 的固有约定）。 */
export interface FormatSelection {
  start: DomPoint;
  end: DomPoint;
}

/** 一个区块 + 一种形态上的换算器：模型只建一次，两个端点共用。 */
export interface SelectionMapper {
  /** 单元文本长度（归一化之后）。 */
  readonly length: number;
  /** 文本下标（`[0, length]`），映射不出来即 `null`。 */
  offsetOf(point: DomPoint): number | null;
  /** 下标 → DOM 落点；越界按夹取处理，落不出来即 `null`。 */
  pointAt(index: number): DomPoint | null;
}

/** 判据/提交/选区三者共用的那次遍历在这里被实例化（见文件头注）。 */
function modelFor(block: HTMLElement, type: EditBlockType, mode: EditMode): EditableTextModel {
  return createEditableTextModel(block, mode === "text" ? type : "paragraph");
}

export function createSelectionMapper(
  block: HTMLElement,
  type: EditBlockType,
  mode: EditMode
): SelectionMapper {
  const model = modelFor(block, type, mode);
  return {
    length: model.length,
    offsetOf(point) {
      // `isConnected` 这道判据不能省：正文重写之后旧节点还在内存里、下标表也还在
      // `Map` 里，但用户看到的早就不是它了。此时宁缺不错 —— 交回 `null` 让上层
      // 走 §6.3 的降级路径（只插字面标记 + 一行说明），也不要把标记插进游离节点。
      if (!point.node.isConnected) {
        return null;
      }
      if (point.node.nodeType === 3) {
        return model.offsetOfText(point.node as Text, point.offset);
      }
      if (point.node.nodeType === 1) {
        return model.offsetOfElement(point.node as Element, point.offset);
      }
      return null;
    },
    pointAt(index) {
      if (model.length === 0 && !block.firstChild) {
        return { node: block, offset: 0 };
      }
      return model.pointAt(index);
    }
  };
}

/**
 * 文本点 → 单元文本下标。
 *
 * 返回 `null` 的三种情形都是 §6.3 的降级入口：端点根本不在本单元里、端点落在
 * 遍历没有覆盖的节点上（比如形态 A 下混进来的 `<img>` 之后的空白文本节点被浏览器
 * 合并成了别的结构）、端点所在节点已经脱离文档。
 */
export function charOffsetOf(
  block: HTMLElement,
  type: EditBlockType,
  mode: EditMode,
  point: DomPoint
): number | null {
  return createSelectionMapper(block, type, mode).offsetOf(point);
}

/** 单元文本下标 → 文本点（把动作算出的新选区还原回 DOM 用）。 */
export function pointAtOffset(
  block: HTMLElement,
  type: EditBlockType,
  mode: EditMode,
  index: number
): DomPoint | null {
  return createSelectionMapper(block, type, mode).pointAt(index);
}

/** `Range` → 选区端点：只取端点，不做「是否落在本单元」的判断。 */
export function selectionFromRange(range: Range): FormatSelection | null {
  return {
    start: { node: range.startContainer, offset: range.startOffset },
    end: { node: range.endContainer, offset: range.endOffset }
  };
}

/**
 * 浏览器侧读当前选区（`EditLayerOptions.selection` 的默认实现）。
 *
 * jsdom 有 `getSelection` 但它对选区的维护不可依赖（ARC-009 §16.6 记过一条同类
 * 取舍：不赌实现，改用注入）。所以单测一律走 `selection: () => FormatSelection`
 * 这条注入口，真实选区读取只在 e2e 覆盖 —— 本函数的职责因此包含「读不出来就返回
 * `null`」，而不是想办法读出来。
 */
export function readUnitSelection(block: HTMLElement): FormatSelection | null {
  const view = block.ownerDocument?.defaultView;
  if (!view || typeof view.getSelection !== "function") {
    return null;
  }
  const selection = view.getSelection();
  if (!selection || selection.rangeCount === 0) {
    return null;
  }
  // `containsNode` 在 jsdom 的实现里缺席过，缺了就少一道判据而不是报错：
  // 后面的 `charOffsetOf` 会因为节点不在本单元里返回 `null`，语义不变。
  if (typeof selection.containsNode === "function" && !selection.containsNode(block, true)) {
    return null;
  }
  return selectionFromRange(selection.getRangeAt(0));
}

/**
 * 端点是否落在本单元内。
 *
 * 「跨出单元」与「单元内映射不出来」是 §6.3 里两条不同的降级：前者夹回来
 * （选区拖过了把手也无所谓，按单元边界截断），后者才是不动结构只插字面标记。
 * 这一层把它们区分开，上层才能各走各的。
 */
export function isPointInsideBlock(block: HTMLElement, point: DomPoint): boolean {
  return point.node === block || block.contains(point.node);
}
