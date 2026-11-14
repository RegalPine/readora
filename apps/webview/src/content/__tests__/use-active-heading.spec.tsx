/**
 * 活动标题同步测试（ARC-007 §7.3 / §7.4 / §7.5 / §12，F02-004 / F02-005）。
 *
 * 两层断言：纯函数 `resolveActiveHeading` 逐条钉住 §7.3 的五条规则；
 * Hook 层钉住「观察器随文档生命周期、无变化不更新、异常不影响正文」这三条。
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import type { ObserverFactory, ObserverHandle } from "../viewport";
import {
  BASELINE_BAND_RATIO,
  DEFAULT_BASELINE_RATIO,
  MAX_OBSERVED_HEADINGS,
  BASELINE_RATIO_VARIABLE,
  nearestToBaseline,
  readBaselineRatio,
  resolveActiveHeading,
  useActiveHeading,
  type HeadingPosition
} from "../use-active-heading";

const VIEWPORT = 800;
/** 默认比例 0.25 → 基准线 200px，基准带 ±160px，即 [40, 360]。 */
const BASELINE = VIEWPORT * DEFAULT_BASELINE_RATIO;
const BAND = VIEWPORT * BASELINE_BAND_RATIO;

let topById = new Map<string, number>();
let throwOnMeasure = false;

function headings(...ids: string[]): void {
  document.body.innerHTML = ids.length
    ? `<div class="readora-document">${ids
        .map((id) => `<h2 id="${id}" class="readora-heading" data-readora-heading="${id}">${id}</h2>`)
        .join("")}</div>`
    : `<div class="readora-document"></div>`;
  topById = new Map(ids.map((id, index) => [id, (index + 1) * 1_000]));
}

function place(entries: Record<string, number>): void {
  topById = new Map(Object.entries(entries));
}

function scroll(y: number): void {
  Object.defineProperty(window, "scrollY", { value: y, configurable: true, writable: true });
}

function contentHeight(value: number): void {
  Object.defineProperty(document.documentElement, "scrollHeight", {
    value,
    configurable: true
  });
}

function tick(): void {
  act(() => {
    window.dispatchEvent(new Event("scroll"));
  });
}

interface FakeObserver extends ObserverHandle {
  observed: Element[];
  disconnects: number;
  rootMargin: string;
  fire(): void;
}

function fakeObserver(): { factory: ObserverFactory; handle: FakeObserver } {
  let callback: ((element: HTMLElement) => void) | null = null;
  const handle: FakeObserver = {
    observed: [],
    disconnects: 0,
    rootMargin: "",
    observe: (element) => {
      handle.observed.push(element);
    },
    unobserve: (element) => {
      handle.observed = handle.observed.filter((entry) => entry !== element);
    },
    disconnect: () => {
      handle.disconnects += 1;
      handle.observed = [];
    },
    fire: () => {
      callback?.({} as HTMLElement);
    }
  };
  const factory: ObserverFactory = (next, options) => {
    callback = next;
    handle.rootMargin = options.rootMargin;
    return handle;
  };
  return { factory, handle };
}

let renders = 0;

type ActiveHeadingApi = ReturnType<typeof useActiveHeading>;

function Probe({
  anchors,
  version,
  factory,
  apiRef
}: {
  anchors: readonly string[];
  version: number;
  factory?: ObserverFactory;
  apiRef?: { current: ActiveHeadingApi | null };
}) {
  renders += 1;
  const api = useActiveHeading(anchors, version, factory ? { observerFactory: factory } : {});
  if (apiRef) {
    apiRef.current = api;
  }
  return <span data-testid="active">{api.activeHeadingId ?? "none"}</span>;
}

function activeText(container: HTMLElement): string {
  return container.querySelector<HTMLElement>('[data-testid="active"]')?.textContent ?? "";
}

