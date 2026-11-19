/**
 * 状态条与浮动快速条（PRD-003 §4.6 的诚实字段清单、§10.5 外壳第四段与快速条）。
 *
 * 状态条最容易犯的不是少字段而是**造字段**：原型图里有 `Ln 142, Col 18` 与
 * `UTF-8`，Webview 拿不到光标位置与文件编码。所以除了「三项齐全」，
 * 这里还要反向断言「不含编造字段」与「已下线的节数、文档版本不回头」。
 * 迁入右端 pill 组后，多一项的怀疑对象多了 pill 一格 —— 它带自己的
 * `data-readora-pill`，不占状态字段的位子。
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ComponentProps } from "react";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { QuickBar, activeHeadingTitleOf } from "../QuickBar";
import {
  StatusBar,
  PILL_CLASS,
  STATUS_CLASS,
  STATUS_ITEM_CLASS,
  STATUS_PILLS_CLASS
} from "../StatusBar";
import { COMPACT_LAYOUT_QUERY } from "../ReaderShell";
import type { TextMetrics } from "../text-metrics";
import { readingMinutesOf } from "../text-metrics";

type MediaListener = (list: { matches: boolean }) => void;

let matches = false;
const listeners = new Set<MediaListener>();

/** 快速条的「展开大纲」在窄窗口要禁用，得能拨动 matchMedia 的返回值。 */
function stubMatchMedia(initial: boolean): void {
  matches = initial;
  listeners.clear();
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string) => ({
      media: query,
      get matches(): boolean {
        return matches;
      },
      onchange: null,
      addEventListener: (_type: string, listener: MediaListener) => {
        listeners.add(listener);
      },
      removeEventListener: (_type: string, listener: MediaListener) => {
        listeners.delete(listener);
      },
      dispatchEvent: () => true
    })
  });
}

function setMatches(next: boolean): void {
  matches = next;
  act(() => {
    for (const listener of [...listeners]) {
      listener({ matches: next });
    }
  });
}

afterEach(() => {
  cleanup();
  listeners.clear();
  Reflect.deleteProperty(window, "matchMedia");
});

/**
 * pill 的文案只由 `text-metrics` 定义，用例不自己拼 `"N min read"` 字符串；
 * 这里按单元数走同一个 `readingMinutesOf`，改口径时用例跟着改而不是先红。
 */
function metricsFor(units: number): TextMetrics {
  return { units, minutes: readingMinutesOf(units), empty: units === 0 };
}

function status(overrides: Partial<ComponentProps<typeof StatusBar>> = {}) {
  return render(
    <StatusBar
      wordCount={1_234}
      metrics={metricsFor(1_234)}
      focusMode={false}
      zoom={1.1}
      theme="dark"
      {...overrides}
    />
  );
}

