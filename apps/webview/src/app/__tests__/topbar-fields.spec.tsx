/**
 * 顶栏控件的取证（PRD-003 §10.5、§4.6 的诚实性规则）。
 *
 * 顶栏只留动作控件，逐条都是「有真实数据源才渲染」：
 * - 缩放组：端点上禁用 − / +，点百分号复位（§10.5）。
 * - Edit 开关（E2 / UX-008）：与 Focus 同排且在它之前；不可写文档上禁用而非隐藏。
 *
 * 面包屑不在顶栏：readora 是自定义编辑器，宿主在编辑器上方给原生面包屑，
 * 顶栏自绘第二条就是冗余导航（「用 VS Code 的，不用自己实现」）。
 *
 * 时长 pill 与模式标签的取证在 `status-quick-bars.spec.tsx`：它们已按产品反馈
 * 从顶栏迁到状态条右端。
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import type { ZoomApi } from "../zoom";
import { ZOOM_MAX, ZOOM_MIN, ZOOM_RESET } from "../zoom";
import { TOOLBAR_CLASS, TopBar } from "../TopBar";

afterEach(cleanup);

function zoomApi(overrides: Partial<ZoomApi> = {}): ZoomApi {
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

function bar(overrides: {
  zoom?: ZoomApi;
  outlineVisible?: boolean;
  editMode?: boolean;
  editAvailable?: boolean;
} = {}) {
  const handlers = {
    onToggleOutline: vi.fn(),
    onToggleFocusMode: vi.fn(),
    onToggleEditMode: vi.fn(),
    onToggleSearch: vi.fn(),
    onToggleSettings: vi.fn(),
    onToggleExport: vi.fn(),
    onCloseExport: vi.fn(),
    onExport: vi.fn()
  };
  const view = render(
    <TopBar
      outlineVisible={overrides.outlineVisible ?? true}
      searchOpen={false}
      settingsOpen={false}
      exportOpen={false}
      editMode={overrides.editMode ?? false}
      editAvailable={overrides.editAvailable ?? true}
      zoom={overrides.zoom ?? zoomApi()}
      {...handlers}
    />
  );
  return { view, handlers };
}

describe("顶栏不再自绘面包屑（改用 VS Code 原生）", () => {
  test("顶栏不输出任何面包屑节点，也不接 documentUri", () => {
    const { view } = bar();
    expect(view.container.querySelector(".readora-breadcrumb")).toBeNull();
    expect(view.container.querySelector("[data-readora-breadcrumb]")).toBeNull();
    // 路径链与同级切换由宿主原生面包屑承担，顶栏不该有第二条。
    expect(view.container.querySelectorAll('[aria-label="Document path"]')).toHaveLength(0);
  });
});

describe("顶栏不再有 pill（已迁到状态条右端）", () => {
  test("顶栏不输出 pill，也不再有专注档的退出入口", () => {
    expect(bar().view.container.querySelector("[data-readora-pill]")).toBeNull();

    // 专注档不再走顶栏的分支（`TopBar` 已不接 `focusMode`）：那一段由 `ReaderShell`
    // 整块不渲染，退出入口住在快速条，所以顶栏只该有常规形态这一套控件。
    // 顶栏不供第二条退出入口，是“专注档只剩一枚退出按钮”这个旧口径能搬到
    // 快速条的前提（§11.2 收的是入口数，不是它住在哪一段）。
    const { view } = bar();
    expect(view.container.querySelectorAll("[data-readora-pill]")).toHaveLength(0);
    expect(view.container.querySelector('[aria-label="Exit focus mode"]')).toBeNull();
    expect(view.container.querySelector(`.${TOOLBAR_CLASS}--focus`)).toBeNull();
  });
});

describe("大纲双态图标", () => {
  test("显示与隐藏使用不同图形，保留按钮名称、状态和点击回调", () => {
    const shown = bar();
    const hide = shown.view.getByRole("button", { name: "Toggle outline" });
    expect(hide.textContent).toBe("");
    expect(hide.getAttribute("aria-pressed")).toBe("true");
    expect(hide.getAttribute("title")).toBe("Hide outline");
    expect(hide.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    const shownShape = hide.querySelector("svg")?.innerHTML;
    expect(shownShape).toBeTruthy();
    fireEvent.click(hide);
    expect(shown.handlers.onToggleOutline).toHaveBeenCalledTimes(1);
    shown.view.unmount();

    const hidden = bar({ outlineVisible: false });
    const show = hidden.view.getByRole("button", { name: "Toggle outline" });
    expect(show.textContent).toBe("");
    expect(show.getAttribute("aria-pressed")).toBe("false");
    expect(show.getAttribute("title")).toBe("Show outline");
    expect(show.querySelectorAll("svg")).toHaveLength(1);
    expect(show.querySelector("svg")?.innerHTML).not.toBe(shownShape);
    fireEvent.click(show);
    expect(hidden.handlers.onToggleOutline).toHaveBeenCalledTimes(1);
  });
});

describe("缩放组", () => {
  /**
   * 三枚按钮的禁用态，按 DOM 顺序取（− / 百分号 / +）。
   *
   * 走 container 而不是 `view.getByRole`：`render` 的默认 baseElement 是
   * `document.body`，同一条用例里挂两次顶栏就会让 role 查询撞车，而端点行为
   * 本来就要成对比较。
   */
  function zoomDisabledState(overrides: Partial<ZoomApi>): {
    out: boolean;
    value: boolean;
    in: boolean;
  } {
    const { view } = bar({ zoom: zoomApi(overrides) });
    const buttons = [
      ...view.container.querySelectorAll<HTMLButtonElement>('[role="group"][aria-label="Zoom"] button')
    ];
    return {
      out: Boolean(buttons[0]?.disabled),
      value: Boolean(buttons[1]?.disabled),
      in: Boolean(buttons[2]?.disabled)
    };
  }

  test("三枚连排：− / 百分号 / + ，显示当前倍率", () => {
    const { view } = bar({ zoom: zoomApi({ zoom: 1.3, display: "130%" }) });
    const group = view.container.querySelector<HTMLElement>('[role="group"][aria-label="Zoom"]');
    expect(group?.getAttribute("class")).toBe("readora-zoom");
    expect(
      [...(group?.querySelectorAll<HTMLButtonElement>("button") ?? [])].map((b) => b.getAttribute("aria-label"))
    ).toEqual(["Zoom out", "Reset zoom", "Zoom in"]);
    expect(group?.textContent).toContain("130%");
  });

  test("端点上禁用：200% 时 + 停用，50% 时 − 停用（区间夹住不外弹）", () => {
    expect(zoomDisabledState({ zoom: ZOOM_MAX, canZoomIn: false })).toEqual({
      out: false,
      value: false,
      in: true
    });
    expect(zoomDisabledState({ zoom: ZOOM_MIN, canZoomOut: false })).toEqual({
      out: true,
      value: false,
      in: false
    });
    // 复位按钮永远可点：停在 100% 时按它也无害，禁用反而让人找不到出口。
    expect(zoomDisabledState({ zoom: ZOOM_RESET })).toEqual({ out: false, value: false, in: false });
  });

  test("点击分别落到 zoomOut / reset / zoomIn 上", () => {
    const zoom = zoomApi();
    const { view } = bar({ zoom });
    fireEvent.click(view.getByRole("button", { name: "Zoom out" }));
    fireEvent.click(view.getByRole("button", { name: "Reset zoom" }));
    fireEvent.click(view.getByRole("button", { name: "Zoom in" }));
    expect(zoom.zoomOut).toHaveBeenCalledTimes(1);
    expect(zoom.reset).toHaveBeenCalledTimes(1);
    expect(zoom.zoomIn).toHaveBeenCalledTimes(1);
  });
});

