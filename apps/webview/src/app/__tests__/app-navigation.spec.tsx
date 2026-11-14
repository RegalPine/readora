/**
 * Reader Shell 装配集成测试（ARC-005 §5、ARC-007 §6~§9、ARC-004 §6.2，STORY-07/09）。
 *
 * 走真实 HostBridge：消息经信封校验与 Schema 解析，于是这里的断言同时证明
 * `reader.viewState` 这条新通道在 View 侧真的可用（ARC-004 §8.3 缺口的落地口径）。
 *
 * 覆盖六件事：
 * 1. 先订阅后 ready 的不变量没被 M4 打乱；
 * 2. viewState 驱动布局（列数、宽度、专注模式）；
 * 3. 工具栏按钮改的是本地覆写，Host 一下发即让位（不再互相打架）；
 * 4. §8.2 的「先渲染后定位」时序；
 * 5. state.save 带真实 activeHeadingId 与 800ms 防抖；
 * 6. 目录折叠、活动高亮与祖先自动展开、搜索浮层的快捷键接管。
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  type DocumentLoadPayload,
  type ReaderPreferences
} from "@readora/contracts";
import { createBridgeHarness } from "../../__tests__/bridge-harness";
import { OUTLINE_FILTER_INPUT_ID } from "../../content/OutlinePanel";
import { SEARCH_DEBOUNCE_MS } from "../../content/SearchPanel";
import { STATE_SAVE_DEBOUNCE_MS, App } from "../App";
import { CONTENT_WIDTH_VARIABLE, FONT_SIZE_VARIABLE, LINE_HEIGHT_VARIABLE } from "../theme";

const PREFERENCES: ReaderPreferences = {
  theme: "auto",
  fontSize: 17,
  lineHeight: 1.8,
  contentWidth: 720,
  showOutline: true,
  typography: "newsreader",
  themePreset: "default"
};

const DOC_URI = "file:///vault/notes/navigation.md";

const TEXT = [
  "# Overview",
  "",
  "The outline tree is built from headings.",
  "",
  "## Architecture",
  "",
  "Host owns the session state.",
  "",
  "### Application Layer",
  "",
  "The webview renders the document.",
  "",
  "## Implementation",
  "",
  "Search runs inside the current document.",
  ""
].join("\n");

/**
 * 消息收发替身在 `src/__tests__/bridge-harness.ts`：装配用例与渲染指标用例共用一份，
 * 否则「View 发出的信封长什么样」会有两套口径，改协议时只改一边就测不出来。
 */
function harness() {
  return createBridgeHarness();
}

function payloadFor(overrides: Partial<DocumentLoadPayload> = {}): DocumentLoadPayload {
  return {
    documentUri: DOC_URI,
    languageId: "markdown",
    version: 1,
    text: TEXT,
    preferences: PREFERENCES,
    ...overrides
  };
}

function viewState(overrides: Partial<{ focusMode: boolean; outlineVisible: boolean; contentWidth: number }> = {}) {
  return {
    focusMode: false,
    outlineVisible: true,
    contentWidth: 820,
    ...overrides
  };
}

const TOPS = new Map<string, number>([
  ["overview", -200],
  ["architecture", 1_000],
  ["application-layer", 1_400],
  ["implementation", 1_800]
]);

function shell(): HTMLElement | null {
  return document.querySelector<HTMLElement>(".readora-shell");
}

function columns(): string {
  return shell()?.getAttribute("data-readora-columns") ?? "";
}

function canvasMain(): HTMLElement | null {
  return document.querySelector<HTMLElement>(".readora-canvas");
}

/**
 * 顶栏动作按钮的名单（按 DOM 顺序取 aria-label）。
 *
 * 这里刻意不写 `toHaveLength(4)`：M6 的顶栏按 PRD-003 §10.5 扩了面，将来再加动作时
 * 这条断言要说出的是「少了谁 / 多了谁」，而不是一个需要猜的数字。
 */
const ACTION_BUTTONS = [
  "Toggle outline",
  "Enter focus mode",
  "Search in document",
  "Export document",
  "Reader settings"
];

