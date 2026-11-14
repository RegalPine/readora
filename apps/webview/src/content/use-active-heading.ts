/**
 * 活动标题同步（ARC-007 §7，ADR-007-03）。
 *
 * 观察器负责「标题进入阅读基准带」这件事（§7.2），滚动事件只补充基准线本身
 * 判不出来的两个边界：滚到文档顶部与底部（§7.3 第 3、4 条）。两条路径共用
 * 同一次计算与同一个提交门：结果没变就不 setState（§7.5 第 4 条）。
 *
 * 三条硬约束：
 * - 观察器随文档生命周期建立与销毁，绝不为每次滚动新建（§7.5 第 1、2 条）；
 * - 基准线来自 CSS 变量 `--readora-baseline-ratio`，逻辑里不硬编码像素（§7.4）；
 * - 任何一次计算抛错都只丢掉这次高亮更新，正文继续可读（§12 末句）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { findHeading } from "./heading-query";
import { createLazyObserver, type ObserverFactory } from "./viewport";

/** 基准线默认落在视口 25% 高度处（视觉值由 M5 视觉批校准，这里只是兜底）。 */
export const DEFAULT_BASELINE_RATIO = 0.25;
/** 基准带宽度：基准线上下各这么多比例，带内标题才算「阅读区域顶部附近」。 */
export const BASELINE_BAND_RATIO = 0.2;
export const BASELINE_RATIO_VARIABLE = "--readora-baseline-ratio";
/** 点击定位后挂起同步的窗口：平滑滚动动画期间标题会连续穿越基准带。 */
export const NAVIGATION_SUPPRESS_MS = 700;
/** 长文档只观察前 N 个标题（§7.5「限制同时观察的节点」），其余靠滚动路径判定。 */
export const MAX_OBSERVED_HEADINGS = 500;
/** 判定「滚到顶/底」的容差像素。 */
export const EDGE_TOLERANCE_PX = 2;

export interface HeadingPosition {
  id: string;
  /** 相对视口顶部的位置（getBoundingClientRect().top）。 */
  top: number;
}

export interface ScrollContext {
  atTop: boolean;
  atBottom: boolean;
}

/**
 * §7.3 五条规则的纯函数实现（不含 DOM，便于逐条断言）：
 * 5 无标题 → null；3 到顶 → 第一个；4 到底 → 最后一个；
 * 1+2 基准带有候选 → 最接近基准线者；否则 → 已经滚过基准线的最后一个标题。
 */
export function resolveActiveHeading(
  candidates: readonly HeadingPosition[],
  positions: readonly HeadingPosition[],
  baseline: number,
  context: ScrollContext
): string | null {
  const first = positions.at(0);
  const last = positions.at(-1);
  if (!first || !last) {
    return null;
  }
  if (context.atTop) {
    return first.id;
  }
  if (context.atBottom) {
    return last.id;
  }
  const nearest = nearestToBaseline(candidates, baseline);
  if (nearest) {
    return nearest.id;
  }
  // 基准带内没有标题：当前小节由「最后一个已经滚到基准线之上的标题」代表。
  let current: HeadingPosition | undefined;
  for (const position of positions) {
    if (position.top > baseline) {
      break;
    }
    current = position;
  }
  return (current ?? first).id;
}

