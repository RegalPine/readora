/**
 * 编辑模式的装配取证（ARC-009 §7.2 / §7.3 / §8，E2）。
 *
 * 这里只测**接线上才会成立**的四件事：
 * 1. 顶栏那枚开关改的是 App 的**本地 state**，一条 view→host 消息都不发
 *    （§7.2 原文「editMode 走 `reader.viewState` 通道」不可实现，本条把它钉成契约：
 *    将来谁想从这里补一条消息，得先改掉这条断言与它背后的理由）；
 * 2. 编辑 × 专注互斥（§7.3）：专注模式整段不渲染顶栏，所以互斥必须做在入口上，
 *    不能留一个「开着但看不见」的开关；
 * 3. `suspend` 随 `searchOpen`：搜索打开期间把手撤下、编辑单元挂起，关掉搜索回到原状；
 * 4. 导出取帧前先 `suspend()`：正在输入的草稿不得跟着克隆进交付物（ARC-008 §16.1）。
 *
 * 单元内部的键盘与冲突行为在 `content/edit/__tests__/edit-layer.spec.ts`，
 * 逐字节写回在 `tests/e2e/edit.spec.ts`，这里不重复。
 */
import { afterEach, describe, expect, test } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  type DocumentLoadPayload,
  type ExportDataPayload,
  type ReaderPreferences
} from "@readora/contracts";
import { createBridgeHarness, type BridgeHarness } from "../../__tests__/bridge-harness";
import {
  EDIT_CONFLICT_CLASS,
  EDITABLE_ATTRIBUTE,
  EDIT_STATE_ATTRIBUTE
} from "../../content/edit/edit-unit";
import { EDIT_UNAVAILABLE_TITLE } from "../../content/edit/limits";
import { App } from "../App";

const FILE_URI = "file:///vault/notes/edit-mode.md";
const UNTITLED_URI = "untitled:Untitled-1";

const PREFERENCES: ReaderPreferences = {
  theme: "auto",
  fontSize: 17,
  lineHeight: 1.8,
  contentWidth: 720,
  showOutline: true,
  typography: "newsreader",
  themePreset: "default"
};

const TEXT = ["# Edit", "", "第一段内容。", "", "第二段内容。", ""].join("\n");

afterEach(cleanup);

function setup(documentUri = FILE_URI): BridgeHarness {
  const host = createBridgeHarness();
  render(<App bridge={host.bridge} />);
  const payload: DocumentLoadPayload = {
    documentUri,
    languageId: "markdown",
    version: 5,
    text: TEXT,
    preferences: PREFERENCES
  };
  act(() => {
    host.emit("document.load", payload);
    host.emit("theme.update", { theme: "light", source: "product" });
  });
  return host;
}

function editButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: "Edit mode" }) as HTMLButtonElement;
}

function pressed(button: Element): string | null {
  return button.getAttribute("aria-pressed");
}

function handles(): Element[] {
  return [...document.querySelectorAll(`[${EDITABLE_ATTRIBUTE}]`)];
}

function paragraph(index = 0): HTMLElement {
  return document.querySelectorAll<HTMLElement>(".readora-paragraph")[index] as HTMLElement;
}

function activate(block: HTMLElement): void {
  block.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
}

function searchPressed(): string | null {
  const trigger = document.querySelector<HTMLElement>('[aria-label="Search in document"]');
  return trigger ? trigger.getAttribute("aria-pressed") : null;
}

describe("开关 = 本地 state（§7.2）", () => {
  test("默认只读：没有把手，开关未按下", () => {
    setup();
    expect(handles()).toHaveLength(0);
    expect(pressed(editButton())).toBe("false");
    expect(editButton().disabled).toBe(false);
  });

  test("点一下只改界面，**不产生任何 view→host 消息**", () => {
    const host = setup();
    const before = host.posted.map((entry) => entry.type);
    fireEvent.click(editButton());
    const after = host.posted.map((entry) => entry.type);
    expect(after).toEqual(before);
    expect(host.sent("document.edit")).toHaveLength(0);
    expect(host.sent("config.patch")).toHaveLength(0);
    expect(pressed(editButton())).toBe("true");
    // 把手真的出现了，而且只落在认领的四类上（本篇夹具里 1 个标题 + 2 个段落）。
    expect(handles().map((node) => node.getAttribute(EDITABLE_ATTRIBUTE))).toEqual([
      "heading",
      "paragraph",
      "paragraph"
    ]);
  });

  test("再点一次回到静态形态", () => {
    setup();
    fireEvent.click(editButton());
    fireEvent.click(editButton());
    expect(handles()).toHaveLength(0);
    expect(document.querySelectorAll(`[${EDIT_STATE_ATTRIBUTE}]`)).toHaveLength(0);
  });
});

