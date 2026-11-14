/**
 * 顶栏新增字段的取证（PRD-003 §10.5、§4.6 的诚实性规则）。
 *
 * 两条主线，逐条都是「有真实数据源才渲染」：
 * - 面包屑：`documentUri` 去 scheme 取末 3 段，纯文本、不可点（§4.6 点名剔除
 *   「可点击目录段」，因为没有 reveal-in-explorer 能力）；
 * - 缩放组：端点上禁用 − / +，点百分号复位（§10.5）。
 *
 * 时长 pill 与模式标签的取证在 `status-quick-bars.spec.tsx`：它们已按产品反馈
 * 从顶栏迁到状态条右端。
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import type { ZoomApi } from "../zoom";
import { ZOOM_MAX, ZOOM_MIN, ZOOM_RESET } from "../zoom";
import { BREADCRUMB_CLASS, BREADCRUMB_MAX_SEGMENTS, TopBar, breadcrumbOf } from "../TopBar";

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
  focusMode?: boolean;
  documentUri?: string;
  zoom?: ZoomApi;
} = {}) {
  const handlers = {
    onToggleOutline: vi.fn(),
    onToggleFocusMode: vi.fn(),
    onToggleSearch: vi.fn(),
    onToggleSettings: vi.fn(),
    onToggleExport: vi.fn(),
    onCloseExport: vi.fn(),
    onExport: vi.fn()
  };
  const view = render(
    <TopBar
      outlineVisible
      focusMode={overrides.focusMode ?? false}
      searchOpen={false}
      settingsOpen={false}
      exportOpen={false}
      documentUri={overrides.documentUri}
      zoom={overrides.zoom ?? zoomApi()}
      {...handlers}
    />
  );
  return { view, handlers };
}

describe("breadcrumbOf", () => {
  test("取末 3 段，前面的目录段丢掉", () => {
    const segments = breadcrumbOf("file:///Users/me/notes/vault/deep/arch.md");
    expect(segments.map((segment) => segment.name)).toEqual(["vault", "deep", "arch.md"]);
    expect(segments.map((segment) => segment.directory)).toEqual([true, true, false]);
    expect(BREADCRUMB_MAX_SEGMENTS).toBe(3);
  });

  test("剥掉 scheme 与 authority：vscode-file 的假 host 不是目录", () => {
    expect(breadcrumbOf("vscode-file://vscode-app/Users/me/a.md").map((s) => s.name)).toEqual([
      "Users",
      "me",
      "a.md"
    ]);
    // 段数不足 3 就照实显示，不拿空串凑数。
    expect(breadcrumbOf("file:///a.md").map((s) => s.name)).toEqual(["a.md"]);
  });

  test("百分号编码还原成人读的目录名", () => {
    expect(breadcrumbOf("file:///My%20Notes/%E7%AC%94%E8%AE%B0.md")[0]?.name).toBe("My Notes");
    expect(breadcrumbOf("file:///My%20Notes/%E7%AC%94%E8%AE%B0.md")[1]?.name).toBe("笔记.md");
  });

  test("解码失败按原文显示：一个显示用的字符串不值得抛穿渲染", () => {
    expect(breadcrumbOf("file:///%E0%A4%A.md")[0]?.name).toBe("%E0%A4%A.md");
  });

  test("没有 URI（Host 还没下发）就是空数组，不编一个占位路径", () => {
    expect(breadcrumbOf(undefined)).toEqual([]);
    expect(breadcrumbOf("")).toEqual([]);
  });
});

describe("面包屑渲染", () => {
  test("末段是文件名、其余是目录段，整条 URI 放在 title 上", () => {
    const uri = "file:///vault/notes/deep/arch.md";
    const { view } = bar({ documentUri: uri });
    const crumb = view.container.querySelector<HTMLElement>(`.${BREADCRUMB_CLASS}`);
    expect(crumb?.getAttribute("title")).toBe(uri);
    expect(crumb?.getAttribute("aria-label")).toBe("Document path");
    const marked = [...view.container.querySelectorAll<HTMLElement>("[data-readora-breadcrumb]")];
    expect(marked.map((node) => node.getAttribute("data-readora-breadcrumb"))).toEqual([
      "directory",
      "directory",
      "filename"
    ]);
  });

  test("纯文本不可点：段里没有 a / button，点上去也不触发动作", () => {
    const { view, handlers } = bar({ documentUri: "file:///vault/a.md" });
    const crumb = view.container.querySelector(`.${BREADCRUMB_CLASS}`) as HTMLElement;
    expect(crumb.querySelectorAll("a, button")).toHaveLength(0);
    expect(view.container.querySelectorAll("[role='link']")).toHaveLength(0);
    // 点了什么都不知道：没有 onNavigate 之类的通道可走（§4.6 剔除假 affordance）。
    fireEvent.click(crumb);
    fireEvent.click(crumb.querySelector(`.${BREADCRUMB_CLASS}-segment--file`) as Element);
    expect(handlers.onToggleOutline).not.toHaveBeenCalled();
    expect(handlers.onToggleSearch).not.toHaveBeenCalled();
    expect(handlers.onToggleFocusMode).not.toHaveBeenCalled();
    expect(handlers.onToggleSettings).not.toHaveBeenCalled();
  });

  test("无 URI 时整段不输出，不留一个空面包屑", () => {
    const { view } = bar();
    expect(view.container.querySelector(`.${BREADCRUMB_CLASS}`)).toBeNull();
  });
});

describe("顶栏不再有 pill（已迁到状态条右端）", () => {
  test("常规档与专注档都不在顶栏输出 pill，专注档只剩退出入口一枚按钮", () => {
    expect(bar().view.container.querySelector("[data-readora-pill]")).toBeNull();

    const focused = bar({ focusMode: true });
    expect(focused.view.container.querySelectorAll("[data-readora-pill]")).toHaveLength(0);
    // §11.2 收的是按钮：退出入口之外一个控件都不留。
    // 走 container 不走 role 查询：同一条用例挂了两份顶栏，baseElement 是 document.body。
    expect(focused.view.container.querySelectorAll("button")).toHaveLength(1);
    expect(
      focused.view.container.querySelector<HTMLButtonElement>(".readora-toolbar-button")?.textContent
    ).toBe("Exit focus mode");
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