function toolbarActions(): string[] {
  return [...document.querySelectorAll<HTMLElement>(".readora-toolbar-button")].map(
    (button) => button.getAttribute("aria-label") ?? button.textContent?.trim() ?? ""
  );
}

/** M5 起偏好与主题都落在 `<html>` 上：变量是唯一的读取口径（PRD-003 §11.4）。 */
function preferenceVariable(name: string): string {
  return document.documentElement.style.getPropertyValue(name).trim();
}

function outlineLinks(): string[] {
  return [...document.querySelectorAll<HTMLElement>(".readora-outline-link")].map(
    (node) => node.textContent ?? ""
  );
}

function outlineLink(anchor: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`.readora-outline-link[href="#${anchor}"]`);
}

function toggleFor(label: string): HTMLElement {
  const node = document.querySelector<HTMLButtonElement>(
    `.readora-outline-toggle[aria-label="Collapse ${label}"]`
  );
  if (!node) {
    throw new Error(`collapse toggle for ${label} missing`);
  }
  return node;
}

function current(): string | null {
  return document.querySelector<HTMLElement>('[aria-current="location"]')?.textContent ?? null;
}

function scroll(y: number): void {
  Object.defineProperty(window, "scrollY", { value: y, configurable: true, writable: true });
}

type StateSaveEntry = { documentUri: string; state: { scrollTop: number; activeHeadingId: string | null } };

let scrolls: number[] = [];

function setup(overrides: Partial<DocumentLoadPayload> = {}) {
  const host = harness();
  const view = render(<App bridge={host.bridge} />);
  act(() => {
    host.emit("document.load", payloadFor(overrides));
    host.emit("theme.update", { theme: "light", source: "product" });
    host.emit("reader.viewState", viewState());
  });
  return { view, host };
}

function press(key: string, init: { metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean } = {}): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  act(() => {
    document.dispatchEvent(event);
  });
  return event;
}

function advance(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  scrolls = [];
  TOPS.set("overview", -200);
  TOPS.set("architecture", 1_000);
  TOPS.set("application-layer", 1_400);
  TOPS.set("implementation", 1_800);
  Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
  Object.defineProperty(window, "innerWidth", { value: 1_440, configurable: true });
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string) => ({
      media: query,
      matches: false,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => true
    })
  });
  HTMLElement.prototype.getBoundingClientRect = function (): DOMRect {
    const top = TOPS.get(this.id) ?? 0;
    return { top, bottom: top + 24 } as DOMRect;
  };
  HTMLElement.prototype.scrollIntoView = vi.fn();
  window.scrollTo = ((options: ScrollToOptions | number) => {
    const top = typeof options === "number" ? options : (options.top ?? 0);
    scrolls.push(top);
    Object.defineProperty(window, "scrollY", { value: top, configurable: true, writable: true });
  }) as typeof window.scrollTo;
  scroll(0);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  document.body.replaceChildren();
  // applyTheme 写的是 `<html>`，jsdom 的文档跨用例复用：不清就会串味。
  document.documentElement.removeAttribute("style");
  document.documentElement.dataset.readoraTheme = "light";
  document.documentElement.dataset.readoraScheme = "light";
});

