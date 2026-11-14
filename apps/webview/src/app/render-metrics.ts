/**
 * 渲染指标采集（PRD-001 F11-014，M6）。
 *
 * ARC-004 §8.3 没有任何 View → Host 的只读上报通道：`reader.error` 的语义是
 * 「出错了」，把正常指标塞进去会让日志里的 error 计数失去意义；`state.save` 的
 * 语义是「阅读位置」，指标跟着它走等于给状态存储加了一类没有寿命的数据。
 * 因此本批补设 `metrics.report`（view-to-host，Host 记录不回复），并登记为规范缺口。
 *
 * 两个时长的口径都锚在同一点上 —— **收到快照的那一刻**：
 * - `renderDurationMs`：到达 → 正文 DOM 写入完成（`onRendered` 被调用的那一瞬）；
 * - `firstPaintDurationMs`：到达 → 写入后的第一帧（`requestAnimationFrame` 回调）。
 * 起点相同、终点相差一帧，两条数才能相减出「浏览器排版+绘制」的成本；若各取各的
 * 起点（例如拿 React 的 render 时刻），指标就变成了两条互不可比的曲线。
 *
 * 用单调时钟而不是 `Date.now()`：用户改系统时间不该让一次渲染看起来花了负数时间。
 */
import type { DocumentLoadPayload, MetricsReportPayload } from "@readora/contracts";

/** 正文容器内的规模计数（与 `metrics.report` 的四个计数字段一一对应）。 */
export interface RenderCounts {
  blockCount: number;
  diagramCount: number;
  mathCount: number;
}

/** 类名是渲染管线的公开契约（IMP-001 §10.3 公式、ARC-003 图表），选择器只认这三条。 */
const BLOCK_SELECTOR = ".readora-document > *";
const DIAGRAM_SELECTOR = ".readora-diagram";
const MATH_SELECTOR = ".readora-math";

/**
 * 单调时钟。
 *
 * Webview 内嵌 Chromium 必有 `performance`；留 `Date.now()` 兜底只为让纯函数在
 * node 单测里也能被注入自造时钟（见 `__tests__/render-metrics.spec.ts`）。
 */
export function monotonicNow(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

/** 一次快照到达的记录：换文档与换版本都要重新计时，所以带上可比对的键。 */
export interface SnapshotArrival {
  key: string;
  at: number;
}

export function arrivalKey(payload: Pick<DocumentLoadPayload, "documentUri" | "version">): string {
  return `${payload.documentUri}#${payload.version}`;
}

/**
 * 快照到达时记账。
 *
 * 只保留最近一条：指标是「这一次渲染花了多久」，不是历史序列；留一份就够挡住
 * 重复渲染回调把同一次到达上报两遍（`onRendered` 在依赖变动时可能被再次触发）。
 */
export function recordArrival(payload: DocumentLoadPayload, now: number): SnapshotArrival {
  return { key: arrivalKey(payload), at: now };
}

/**
 * 从 DOM 里数规模，而不是从 `result.html` 里数子串。
 *
 * 字符串计数会把降级形态（公式渲染失败退回源码、图表 pending）按源码文本计入，
 * 于是「10 条公式全部渲染失败」在指标里仍然显示为 10 —— 那正是要避免的自证。
 * 数 DOM 得到的是用户实际看到的节点数；容器缺失（首帧前、卸载后）一律记 0。
 */
export function countRenderedBlocks(root: Element | null): RenderCounts {
  if (!root) {
    return { blockCount: 0, diagramCount: 0, mathCount: 0 };
  }
  const scope = root.matches(".readora-document") ? root : root.querySelector(".readora-document");
  const within = scope ?? root;
  return {
    blockCount: within.querySelectorAll(BLOCK_SELECTOR).length,
    diagramCount: within.querySelectorAll(DIAGRAM_SELECTOR).length,
    mathCount: within.querySelectorAll(MATH_SELECTOR).length
  };
}

/** 时长与计数的输入：`receivedAt` 缺失时不编造，直接不上报（返回 null）。 */
export interface RenderSampleInput {
  payload: DocumentLoadPayload;
  receivedAt: number;
  /** DOM 写入完成时刻。 */
  renderedAt: number;
  /** 第一帧时刻。 */
  paintedAt: number;
  counts: RenderCounts;
}

const MAX_DURATION_MS = 600_000;

/** 单调时钟的差值理论上非负，但 `performance.timeOrigin` 变化等异常仍要夹住。 */
function duration(from: number, to: number): number {
  return Math.min(Math.max(Math.round(to - from), 0), MAX_DURATION_MS);
}

/**
 * 组装 `metrics.report` 载荷。
 *
 * 纯函数：App 只负责取时刻与 DOM，数值口径全在这里，因此本文件的用例不需要渲染
 * 任何组件就能锁住「负数归零、超上限截断、四舍五入到整毫秒」这三条。
 */
export function toMetricsReport(input: RenderSampleInput): MetricsReportPayload {
  const { payload, counts } = input;
  return {
    documentUri: payload.documentUri.slice(0, 2048),
    version: payload.version,
    renderDurationMs: duration(input.receivedAt, input.renderedAt),
    firstPaintDurationMs: duration(input.receivedAt, input.paintedAt),
    charCount: payload.text.length,
    blockCount: counts.blockCount,
    diagramCount: counts.diagramCount,
    mathCount: counts.mathCount
  };
}