describe("Edit 开关（ARC-009 §7.2 / PRD-002 UX-008，E2）", () => {
  function editButton(container: HTMLElement): HTMLButtonElement | null {
    return container.querySelector<HTMLButtonElement>('button[aria-label="Edit mode"]');
  }

  test("与 Focus 同排且排在它之前：两个互斥的模式开关相邻摆放", () => {
    const { view } = bar();
    const labels = [...view.container.querySelectorAll<HTMLButtonElement>(`.${TOOLBAR_CLASS}-actions button`)].map(
      (button) => button.getAttribute("aria-label")
    );
    expect(labels.slice(0, 3)).toEqual(["Edit mode", "Enter focus mode", "Search in document"]);
  });

  test("aria-pressed 跟开关走", () => {
    expect(editButton(bar().view.container)?.getAttribute("aria-pressed")).toBe("false");
    expect(
      editButton(bar({ editMode: true }).view.container)?.getAttribute("aria-pressed")
    ).toBe("true");
  });

  test("不可写文档：禁用而不是隐藏，title 说清原因", () => {
    const { view } = bar({ editAvailable: false });
    const button = editButton(view.container);
    expect(button).not.toBeNull();
    expect(button?.disabled).toBe(true);
    expect(button?.title).toBe("Editing is available only for local files");
  });

  test("可写文档上按钮可用，点击落到 onToggleEditMode", () => {
    const { view, handlers } = bar();
    const button = editButton(view.container);
    expect(button?.disabled).toBe(false);
    fireEvent.click(button as HTMLButtonElement);
    expect(handlers.onToggleEditMode).toHaveBeenCalledTimes(1);
  });
});