describe("装配与协议", () => {
  test("挂载即先订阅后 ready，未收到文档前只显示加载态", () => {
    const host = harness();
    const view = render(<App bridge={host.bridge} />);
    expect(host.sent("reader.ready")).toHaveLength(1);
    expect(view.container.querySelector(".readora-loading")?.textContent).toBe("Loading document…");
    expect(host.posted[0]?.type).toBe("reader.ready");
    view.unmount();
    host.dispose();
  });

  test("document.load 后目录与正文同源：条目与文档标题逐项一致", () => {
    setup();
    expect(outlineLinks()).toEqual([
      "Overview",
      "Architecture",
      "Application Layer",
      "Implementation"
    ]);
    expect(document.querySelectorAll(".readora-document .readora-heading")).toHaveLength(4);
    expect(document.querySelector(".readora-document")?.getAttribute("data-readora-document-version")).toBe(
      "1"
    );
  });

  test("viewState 决定列数、阅读宽度与左栏渲染", () => {
    const { host } = setup();
    expect(columns()).toBe("two");
    expect(preferenceVariable(CONTENT_WIDTH_VARIABLE)).toBe("820px");
    act(() => {
      host.emit("reader.viewState", viewState({ outlineVisible: false, contentWidth: 1_200 }));
    });
    expect(columns()).toBe("one");
    expect(document.querySelector(".readora-shell-nav")).toBeNull();
    expect(preferenceVariable(CONTENT_WIDTH_VARIABLE)).toBe("1200px");
  });

  test("Host 未下发 viewState 时退回用户偏好（showOutline / contentWidth）", () => {
    const host = harness();
    render(<App bridge={host.bridge} />);
    act(() => {
      host.emit("document.load", payloadFor());
    });
    expect(columns()).toBe("two");
    expect(preferenceVariable(CONTENT_WIDTH_VARIABLE)).toBe("720px");
  });

  test("config.update 换偏好后宽度回落跟随，但不覆盖会话视图状态", () => {
    const { host } = setup();
    act(() => {
      host.emit("config.update", { preferences: { ...PREFERENCES, contentWidth: 900 } });
    });
    // 已有 viewState（820）时以会话状态为准，偏好只是缺省
    expect(preferenceVariable(CONTENT_WIDTH_VARIABLE)).toBe("820px");
  });

  test("三项偏好都落到 :root 变量上（PRD-003 §11.4 单一变量驱动）", () => {
    const { host } = setup();
    expect(preferenceVariable(FONT_SIZE_VARIABLE)).toBe("17px");
    expect(preferenceVariable(LINE_HEIGHT_VARIABLE)).toBe("1.8");
    act(() => {
      host.emit("config.update", { preferences: { ...PREFERENCES, fontSize: 21, lineHeight: 2 } });
    });
    expect(preferenceVariable(FONT_SIZE_VARIABLE)).toBe("21px");
    expect(preferenceVariable(LINE_HEIGHT_VARIABLE)).toBe("2");
    // 正文不因此带内联样式：变量是唯一载体，画布只留类名。
    expect(canvasMain()?.getAttribute("style")).toBeNull();
  });
});

describe("工具栏与视图状态权威（ARC-004 §4.1 / §6.2）", () => {
  test("点按钮改本地覆写，Host 一下发就让位", () => {
    const { host } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Toggle outline" }));
    expect(columns()).toBe("one");
    act(() => {
      host.emit("reader.viewState", viewState({ outlineVisible: true }));
    });
    expect(columns()).toBe("two");
  });

  test("专注模式按钮收左栏并只留退出入口，退出恢复正常布局", () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Enter focus mode" }));
    expect(columns()).toBe("one");
    expect(canvasMain()?.classList.contains("readora-canvas--focus")).toBe(true);
    expect(toolbarActions()).toEqual(["Exit focus mode"]);
    fireEvent.click(screen.getByRole("button", { name: "Exit focus mode" }));
    expect(columns()).toBe("two");
    expect(toolbarActions()).toEqual(ACTION_BUTTONS);
  });

  test("Host 命令下发 focusMode 时按钮状态同步（快捷键与按钮不打架）", () => {
    const { host } = setup();
    // 用户先用按钮开了专注，随后 Host 命令切回去：本地覆写必须让位
    fireEvent.click(screen.getByRole("button", { name: "Enter focus mode" }));
    act(() => {
      host.emit("reader.viewState", viewState({ focusMode: false }));
    });
    expect(toolbarActions()).toEqual(ACTION_BUTTONS);
    act(() => {
      host.emit("reader.viewState", viewState({ focusMode: true }));
    });
    expect(toolbarActions()).toEqual(["Exit focus mode"]);
  });
});

