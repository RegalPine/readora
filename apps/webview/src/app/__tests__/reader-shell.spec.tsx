/**
 * Reader Shell 与工具栏测试（ARC-005 §5.1~§5.3、PRD-002 §4.3 / §11.2，STORY-09-01）。
 *
 * 三件事必须钉住：目录或专注模式退成单栏、窄窗口自动收栏但不改写用户偏好、
 * 专注模式下顶栏整段不输出（退出入口住在快速条，归 status-quick-bars.spec）。右栏本批不输出 DOM，也顺手断言。
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import type { ZoomApi } from "../zoom";
import { ReaderShell, COMPACT_LAYOUT_QUERY } from "../ReaderShell";
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

  test("主体栅格齐备且各有 data-readora-band（大纲通顶、顶栏在右列，PRD-003 §10.5）", () => {
    const view = shell(true, false);
    const bands = [...view.container.querySelectorAll<HTMLElement>("[data-readora-band]")].map(
      (band) => band.getAttribute("data-readora-band")
    );
    // 文档顺序 = 视觉顺序：body 是父（含左列大纲 + 右列内容），topbar 在右列里，
    // statusbar 横贯整窗在最后。基线与 e2e 按 band 取 rect。
    expect(bands).toEqual(["body", "topbar", "statusbar"]);
    // 大纲与顶栏都在 body 之下：左列 aside、右列 shell-main 里嵌 topbar。
    expect(view.container.querySelector(".readora-body .readora-shell-nav")).not.toBeNull();
    expect(view.container.querySelector(".readora-body .readora-shell-main")).not.toBeNull();
    expect(
      view.container.querySelector(".readora-shell-main [data-readora-band='topbar']")
    ).not.toBeNull();
  });

  test("专注模式整段不输出顶栏，常规档输出（隐藏了就不许留透明占位）", () => {
    // jsdom 不算 CSS，这里只能钉住 DOM 这一半；快速条贴顶与退出入口浮现归 e2e 证。
    // 旧版是「输出顶栏段 + 挂浮层门控」，结果 4px 触发沿命中不到、44px 空带还在，
    // 所以下面断言的正是那两条不能回来：段不在 DOM，连它的内容也不在。
    const focused = shell(true, true);
    expect(focused.container.querySelector(".readora-topbar")).toBeNull();
    expect(focused.container.querySelector('[data-readora-band="topbar"]')).toBeNull();
    expect(focused.queryByTestId("toolbar")).toBeNull();
    // 外壳仍要留下专注档自己的门控属性，CSS 靠它把快速条按到 0。
    expect(
      focused.container.querySelector<HTMLElement>(".readora-shell")?.getAttribute(
        "data-readora-focus-mode"
      )
    ).toBe("true");
    focused.unmount();

    const plain = shell(true, false);
    expect(
      plain.container.querySelector('[data-readora-band="topbar"]')?.textContent
    ).toBe("Toolbar");
    expect(
      plain.container.querySelector<HTMLElement>(".readora-shell")?.hasAttribute(
        "data-readora-focus-mode"
      )
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
    // body 是父，topbar/searchbar 都在它的右列里，statusbar 横贯整窗在最后。
    expect(bands).toEqual(["body", "topbar", "searchbar", "statusbar"]);
    // 搜索段排在顶栏之后、正文之前，同在右列：「随内容」而不是浮在正文上。
    expect(
      withSearch.container.querySelector(".readora-searchbar")?.previousElementSibling?.getAttribute(
        "data-readora-band"
      )
    ).toBe("topbar");
    expect(
      withSearch.container.querySelector(".readora-searchbar")?.nextElementSibling?.getAttribute(
        "data-testid"
      )
    ).toBe("canvas");
  });
});

describe("TopBar 工具栏", () => {
  const handlers = () => ({
    onToggleOutline: vi.fn(),
    onToggleFocusMode: vi.fn(),
    onToggleEditMode: vi.fn(),
    onToggleEditHelp: vi.fn(),
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
    outlineVisible = true,
    searchOpen = false,
    options: {
      settingsOpen?: boolean;
      exportOpen?: boolean;
      zoom?: ZoomApi;
    } = {}
  ) {
    const next = handlers();
    const view = render(
      <TopBar
        outlineVisible={outlineVisible}
        searchOpen={searchOpen}
        settingsOpen={options.settingsOpen ?? false}
        exportOpen={options.exportOpen ?? false}
        editMode={false}
        editAvailable
        editHelpOpen={false}
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

  /** 顶栏动作按钮：四枚常驻切换 + Export 触发器 + Reader Settings 触发器，顺序即视觉顺序。 */
  function actions(container: HTMLElement): string[] {
    return [...container.querySelectorAll<HTMLElement>(".readora-toolbar-button")].map(
      (button) => button.getAttribute("aria-label") ?? ""
    );
  }

  test("常驻按钮按 §10.5 的清单齐备，各自用 aria-pressed 表达状态（PRD-002 §4.3）", () => {
    const { view } = bar();
    expect(actions(view.container)).toEqual([
      "Toggle outline",
      "Edit mode",
      "Enter focus mode",
      "Search in document",
      "Export document",
      "Reader settings"
    ]);
    expect(pressed(view.container, "Toggle outline")).toBe("true");
    expect(pressed(view.container, "Enter focus mode")).toBe("false");
    expect(pressed(view.container, "Search in document")).toBe("false");
  });

  test("大纲开合靠左、不在靠右动作组里（与通顶大纲列同侧）", () => {
    const { view } = bar();
    const outline = view.container.querySelector('[aria-label="Toggle outline"]');
    expect(outline).not.toBeNull();
    // 动作组靠 `margin-left: auto` 顶到右侧；大纲按钮被挪到它前面，不共享这段。
    expect(outline?.closest(".readora-toolbar-actions")).toBeNull();
  });

  test("Settings 触发器是弹层入口而非开关：aria-haspopup + aria-expanded", () => {
    const closed = bar();
    const trigger = closed.view.getByRole("button", { name: "Reader settings" });
    expect(trigger.getAttribute("aria-haspopup")).toBe("dialog");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(trigger.hasAttribute("aria-pressed")).toBe(false);
    closed.view.unmount();

    const open = bar(true, false, { settingsOpen: true });
    expect(
      open.view.getByRole("button", { name: "Reader settings" }).getAttribute("aria-expanded")
    ).toBe("true");
  });

  test("搜索面板打开时 Search 按钮按下（状态可见性）", () => {
    const { view } = bar(true, true);
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

    const open = bar(true, false, { exportOpen: true });
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

  test("顶栏不再有专注分支：动作清单与模式无关（§11.2 的收法改到段一级）", () => {
    // 旧版在这里早退成「只剩退出入口一枚按钮」，但那枚按钮住在 4px 触发沿里，
    // 实际上选不到。现在专注档的收法由 `ReaderShell` 不渲染顶栏段完成，顶栏自己
    // 回到单一形态；退出入口归快速条（status-quick-bars.spec）。
    const { view } = bar(true, false, { exportOpen: true });
    expect(actions(view.container)).toEqual([
      "Toggle outline",
      "Edit mode",
      "Enter focus mode",
      "Search in document",
      "Export document",
      "Reader settings"
    ]);
    expect(view.container.querySelector(`.${TOOLBAR_CLASS}--focus`)).toBeNull();
    expect(view.container.querySelector('[aria-label="Exit focus mode"]')).toBeNull();
  });

  test("工具栏是 role=toolbar 且有可读名称", () => {
    const { view } = bar();
    const toolbar = view.container.querySelector<HTMLElement>(`.${TOOLBAR_CLASS}`);
    expect(toolbar?.getAttribute("role")).toBe("toolbar");
    expect(toolbar?.getAttribute("aria-label")).toBe("Reading controls");
  });
});
