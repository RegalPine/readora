/**
 * 格式化工具条取证（ARC-009 §6.3 / §7.4，E3）。
 *
 * 这个文件只管三件事，也都是**挂 `body` 换来的债**（决策 4 明记的代价）：
 * 1. 定位的边界（贴顶翻面、左右夹取）—— 纯函数，jsdom 里没有真像素，所以断言
 *    的是算法；真像素在 e2e 与 playwright-cli 取证里各断言一次；
 * 2. 焦点模型（roving tabindex 四键）—— 照 `ExportMenu.tsx` 的既有键盘模型；
 * 3. **零残留** —— 工具条不在正文子树里，接管层收不干净就会一直飘在屏上，
 *    而它在 `document.body` 上是一个可以直接数的节点。
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  EDIT_TOOLBAR_CLASS,
  createFormatToolbar,
  placeToolbar,
  type HeadingLevel,
  type ToolbarState
} from "../format-toolbar";
import type { InlineAction } from "../inline-format";

const mounted: HTMLElement[] = [];

afterEach(() => {
  for (const node of mounted.splice(0)) {
    node.remove();
  }
  // 工具条挂在 body 上：任何一条用例忘了 hide/destroy 都会污染下一条，
  // 这一句把污染变成失败而不是顺序依赖。
  for (const node of Array.from(document.body.querySelectorAll(`.${EDIT_TOOLBAR_CLASS}`))) {
    node.remove();
  }
});

function target(): HTMLElement {
  const block = document.createElement("p");
  block.textContent = "内容";
  document.body.appendChild(block);
  mounted.push(block);
  return block;
}

function state(overrides: Partial<ToolbarState> = {}): ToolbarState {
  return {
    canWrap: true,
    insideCode: false,
    isHeading: false,
    level: null,
    rect: { top: 200, left: 120 },
    ...overrides
  };
}

function recorded() {
  const actions: InlineAction[] = [];
  const levels: HeadingLevel[] = [];
  const urls: string[] = [];
  /** `onUrlOpen` 被叫到的那一刻的 `activeElement`：选区就是在这一帧被抄走的。 */
  const urlOpens: Array<string | null> = [];
  return {
    actions,
    levels,
    urls,
    urlOpens,
    handlers: {
      onAction: (action: InlineAction) => actions.push(action),
      onLevel: (level: HeadingLevel) => levels.push(level),
      onLink: (url: string) => urls.push(url),
      onUrlOpen: () => {
        urlOpens.push(document.activeElement?.tagName ?? null);
      }
    }
  };
}

describe("placeToolbar（纯函数，可穷举）", () => {
  const box = { top: 300, bottom: 320, left: 200 };
  const viewport = { width: 1_000, height: 800 };

  test("默认浮在选区上方，且与选区之间留出边距", () => {
    const placed = placeToolbar(box, viewport);
    expect(placed.top).toBeLessThan(box.top);
    expect(placed.left).toBe(200);
  });

  test("贴顶时翻到选区下方", () => {
    const placed = placeToolbar({ top: 10, bottom: 30, left: 40 }, viewport);
    expect(placed.top).toBeGreaterThan(30);
  });

  test("贴顶又贴底（选区比工具条还高）：贴着视口顶边，不跑负坐标", () => {
    const placed = placeToolbar({ top: 4, bottom: 796, left: 10 }, { width: 1_000, height: 120 });
    expect(placed.top).toBeGreaterThanOrEqual(0);
    expect(placed.top + 34).toBeLessThanOrEqual(120);
  });

  test("左右夹进视口：贴右不越界，贴左不为负", () => {
    const right = placeToolbar({ top: 300, bottom: 320, left: 990 }, viewport);
    expect(right.left).toBeLessThanOrEqual(1_000);
    expect(right.left).toBeGreaterThanOrEqual(0);
    const left = placeToolbar({ top: 300, bottom: 320, left: -80 }, viewport);
    expect(left.left).toBe(8);
  });

  test("视口窄于工具条时按视口宽夹取，不算出负数", () => {
    const placed = placeToolbar({ top: 100, bottom: 120, left: 50 }, { width: 200, height: 400 });
    expect(placed.left).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(placed.top)).toBe(true);
  });
});

