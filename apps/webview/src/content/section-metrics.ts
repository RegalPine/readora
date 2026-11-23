/**
 * 分节度量（PRD-003 §10.7 行内标签）。
 *
 * 数据源只有两样，都是真的：`OutlineItem.position`（markdown-core 从 mdast
 * 位置透传）与 `DocumentSnapshot.text`（Markdown 源文）。字数用 `text-metrics.ts`
 * 的同一个 `countTextUnits`：时长 pill、状态条、大纲行内标签并排在同一屏里，
 * 各数一遍迟早数出三个答案。
 *
 * 区间口径是「按 outline 顺序取相邻标题」：第 i 节的范围是
 * `[item[i].position.startLine, item[i+1].position.startLine)`，最后一节
 * 到文件末尾。注意边界取的是**下一个标题**而不是下一个同级标题，所以 H1 的
 * 字数天然包含它下面的 H2/H3 子节 —— 行内标签只给 H1 显示字数（§10.7），
 * 正好和「这一大节一共多少字」的读法一致。更深层级不配行内标签：源行号是编辑器
 * 坐标而不是阅读信息，不再上 UI，但 `startLine` 仍是切区间的边界，留在结构里。
 *
 * 基序必须是 **0 基**：`SourcePosition.startLine` 由 markdown-core 从 markdown-it
 * `token.map` 透传下来，行号 0 就是源文件首行 —— 按 1 基解释会把首行标题判成
 * 「没有位置」（最常见的文档形状恰好是 H1 在第一行），并让每一节都少算自己
 * 最后一行。整条链路只在 markdown-core 的测试里钉住过基序，这里再钉一次。
 *
 * 没有 `position` 的条目直接跳过：区间边界一旦缺失，切出来的就是任意一段文本，
 * 报出来的字数比不报更容易误导（§10.7 末句：`position` 缺失则不显示该标签）。
 */
import { useMemo } from "react";
import type { OutlineItem } from "@readora/markdown-core";
import { countTextUnits } from "../app/text-metrics";
import { bodyLineOffsetOf } from "./outline-section-ops";

export interface SectionMetrics {
  /** 该节起始源行（0 基、**文件绝对行**，已补偿 frontmatter）。 */
  readonly startLine: number;
  /** 该节到下一个标题为止的单元数（含子节，见文件头）。 */
  readonly units: number;
}

/**
 * key 是 `OutlineItem` 本身（对象标识），不是 `id`/`anchor`：
 * `outline-tree` 的节点 key 是**去重后的锚点**（撞车时追加 `-1`），与 `id` 都
 * 不同源；而 `buildOutlineTree` 把同一个对象引用挂在 `node.item` 上，按引用查
 * 是唯一不会因为重名标题串到别的节上的口径。
 */
export type SectionMetricsMap = ReadonlyMap<OutlineItem, SectionMetrics>;

function usableLine(line: number | undefined): line is number {
  return typeof line === "number" && Number.isInteger(line) && line >= 0;
}

/**
 * 纯函数形态，便于逐条断言（钩子只是 `useMemo` 的一层皮）。
 *
 * 复杂度 O(行数 + 条目数)：先把有源行的条目按文档顺序收集，再逐节切片。
 * 每节各自 `split` 一次会退化成 O(条目 × 全文)，所以整篇只切一次行数组。
 */
export function sectionMetricsOf(
  text: string,
  outline: readonly OutlineItem[]
): SectionMetricsMap {
  const lines = text.split("\n");
  // `OutlineItem.position` 相对**剥掉 frontmatter 的 body**（markdown-core 透传
  // AST 原始行号），而 `lines` 是整篇文件 —— 不补偿则带 frontmatter 的文档每节
  // 整体前移，字数读到隔壁几行（与大纲章节操作共用同一个补偿函数，口径只有一处）。
  const offset = bodyLineOffsetOf(text);
  const starts: Array<{ item: OutlineItem; startLine: number }> = [];
  for (const item of outline) {
    const startLine = item.position?.startLine;
    if (usableLine(startLine)) {
      starts.push({ item, startLine: startLine + offset });
    }
  }

  const sections = new Map<OutlineItem, SectionMetrics>();
  for (let index = 0; index < starts.length; index += 1) {
    const current = starts[index] as { item: OutlineItem; startLine: number };
    const next = starts[index + 1];
    // 下一节不存在就是文件末尾；位置乱序（异常输入）时右边界至少盖住标题自己那一行。
    const endLine = next ? Math.max(current.startLine + 1, next.startLine) : lines.length;
    const slice = lines.slice(current.startLine, endLine).join("\n");
    sections.set(current.item, { startLine: current.startLine, units: countTextUnits(slice) });
  }
  return sections;
}

/**
 * §10.7 要求「每次渲染一次，不是每次滚动一次」：依赖就是 `[text, outline]`
 * 两个输入，滚动进度、活动高亮都不进来。
 */
export function useSectionMetrics(
  text: string,
  outline: readonly OutlineItem[]
): SectionMetricsMap {
  return useMemo(() => sectionMetricsOf(text, outline), [text, outline]);
}
