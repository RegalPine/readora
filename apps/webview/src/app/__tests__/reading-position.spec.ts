/**
 * 阅读位置恢复测试（ARC-007 §8.2 六步 / §8.4 文档变化 / §12 导航异常隔离，STORY-09-02）。
 *
 * 两个导出函数是恢复策略的全部决策点，用假 locator 与假滚动把它们逐分支钉死；
 * 消息时序与 state.save 载荷在 app-navigation.spec.tsx 里做集成断言。
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ReadingState } from "@readora/contracts";
import type { HeadingLocator } from "../../content/heading-locator";
import { STATE_SAVE_DEBOUNCE_MS, applyRestoredState, recoverAfterDocumentChange } from "../App";

interface ScrollCall {
  top: number;
  behavior: string | undefined;
}

let scrolls: ScrollCall[] = [];

function stubWindow(init: { scrollY?: number; innerHeight?: number; scrollHeight?: number }): void {
  scrolls = [];
  let y = init.scrollY ?? 0;
  Object.defineProperty(window, "scrollY", {
    configurable: true,
    get: () => y,
    set: (next: number) => {
      y = next;
    }
  });
  Object.defineProperty(window, "innerHeight", {
    value: init.innerHeight ?? 800,
    configurable: true
  });
  window.scrollTo = ((options: ScrollToOptions | number, second?: number) => {
    const top =
      typeof options === "number"
        ? second ?? 0
        : (options.top ?? 0);
    y = top;
    scrolls.push({ top, behavior: typeof options === "object" ? options.behavior : undefined });
  }) as typeof window.scrollTo;
  for (const element of [document.documentElement, document.body]) {
    Object.defineProperty(element, "scrollHeight", {
      value: element === document.documentElement ? (init.scrollHeight ?? 0) : 0,
      configurable: true
    });
  }
}

interface LocatorOptions {
  /** locator.has 的返回值（§8.4 判据）。 */
  present?: boolean;
  /** locator.navigateTo 的返回值：false 表示标题已不在 DOM。 */
  found?: boolean;
  /** 定位层炸掉（§12 要求降级而不是外溢）。 */
  throws?: boolean;
}

function locatorOf(options: LocatorOptions = {}): HeadingLocator {
  const { present = true, found = true, throws = false } = options;
  const navigateTo = vi.fn((id: string) => {
    if (throws) {
      throw new Error(`locator exploded on ${id}`);
    }
    return found;
  });
  return {
    navigateTo,
    has: vi.fn(() => present)
  } as unknown as HeadingLocator;
}

function stateOf(activeHeadingId: string | null, scrollTop: number): ReadingState {
  return { activeHeadingId, scrollTop };
}

beforeEach(() => {
  stubWindow({});
});

afterEach(() => {
  document.body.replaceChildren();
});

describe("§8.2 六步", () => {
  test("第 3～4 步：标题仍在 → 定位标题，用即时滚动且不动 scrollTop 回退", () => {
    const locator = locatorOf({});
    applyRestoredState(stateOf("architecture", 4_321), locator);
    expect(locator.navigateTo).toHaveBeenCalledWith("architecture", {
      behavior: "auto",
      block: "start"
    });
    expect(scrolls).toHaveLength(0);
  });

  test("第 5 步：标题已不在（定位返回 false）→ 回退到上次滚动位置", () => {
    const locator = locatorOf({ found: false });
    applyRestoredState(stateOf("gone", 1_200), locator);
    expect(scrolls).toEqual([{ top: 1_200, behavior: "auto" }]);
  });

  test("第 5 步：没有标题记录时同样直接用 scrollTop", () => {
    const locator = locatorOf({});
    applyRestoredState(stateOf(null, 900), locator);
    expect(locator.navigateTo).not.toHaveBeenCalled();
    expect(scrolls).toEqual([{ top: 900, behavior: "auto" }]);
  });

  test("第 6 步：两者都不可用 → 文档顶部", () => {
    const locator = locatorOf({ found: false });
    applyRestoredState(stateOf("gone", 0), locator);
    expect(scrolls).toEqual([{ top: 0, behavior: "auto" }]);
    scrolls = [];
    applyRestoredState(stateOf(null, 0), locator);
    expect(scrolls).toEqual([{ top: 0, behavior: "auto" }]);
  });

  test("非法 scrollTop（NaN / 负数）不会把页面滚坏，一律回顶部", () => {
    const locator = locatorOf({});
    for (const value of [Number.NaN, -40, Number.POSITIVE_INFINITY]) {
      scrolls = [];
      applyRestoredState(stateOf(null, value), locator);
      expect(scrolls).toEqual([{ top: 0, behavior: "auto" }]);
    }
  });

  test("§12：定位器抛错降级成 scrollTop，不冒泡出去", () => {
    const locator = locatorOf({ throws: true });
    expect(() => {
      applyRestoredState(stateOf("architecture", 777), locator);
    }).not.toThrow();
    expect(scrolls).toEqual([{ top: 777, behavior: "auto" }]);
  });

  test("防抖窗口按 §8.3 注记取 800ms", () => {
    expect(STATE_SAVE_DEBOUNCE_MS).toBe(800);
  });
});

describe("§8.4 文档变化", () => {
  test("第 1 条：原标题还在 → 完全不滚动", () => {
    stubWindow({ scrollY: 1_000, scrollHeight: 6_000 });
    const locator = locatorOf({ present: true });
    recoverAfterDocumentChange("architecture", locator);
    expect(locator.has).toHaveBeenCalledWith("architecture");
    expect(scrolls).toHaveLength(0);
  });

  test("第 2 条：标题被删且超出新内容高度 → 钳制到新底部", () => {
    stubWindow({ scrollY: 5_000, innerHeight: 800, scrollHeight: 3_000 });
    const locator = locatorOf({ present: false });
    recoverAfterDocumentChange("gone", locator);
    expect(scrolls).toEqual([{ top: 2_200, behavior: "auto" }]);
  });

  test("第 4 条：标题被删但位置仍在新内容内 → 守住滚动位置，不跳回旧标题", () => {
    stubWindow({ scrollY: 1_000, innerHeight: 800, scrollHeight: 12_000 });
    const locator = locatorOf({ present: false });
    recoverAfterDocumentChange("gone", locator);
    expect(locator.navigateTo).not.toHaveBeenCalled();
    expect(scrolls).toHaveLength(0);
  });

  test("没有历史记录的活动标题时只做钳制，不做定位", () => {
    stubWindow({ scrollY: 4_000, innerHeight: 800, scrollHeight: 2_000 });
    const locator = locatorOf({});
    recoverAfterDocumentChange(null, locator);
    expect(locator.has).not.toHaveBeenCalled();
    expect(scrolls).toEqual([{ top: 1_200, behavior: "auto" }]);
  });

  test("内容尚未测量（scrollHeight 为 0）时不动滚动，避免把位置抹成顶部", () => {
    stubWindow({ scrollY: 2_000, scrollHeight: 0 });
    const locator = locatorOf({ present: false });
    recoverAfterDocumentChange("gone", locator);
    expect(scrolls).toHaveLength(0);
  });

  test("新内容极短也不会算出负的上限", () => {
    stubWindow({ scrollY: 500, innerHeight: 800, scrollHeight: 300 });
    const locator = locatorOf({ present: false });
    recoverAfterDocumentChange("gone", locator);
    expect(scrolls).toEqual([{ top: 0, behavior: "auto" }]);
  });
});
