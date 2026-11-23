/**
 * 编辑模式的装配取证（ARC-009 §7.2 / §7.3 / §8，E2）。
 *
 * 这里只测**接线上才会成立**的五件事：
 * 1. 顶栏那枚开关改的是 App 的**本地 state**，一条 view→host 消息都不发
 *    （§7.2 原文「editMode 走 `reader.viewState` 通道」不可实现，本条把它钉成契约：
 *    将来谁想从这里补一条消息，得先改掉这条断言与它背后的理由）；
 * 2. 编辑 × 专注互斥（§7.3）：专注模式整段不渲染顶栏，所以互斥必须做在入口上，
 *    不能留一个「开着但看不见」的开关；
 * 3. `suspend` 随 `searchOpen`：搜索打开期间把手撤下、编辑单元挂起，关掉搜索回到原状；
 * 4. 导出取帧前先 `suspend()`：正在输入的草稿不得跟着克隆进交付物（ARC-008 §16.1）；
 * 5. 编辑手册（§7.5）入口只在编辑模式开着时存在，`?` 只叫手册不写字，
 *    退出编辑与点 Help 这两条路径各自兑现「不留浮层」与「不误提交」。
 *
 * 单元内部的键盘与冲突行为在 `content/edit/__tests__/edit-layer.spec.ts`，
 * 逐字节写回在 `tests/e2e/edit.spec.ts`，这里不重复。
 */
import { afterEach, describe, expect, test } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  READORA_ERROR_CODES,
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
import { EDIT_HELP_DIALOG_CLASS } from "../../content/interactions";
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

function helpTrigger(): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>('button[aria-label="Editing guide"]');
}

function helpPanel(): HTMLElement | null {
  return document.querySelector<HTMLElement>(`.${EDIT_HELP_DIALOG_CLASS}`);
}

/**
 * 点开手册，并把焦点交给触发器 —— jsdom 的合成 click 不移动焦点，
 * 真实点击会（与 `app-navigation.spec.tsx` 那条 Settings 弹层用例同一条口径），
 * 不这么做「弹层挂载时记下的触发器」就不是我们点的那一枚。
 */
function openHelp(): HTMLButtonElement {
  const trigger = helpTrigger() as HTMLButtonElement;
  trigger.focus();
  fireEvent.click(trigger);
  return trigger;
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

/**
 * 大纲章节结构菜单的接线（E7）：面板侧的动作形态在
 * `content/__tests__/outline-panel.spec.tsx`，这里只钉「接线才成立」的四件事：
 * 入口门槛、`document.edit` 出线形状、连续动作的版本记账、错误码到提示。
 * 夹具 `TEXT` 共 6 行（文件绝对行 0 基）：0 `# Edit` … 5 空行；唯一一节
 * 没有兄弟边界，所以新增落点钳在末行 5。
 */
describe("大纲结构菜单接线（E7）", () => {
  function openMenu(): void {
    fireEvent.click(screen.getByRole("button", { name: "Section actions for Edit" }));
  }

  function enableEditing(): void {
    fireEvent.click(editButton());
  }

  test("只读时零入口；开编辑后行尾出现 ⋯", () => {
    setup();
    expect(screen.queryByRole("button", { name: /Section actions for/ })).toBeNull();
    enableEditing();
    expect(screen.getByRole("button", { name: "Section actions for Edit" })).toBeTruthy();
  });

  test("动作发 `document.edit`：uri / 区间 / 文本 / baseVersion 全部现读快照", () => {
    const host = setup();
    enableEditing();
    openMenu();
    fireEvent.click(screen.getByRole("button", { name: "Add section after" }));
    expect(host.sent("document.edit")).toEqual([
      {
        documentUri: FILE_URI,
        range: { startLine: 5, endLine: 5 },
        newText: "\n# 新章节",
        baseVersion: 5
      }
    ]);
  });

  test("连续两笔动作：第二笔的 baseVersion 用上一笔回执，不被自己的回声误杀", async () => {
    const host = setup();
    enableEditing();
    openMenu();
    fireEvent.click(screen.getByRole("button", { name: "Add section after" }));
    act(() => {
      expect(host.respondTo("document.edit", { version: 6 })).toBe(true);
    });
    // 成功回执：菜单收起，且没有 document.update 回声（快照 version 仍停在 5）。
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Add section after" })).toBeNull();
    });
    openMenu();
    fireEvent.click(screen.getByRole("button", { name: "Add section after" }));
    const edits = host.sent("document.edit") as { baseVersion: number }[];
    expect(edits).toHaveLength(2);
    expect(edits[1]?.baseVersion).toBe(6);
  });

  test("换文档后版本记账重开：新文档用自家的 version", async () => {
    const host = setup();
    enableEditing();
    openMenu();
    fireEvent.click(screen.getByRole("button", { name: "Add section after" }));
    act(() => {
      host.respondTo("document.edit", { version: 6 });
    });
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Add section after" })).toBeNull();
    });
    act(() => {
      host.emit("document.load", {
        documentUri: "file:///vault/notes/second.md",
        languageId: "markdown",
        version: 1,
        text: TEXT,
        preferences: PREFERENCES
      });
    });
    openMenu();
    fireEvent.click(screen.getByRole("button", { name: "Add section after" }));
    const edits = host.sent("document.edit") as { documentUri: string; baseVersion: number }[];
    expect(edits[1]?.documentUri).toBe("file:///vault/notes/second.md");
    // 上一版的回执 6 泄漏进新文档就会让宿主把 baseVersion=6 判成未来版本；
    // 重置后应回到 max(1, -1) = 1。
    expect(edits[1]?.baseVersion).toBe(1);
  });

  test("stale 错误码 → 面板内一行提示，不是对话框也不是 reader.error", async () => {
    const host = setup();
    enableEditing();
    openMenu();
    fireEvent.click(screen.getByRole("button", { name: "Add section after" }));
    const before = host.posted
      .map((entry) => entry.type)
      .filter((type) => type !== "metrics.report");
    act(() => {
      expect(
        host.respondToError("document.edit", READORA_ERROR_CODES.EDIT_STALE, "base version 5 is gone")
      ).toBe(true);
    });
    await waitFor(() => {
      expect(
        document.querySelector('[data-readora-outline="section-note"]')
      ).toBeTruthy();
    });
    expect(
      document.querySelector('[data-readora-outline="section-note"]')?.textContent
    ).toContain("The document changed outside the outline");
    // 失败不新增任何出站消息（提示是纯本地；也不会退化成 reader.error 上报）。
    // metrics.report 不参与对比：渲染上报落在 waitFor 的任意帧里，与失败无关。
    expect(
      host.posted.map((entry) => entry.type).filter((type) => type !== "metrics.report")
    ).toEqual(before);
  });
});

