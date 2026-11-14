/**
 * 阅读进度（PRD-003 §10.5 浮动快速条、§10.7 大纲进度块）。
 *
 * `rAF` 节流：滚动事件的密度远高于刷新率，一次 `scroll` 就 setState 会把渲染
 * 排在合成前面（ARC-007 §7.5 第 4 条同一口径：结果没变就不 setState）。
 *
 * **唯一滚动容器是 window**（`document.scrollingElement`）。PRD-003 §10.5 的表格
 * 把主体段写成「唯一滚动容器 `main.readora-canvas-scroll`」，本仓从 M2 起滚动条
 * 就挂在 window 上：Host 的 `state.save.scrollTop`、ARC-007 §8 的六步恢复、
 * `--readora-navigation-offset` 的定位预留全都按 window 口径算。换成内层容器要
 * 同时改状态契约，不属本批范围，登记为偏差（README）。
 *
 * `activeHeading` 不在这里二次判定：ARC-007 §7 的基准带算法（`useActiveHeading`）
 * 是活动标题的唯一权威，本钩子只做透传。再造一条「按滚动位置算当前标题」的
 * 路径就会出现快速条标题与大纲高亮各说各话的局面。
 */
import { useEffect, useState } from "react";

/** 进度写进百分比文案，小于这个步长的变化不值得一次渲染。 */
export const PROGRESS_EPSILON = 0.001;

export interface ReadingProgress {
  /** 0–1；文档不足一屏（没有可滚动的距离）时为 0。 */
  readonly progress: number;
  readonly activeHeading: string | null;
}

/**
 * 纯函数形态，便于逐条断言（jsdom 里 scrollHeight 恒为 0，测不到真实滚动）。
 *
 * 可滚距离 <= 0 时返回 0 而不是 1：把「一屏放得下」报成「已读完」是错的，
 * 用户在顶部时尤其显眼。
 */
export function readingProgressOf(
  scrollTop: number,
  scrollHeight: number,
  viewport: number
): number {
  const scrollable = scrollHeight - viewport;
  if (!(scrollable > 0)) {
    return 0;
  }
  const ratio = scrollTop / scrollable;
  if (!Number.isFinite(ratio)) {
    return 0;
  }
  return Math.min(1, Math.max(0, ratio));
}

function measure(doc: Document, win: Window): number {
  const scroller = doc.scrollingElement ?? doc.documentElement;
  const scrollHeight = scroller?.scrollHeight ?? 0;
  const viewport = win.innerHeight > 0 ? win.innerHeight : 0;
  return readingProgressOf(win.scrollY, scrollHeight, viewport);
}

export interface ReadingProgressOptions {
  doc?: Document;
  win?: Window;
  /** 注入 rAF（单测里换成同步执行，避免等一帧）。 */
  raf?: (callback: () => void) => number;
  caf?: (handle: number) => void;
}

/**
 * @param activeHeading 来自 `useActiveHeading`，本钩子只透传。
 * @param revision 文档版本号；换文档要把进度复位重算，否则旧文档滚到底的
 *                 100% 会挂在刚加载的新文档上一帧。
 */
export function useReadingProgress(
  activeHeading: string | null,
  revision: number,
  options: ReadingProgressOptions = {}
): ReadingProgress {
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    const doc = options.doc ?? document;
    const win = options.win ?? window;
    const raf =
      options.raf ??
      ((callback: () => void): number =>
        typeof win.requestAnimationFrame === "function"
          ? win.requestAnimationFrame(callback)
          : win.setTimeout(callback, 16));
    const caf =
      options.caf ??
      ((handle: number): void => {
        if (typeof win.cancelAnimationFrame === "function") {
          win.cancelAnimationFrame(handle);
        } else {
          win.clearTimeout(handle);
        }
      });

    let frame = 0;
    const sync = (): void => {
      frame = 0;
      const next = measure(doc, win);
      // 只有真的动过才 setState（滚动风暴不该换成渲染风暴）。
      setProgress((current) =>
        Math.abs(current - next) < PROGRESS_EPSILON ? current : next
      );
    };
    const schedule = (): void => {
      if (frame !== 0) {
        return;
      }
      frame = raf(sync);
    };

    schedule();
    win.addEventListener("scroll", schedule, { passive: true });
    win.addEventListener("resize", schedule);
    return () => {
      win.removeEventListener("scroll", schedule);
      win.removeEventListener("resize", schedule);
      if (frame !== 0) {
        caf(frame);
      }
    };
    // revision 进依赖：换文档或版本推进时重新测一次。
  }, [revision, options.doc, options.win, options.raf, options.caf]);

  return { progress, activeHeading };
}

/** 百分比文案：四舍五入到整数，100% 只在真的滚到底时出现。 */
export function formatProgress(progress: number): string {
  return `${Math.round(Math.min(1, Math.max(0, progress)) * 100)}%`;
}