describe("节点形态：文本字形 + aria-label（不新增 Icon）", () => {
  test("六枚动作按钮齐全，可见内容是字面字形", () => {
    const toolbar = createFormatToolbar(target(), recorded().handlers);
    toolbar.show(state());
    const glyphs = Array.from(
      toolbar.root.querySelectorAll<HTMLElement>(`.${EDIT_TOOLBAR_CLASS}__button`)
    )
      .filter(
        (button) =>
          button.closest(`.${EDIT_TOOLBAR_CLASS}__levels`) === null &&
          button.closest(`.${EDIT_TOOLBAR_CLASS}__url`) === null
      )
      .map((button) => `${button.textContent}/${button.getAttribute("aria-label")}`);
    expect(glyphs).toEqual([
      "B/Bold",
      "I/Italic",
      "S/Strikethrough",
      "<>/Inline code",
      "[]/Link",
      "[^n]/Footnote reference"
    ]);
    toolbar.destroy();
  });

  test("role=toolbar + aria-label=Formatting", () => {
    const toolbar = createFormatToolbar(target(), recorded().handlers);
    toolbar.show(state());
    expect(toolbar.root.getAttribute("role")).toBe("toolbar");
    expect(toolbar.root.getAttribute("aria-label")).toBe("Formatting");
    toolbar.destroy();
  });

  test("级别组只在 heading 时出现", () => {
    const toolbar = createFormatToolbar(target(), recorded().handlers);
    toolbar.show(state());
    expect(toolbar.root.querySelector<HTMLElement>(`.${EDIT_TOOLBAR_CLASS}__levels`)?.hidden).toBe(
      true
    );
    toolbar.show(state({ isHeading: true, level: 2 }));
    const group = toolbar.root.querySelector<HTMLElement>(`.${EDIT_TOOLBAR_CLASS}__levels`);
    expect(group?.hidden).toBe(false);
    expect(group?.querySelectorAll("button")).toHaveLength(6);
    toolbar.destroy();
  });
});

describe("可点性三档（决策 5 / §6.3）", () => {
  function disabledMap(toolbar: ReturnType<typeof createFormatToolbar>) {
    const out: Record<string, boolean> = {};
    for (const button of Array.from(
      toolbar.root.querySelectorAll<HTMLButtonElement>(`[data-readora-action]`)
    )) {
      out[button.dataset.readoraAction as string] = button.disabled;
    }
    return out;
  }

  test("无选区（canWrap=false）：四枚包裹 + 代码灰，脚注仍可点", () => {
    const toolbar = createFormatToolbar(target(), recorded().handlers);
    toolbar.show(state({ canWrap: false }));
    expect(disabledMap(toolbar)).toEqual({
      bold: true,
      italic: true,
      strike: true,
      code: true,
      link: true,
      footnote: false
    });
    toolbar.destroy();
  });

  test("代码段内：bold/italic/strike/link 四枚灰，code 仍可用（它自己走解包）", () => {
    const toolbar = createFormatToolbar(target(), recorded().handlers);
    toolbar.show(state({ insideCode: true }));
    const disabled = disabledMap(toolbar);
    expect([disabled.bold, disabled.italic, disabled.strike, disabled.link]).toEqual([
      true,
      true,
      true,
      true
    ]);
    expect(disabled.code).toBe(false);
    toolbar.destroy();
  });

  test("当前级别 aria-pressed=true 且灰；解析不出 ATX 前缀时六枚全灰", () => {
    const toolbar = createFormatToolbar(target(), recorded().handlers);
    toolbar.show(state({ isHeading: true, level: 3 }));
    const group = toolbar.root.querySelector(`.${EDIT_TOOLBAR_CLASS}__levels`);
    const pressed = Array.from(group?.querySelectorAll<HTMLButtonElement>("button") ?? []).map(
      (button) => `${button.dataset.readoraLevel}:${button.getAttribute("aria-pressed")}:${button.disabled}`
    );
    expect(pressed).toEqual([
      "1:false:false",
      "2:false:false",
      "3:true:true",
      "4:false:false",
      "5:false:false",
      "6:false:false"
    ]);
    toolbar.show(state({ isHeading: true, level: null }));
    expect(
      Array.from(group?.querySelectorAll<HTMLButtonElement>("button") ?? []).every(
        (button) => button.disabled
      )
    ).toBe(true);
    toolbar.destroy();
  });
});