/** §7.3 第 2 条：多候选取最接近基准线的那个。 */
export function nearestToBaseline(
  candidates: readonly HeadingPosition[],
  baseline: number
): HeadingPosition | null {
  let best: HeadingPosition | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const distance = Math.abs(candidate.top - baseline);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

/** 基准线比例只认 (0, 1) 区间内的合法值，其余（含未定义变量）回落默认。 */
export function readBaselineRatio(doc: Document = document): number {
  const element = doc.documentElement;
  if (!element || typeof doc.defaultView?.getComputedStyle !== "function") {
    return DEFAULT_BASELINE_RATIO;
  }
  const raw = doc.defaultView
    .getComputedStyle(element)
    .getPropertyValue(BASELINE_RATIO_VARIABLE)
    .trim();
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed > 0 && parsed < 1 ? parsed : DEFAULT_BASELINE_RATIO;
}

export interface ActiveHeadingOptions {
  /** 注入点：单测给假观察器或 null（模拟 §12「Observer 初始化失败」的退化路径）。 */
  observerFactory?: ObserverFactory;
  doc?: Document;
  win?: Window;
  /** 覆盖默认挂起窗口，仅测试用。 */
  suppressMs?: number;
}

export interface ActiveHeadingApi {
  activeHeadingId: string | null;
  /**
   * 点击目录后立刻把该项钉为活动标题，并在挂起窗口内不再被滚动同步覆盖
   * （PRD-002 §5.2 第 5 条：点击定位期间抑制观察器抖动）。
   */
  pin(headingId: string, ms?: number): void;
}

export function useActiveHeading(
  anchors: readonly string[],
  version: number,
  options: ActiveHeadingOptions = {}
): ActiveHeadingApi {
  const factory = options.observerFactory ?? createLazyObserver;
  const suppressMs = options.suppressMs ?? NAVIGATION_SUPPRESS_MS;
  const [activeHeadingId, setActiveHeadingId] = useState<string | null>(null);
  const suppressedUntilRef = useRef(0);
  // 计算函数需要被观察器与滚动共用，用 ref 持有最新的提交入口。
  const computeRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    const doc = options.doc ?? document;
    const win = options.win ?? window;
    // 标题集合变了（新版本或新增/删除标题）才重建目标与观察器（§7.5 第 2 条）。
    const targets = anchors
      .slice(0, MAX_OBSERVED_HEADINGS)
      .map((id) => ({ id, element: findHeading(doc, id) }))
      .filter((entry): entry is { id: string; element: HTMLElement } => entry.element !== null);

    const commit = (next: string | null): void => {
      // 只有真的变化才 setState：滚动风暴不该换成渲染风暴（§7.5 第 4 条）。
      setActiveHeadingId((current) => (current === next ? current : next));
    };

    const compute = (): void => {
      try {
        if (suppressedUntilRef.current > Date.now()) {
          return;
        }
        if (targets.length === 0) {
          commit(null);
          return;
        }
        const viewport = win.innerHeight > 0 ? win.innerHeight : 1;
        const baseline = readBaselineRatio(doc) * viewport;
        const positions: HeadingPosition[] = targets.map((target) => ({
          id: target.id,
          top: target.element.getBoundingClientRect().top
        }));
        const band = BASELINE_BAND_RATIO * viewport;
        const candidates = positions.filter(
          (position) => position.top >= baseline - band && position.top <= baseline + band
        );
        const scroller = doc.scrollingElement ?? doc.documentElement;
        const scrollHeight = scroller?.scrollHeight ?? 0;
        const y = win.scrollY;
        commit(
          resolveActiveHeading(candidates, positions, baseline, {
            atTop: y <= EDGE_TOLERANCE_PX,
            // scrollHeight 未超过视口时谈不上「滚到底」。
            atBottom:
              scrollHeight > viewport && y + viewport >= scrollHeight - EDGE_TOLERANCE_PX
          })
        );
      } catch {
        // §12：导航层异常就地吞掉，最坏结果是这一次不更新高亮。
      }
    };
    computeRef.current = compute;

    if (targets.length === 0) {
      commit(null);
      return (): void => {
        computeRef.current = () => undefined;
      };
    }

    let observer: ReturnType<ObserverFactory> | null = null;
    try {
      // rootMargin 把视口压成基准带：只有带内标题的进出才值得重算一次。
      const top = Math.round((readBaselineRatio(doc) - BASELINE_BAND_RATIO) * 100);
      const bottom = Math.round(
        (1 - readBaselineRatio(doc) - BASELINE_BAND_RATIO) * 100
      );
      observer = factory(compute, { rootMargin: `${top}% 0px ${bottom}% 0px` });
    } catch {
      observer = null;
    }
    if (observer) {
      for (const target of targets) {
        observer.observe(target.element);
      }
    }
    // 观察器缺席（jsdom、旧内核、初始化失败）时它就是唯一路径：§12 降级口径。
    win.addEventListener("scroll", compute, { passive: true });
    compute();

    return () => {
      win.removeEventListener("scroll", compute);
      observer?.disconnect();
      computeRef.current = () => undefined;
    };
    // anchors 是派生数组，按内容比较会每次渲染都重建，因此只随版本与引用变化。
  }, [anchors, version, factory, options.doc, options.win]);

  const pin = useCallback(
    (headingId: string, ms?: number): void => {
      suppressedUntilRef.current = Date.now() + (ms ?? suppressMs);
      setActiveHeadingId(headingId);
      // 钉住之后不再需要挂起窗口里的旧计算结果：把待跑的挂起清零由时间自然到期。
    },
    [suppressMs]
  );

  return {
    activeHeadingId,
    pin
  };
}