describe("点击定位与活动标题（§5.3 / §7.3）", () => {
  test("点目录项走 HeadingLocator 并立刻高亮该项", () => {
    setup();
    const link = outlineLink("architecture");
    if (!link) {
      throw new Error("outline link for architecture missing");
    }
    fireEvent.click(link);
    expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalledTimes(1);
    expect(current()).toBe("Architecture");
  });

  test("滚动按基准线切换活动标题，aria-current 只有一处", () => {
    setup();
    scroll(500);
    act(() => {
      window.dispatchEvent(new Event("scroll"));
    });
    expect(current()).toBe("Overview");
    TOPS.set("overview", -600);
    TOPS.set("architecture", 200);
    act(() => {
      window.dispatchEvent(new Event("scroll"));
    });
    expect(current()).toBe("Architecture");
    TOPS.set("architecture", -600);
    TOPS.set("application-layer", 200);
    act(() => {
      window.dispatchEvent(new Event("scroll"));
    });
    expect(current()).toBe("Application Layer");
  });

  test("折叠父节点隐藏后代，活动标题进入子树时祖先自动展开（§6.2 第 3 条）", () => {
    setup();
    fireEvent.click(toggleFor("Architecture"));
    expect(outlineLinks()).toEqual(["Overview", "Architecture", "Implementation"]);
    // 深滚到 Application Layer：祖先 overview / architecture 被并入展开集
    scroll(900);
    TOPS.set("overview", -600);
    TOPS.set("architecture", -400);
    TOPS.set("application-layer", 200);
    act(() => {
      window.dispatchEvent(new Event("scroll"));
    });
    expect(current()).toBe("Application Layer");
    expect(outlineLinks()).toContain("Application Layer");
  });

  test("锚点在 DOM 里已不存在时点击不抛错，正文照常可读（§12）", () => {
    setup();
    const link = outlineLink("architecture");
    if (!link) {
      throw new Error("outline link for architecture missing");
    }
    document.getElementById("architecture")?.remove();
    expect(() => {
      fireEvent.click(link);
    }).not.toThrow();
    expect(document.querySelectorAll(".readora-document .readora-heading")).toHaveLength(3);
  });
});

describe("阅读位置恢复时序（§8.2）", () => {
  test("state.restore 先到也要等渲染完成，再按标题定位", () => {
    const host = harness();
    render(<App bridge={host.bridge} />);
    act(() => {
      host.emit("state.restore", { state: { scrollTop: 420, activeHeadingId: null } });
    });
    expect(scrolls).toHaveLength(0);
    act(() => {
      host.emit("document.load", payloadFor());
    });
    expect(scrolls).toEqual([420]);
  });

  test("已渲染时直接定位标题，不动 window.scrollTo", () => {
    const { host } = setup();
    scrolls = [];
    act(() => {
      host.emit("state.restore", { state: { scrollTop: 999, activeHeadingId: "architecture" } });
    });
    expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrolls).toHaveLength(0);
  });

  test("恢复用的标题已被删除时回退 scrollTop", () => {
    const { host } = setup();
    scrolls = [];
    act(() => {
      host.emit("state.restore", { state: { scrollTop: 640, activeHeadingId: "no-such-heading" } });
    });
    expect(scrolls).toEqual([640]);
  });

  test("state.restore 载荷为 null 时什么都不动", () => {
    const { host } = setup();
    scrolls = [];
    act(() => {
      host.emit("state.restore", { state: null });
    });
    expect(scrolls).toHaveLength(0);
    expect(HTMLElement.prototype.scrollIntoView).not.toHaveBeenCalled();
  });

  test("document.update 后原标题还在就不动滚动（§8.4 第 1 条）", () => {
    const { host } = setup();
    scroll(700);
    act(() => {
      window.dispatchEvent(new Event("scroll"));
    });
    scrolls = [];
    act(() => {
      host.emit("document.update", payloadFor({ version: 2, text: `${TEXT}\n## Appended\n` }));
    });
    expect(scrolls).toHaveLength(0);
  });
});