describe("点击与键盘", () => {
  test("五个动作各回一次 onAction，级别回 onLevel", () => {
    const scope = recorded();
    const toolbar = createFormatToolbar(target(), scope.handlers);
    toolbar.show(state({ isHeading: true, level: 1 }));
    for (const action of ["bold", "italic", "strike", "code", "footnote"] as const) {
      toolbar.root
        .querySelector<HTMLButtonElement>(`[data-readora-action="${action}"]`)
        ?.click();
    }
    toolbar.root.querySelector<HTMLButtonElement>(`[data-readora-level="4"]`)?.click();
    expect(scope.actions).toEqual(["bold", "italic", "strike", "code", "footnote"]);
    expect(scope.levels).toEqual([4]);
    toolbar.destroy();
  });

  test("点链接不立刻发动作，而是展开 URL 输入框；回车才带上地址", () => {
    const scope = recorded();
    const toolbar = createFormatToolbar(target(), scope.handlers);
    toolbar.show(state());
    toolbar.root.querySelector<HTMLButtonElement>(`[data-readora-action="link"]`)?.click();
    expect(scope.actions).toEqual([]);
    expect(scope.urls).toEqual([]);
    expect(toolbar.awaitingUrl).toBe(true);
    const input = toolbar.root.querySelector<HTMLInputElement>(
      `.${EDIT_TOOLBAR_CLASS}__url-input`
    );
    expect(input).not.toBeNull();
    input!.value = "https://example.com";
    input!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(scope.urls).toEqual(["https://example.com"]);
    expect(toolbar.awaitingUrl).toBe(false);
    toolbar.destroy();
  });

  test("URL 输入框里的 Escape 只收输入框，不退整次编辑（嵌套提示优先）", () => {
    const scope = recorded();
    const toolbar = createFormatToolbar(target(), scope.handlers);
    toolbar.show(state());
    toolbar.root.querySelector<HTMLButtonElement>(`[data-readora-action="link"]`)?.click();
    const input = toolbar.root.querySelector<HTMLInputElement>(
      `.${EDIT_TOOLBAR_CLASS}__url-input`
    );
    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    input?.dispatchEvent(event);
    expect(toolbar.awaitingUrl).toBe(false);
    expect(scope.urls).toEqual([]);
    expect(event.defaultPrevented).toBe(true);
    toolbar.destroy();
  });

  test("onUrlOpen 在 `focus()` 之前发出（e2e 跑出来的那个时间差）", () => {
    // Chromium 的文档选区属于当前焦点控件：焦点一进 `<input>` 正文里那段选区就没了。
    // 接管层要在还能读的时候读，所以这一条**顺序**断言不是吹毛求疵：
    // 把 `handlers.onUrlOpen()` 挪到 `urlInput.focus()` 之后，这里就会红。
    const scope = recorded();
    const toolbar = createFormatToolbar(target(), scope.handlers);
    toolbar.show(state());
    toolbar.root.querySelector<HTMLButtonElement>(`[data-readora-action="link"]`)?.click();
    expect(scope.urlOpens).toEqual(["BODY"]);
    const input = toolbar.root.querySelector<HTMLInputElement>(
      `.${EDIT_TOOLBAR_CLASS}__url-input`
    );
    expect(document.activeElement).toBe(input);
    toolbar.destroy();
  });

  test("输入框一收起就交回焦点：提交、Escape、`hide` 三条路径都是", () => {
    // 焦点留在工具条里 = 接管层接下来那一次 `addRange` 落不下去，
    // 也 = 后续的 `Ctrl+Enter` 递给输入框而不是单元。
    const scope = recorded();
    const toolbar = createFormatToolbar(target(), scope.handlers);
    toolbar.show(state());
    const linkButton = toolbar.root.querySelector<HTMLButtonElement>(
      `[data-readora-action="link"]`
    );
    const input = toolbar.root.querySelector<HTMLInputElement>(
      `.${EDIT_TOOLBAR_CLASS}__url-input`
    ) as HTMLInputElement;

    linkButton?.click();
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(document.activeElement).not.toBe(input);

    linkButton?.click();
    expect(document.activeElement).toBe(input);
    input.value = "https://example.com";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(scope.urls).toEqual(["https://example.com"]);
    expect(document.activeElement).not.toBe(input);

    linkButton?.click();
    toolbar.hide();
    expect(document.activeElement).not.toBe(input);
    toolbar.destroy();
  });

  test("roving tabindex：整条工具条在 tab 序列里只占一格，方向键在可用件之间循环", () => {
    const toolbar = createFormatToolbar(target(), recorded().handlers);
    toolbar.show(state());
    const buttons = Array.from(
      toolbar.root.querySelectorAll<HTMLButtonElement>(`[data-readora-action]`)
    );
    expect(buttons.filter((button) => button.tabIndex === 0)).toHaveLength(1);
    const first = buttons[0] as HTMLButtonElement;
    first.focus();
    const root = toolbar.root;
    function key(name: string): void {
      root.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }));
    }
    key("ArrowRight");
    expect(document.activeElement).toBe(buttons[1]);
    key("End");
    expect(document.activeElement).toBe(buttons[buttons.length - 1]);
    key("ArrowRight");
    expect(document.activeElement).toBe(buttons[0]);
    key("ArrowLeft");
    expect(document.activeElement).toBe(buttons[buttons.length - 1]);
    key("Home");
    expect(document.activeElement).toBe(buttons[0]);
    toolbar.destroy();
  });

  test("灰掉的按钮不进方向键序列", () => {
    const toolbar = createFormatToolbar(target(), recorded().handlers);
    toolbar.show(state({ canWrap: false }));
    // 只剩脚注一枚可点：任何方向键都把它留在焦点上
    const footnote = toolbar.root.querySelector<HTMLButtonElement>(
      `[data-readora-action="footnote"]`
    );
    toolbar.root.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true })
    );
    expect(document.activeElement).toBe(footnote);
    toolbar.destroy();
  });
});