describe("StatusBar", () => {
  test("三项齐备，顺序稳定，各自带可定位的 data-readora-status", () => {
    const view = status();
    const items = [...view.container.querySelectorAll<HTMLElement>(`.${STATUS_ITEM_CLASS}`)];
    expect(items.map((item) => item.getAttribute("data-readora-status"))).toEqual([
      "words",
      "zoom",
      "theme"
    ]);
    expect(items.map((item) => item.textContent)).toEqual([
      "1,234 words",
      "zoom 110%",
      "theme dark"
    ]);
  });

  test("不含编造字段：光标位置、编码、可点面包屑、Bridge 都不在这条上（§4.6）", () => {
    const view = status();
    const text = view.container.textContent ?? "";
    expect(text).not.toMatch(/Ln\s*\d|Col\s*\d/iu);
    expect(text).not.toContain("UTF-8");
    // Bridge 字段已删：状态条随外壳一起等第一份快照，出现即已连接，
    // 恒为 Connected 的字段等于没有字段（§4.6 诚实性）。
    expect(text).not.toContain("Bridge");
    // 节数字段已删（产品反馈：目录那一栏直接数得出来，底部再说一遍是重复）。
    expect(text).not.toMatch(/\bsections?\b/iu);
    expect(view.container.querySelectorAll("a, button")).toHaveLength(0);
    expect(view.container.querySelector('[data-readora-status="version"]')).toBeNull();
    expect(text).not.toMatch(/\bv\d+\b/u);
    expect(view.container.querySelectorAll("[data-readora-status]")).toHaveLength(3);
  });

  test("0 字照样如实显示，不写成「—」也不省略字段", () => {
    const view = status({ wordCount: 0, metrics: metricsFor(0) });
    const texts = [...view.container.querySelectorAll<HTMLElement>(`.${STATUS_ITEM_CLASS}`)].map(
      (item) => item.textContent
    );
    expect(texts[0]).toBe("0 words");
  });

  test("地标是 contentinfo 且有可读名称", () => {
    const view = status();
    const root = view.container.querySelector<HTMLElement>(`.${STATUS_CLASS}`);
    expect(root?.getAttribute("role")).toBe("contentinfo");
    expect(root?.getAttribute("aria-label")).toBe("Document status");
  });

  // pill 从顶栏迁到状态条右端（产品反馈）：迁位不迁语义，定位仍靠 data-readora-pill。
  test("右端 pill 组有阅读时长与模式标签，顺序稳定且都是 span", () => {
    const view = status();
    const group = view.container.querySelector<HTMLElement>(`.${STATUS_PILLS_CLASS}`);
    if (!group) {
      throw new Error("status bar must render the pill group");
    }
    const pills = [...group.querySelectorAll<HTMLElement>("[data-readora-pill]")];
    expect(pills.map((pill) => pill.getAttribute("data-readora-pill"))).toEqual([
      "reading-time",
      "mode"
    ]);
    expect(pills.map((pill) => pill.textContent)).toEqual(["5 min read", "Reading"]);
    expect(pills.every((pill) => pill.classList.contains(PILL_CLASS))).toBe(true);
    expect(group.querySelectorAll("a, button")).toHaveLength(0);
  });

  test("模式标签跟着真的专注态走，不是永远写 Reading", () => {
    const focused = status({ focusMode: true });
    const mode = focused.container.querySelector<HTMLElement>('[data-readora-pill="mode"]');
    expect(mode?.textContent).toBe("Focus");
    expect(mode?.getAttribute("data-readora-mode")).toBe("focus");
    expect(status().container.querySelector('[data-readora-mode="focus"]')).toBeNull();
  });

  test("空文档不出时长 pill，但字数那一项照实留着（§5.6）", () => {
    const view = status({ metrics: metricsFor(0), wordCount: 0 });
    expect(view.container.querySelector('[data-readora-pill="reading-time"]')).toBeNull();
    expect(view.container.querySelectorAll(`[data-readora-pill="mode"]`)).toHaveLength(1);
    const words = view.container.querySelector<HTMLElement>(`[data-readora-status="words"]`);
    expect(words?.textContent).toBe("0 words");
  });
});

describe("activeHeadingTitleOf", () => {
  const outline = [
    { anchor: "overview", title: "Overview" },
    { anchor: "architecture", title: "架构" }
  ];

  test("按 anchor 回查标题文本", () => {
    expect(activeHeadingTitleOf(outline, "architecture")).toBe("架构");
  });

  test("锚点找不到就返回 null：不把上一个标题挂在新位置上", () => {
    expect(activeHeadingTitleOf(outline, "deleted-heading")).toBeNull();
    expect(activeHeadingTitleOf(outline, null)).toBeNull();
    expect(activeHeadingTitleOf([], "overview")).toBeNull();
  });
});

function quickBar(overrides: {
  activeHeadingTitle?: string | null;
  progress?: number;
  focusMode?: boolean;
  outlineExpanded?: boolean;
} = {}) {
  const handlers = { onToggleOutline: vi.fn(), onToggleFocusMode: vi.fn() };
  const view = render(
    <QuickBar
      activeHeadingTitle={overrides.activeHeadingTitle ?? null}
      progress={overrides.progress ?? 0}
      focusMode={overrides.focusMode ?? false}
      outlineExpanded={overrides.outlineExpanded ?? false}
      {...handlers}
    />
  );
  return { view, handlers };
}