beforeEach(() => {
  renders = 0;
  throwOnMeasure = false;
  scroll(0);
  contentHeight(0);
  Object.defineProperty(window, "innerHeight", { value: VIEWPORT, configurable: true });
  HTMLElement.prototype.getBoundingClientRect = function (): DOMRect {
    if (throwOnMeasure) {
      throw new Error("layout measurement blew up");
    }
    const top = topById.get(this.id) ?? 0;
    return { top, bottom: top + 24 } as DOMRect;
  };
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
  document.documentElement.style.removeProperty?.(BASELINE_RATIO_VARIABLE);
});

describe("resolveActiveHeading（§7.3 五条规则）", () => {
  const position = (id: string, top: number): HeadingPosition => ({ id, top });

  test("第 1 条：基准带内只有一个候选就用它", () => {
    const positions = [position("a", 10), position("b", BASELINE + 5), position("c", 900)];
    const candidates = positions.filter(
      (entry) => entry.top >= BASELINE - BAND && entry.top <= BASELINE + BAND
    );
    expect(
      resolveActiveHeading(candidates, positions, BASELINE, { atTop: false, atBottom: false })
    ).toBe("b");
  });

  test("第 2 条：多个候选取最接近基准线的", () => {
    const positions = [position("a", 60), position("b", 300), position("c", 205)];
    const candidates = positions.filter(
      (entry) => entry.top >= BASELINE - BAND && entry.top <= BASELINE + BAND
    );
    expect(candidates).toHaveLength(3);
    expect(
      resolveActiveHeading(candidates, positions, BASELINE, { atTop: false, atBottom: false })
    ).toBe("c");
  });

  test("第 3 条：滚到顶部取第一个有效标题，即使带内另有候选", () => {
    const positions = [position("a", -400), position("b", BASELINE)];
    expect(
      resolveActiveHeading([positions[1] as HeadingPosition], positions, BASELINE, {
        atTop: true,
        atBottom: false
      })
    ).toBe("a");
  });

  test("第 4 条：滚到底部允许最后一个成为活动", () => {
    const positions = [position("a", -800), position("b", -400), position("c", -200)];
    expect(
      resolveActiveHeading([], positions, BASELINE, { atTop: false, atBottom: true })
    ).toBe("c");
  });

  test("带内无候选时由「已滚过基准线的最后一个标题」代表当前小节", () => {
    const positions = [position("a", -500), position("b", -260), position("c", 600)];
    expect(
      resolveActiveHeading([], positions, BASELINE, { atTop: false, atBottom: false })
    ).toBe("b");
  });

  test("基准线之上没有任何标题时回到第一个", () => {
    const positions = [position("a", 600), position("b", 900)];
    expect(resolveActiveHeading([], positions, BASELINE, { atTop: false, atBottom: false })).toBe(
      "a"
    );
  });

  test("第 5 条：无标题不产生活动状态", () => {
    expect(resolveActiveHeading([], [], BASELINE, { atTop: true, atBottom: true })).toBeNull();
  });

  test("nearestToBaseline：空集合与并列都确定", () => {
    expect(nearestToBaseline([], BASELINE)).toBeNull();
    const picked = nearestToBaseline(
      [position("a", 100), position("b", 300)],
      BASELINE
    );
    expect(picked?.id).toBe("a");
    const tie = nearestToBaseline([position("a", 190), position("b", 210)], BASELINE);
    expect(tie?.id).toBe("a");
  });
});

describe("readBaselineRatio（§7.4 不硬编码像素）", () => {
  function docWithRaw(raw: string): Document {
    return {
      documentElement: {} as HTMLElement,
      defaultView: {
        getComputedStyle: () => ({
          getPropertyValue: (name: string) => (name === BASELINE_RATIO_VARIABLE ? raw : "")
        })
      }
    } as unknown as Document;
  }

  test("合法比例被采纳", () => {
    expect(readBaselineRatio(docWithRaw("0.4"))).toBeCloseTo(0.4);
    expect(readBaselineRatio(docWithRaw(" 0.35 "))).toBeCloseTo(0.35);
  });

  test("缺失、越界、非数值都回落默认（含 0 与 1 这两个退化值）", () => {
    for (const raw of ["", "0", "1", "1.5", "-0.2", "auto", "NaN"]) {
      expect(readBaselineRatio(docWithRaw(raw))).toBe(DEFAULT_BASELINE_RATIO);
    }
  });

  test("没有 defaultView 或 getComputedStyle 时同样回落", () => {
    expect(readBaselineRatio({ documentElement: null } as unknown as Document)).toBe(
      DEFAULT_BASELINE_RATIO
    );
    expect(
      readBaselineRatio({
        documentElement: {} as HTMLElement,
        defaultView: {}
      } as unknown as Document)
    ).toBe(DEFAULT_BASELINE_RATIO);
  });
});