describe("编辑 × 专注互斥（§7.3）", () => {
  test("开着编辑进专注：编辑被清除，退出专注后仍是关的", () => {
    setup();
    fireEvent.click(editButton());
    expect(pressed(editButton())).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Enter focus mode" }));
    // 专注那一段顶栏整块不渲染，所以「看得见却点不到」的开关不可能存在。
    expect(document.querySelector('[aria-label="Edit mode"]')).toBeNull();
    expect(document.querySelector('[aria-label="Exit focus mode"]')).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Exit focus mode" }));
    expect(pressed(editButton())).toBe("false");
    expect(handles()).toHaveLength(0);
  });

  test("开着专注找不到编辑入口", () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Enter focus mode" }));
    expect(document.querySelector('[aria-label="Edit mode"]')).toBeNull();
  });
});

describe("挂起随 searchOpen（§7.3）", () => {
  test("搜索打开撤把手，关掉搜索回到原状（编辑模式不被清除）", () => {
    setup();
    fireEvent.click(editButton());
    expect(handles().length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Search in document" }));
    expect(searchPressed()).toBe("true");
    expect(handles()).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Search in document" }));
    expect(handles().length).toBeGreaterThan(0);
    expect(pressed(editButton())).toBe("true");
  });

  test("搜索打开时正在输入的块进卡片，卡片上的 Escape 不收搜索面板", () => {
    setup();
    fireEvent.click(editButton());
    const block = paragraph(0);
    activate(block);
    block.textContent = "还没提交的输入";
    fireEvent.click(screen.getByRole("button", { name: "Search in document" }));
    const card = document.querySelector<HTMLElement>(`.${EDIT_CONFLICT_CLASS}`);
    expect(card?.getAttribute("data-readora-edit-reason")).toBe("search");
    expect(card?.textContent).toContain("还没提交的输入");
    // Escape 落在卡片里 = 放弃这份输入；面板不能被这一次按键一起关掉（防串）。
    const event = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true
    });
    act(() => {
      card?.querySelector("button")?.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    expect(document.querySelector(`.${EDIT_CONFLICT_CLASS}`)).toBeNull();
    expect(searchPressed()).toBe("true");
    // 输入没有悄悄落进正文：那块回到静态产物。
    expect(paragraph(0).textContent).toBe("第一段内容。");
  });
  test("「继续编辑」反过来请宿主关搜索，草稿回到块里（§7.3）", () => {
    setup();
    fireEvent.click(editButton());
    const block = paragraph(0);
    activate(block);
    block.textContent = "被搜索打断的输入";
    fireEvent.click(screen.getByRole("button", { name: "Search in document" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue editing" }));
    // 挂起信号归 App 所有：接管层只转达，由这里把面板关掉
    expect(searchPressed()).toBe("false");
    expect(document.querySelector(`.${EDIT_CONFLICT_CLASS}`)).toBeNull();
    expect(block.getAttribute("contenteditable")).toBe("true");
    expect(block.textContent).toBe("被搜索打断的输入");
    // 输入仍然没落盘：正文里只能在这一个块上看到它
    expect(paragraph(1).textContent).toBe("第二段内容。");
  });
});

describe("导出取帧前先挂起（ARC-008 §16.1）", () => {
  test("export.capture 到达时正在输入的草稿不进交付物", () => {
    const host = setup();
    fireEvent.click(editButton());
    const block = paragraph(0);
    activate(block);
    block.textContent = "正在输入的草稿";
    act(() => {
      host.emit("export.capture", { requestId: "exp-edit-1", format: "html" });
    });
    const [data] = host.sent("export.data") as ExportDataPayload[];
    expect(data).toBeDefined();
    expect(data?.bodyHtml).not.toContain("正在输入的草稿");
    expect(data?.bodyHtml).toContain("第一段内容。");
    // 交付物里没有编辑态的三种痕迹
    expect(data?.bodyHtml).not.toContain(EDITABLE_ATTRIBUTE);
    expect(data?.bodyHtml).not.toContain(EDIT_CONFLICT_CLASS);
    expect(data?.bodyHtml).not.toContain("contenteditable");
    // 取帧之后界面自己进入挂起态：块不再是可编辑的，输入留在卡片里可手选。
    expect(block.getAttribute("contenteditable")).toBeNull();
    expect(document.querySelector(`.${EDIT_CONFLICT_CLASS}`)).not.toBeNull();
  });
});

describe("不可写文档（§7.2 的禁用而非隐藏）", () => {
  test("untitled 文档：Edit 禁用 + 说明，双击也不激活", () => {
    const host = setup(UNTITLED_URI);
    const button = editButton();
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("title")).toBe(EDIT_UNAVAILABLE_TITLE);
    fireEvent.click(button);
    expect(pressed(button)).toBe("false");
    expect(handles()).toHaveLength(0);
    expect(host.sent("document.edit")).toHaveLength(0);
    expect(host.sent("reader.error")).toHaveLength(0);
  });

  test("同一面板里换成 file: 文档后开关可用", () => {
    const host = setup(UNTITLED_URI);
    expect(editButton().disabled).toBe(true);
    act(() => {
      host.emit("document.load", {
        documentUri: FILE_URI,
        languageId: "markdown",
        version: 1,
        text: TEXT,
        preferences: PREFERENCES
      });
    });
    expect(editButton().disabled).toBe(false);
    fireEvent.click(editButton());
    expect(handles().length).toBeGreaterThan(0);
  });
});