describe("QuickBar", () => {
  test("活动标题 + 进度百分比两项都在，「回到顶部」已下掉", () => {
    stubMatchMedia(false);
    const { view } = quickBar({ activeHeadingTitle: "架构", progress: 0.42 });
    expect(view.container.querySelector('[data-readora-quickbar="heading"]')?.textContent).toBe(
      "架构"
    );
    expect(view.container.querySelector('[data-readora-quickbar="progress"]')?.textContent).toBe(
      "42%"
    );
    expect(view.container.innerHTML).not.toMatch(/back to top/iu);
    expect(view.container.querySelectorAll("button")).toHaveLength(0);
  });

  test("没有活动标题时槽位留空，不写「未知章节」这种占位文案", () => {
    stubMatchMedia(false);
    const { view } = quickBar({ activeHeadingTitle: null });
    expect(view.container.querySelector('[data-readora-quickbar="heading"]')?.textContent).toBe("");
    expect(view.container.textContent).not.toMatch(/unknown|暂无/iu);
  });

  test("专注模式才有「展开大纲」，常规模式下不出现", () => {
    stubMatchMedia(false);
    const plain = quickBar({ focusMode: false });
    expect(plain.view.container.querySelector('[aria-label="Expand outline"]')).toBeNull();
    const focused = quickBar({ focusMode: true });
    const button = focused.view.container.querySelector<HTMLButtonElement>(
      '[aria-label="Expand outline"]'
    );
    if (!button) {
      throw new Error("focus mode must render the outline toggle");
    }
    fireEvent.click(button);
    expect(focused.handlers.onToggleOutline).toHaveBeenCalledTimes(1);
  });

  test("退出入口带图标并排在进度前，常规档不出现", () => {
    stubMatchMedia(false);
    // 顶栏段在专注档整块不渲染；退出入口位于进度前并带专注模式图标。
    const plain = quickBar({ focusMode: false });
    expect(plain.view.container.querySelector('[aria-label="Exit focus mode"]')).toBeNull();

    const focused = quickBar({ focusMode: true });
    const buttons = [...focused.view.container.querySelectorAll<HTMLButtonElement>("button")];
    expect(buttons.map((button) => button.getAttribute("aria-label"))).toEqual([
      "Exit focus mode",
      "Expand outline"
    ]);
    const exit = buttons[0] as HTMLButtonElement;
    expect(exit.compareDocumentPosition(
      focused.view.container.querySelector('[data-readora-quickbar="progress"]') as Node
    ) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(exit.className).toContain("readora-quickbar-exit");
    expect(exit.querySelector("svg.readora-icon")).not.toBeNull();
    expect(exit.getAttribute("data-readora-quickbar")).toBe("exit");
    expect(exit.getAttribute("title")).toBe("Exit full screen reading mode");
    expect(exit.disabled).toBe(false);
    fireEvent.click(exit);
    expect(focused.handlers.onToggleFocusMode).toHaveBeenCalledTimes(1);
    expect(focused.handlers.onToggleOutline).not.toHaveBeenCalled();
  });

  test("aria-pressed 说的是「大纲此刻真的展开了没有」", () => {
    stubMatchMedia(false);
    // 同一条用例挂两次：走 container，role 查询的默认底是 document.body。
    const pressed = (outlineExpanded: boolean): string | null =>
      quickBar({ focusMode: true, outlineExpanded }).view.container
        .querySelector<HTMLButtonElement>('[aria-label="Expand outline"]')
        ?.getAttribute("aria-pressed") ?? null;
    expect(pressed(true)).toBe("true");
    expect(pressed(false)).toBe("false");
  });

  test("窄窗口禁用展开而不是让它按下去没反应，拉宽后自己恢复", () => {
    stubMatchMedia(false);
    const { view } = quickBar({ focusMode: true });
    const button = view.getByRole("button", {
      name: "Expand outline"
    }) as HTMLButtonElement;
    expect(COMPACT_LAYOUT_QUERY).toBe("(max-width: 900px)");
    setMatches(true);
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("title")).toContain("窗口太窄");
    setMatches(false);
    expect(button.disabled).toBe(false);
  });
});
