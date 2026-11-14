/**
 * 分节度量的取证（PRD-003 §10.7 的行内标签）。
 *
 * 区间口径是这里唯一容易被写错的东西：边界取「outline 里的下一个标题」，
 * 不是「下一个同级标题」，所以 H1 的字数天然含它的子节；最后一节到文件末尾；
 * 没有 `position` 的条目整条跳过（缺边界就切不出区间，猜出来的字数比不写更误导）。
 * 行号按 **0 基** 算（markdown-core 透传 markdown-it `token.map`），区间左闭右开。
 */
import { describe, expect, test } from "vitest";
import type { OutlineItem } from "@readora/markdown-core";
import { sectionMetricsOf } from "../section-metrics";

function heading(
  title: string,
  level: number,
  anchor: string,
  startLine?: number
): OutlineItem {
  return {
    id: `n-${anchor}`,
    title,
    level,
    anchor,
    ...(startLine === undefined ? {} : { position: { startLine, endLine: startLine } })
  };
}

/**
 * 行号与文本一一对应的夹具（0 基，与 markdown-core 透传的 `SourcePosition` 同基）：
 * 0  # Overview
 * 1  intro alpha beta
 * 2
 * 3  ## Architecture
 * 4  gamma delta
 * 5  ## Implementation
 * 6  epsilon
 */
const SOURCE = [
  "# Overview",
  "intro alpha beta",
  "",
  "## Architecture",
  "gamma delta",
  "## Implementation",
  "epsilon"
].join("\n");

const OVERVIEW = heading("Overview", 1, "overview", 0);
const ARCHITECTURE = heading("Architecture", 2, "architecture", 3);
const IMPLEMENTATION = heading("Implementation", 2, "implementation", 5);

describe("sectionMetricsOf：相邻标题的源行区间", () => {
  test("每节到自己的下一个标题为止", () => {
    const metrics = sectionMetricsOf(SOURCE, [OVERVIEW, ARCHITECTURE, IMPLEMENTATION]);
    // Overview = 第 0–2 行：`#` 与空行都不是单元，剩 Overview / intro / alpha / beta = 4。
    expect(metrics.get(OVERVIEW)).toEqual({ startLine: 0, units: 4 });
    expect(metrics.get(ARCHITECTURE)).toEqual({ startLine: 3, units: 3 });
    expect(metrics.get(IMPLEMENTATION)).toEqual({ startLine: 5, units: 2 });
  });

  test("父节的字数含它的子节：口径是「这一大节一共多少字」", () => {
    const metrics = sectionMetricsOf(SOURCE, [OVERVIEW]);
    // 只有一节时它到文件末尾，整篇单元数就是它的单元数。
    const whole = sectionMetricsOf(SOURCE, [OVERVIEW, ARCHITECTURE, IMPLEMENTATION]);
    expect(metrics.get(OVERVIEW)?.units).toBeGreaterThan(
      whole.get(OVERVIEW)?.units ?? 0
    );
    expect(metrics.get(OVERVIEW)?.units).toBe(9);
  });

  test("最后一节到文件末尾，末尾空行不额外产生单元", () => {
    const withTrailingBlank = `${SOURCE}\n\n\n`;
    const metrics = sectionMetricsOf(withTrailingBlank, [IMPLEMENTATION]);
    expect(metrics.get(IMPLEMENTATION)).toEqual({ startLine: 5, units: 2 });
  });

  test("没有 position 的条目不进结果：调用方据此不显示标签", () => {
    const loose = heading("No Position", 2, "loose");
    const metrics = sectionMetricsOf(SOURCE, [OVERVIEW, loose]);
    expect(metrics.has(loose)).toBe(false);
    expect(metrics.has(OVERVIEW)).toBe(true);
    // 缺位置的条目不配当边界：Overview 后面没有别的定位标题，就一路到文件末尾。
    // 少报一节比报一条切错的区间诚实 —— 区间口径只看「有位置的相邻标题」。
    expect(metrics.get(OVERVIEW)).toEqual({ startLine: 0, units: 9 });
    const anchored = heading("Architecture", 2, "architecture", 3);
    expect(sectionMetricsOf(SOURCE, [OVERVIEW, loose, anchored]).get(OVERVIEW)).toEqual({
      startLine: 0,
      units: 4
    });
  });

  test("startLine 0 是合法位置：首行标题不能被判成「没有位置」", () => {
    // 这曾是真实的错位：markdown-core 行号 0 基，按 1 基解释时首行 H1 整条不进结果，
    // 而「H1 写在第一行」是最常见的文档形状 —— 字数标签会静默不显示。
    const metrics = sectionMetricsOf(SOURCE, [OVERVIEW]);
    expect(metrics.get(OVERVIEW)?.startLine).toBe(0);
    expect(metrics.get(OVERVIEW)?.units).toBe(9);
  });

  test("非法源行（负数、小数、NaN）一律当没有位置", () => {
    const bad = [-3, -1, 2.5, Number.NaN].map((line) =>
      heading(`Bad ${line}`, 2, `bad-${line}`, line as number)
    );
    const metrics = sectionMetricsOf(SOURCE, bad);
    expect(metrics.size).toBe(0);
  });

  test("位置乱序时至少保住标题自己那一行，不切出空区间或负区间", () => {
    const later = heading("Later", 1, "later", 5);
    const earlier = heading("Earlier", 2, "earlier", 2);
    const metrics = sectionMetricsOf(SOURCE, [later, earlier]);
    expect(metrics.get(later)?.startLine).toBe(5);
    expect(metrics.get(earlier)?.startLine).toBe(2);
    // 下一项的行号比自己小，右边界夹回 startLine + 1：本节只剩自己那一行。
    expect(metrics.get(later)?.units).toBe(1);
  });

  test("中文源文按字计，与时长 pill 同一口径", () => {
    const chinese = ["# 概览", "第一段中文内容", "", "## 架构", "第二段"].join("\n");
    const overview = heading("概览", 1, "overview", 0);
    const architecture = heading("架构", 2, "architecture", 3);
    const metrics = sectionMetricsOf(chinese, [overview, architecture]);
    // 概览(2) + 第一段中文内容(7) = 9；架构(2) + 第二段(3) = 5。
    expect(metrics.get(overview)?.units).toBe(9);
    expect(metrics.get(architecture)?.units).toBe(5);
  });

  test("空源文没有区间可切，但条目本身仍拿得到行号", () => {
    const metrics = sectionMetricsOf("", [OVERVIEW]);
    expect(metrics.get(OVERVIEW)?.startLine).toBe(0);
    expect(metrics.get(OVERVIEW)?.units).toBe(0);
  });

  test("重名标题各归各节：按对象标识查，不按锚点或 id", () => {
    // 两个条目的锚点与 id 完全相同（outline-tree 只能靠追加序号区分 key），
    // 按引用查才不会把第二节的区间套到第一节上。
    const first = heading("Same", 2, "same", 0);
    const second = heading("Same", 2, "same", 3);
    expect(first.id).toBe(second.id);
    expect(first.anchor).toBe(second.anchor);
    const metrics = sectionMetricsOf(SOURCE, [first, second]);
    expect(metrics.get(first)).toEqual({ startLine: 0, units: 4 });
    expect(metrics.get(second)).toEqual({ startLine: 3, units: 5 });
  });
});