describe("state.save（§8.1 / §8.3）", () => {
  function savedAfter(overrides: Partial<DocumentLoadPayload> = {}): ReturnType<typeof harness> {
    return setup(overrides).host;
  }

  function saves(host: ReturnType<typeof harness>): StateSaveEntry[] {
    return host.sent("state.save") as StateSaveEntry[];
  }

  test("滚动停止 800ms 后投递一次，带真实 activeHeadingId", () => {
    const host = savedAfter();
    scroll(500);
    act(() => {
      window.dispatchEvent(new Event("scroll"));
    });
    advance(STATE_SAVE_DEBOUNCE_MS - 1);
    expect(host.sent("state.save")).toHaveLength(0);
    advance(1);
    const entries = saves(host);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.documentUri).toBe(DOC_URI);
    expect(entries[0]?.state).toEqual({ scrollTop: 500, activeHeadingId: "overview" });
  });

  test("连续滚动只投递最后一次", () => {
    const host = savedAfter();
    for (const y of [100, 200, 900]) {
      scroll(y);
      act(() => {
        window.dispatchEvent(new Event("scroll"));
      });
      advance(300);
    }
    advance(STATE_SAVE_DEBOUNCE_MS);
    const entries = saves(host);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.state.scrollTop).toBe(900);
  });

  test("面板隐藏时立刻补投一次，不等防抖", () => {
    const host = savedAfter();
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    scroll(1_234);
    act(() => {
      window.dispatchEvent(new Event("scroll"));
      document.dispatchEvent(new Event("visibilitychange"));
    });
    const entries = saves(host);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.state).toEqual({ scrollTop: 1_234, activeHeadingId: "overview" });
    advance(STATE_SAVE_DEBOUNCE_MS);
    expect(host.sent("state.save")).toHaveLength(1);
  });

  test("pagehide 也补投一次", () => {
    const host = savedAfter();
    scroll(77);
    act(() => {
      window.dispatchEvent(new Event("scroll"));
      window.dispatchEvent(new Event("pagehide"));
    });
    expect(host.sent("state.save")).toHaveLength(1);
  });

  test("没有文档时不投状态；换文档后按新 URI 投递", () => {
    const host = harness();
    render(<App bridge={host.bridge} />);
    act(() => {
      window.dispatchEvent(new Event("scroll"));
    });
    advance(STATE_SAVE_DEBOUNCE_MS);
    expect(host.sent("state.save")).toHaveLength(0);

    act(() => {
      host.emit("document.load", payloadFor());
    });
    scroll(50);
    act(() => {
      window.dispatchEvent(new Event("scroll"));
    });
    advance(STATE_SAVE_DEBOUNCE_MS);
    const entries = saves(host);
    expect(entries[entries.length - 1]?.documentUri).toBe(DOC_URI);
  });
});

