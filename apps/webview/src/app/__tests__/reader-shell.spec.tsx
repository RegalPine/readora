/**
 * Reader Shell 与工具栏测试（ARC-005 §5.1~§5.3、PRD-002 §4.3 / §11.2，STORY-09-01）。
 *
 * 三件事必须钉住：目录或专注模式退成单栏、窄窗口自动收栏但不改写用户偏好、
 * 专注模式下工具栏只留退出入口。右栏本批不输出 DOM，也顺手断言。
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import type { ZoomApi } from "../zoom";
import { ReaderShell, COMPACT_LAYOUT_QUERY, TOPBAR_REVEAL_ATTR, TOPBAR_REVEAL_HOVER } from "../ReaderShell";
import { TopBar, TOOLBAR_CLASS } from "../TopBar";

type MediaListener = (list: { matches: boolean }) => void;

const listeners = new Set<MediaListener>();
let matches = false;

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

function shell(outlineVisible = true, focusMode = false) {
  return render(
    <ReaderShell
      outlineVisible={outlineVisible}
      focusMode={focusMode}
      outline={<nav data-testid="outline">Outline</nav>}
      toolbar={<div data-testid="toolbar">Toolbar</div>}
      statusbar={<div data-testid="statusbar">Status</div>}
    >
      <main data-testid="canvas">Canvas</main>
    </ReaderShell>
  );
}

function columns(container: HTMLElement): string {
  return container.querySelector<HTMLElement>(".readora-shell")?.getAttribute("data-readora-columns") ?? "";
}

beforeEach(() => {
  stubMatchMedia(false);
});

afterEach(() => {
  cleanup();
  listeners.clear();
  Reflect.deleteProperty(window, "matchMedia");
});

describe("ReaderShell 布局", () => {
  test("目录可见时两列，隐藏时单列且不输出左栏 DOM", () => {
    const wide = shell(true, false);
    expect(columns(wide.container)).toBe("two");
    expect(wide.container.querySelectorAll(".readora-shell-nav")).toHaveLength(1);
    wide.unmount();

    const narrow = shell(false, false);
    expect(columns(narrow.container)).toBe("one");
    expect(narrow.container.querySelector(".readora-shell-nav")).toBeNull();
  });

  test("专注模式收左栏（ARC-005 §5.3 与 PRD-002 §11.2 同源）", () => {
    const view = shell(true, true);
    expect(columns(view.container)).toBe("one");
    expect(view.container.querySelector(".readora-shell-nav")).toBeNull();
    expect(
      view.container.querySelector<HTMLElement>(".readora-shell")?.getAttribute("data-readora-focus-mode")
    ).toBe("true");
  });

  test("窄窗口自动收起左栏，拉宽后自己回来（§5.3 自适应）", () => {
    const view = shell(true, false);
    expect(COMPACT_LAYOUT_QUERY).toBe("(max-width: 900px)");
    setMatches(true);
    expect(columns(view.container)).toBe("one");
    expect(
      view.container.querySelector<HTMLElement>(".readora-shell")?.getAttribute("data-readora-compact")
    ).toBe("true");
    setMatches(false);
    expect(columns(view.container)).toBe("two");
  });

  test("窄窗口只影响渲染，不改写用户的目录显隐状态", () => {
    const view = shell(true, false);
    setMatches(true);
    expect(view.queryByTestId("outline")).toBeNull();
    setMatches(false);
    expect(view.queryByTestId("outline")).not.toBeNull();
  });

  test("右栏槽位本批不输出 DOM（不得伪装已完成）", () => {
    const view = shell(true, false);
    expect(view.container.querySelectorAll(".readora-shell-aside-right")).toHaveLength(0);
    expect(view.container.querySelectorAll('[aria-label="Document properties"]')).toHaveLength(0);
  });

  test("没有 matchMedia 的环境按宽窗口渲染，不因探测失败收栏", () => {
    Reflect.deleteProperty(window, "matchMedia");
    const view = shell(true, false);
    expect(columns(view.container)).toBe("two");
  });

  test("四段栅格齐备且各有 data-readora-band（PRD-003 §10.5）", () => {
    const view = shell(true, false);
    const bands = [...view.container.querySelectorAll<HTMLElement>("[data-readora-band]")].map(
      (band) => band.getAttribute("data-readora-band")
    );
    // 顺序即视觉顺序；四段都挂 data-readora-band，基线与 e2e 按它取 rect。
    expect(bands).toEqual(["topbar", "body", "statusbar"]);
    expect(view.container.querySelector(".readora-body .readora-shell-nav")).not.toBeNull();
    expect(view.container.querySelector(".readora-body .readora-shell-main")).not.toBeNull();
  });

  test("专注模式给顶栏段挂上浮层门控，常规档不挂（退出入口默认淡出）", () => {
    // jsdom 不算 CSS，这里只能钉住属性这一半；opacity 真的变了归 e2e 证。
    // 门控挂在段而不是工具栏：浮现靠段的 :hover，工具栏只占带内一行。
    const focused = shell(true, true);
    expect(
      focused.container.querySelector<HTMLElement>(".readora-topbar")?.getAttribute(TOPBAR_REVEAL_ATTR)
    ).toBe(TOPBAR_REVEAL_HOVER);
    focused.unmount();

    const plain = shell(true, false);
    expect(
      plain.container.querySelector<HTMLElement>(".readora-topbar")?.hasAttribute(TOPBAR_REVEAL_ATTR)
    ).toBe(false);
  });

  test("搜索段只在面板打开时输出 DOM，不留一条空 band", () => {
    const without = shell(true, false);
    expect(without.container.querySelector(".readora-searchbar")).toBeNull();
    without.unmount();

    const withSearch = render(
      <ReaderShell
        outlineVisible
        focusMode={false}
        outline={<nav data-testid="outline">Outline</nav>}
        toolbar={<div data-testid="toolbar">Toolbar</div>}
        searchbar={<div data-testid="searchbar">Search</div>}
        statusbar={<div data-testid="statusbar">Status</div>}
      >
        <main data-testid="canvas">Canvas</main>
      </ReaderShell>
    );
    const bands = [...withSearch.container.querySelectorAll<HTMLElement>("[data-readora-band]")].map(
      (band) => band.getAttribute("data-readora-band")
    );
    expect(bands).toEqual(["topbar", "searchbar", "body", "statusbar"]);
    // 搜索段排在主体之前、顶栏之后，「随内容」而不是浮在正文上。
    expect(withSearch.container.querySelector(".readora-searchbar")?.nextElementSibling?.className).toBe(
      "readora-body"
    );
  });
});

describe("TopBar 工具栏", () => {
  const handlers = () => ({
    onToggleOutline: vi.fn(),
    onToggleFocusMode: vi.fn(),
    onToggleSearch: vi.fn(),
    onToggleSettings: vi.fn(),
    onToggleExport: vi.fn(),
    onCloseExport: vi.fn(),
    onExport: vi.fn()
  });

  /** 缩放组只当外壳看：状态由 `useZoom` 管，本文件另有 `zoom.spec.ts` 覆盖纯函数。 */
  function fakeZoom(overrides: Partial<ZoomApi> = {}): ZoomApi {
    return {
      zoom: 1,
      display: "100%",
      canZoomIn: true,
      canZoomOut: true,
      zoomIn: vi.fn(),
      zoomOut: vi.fn(),
      reset: vi.fn(),
      ...overrides
    };
  }

  function bar(
    focusMode = false,
    outlineVisible = true,
    searchOpen = false,
    options: {
      settingsOpen?: boolean;
      exportOpen?: boolean;
      documentUri?: string;
      zoom?: ZoomApi;
    } = {}
  ) {
    const next = handlers();
    const view = render(
      <TopBar
        outlineVisible={outlineVisible}
        focusMode={focusMode}
        searchOpen={searchOpen}
        settingsOpen={options.settingsOpen ?? false}
        exportOpen={options.exportOpen ?? false}
        documentUri={options.documentUri}
        zoom={options.zoom ?? fakeZoom()}
        {...next}
      />
    );
    return { view, next };
  }

  function pressed(container: HTMLElement, label: string): string | null {
    return (
      container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)?.getAttribute(
        "aria-pressed"
      ) ?? null
    );
  }

  /** 顶栏动作按钮：三枚常驻切换 + Export 触发器 + Reader Settings 触发器，顺序即视觉顺序。 */
  function actions(container: HTMLElement): string[] {
    return [...container.querySelectorAll<HTMLElement>(".readora-toolbar-button")].map(
      (button) => button.getAttribute("aria-label") ?? ""
    );
  }

  test("常驻按钮按 §10.5 的清单齐备，各自用 aria-pressed 表达状态（PRD-002 §4.3）", () => {
    const { view } = bar();
    expect(actions(view.container)).toEqual([
      "Toggle outline",
      "Enter focus mode",
      "Search in document",
      "Export document",
      "Reader settings"
    ]);
    expect(pressed(view.container, "Toggle outline")).toBe("true");
    expect(pressed(view.container, "Enter focus mode")).toBe("false");
    expect(pressed(view.container, "Search in document")).toBe("false");
  });

  test("Settings 触发器是弹层入口而非开关：aria-haspopup + aria-expanded", () => {
    const closed = bar();
    const trigger = closed.view.getByRole("button", { name: "Reader settings" });
    expect(trigger.getAttribute("aria-haspopup")).toBe("dialog");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(trigger.hasAttribute("aria-pressed")).toBe(false);
    closed.view.unmount();

    const open = bar(false, true, false, { settingsOpen: true });
    expect(
      open.view.getByRole("button", { name: "Reader settings" }).getAttribute("aria-expanded")
    ).toBe("true");
  });

  test("搜索面板打开时 Search 按钮按下（状态可见性）", () => {
    const { view } = bar(false, true, true);
    expect(pressed(view.container, "Search in document")).toBe("true");
  });

  test("点击分别落到五个动作上", () => {
    const { view, next } = bar();
    fireEvent.click(view.getByRole("button", { name: "Toggle outline" }));
    fireEvent.click(view.getByRole("button", { name: "Enter focus mode" }));
    fireEvent.click(view.getByRole("button", { name: "Search in document" }));
    fireEvent.click(view.getByRole("button", { name: "Export document" }));
    fireEvent.click(view.getByRole("button", { name: "Reader settings" }));
    expect(next.onToggleOutline).toHaveBeenCalledTimes(1);
    expect(next.onToggleFocusMode).toHaveBeenCalledTimes(1);
    expect(next.onToggleSearch).toHaveBeenCalledTimes(1);
    expect(next.onToggleExport).toHaveBeenCalledTimes(1);
    expect(next.onToggleSettings).toHaveBeenCalledTimes(1);
  });

  test("Export 触发器与 Settings 同形：弹层入口而非开关（M11）", () => {
    const closed = bar();
    const trigger = closed.view.getByRole("button", { name: "Export document" });
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(trigger.getAttribute("data-readora-export-menu")).toBe("true");
    expect(trigger.hasAttribute("aria-pressed")).toBe(false);
    closed.view.unmount();

    const open = bar(false, true, false, { exportOpen: true });
    expect(
      open.view.getByRole("button", { name: "Export document" }).getAttribute("aria-expanded")
    ).toBe("true");
    // 菜单只在顶栏打开时存在，三项按锁定口径排序。
    expect(
      [...open.view.container.querySelectorAll<HTMLButtonElement>("[role='menuitem']")].map(
        (item) => item.textContent
      )
    ).toEqual(["Export as HTML", "Export as PDF", "Export as PNG"]);
  });

  test("专注模式下只留退出入口，其它按钮不出现（§11.2）", () => {
    const { view, next } = bar(true, true, false, { exportOpen: true });
    const buttons = view.container.querySelectorAll<HTMLButtonElement>("button");
    expect(buttons).toHaveLength(1);
    expect(view.container.querySelector("[role='menuitem']")).toBeNull();
    expect(buttons[0]?.textContent).toBe("Exit focus mode");
    fireEvent.click(buttons[0] as HTMLButtonElement);
    expect(next.onToggleFocusMode).toHaveBeenCalledTimes(1);
    expect(next.onToggleOutline).not.toHaveBeenCalled();
    expect(view.container.querySelector(`.${TOOLBAR_CLASS}--focus`)).not.toBeNull();
  });

  test("工具栏是 role=toolbar 且有可读名称", () => {
    const { view } = bar();
    const toolbar = view.container.querySelector<HTMLElement>(`.${TOOLBAR_CLASS}`);
    expect(toolbar?.getAttribute("role")).toBe("toolbar");
    expect(toolbar?.getAttribute("aria-label")).toBe("Reading controls");
  });
});