describe("生命周期（挂 body 的代价）", () => {
  test("show 挂在 body 上，不在正文子树里", () => {
    const block = target();
    const toolbar = createFormatToolbar(block, recorded().handlers);
    toolbar.show(state());
    expect(document.body.contains(toolbar.root)).toBe(true);
    expect(block.contains(toolbar.root)).toBe(false);
    expect(document.body.querySelectorAll(`.${EDIT_TOOLBAR_CLASS}`)).toHaveLength(1);
    toolbar.destroy();
  });

  test("重复 show 不重复挂载", () => {
    const toolbar = createFormatToolbar(target(), recorded().handlers);
    toolbar.show(state());
    toolbar.show(state({ rect: { top: 10, left: 10 } }));
    expect(document.body.querySelectorAll(`.${EDIT_TOOLBAR_CLASS}`)).toHaveLength(1);
    toolbar.destroy();
  });

  test("hide / destroy 之后 body 上零残留", () => {
    const toolbar = createFormatToolbar(target(), recorded().handlers);
    toolbar.show(state());
    toolbar.hide();
    expect(document.body.querySelectorAll(`.${EDIT_TOOLBAR_CLASS}`)).toHaveLength(0);
    expect(toolbar.root.hidden).toBe(true);
    toolbar.show(state());
    toolbar.destroy();
    expect(document.body.querySelectorAll(`.${EDIT_TOOLBAR_CLASS}`)).toHaveLength(0);
  });

  test("hide 会把展开中的 URL 输入框一起收掉（下次 show 不带着上次的地址）", () => {
    const toolbar = createFormatToolbar(target(), recorded().handlers);
    toolbar.show(state());
    toolbar.root.querySelector<HTMLButtonElement>(`[data-readora-action="link"]`)?.click();
    const input = toolbar.root.querySelector<HTMLInputElement>(
      `.${EDIT_TOOLBAR_CLASS}__url-input`
    );
    input!.value = "https://stale.test";
    toolbar.hide();
    expect(toolbar.awaitingUrl).toBe(false);
    toolbar.show(state());
    expect(
      toolbar.root.querySelector<HTMLElement>(`.${EDIT_TOOLBAR_CLASS}__url`)?.hidden
    ).toBe(true);
    expect(
      (toolbar.root.querySelector<HTMLInputElement>(`.${EDIT_TOOLBAR_CLASS}__url-input`) ?? input)!
        .value
    ).toBe("");
    toolbar.destroy();
  });

  test("mousedown 全件 preventDefault：焦点转移不吞选区", () => {
    const toolbar = createFormatToolbar(target(), recorded().handlers);
    toolbar.show(state());
    const seen: string[] = [];
    for (const node of Array.from(
      toolbar.root.querySelectorAll<HTMLElement>("button, input")
    )) {
      const event = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
      node.dispatchEvent(event);
      seen.push(`${node.tagName}:${event.defaultPrevented}`);
    }
    expect(seen.every((entry) => entry.endsWith(":true"))).toBe(true);
    expect(seen.length).toBeGreaterThanOrEqual(7);
    toolbar.destroy();
  });

  test("定位写进 inline style（position:fixed + 视口坐标）", () => {
    const toolbar = createFormatToolbar(target(), recorded().handlers);
    const innerWidth = vi.spyOn(window, "innerWidth", "get").mockReturnValue(1_200);
    const innerHeight = vi.spyOn(window, "innerHeight", "get").mockReturnValue(900);
    toolbar.show(state({ rect: { top: 400, left: 300 } }));
    expect(toolbar.root.style.position).toBe("fixed");
    expect(toolbar.root.style.top).toBe("358px");
    expect(toolbar.root.style.left).toBe("300px");
    innerWidth.mockRestore();
    innerHeight.mockRestore();
    toolbar.destroy();
  });
});