describe("useActiveHeading（Hook 层）", () => {
  test("基准带内变化按基准线切换活动标题（连续滚动）", () => {
    headings("a", "b", "c");
    place({ a: 100, b: 500, c: 900 });
    scroll(300);
    const { container } = render(<Probe anchors={["a", "b", "c"]} version={1} />);
    expect(activeText(container)).toBe("a");

    place({ a: -60, b: BASELINE, c: 900 });
    tick();
    expect(activeText(container)).toBe("b");
  });

  test("到顶与到底按 §7.3 第 3、4 条判定", () => {
    headings("a", "b", "c");
    place({ a: -400, b: -200, c: BASELINE });
    scroll(0);
    const { container } = render(<Probe anchors={["a", "b", "c"]} version={1} />);
    expect(activeText(container)).toBe("a");

    contentHeight(5_000);
    scroll(5_000 - VIEWPORT);
    tick();
    expect(activeText(container)).toBe("c");
  });

  test("结果没变就不重复 setState（§7.5 第 4 条）", () => {
    headings("a", "b");
    place({ a: BASELINE, b: 900 });
    scroll(300);
    const { container } = render(<Probe anchors={["a", "b"]} version={1} />);
    expect(activeText(container)).toBe("a");
    // 头两次滚动允许 React 对同值 setState 的一次兜底重渲染，之后就完全静默
    tick();
    tick();
    const quiet = renders;
    for (let index = 0; index < 20; index += 1) {
      tick();
    }
    expect(renders).toBe(quiet);
    expect(activeText(container)).toBe("a");
  });

  test("观察器随文档生命周期建立：目标一次、退出即断开（§7.5 第 1、2 条）", () => {
    headings("a", "b", "c");
    place({ a: BASELINE, b: 500, c: 900 });
    scroll(200);
    const { factory, handle } = fakeObserver();
    const view = render(<Probe anchors={["a", "b", "c"]} version={1} factory={factory} />);
    expect(handle.observed).toHaveLength(3);
    // 基准带换算成 rootMargin：带顶 5%、带底 55%（1 - 0.25 - 0.2）
    expect(handle.rootMargin).toBe("5% 0px 55% 0px");

    act(() => {
      handle.fire();
    });
    expect(activeText(view.container)).toBe("a");

    view.unmount();
    expect(handle.disconnects).toBe(1);
  });

  test("观察器缺席（jsdom / 初始化失败）时退化成滚动位置检测（§12）", () => {
    headings("a", "b");
    place({ a: BASELINE, b: 900 });
    scroll(100);
    const nullFactory: ObserverFactory = () => null;
    const { container } = render(<Probe anchors={["a", "b"]} version={1} factory={nullFactory} />);
    expect(activeText(container)).toBe("a");
    place({ a: -500, b: BASELINE });
    tick();
    expect(activeText(container)).toBe("b");
  });

  test("观察器工厂抛错不影响正文，导航层自己吞掉（§12 末句）", () => {
    headings("a", "b");
    place({ a: BASELINE, b: 900 });
    scroll(100);
    const throwing: ObserverFactory = () => {
      throw new Error("IntersectionObserver unavailable");
    };
    const { container } = render(
      <Probe anchors={["a", "b"]} version={1} factory={throwing} />
    );
    expect(activeText(container)).toBe("a");
    place({ a: -900, b: BASELINE });
    tick();
    expect(activeText(container)).toBe("b");
    // 正文容器与标题元素都还在：导航层出问题不外溢（§12 末句）
    expect(document.querySelectorAll(".readora-heading")).toHaveLength(2);
  });

  test("测量抛错只丢掉这一次高亮更新，不冒泡出去", () => {
    headings("a");
    place({ a: BASELINE });
    scroll(100);
    const { factory, handle } = fakeObserver();
    const { container } = render(<Probe anchors={["a"]} version={1} factory={factory} />);
    expect(activeText(container)).toBe("a");
    throwOnMeasure = true;
    expect(() => {
      act(() => {
        handle.fire();
      });
      tick();
    }).not.toThrow();
    expect(activeText(container)).toBe("a");
  });

  test("DOM 里不存在的锚点不进观察集合（标题被删后不误报）", () => {
    headings("a", "c");
    place({ a: BASELINE, c: 900 });
    scroll(100);
    const { factory, handle } = fakeObserver();
    render(<Probe anchors={["a", "gone", "c"]} version={1} factory={factory} />);
    expect(handle.observed.map((node) => node.id)).toEqual(["a", "c"]);
  });

  test("长文档只观察前 N 个标题（§7.5 限制观察节点数）", () => {
    const ids = Array.from({ length: MAX_OBSERVED_HEADINGS + 3 }, (_, index) => `h${index}`);
    headings(...ids);
    place({ h0: BASELINE });
    scroll(100);
    const { factory, handle } = fakeObserver();
    render(<Probe anchors={ids} version={1} factory={factory} />);
    expect(handle.observed).toHaveLength(MAX_OBSERVED_HEADINGS);
  });

  test("无标题文档不产生活动状态，也不建观察器（§7.3 第 5 条）", () => {
    headings();
    scroll(100);
    const { factory, handle } = fakeObserver();
    const { container } = render(<Probe anchors={[]} version={1} factory={factory} />);
    expect(activeText(container)).toBe("none");
    expect(handle.observed).toHaveLength(0);
  });

  test("点击目录后钉住目标并在挂起窗口内抑制抖动", () => {
    vi.useFakeTimers();
    try {
      headings("a", "b");
      place({ a: BASELINE, b: 900 });
      scroll(100);
      const { factory, handle } = fakeObserver();
      const apiRef: { current: ActiveHeadingApi | null } = { current: null };
      const { container } = render(
        <Probe anchors={["a", "b"]} version={1} factory={factory} apiRef={apiRef} />
      );
      expect(activeText(container)).toBe("a");

      // 模拟平滑滚动途中 a 又落回基准带：钉住的结果不该被覆盖
      act(() => {
        apiRef.current?.pin("b", 5_000);
      });
      expect(activeText(container)).toBe("b");
      place({ a: BASELINE, b: 900 });
      act(() => {
        handle.fire();
        window.dispatchEvent(new Event("scroll"));
      });
      expect(activeText(container)).toBe("b");

      // 挂起窗口到期后恢复正常同步
      vi.advanceTimersByTime(6_000);
      tick();
      expect(activeText(container)).toBe("a");
    } finally {
      vi.useRealTimers();
    }
  });

  test("只有锚点集合或文档版本变化才重建观察器（§7.5 第 1、2 条）", () => {
    headings("a", "b");
    place({ a: BASELINE, b: 900 });
    scroll(100);
    const ids = ["a", "b"];
    const observed: Element[] = [];
    const factory: ObserverFactory = () => ({
      observe: (element) => {
        observed.push(element);
      },
      unobserve: () => undefined,
      disconnect: () => undefined
    });
    const { rerender } = render(<Probe anchors={ids} version={1} factory={factory} />);
    expect(observed).toHaveLength(2);
    // 同一引用 + 同一版本重渲染：不重建（App 的 state 更新不该带来观察器抖动）
    rerender(<Probe anchors={ids} version={1} factory={factory} />);
    expect(observed).toHaveLength(2);
    // 新版本：目标集合重新解析一次
    rerender(<Probe anchors={ids} version={2} factory={factory} />);
    expect(observed).toHaveLength(4);
  });
});
