/**
 * 搜索浮层测试（ARC-007 §9.1 / §9.4 / §12、PRD-002 §10.2 / §10.3，STORY-07-03）。
 *
 * 覆盖面板六条交互口径 + 文档级快捷键接管（cmd/ctrl+f、Escape 优先级）。
 * 高亮还原与匹配语义本身在 search-engine.spec.ts 里断言，这里只走面板链路。
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { SearchPanel, NO_MATCH_LABEL, SEARCH_DEBOUNCE_MS, SEARCH_PANEL_CLASS } from "../SearchPanel";
import {
  SEARCH_HIT_ID_ATTRIBUTE,
  clearHighlights,
  highlightVersion
} from "../search-engine";
import { EDIT_HELP_DIALOG_CLASS, TOP_OVERLAY_SELECTOR, useSearchShortcuts } from "../interactions";

const PROSE =
  '<h2 id="overview" data-readora-heading="overview">Overview</h2>' +
  "<p>The engine draws. Engine again. another engine and the engine.</p>";

let root: HTMLElement;
const onClose = vi.fn();

function mountDocument(): HTMLElement {
  const host = document.createElement("div");
  host.className = "readora-document";
  host.innerHTML = PROSE;
  document.body.replaceChildren(host);
  return host;
}

function openPanel(documentVersion = 1) {
  const view = render(
    <SearchPanel
      getRoot={() => root}
      documentId="file:///notes/search.md"
      documentVersion={documentVersion}
      onClose={onClose}
    />
  );
  return view;
}

function input(container: HTMLElement = document.body): HTMLInputElement {
  const node = container.querySelector<HTMLInputElement>(".readora-search-input");
  if (!node) {
    throw new Error("search input missing");
  }
  return node;
}

function count(container: HTMLElement): string {
  return container.querySelector<HTMLElement>(".readora-search-count")?.textContent ?? "";
}

function type(value: string, container?: HTMLElement): void {
  fireEvent.change(input(container ?? document.body), { target: { value } });
}

function settle(): void {
  act(() => {
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
  });
}

function press(key: string, init: { shiftKey?: boolean } = {}): void {
  fireEvent.keyDown(input(document.body), { key, ...init });
}

function marks(): Element[] {
  return [...root.querySelectorAll("mark")];
}

beforeEach(() => {
  vi.useFakeTimers();
  onClose.mockClear();
  root = mountDocument();
  HTMLElement.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe("面板与输入", () => {
  test("打开即聚焦输入框，面板是可命名的 search 地标而非 modal", () => {
    const view = openPanel();
    expect(view.container.querySelector<HTMLElement>(`.${SEARCH_PANEL_CLASS}`)?.getAttribute("role")).toBe(
      "search"
    );
    expect(document.activeElement).toBe(input(view.container));
    expect(view.container.querySelector("[aria-modal]")).toBeNull();
  });

  test("空输入不搜索，计数位留空", () => {
    const view = openPanel();
    settle();
    expect(count(view.container)).toBe("");
    expect(marks()).toHaveLength(0);
  });

  test("防抖 250ms：窗口内不扫正文，到点才出结果", () => {
    const view = openPanel();
    type("engine", view.container);
    act(() => {
      vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS - 1);
    });
    expect(marks()).toHaveLength(0);
    expect(count(view.container)).toBe("");
    settle();
    expect(marks()).toHaveLength(4);
    expect(count(view.container)).toBe("1 / 4");
  });

  test("连续输入只按最后一次搜索（不留旧高亮叠加）", () => {
    const view = openPanel();
    type("engine", view.container);
    settle();
    type("engines", view.container);
    settle();
    expect(marks()).toHaveLength(0);
    type("engine", view.container);
    settle();
    expect(marks()).toHaveLength(4);
  });

  test("无结果给明确提示（§12「搜索无结果」）", () => {
    const view = openPanel();
    type("zzzz", view.container);
    settle();
    expect(count(view.container)).toBe(NO_MATCH_LABEL);
    expect(marks()).toHaveLength(0);
  });

  test("大小写开关切换匹配集合", () => {
    const view = openPanel();
    type("engine", view.container);
    settle();
    expect(count(view.container)).toBe("1 / 4");
    fireEvent.click(view.getByTitle("Match case"));
    settle();
    expect(count(view.container)).toBe("1 / 3");
  });
});

describe("命中导航", () => {
  test("上一个 / 下一个按钮循环推进计数", () => {
    const view = openPanel();
    type("engine", view.container);
    settle();
    const next = view.getByLabelText("Next match");
    const previous = view.getByLabelText("Previous match");
    fireEvent.click(next);
    expect(count(view.container)).toBe("2 / 4");
    for (let index = 0; index < 3; index += 1) {
      fireEvent.click(next);
    }
    expect(count(view.container)).toBe("1 / 4");
    fireEvent.click(previous);
    expect(count(view.container)).toBe("4 / 4");
  });

  test("Enter / Shift+Enter / ↑ / ↓ 与按钮等价", () => {
    const view = openPanel();
    type("engine", view.container);
    settle();
    press("Enter");
    expect(count(view.container)).toBe("2 / 4");
    press("Enter", { shiftKey: true });
    expect(count(view.container)).toBe("1 / 4");
    press("ArrowDown");
    press("ArrowDown");
    expect(count(view.container)).toBe("3 / 4");
    press("ArrowUp");
    expect(count(view.container)).toBe("2 / 4");
  });

  test("活动命中带 data-readora-search-active 并滚到视口中线", () => {
    openPanel();
    type("engine", document.body);
    settle();
    const active = root.querySelectorAll('[data-readora-search-active="true"]');
    expect(active).toHaveLength(1);
    expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalled();
  });

  test("点击正文里的命中项即把它设为当前项", () => {
    const view = openPanel();
    type("engine", view.container);
    settle();
    const list = marks();
    fireEvent.click(list[2] as Element);
    expect(count(view.container)).toBe("3 / 4");
  });

  test("无结果时导航按钮禁用，按方向键不报错", () => {
    const view = openPanel();
    type("zzzz", view.container);
    settle();
    expect((view.getByLabelText("Next match") as HTMLButtonElement).disabled).toBe(true);
    expect(() => {
      press("ArrowDown");
      press("ArrowUp");
    }).not.toThrow();
  });
});

describe("关闭与还原（§9.4 第 4 条）", () => {
  test("Escape 关闭浮层、清除临时高亮并把焦点还给正文", () => {
    const view = openPanel();
    type("engine", view.container);
    settle();
    const before = root.textContent ?? "";
    press("Escape");
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(marks()).toHaveLength(0);
    expect(root.textContent).toBe(before);
    expect(document.activeElement).toBe(root);
  });

  test("面板内 Escape 不再往上冒，避免一次关掉两层", () => {
    const spy = vi.fn();
    document.addEventListener("keydown", spy);
    const view = openPanel();
    type("aa", view.container);
    settle();
    press("Escape");
    expect(spy).not.toHaveBeenCalled();
    document.removeEventListener("keydown", spy);
  });

  test("关闭按钮与 Escape 走同一条还原路径", () => {
    const view = openPanel();
    type("engine", view.container);
    settle();
    const before = root.textContent ?? "";
    fireEvent.click(view.getByLabelText("Close search"));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(root.textContent).toBe(before);
    expect(highlightVersion(root)).toBeNull();
  });

  test("卸载即还原：临时高亮不属于文档", () => {
    const view = openPanel();
    type("engine", view.container);
    settle();
    const before = root.textContent ?? "";
    expect(marks()).toHaveLength(4);
    view.unmount();
    expect(root.textContent).toBe(before);
    expect(marks()).toHaveLength(0);
  });

  test("图表子树不被高亮破坏，正文仍可交互（§9.4 末段）", () => {
    document.body.replaceChildren();
    root = document.createElement("div");
    root.className = "readora-document";
    root.innerHTML =
      "<p>engine text</p><div data-readora-diagram-container=\"mermaid\"><svg><text>engine</text></svg></div>";
    document.body.append(root);
    const before = root.textContent ?? "";
    const view = openPanel();
    type("engine", view.container);
    settle();
    expect(marks()).toHaveLength(1);
    expect(root.querySelector("svg text")?.textContent).toBe("engine");
    fireEvent.click(view.getByLabelText("Close search"));
    expect(root.textContent).toBe(before);
  });
});

describe("文档版本失效（§9.4 第 3 条）", () => {
  test("版本变化后重新搜索，旧结果与旧高亮都不保留", () => {
    const view = openPanel(1);
    type("engine", view.container);
    settle();
    expect(highlightVersion(root)).toBe(1);

    root.innerHTML =
      '<h2 id="overview" data-readora-heading="overview">Overview</h2><p>engine once</p>';
    view.rerender(
      <SearchPanel
        getRoot={() => root}
        documentId="file:///notes/search.md"
        documentVersion={2}
        onClose={onClose}
      />
    );
    settle();
    expect(marks()).toHaveLength(1);
    expect(highlightVersion(root)).toBe(2);
    expect(count(view.container)).toBe("1 / 1");
  });

  test("命中项 id 稳定可读，供跳转与还原配对", () => {
    const view = openPanel();
    type("engine", view.container);
    settle();
    const ids = marks().map((node) => node.getAttribute(SEARCH_HIT_ID_ATTRIBUTE));
    expect(new Set(ids).size).toBe(4);
    clearHighlights(root);
    expect(marks()).toHaveLength(0);
  });
});

describe("文档级快捷键（ARC-004 §4.5）", () => {
  function Shortcuts({ open, close }: { open(): void; close(): void }) {
    useSearchShortcuts({ open, close });
    return <span data-testid="hooked" />;
  }

  test("cmd/ctrl+f 打开搜索并阻止浏览器默认查找", () => {
    const open = vi.fn();
    const close = vi.fn();
    render(<Shortcuts open={open} close={close} />);
    const event = new KeyboardEvent("keydown", { key: "f", metaKey: true, bubbles: true, cancelable: true });
    document.dispatchEvent(event);
    expect(open).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true }));
    expect(open).toHaveBeenCalledTimes(2);
  });

  test("单独 f、Alt+F、其他修饰键都不接管", () => {
    const open = vi.fn();
    render(<Shortcuts open={open} close={vi.fn()} />);
    for (const init of [
      { key: "f" },
      { key: "f", altKey: true, metaKey: true },
      { key: "g", metaKey: true },
      { key: "F", shiftKey: true }
    ]) {
      document.dispatchEvent(new KeyboardEvent("keydown", { ...init, bubbles: true }));
    }
    expect(open).not.toHaveBeenCalled();
  });

  test("未打开时按 Escape 是 no-op，打开后关闭", () => {
    const open = vi.fn();
    const close = vi.fn();
    render(<Shortcuts open={open} close={close} />);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(close).toHaveBeenCalledTimes(1);
    expect(open).not.toHaveBeenCalled();
  });

  test("Lightbox、全屏图表或编辑手册在场时 Escape 让路（优先级：浮层 > 搜索）", () => {
    // 名单不逐字写死（每新增一类顶层浮层就要坏一次），断言的是「这三类都在名单里」，
    // 再各自造一次现场证明让路真的发生。
    expect(TOP_OVERLAY_SELECTOR).toContain(".readora-lightbox");
    expect(TOP_OVERLAY_SELECTOR).toContain(".readora-diagram--fullscreen");
    expect(TOP_OVERLAY_SELECTOR).toContain(`.${EDIT_HELP_DIALOG_CLASS}`);
    const close = vi.fn();
    render(<Shortcuts open={vi.fn()} close={close} />);
    const overlay = document.createElement("div");
    overlay.className = "readora-lightbox";
    document.body.append(overlay);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(close).not.toHaveBeenCalled();
    overlay.remove();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(close).toHaveBeenCalledTimes(1);

    // 手册挂在 `body` 上（与 Lightbox 同一形态），所以它必须在 document 这一层
    // 就被认出：否则一次 Escape 会同时收掉手册与搜索面板。
    close.mockClear();
    const help = document.createElement("div");
    help.className = EDIT_HELP_DIALOG_CLASS;
    document.body.append(help);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(close).not.toHaveBeenCalled();
    help.remove();
  });

  test("卸载后不再响应快捷键", () => {
    const open = vi.fn();
    const view = render(<Shortcuts open={open} close={vi.fn()} />);
    view.unmount();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "f", metaKey: true, bubbles: true }));
    expect(open).not.toHaveBeenCalled();
  });
});