describe("文档内搜索接管（§9.1 / PRD-002 §10.2）", () => {
  test("工具栏按钮与 cmd/ctrl+f 都能打开浮层，Escape 关闭", () => {
    setup();
    expect(document.querySelector(".readora-search-panel")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Search in document" }));
    expect(document.querySelector(".readora-search-panel")).not.toBeNull();
    press("Escape");
    expect(document.querySelector(".readora-search-panel")).toBeNull();

    press("f", { metaKey: true });
    expect(document.querySelector(".readora-search-panel")).not.toBeNull();
    press("f", { ctrlKey: true });
    // 已打开时再按一次仍是同一个浮层（不叠两层）
    expect(document.querySelectorAll(".readora-search-panel")).toHaveLength(1);
    press("Escape");
    expect(document.querySelector(".readora-search-panel")).toBeNull();
  });

  test("搜索只作用于当前文档容器，命中落在正文里", () => {
    setup();
    press("f", { metaKey: true });
    const input = document.querySelector<HTMLInputElement>(".readora-search-input");
    if (!input) {
      throw new Error("search input missing");
    }
    fireEvent.change(input, { target: { value: "document" } });
    advance(SEARCH_DEBOUNCE_MS);
    const marks = document.querySelectorAll(".readora-document mark");
    expect(marks.length).toBeGreaterThan(0);
    expect(
      [...marks].every((node) => node.getAttribute("data-readora-search-version") === "1")
    ).toBe(true);
  });

  test("切换文档时清空搜索浮层与折叠状态（§10.3 不留副本）", () => {
    const { host } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Search in document" }));
    fireEvent.click(toggleFor("Architecture"));
    expect(document.querySelectorAll(".readora-outline-item")).toHaveLength(3);

    act(() => {
      host.emit("document.load", payloadFor({ documentUri: "file:///vault/notes/other.md" }));
    });
    expect(document.querySelector(".readora-search-panel")).toBeNull();
    expect(document.querySelectorAll(".readora-outline-item")).toHaveLength(4);
  });

  test("跳到版本号更小的另一篇文档仍然渲染，不被上一版的计数线拦住", () => {
    const { host } = setup();
    act(() => {
      host.emit("document.update", payloadFor({ version: 3 }));
    });
    fireEvent.click(screen.getByRole("button", { name: "Search in document" }));
    fireEvent.click(toggleFor("Architecture"));
    expect(document.querySelectorAll(".readora-outline-item")).toHaveLength(3);

    act(() => {
      host.emit(
        "document.load",
        payloadFor({
          documentUri: "file:///vault/notes/older.md",
          version: 1,
          text: "# Restart\n\nAnother file, its own version line.\n\n## Second heading\n"
        })
      );
    });
    expect(document.querySelector(".readora-document h1")?.textContent).toBe("Restart");
    expect(document.querySelector(".readora-search-panel")).toBeNull();
    expect(document.querySelectorAll(".readora-outline-item")).toHaveLength(2);
    expect(outlineLinks()).toEqual(["Restart", "Second heading"]);
  });
});

/**
 * M6 外壳接线（PRD-003 §10.5 / §4.6 / §11.4，STORY-06）。
 *
 * 这一段证明的是「装配」而不是组件外观：弹层的每一项改动都要经真实 HostBridge 变成
 * 一条 `config.patch` 消息，缩放要真的进到 `--readora-font-size`，快速条那枚
 * 「展开大纲」在专注模式里要真的把左栏带回来。
 */
describe("顶栏 / 弹层 / 状态条装配（M6）", () => {
  function openSettings(): void {
    fireEvent.click(screen.getByRole("button", { name: "Reader settings" }));
  }

  function triggerExpanded(): string | null {
    return screen
      .getByRole("button", { name: "Reader settings" })
      .getAttribute("aria-expanded");
  }

  test("状态条的 Bridge 字段以收到过 document.load 为判据（§4.6）", () => {
    setup();
    const bridge = document.querySelector<HTMLElement>('[data-readora-status="bridge"]');
    expect(bridge?.textContent).toContain("Bridge: Connected");
    expect(bridge?.querySelector(".readora-status-indicator")?.getAttribute("data-readora-bridge-state")).toBe(
      "connected"
    );
    // 字数与节数都来自真实数据源：TEXT 有 4 个标题，单元数由 text-metrics 数。
    expect(document.querySelector('[data-readora-status="sections"]')?.textContent).toBe("4 sections");
    expect(document.querySelector('[data-readora-status="words"]')?.textContent).toMatch(/^\d+ words$/u);
  });

  test("弹层开合：aria-expanded 跟随，Escape 关闭且焦点回触发器", () => {
    setup();
    expect(document.querySelector(".readora-settings-dialog")).toBeNull();
    expect(triggerExpanded()).toBe("false");

    const trigger = screen.getByRole("button", { name: "Reader settings" });
    // jsdom 的合成 click 不移动焦点，真实点击会：先把焦点交给触发器，
    // 「关闭后归位」量的才是归位本身，而不是退回 body。
    trigger.focus();
    openSettings();
    expect(triggerExpanded()).toBe("true");
    const panel = document.querySelector<HTMLElement>(".readora-settings-dialog");
    expect(panel?.getAttribute("role")).toBe("dialog");
    expect(panel?.getAttribute("aria-modal")).toBe("true");
    // 焦点收拢进弹层，关闭后归位触发器（不额外传 ref）。
    expect(panel?.contains(document.activeElement)).toBe(true);

    fireEvent.keyDown(panel as HTMLElement, { key: "Escape" });
    expect(document.querySelector(".readora-settings-dialog")).toBeNull();
    expect(triggerExpanded()).toBe("false");
    expect(document.activeElement).toBe(trigger);
  });

  test("改一项就发一条 config.patch，且显示的是 Host 确认值而非本地乐观值", () => {
    const { host } = setup();
    openSettings();
    fireEvent.click(screen.getByRole("button", { name: "High contrast" }));
    expect(host.sent("config.patch")).toEqual([{ key: "themePreset", value: "high-contrast" }]);
    // Host 还没回话：弹层里按下的仍是旧值，非法值被挡掉时界面不会自己先跳。
    expect(
      screen.getByRole("button", { name: "High contrast" }).getAttribute("aria-pressed")
    ).toBe("false");
    expect(
      screen.getByRole("button", { name: "Default" }).getAttribute("aria-pressed")
    ).toBe("true");

    act(() => {
      host.emit("config.update", { preferences: { ...PREFERENCES, themePreset: "high-contrast" } });
    });
    expect(
      screen.getByRole("button", { name: "High contrast" }).getAttribute("aria-pressed")
    ).toBe("true");
    // Host 侧的预设同样落到 <html> 属性上，与首帧预置同一出口。
    expect(document.documentElement.dataset.readoraPreset).toBe("high-contrast");
  });

  test("滑杆与复选框发出的是数字与布尔，不是字符串", () => {
    const { host } = setup();
    openSettings();
    const slider = document.querySelector<HTMLInputElement>("#readora-settings-font-size");
    if (!slider) {
      throw new Error("font size slider missing");
    }
    fireEvent.change(slider, { target: { value: "21" } });
    fireEvent.click(document.querySelector<HTMLInputElement>('.readora-settings-check input[type="checkbox"]') as HTMLElement);
    expect(host.sent("config.patch")).toEqual([
      { key: "fontSize", value: 21 },
      { key: "showOutline", value: false }
    ]);
  });

  test("缩放：快捷键与缩放组共用一份状态，只动字号变量", () => {
    setup();
    expect(preferenceVariable(FONT_SIZE_VARIABLE)).toBe("17px");
    expect(screen.getByRole("button", { name: "Reset zoom" }).textContent).toBe("100%");

    press("=", { metaKey: true });
    expect(preferenceVariable(FONT_SIZE_VARIABLE)).toBe("19px"); // round(17 × 1.1)
    expect(screen.getByRole("button", { name: "Reset zoom" }).textContent).toBe("110%");
    // 行高与内容宽度不跟缩放走（§11.4：那是字号偏好的职责）。
    expect(preferenceVariable(LINE_HEIGHT_VARIABLE)).toBe("1.8");

    press("-", { ctrlKey: true });
    press("-", { ctrlKey: true });
    expect(preferenceVariable(FONT_SIZE_VARIABLE)).toBe("15px");

    press("0", { metaKey: true });
    expect(preferenceVariable(FONT_SIZE_VARIABLE)).toBe("17px");
    expect(screen.getByRole("button", { name: "Reset zoom" }).textContent).toBe("100%");
  });

  test("缩放连点 20 次也停在 200%，端点上 + 停用（不外弹、不越 32px）", () => {
    setup();
    for (let index = 0; index < 20; index += 1) {
      press("=", { metaKey: true });
    }
    expect(screen.getByRole("button", { name: "Reset zoom" }).textContent).toBe("200%");
    expect(preferenceVariable(FONT_SIZE_VARIABLE)).toBe("32px"); // round(17×2)=34 → 夹回 32
    expect((screen.getByRole("button", { name: "Zoom in" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Zoom out" }));
    expect(screen.getByRole("button", { name: "Reset zoom" }).textContent).toBe("190%");
    expect((screen.getByRole("button", { name: "Zoom in" }) as HTMLButtonElement).disabled).toBe(false);
  });

  test("空视图不抢按键：没有 document.load 时 Ctrl+= 不动任何变量", () => {
    const host = harness();
    render(<App bridge={host.bridge} />);
    press("=", { metaKey: true });
    expect(preferenceVariable(FONT_SIZE_VARIABLE)).toBe("");
    expect(document.querySelector(".readora-loading")).not.toBeNull();
    expect(document.querySelector(".readora-statusbar")).toBeNull();
  });

  test("专注模式：顶栏收成退出入口，快速条的展开大纲真的把左栏带回来", () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Enter focus mode" }));
    expect(columns()).toBe("one");
    expect(document.querySelector(".readora-shell-nav")).toBeNull();

    const expand = screen.getByRole("button", { name: "Expand outline" });
    expect(expand.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(expand);
    // §10.5 那枚按钮必须真的能展开，否则是一个假 affordance。
    expect(document.querySelector(".readora-shell-nav")).not.toBeNull();
    expect(columns()).toBe("two");
    expect(
      screen.getByRole("button", { name: "Expand outline" }).getAttribute("aria-pressed")
    ).toBe("true");

    // 收起态是临时态：退出专注后回到「大纲按偏好显示」，不残留、也不改写偏好。
    fireEvent.click(screen.getByRole("button", { name: "Exit focus mode" }));
    expect(columns()).toBe("two");
    expect(screen.queryByRole("button", { name: "Expand outline" })).toBeNull();
  });

  test("专注模式下的临时展开不进 Host 的视图状态：下发即清（ARC-004 §6.2）", () => {
    const { host } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Enter focus mode" }));
    fireEvent.click(screen.getByRole("button", { name: "Expand outline" }));
    expect(document.querySelector(".readora-shell-nav")).not.toBeNull();

    act(() => {
      host.emit("reader.viewState", viewState({ focusMode: true, outlineVisible: false }));
    });
    expect(document.querySelector(".readora-shell-nav")).toBeNull();
  });

  test("快速条的标题与大纲高亮同源，且不自带「回到顶部」", () => {
    setup();
    const quickTitle = document.querySelector('[data-readora-quickbar="heading"]')?.textContent;
    const activeTitle = document.querySelector(
      ".readora-outline-link[aria-current='location']"
    )?.textContent;
    // 两处读的都是 `useActiveHeading` 的判定：另起一条「按滚动位置算当前章节」
    // 的路就会出现快速条与大纲各说各话。
    expect(quickTitle).toBe(activeTitle);
    expect(quickTitle).toBe("Overview");
    // 「回到顶部」已下掉：没有入口，也就没人替读者写一次 window.scrollTo(0)。
    expect(screen.queryByRole("button", { name: "Back to top" })).toBeNull();
  });

  test("大纲「折叠全部 / 展开全部」由 App 持有状态：按下真的改树，再按下真的回得来", () => {
    setup();
    expect(outlineLinks()).toHaveLength(4);

    fireEvent.click(screen.getByRole("button", { name: "Collapse all" }));
    // 折叠集合是「有后代的节点」名单（overview、architecture）：两个都收之后
    // 只剩顶层标题自己，叶子条目是被祖先藏掉的，不是它们自己进了折叠集合。
    expect(outlineLinks()).toEqual(["Overview"]);

    fireEvent.click(screen.getByRole("button", { name: "Expand all" }));
    expect(outlineLinks()).toHaveLength(4);
  });

  test("大纲过滤是这一篇的临时视图态：换文档即清空，不留副本（§10.3）", () => {
    const { host } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Filter" }));
    const input = document.getElementById(OUTLINE_FILTER_INPUT_ID) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "arch" } });
    expect(document.querySelectorAll(".readora-outline-link")).toHaveLength(1);

    act(() => {
      host.emit("document.load", payloadFor({ documentUri: "file:///vault/notes/other.md" }));
    });
    // 换文档靠重挂清状态：过滤输入框连同 disclosure 都不该带着上一篇的查询活下来。
    expect(document.getElementById(OUTLINE_FILTER_INPUT_ID)).toBeNull();
    expect(outlineLinks()).toHaveLength(4);
  });

  test("进度只在快速条一处报：滚动位置换算成百分比，大纲不再读它", () => {
    setup();
    // jsdom 的 scrollHeight 恒为 0，进度会永远停在 0%：造一个可滚距离，
    // 否则这条断言在「两个 0」上恒真，测不出读数真的跟着滚动走。
    Object.defineProperty(document.documentElement, "scrollHeight", {
      configurable: true,
      value: 2_300
    });
    scroll(400);
    act(() => {
      window.dispatchEvent(new Event("scroll"));
      vi.advanceTimersByTime(20);
    });

    // 400 / (2300 - 800) ≈ 26.7% → 27%：非零才证明进度链路真的跑到了 UI。
    expect(
      document.querySelector('[data-readora-quickbar="progress"]')?.textContent
    ).toBe("27%");
    expect(document.querySelector('[data-readora-outline="progress"]')).toBeNull();
  });
});