/**
 * 编辑手册（ARC-009 §7.5）：产品诉求「进入编辑模式能有地方看帮助」的接线取证。
 * 弹层自己的键盘与内容契约在 `edit-help-dialog.spec.tsx`，这里只钉四条
 * 跨组件才成立的事：入口可见性、`?` 不写字、点 Help 不误提交、退出编辑不留浮层。
 */
describe("编辑手册入口（§7.5）", () => {
  test("只读态 DOM 里没有这一枚；开了编辑才出现", () => {
    setup();
    expect(helpTrigger()).toBeNull();
    fireEvent.click(editButton());
    expect(helpTrigger()).not.toBeNull();
  });

  test("点 Help 只开弹层：一条消息都不发，开关状态不被碰", () => {
    const host = setup();
    fireEvent.click(editButton());
    const before = host.posted.map((entry) => entry.type);
    openHelp();
    expect(helpPanel()).not.toBeNull();
    expect(helpTrigger()?.getAttribute("aria-expanded")).toBe("true");
    expect(pressed(editButton())).toBe("true");
    expect(host.sent("document.edit")).toHaveLength(0);
    expect(
      host.posted.map((entry) => entry.type).filter((type) => type !== "metrics.report")
    ).toEqual(before.filter((type) => type !== "metrics.report"));
  });

  test("Escape 先收手册：焦点归位触发器，编辑模式与把手原地不动", () => {
    setup();
    fireEvent.click(editButton());
    const trigger = openHelp();
    // Escape 落在弹层自己的焦点链上（真浏览器里弹层拿到焦点）；从 document 直发
    // 不经过容器，那一次按键根本不会达到面板的监听。
    const event = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true
    });
    act(() => {
      helpPanel()?.dispatchEvent(event);
    });
    // 那一次 Escape 归弹层自己接（它 `preventDefault` + `stopPropagation`）：
    // 只收手册，不得连带退出编辑模式。
    expect(event.defaultPrevented).toBe(true);
    expect(helpPanel()).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(pressed(editButton())).toBe("true");
    expect(handles().length).toBeGreaterThan(0);
  });

  test("活动单元的焦点交给手册：不算离开，不发出提交（§7.4 focusout 是提交）", () => {
    const host = setup();
    fireEvent.click(editButton());
    const block = paragraph(0);
    activate(block);
    block.textContent = "还没提交的输入";
    const trigger = helpTrigger() as HTMLButtonElement;
    // 两条路径都钉下来：
    // 1. 触发器自己标了 `data-readora-keep-editing` —— 焦点从单元走进它时
    //    不算「离开单元」（否则点一下 Help 就是一次失焦提交）；
    trigger.focus();
    expect(host.sent("document.edit")).toHaveLength(0);
    expect(block.getAttribute("contenteditable")).toBe("true");
    fireEvent.click(trigger);
    // 2. 弹层带 `role="dialog"`，已在 `edit-unit` 的 `KEEP_EDITING_SELECTOR` 里。
    const dialog = helpPanel() as HTMLElement;
    block.dispatchEvent(
      new FocusEvent("focusout", { bubbles: true, relatedTarget: dialog.querySelector("button") })
    );
    expect(host.sent("document.edit")).toHaveLength(0);
    expect(block.getAttribute("contenteditable")).toBe("true");
    expect(block.textContent).toBe("还没提交的输入");
    // 手册里没有第二套焦点陷阱把用户困住：Close 就在里面。
    expect(dialog.querySelector('button[aria-label="Close editing guide"]')).not.toBeNull();
  });

  /**
   * 从指定落点发出一次 `?` 并冒泡到 document。
   * 为什么不直接 `document.dispatchEvent`：真浏览器里 keydown 的 `event.target`
   * 就是焦点元素，判据（`shouldOpenEditHelp`）读的是落点；从 document 直发等于
   * 造一个浏览器里发不出的事件，那条落点护栏就被绕过了。
   */
  function pressQuestion(at: Element): KeyboardEvent {
    const event = new KeyboardEvent("keydown", { key: "?", bubbles: true, cancelable: true });
    act(() => {
      at.dispatchEvent(event);
    });
    return event;
  }

  test("`?` 只在编辑模式里叫出手册；单元里敲 `?` 是打一个字", () => {
    const host = setup();
    // 只读态：监听未注册，`?` 不产生任何界面变化。
    expect(pressQuestion(paragraph(0)).defaultPrevented).toBe(false);
    expect(helpPanel()).toBeNull();

    fireEvent.click(editButton());
    // 落点在正文段落上（idle，不是输入件）：`?` 叫出手册。
    const idle = paragraph(0);
    expect(pressQuestion(idle).defaultPrevented).toBe(true);
    expect(helpPanel()).not.toBeNull();
    // 键位不进协议：叫手册与点按钮同一条本地通道，不发 `document.edit`。
    expect(host.sent("document.edit")).toHaveLength(0);
    // 手册开着时再按一次：监听已不注册，面板节点不得因此重挂。
    const mounted = helpPanel();
    expect(pressQuestion(idle).defaultPrevented).toBe(false);
    expect(helpPanel()).toBe(mounted);

    // 手册先收掉（否则监听本就不注册，测不到那一条护栏）。
    fireEvent.keyDown(helpPanel() as HTMLElement, { key: "Escape" });
    expect(helpPanel()).toBeNull();
    // 落点在正在编辑的单元里：那里挨一个 `?` 是打一个字，不是叫手册。
    const block = paragraph(1);
    activate(block);
    expect(block.getAttribute("contenteditable")).toBe("true");
    const typed = pressQuestion(block);
    expect(helpPanel()).toBeNull();
    expect(typed.defaultPrevented).toBe(false);
    // 上面那一次敲字没有顺手提交（护栏只看落点，不停在手上的草稿）。
    expect(host.sent("document.edit")).toHaveLength(0);
  });

  test("退出编辑同时收掉手册（不留一个关不掉的浮层）", () => {
    setup();
    fireEvent.click(editButton());
    openHelp();
    expect(helpPanel()).not.toBeNull();
    fireEvent.click(editButton());
    expect(helpPanel()).toBeNull();
    expect(helpTrigger()).toBeNull();
    expect(handles()).toHaveLength(0);
  });

  test("开着编辑进专注：手册与顶栏一起收，不留一个没得点的浮层", () => {
    setup();
    fireEvent.click(editButton());
    openHelp();
    expect(helpPanel()).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Enter focus mode" }));
    expect(helpPanel()).toBeNull();
    expect(document.querySelector('[aria-label="Editing guide"]')).toBeNull();
  });
});
