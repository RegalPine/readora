/**
 * 编辑接管层取证（ARC-009 §5.3 / §5.4 / §7.1 / §7.3 / §7.4 / §9.5，E2 · STORY-13-03）。
 *
 * 全部跑在 jsdom：接管层是纯 DOM 对象 + 一个注进去的 `EditPort`，不需要起浏览器
 * （浏览器那一份证据在 `tests/e2e/edit.spec.ts`）。三条写法上的约定：
 * 1. 正文产物来自**真跑一遍** renderMarkdown，不手写 DOM —— 本层依赖 E0 的
 *    `data-readora-source-range` 落点，手写的夹具会把它想当然；
 * 2. 「外部快照到达」一律走 `rewrite()`，它照 `MarkdownContent` 那三步
 *    （`detachForRewrite → innerHTML → scan`）执行，取证的是真实时序不是理想化调用；
 * 3. 冲突保全的证据是**节点身份**（`toBe`），不是文本相似：用户正在打的字活在
 *    那个 DOM 节点里，源文件里还没有，被 innerHTML 端掉就是丢输入。
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  READORA_ERROR_CODES,
  type DocumentEditResult
} from "@readora/contracts";
import { SOURCE_RANGE_ATTRIBUTE, renderMarkdown } from "@readora/markdown-core";
import {
  createEditLayer,
  type EditLayer,
  type EditPort,
  type EditSubmitRequest
} from "../edit-layer";
import {
  EDITABLE_ATTRIBUTE,
  EDIT_ACTIVE_STATE,
  EDIT_CONFLICT_CLASS,
  EDIT_CONFLICT_STATE,
  EDIT_MODE_ATTRIBUTE,
  EDIT_STATE_ATTRIBUTE
} from "../edit-unit";
import { EDIT_BLOCK_MAX_SOURCE_LENGTH, EDIT_CONFLICT_MESSAGES } from "../limits";
import { renderedTextOf } from "../source-text";
import { EDIT_TOOLBAR_CLASS } from "../format-toolbar";
import {
  EDIT_FOOTNOTE_NOTE,
  EDIT_INSIDE_CODE_NOTE,
  EDIT_LEVEL_UNAVAILABLE_NOTE,
  EDIT_MULTILINE_WRAP_NOTE,
  EDIT_SELECTION_UNMAPPED_NOTE
} from "../limits";
import { readEditableText } from "../source-text";
import type { FormatSelection } from "../selection-map";

const DOC_URI = "file:///vault/doc.md";

const TWO_BLOCKS = "# 标题\n\n第一段。\n\n第二段。\n";

function staticHtml(text: string): string {
  const result = renderMarkdown({
    documentId: DOC_URI,
    documentUri: DOC_URI,
    version: 1,
    text,
    theme: "light"
  });
  const host = document.createElement("div");
  host.innerHTML = result.html;
  return host.innerHTML;
}

/** 同一份文本里某个 rangeKey 的**静态**产物：与屏上那一段比，只可能差把手属性。 */
function staticBlockHtml(text: string, rangeKey: string): string {
  const host = document.createElement("div");
  host.innerHTML = staticHtml(text);
  return (host.querySelector(`[${SOURCE_RANGE_ATTRIBUTE}="${rangeKey}"]`) as HTMLElement).innerHTML;
}

interface SetupOptions {
  text?: string;
  version?: number;
  documentUri?: string;
  /** 写回应答替身：默认成功并把版本号前进一格（与 Host 的 `applyEdit` 同形）。 */
  submit?: (request: EditSubmitRequest) => Promise<DocumentEditResult>;
  /** 「继续编辑」的向上请求（相当于 App 把 `searchOpen` 改回假）。 */
  onResume?: () => void;
  /**
   * 选区注入口（E3 / 决策 4）：jsdom 有 `getSelection` 但它对选区的维护不可依赖，
   * 于是格式化那几条用例把端点直接交进来，真实选区读取归 e2e。
   */
  selection?: () => FormatSelection | undefined | null;
}

interface Harness {
  container: HTMLElement;
  layer: EditLayer;
  requests: EditSubmitRequest[];
  block(index: number): HTMLElement;
  /** 按 rangeKey 取块：冲突卡片就插在块后，用下标会数到卡片。 */
  blockByRange(rangeKey: string): HTMLElement | null;
  rangeKey(index: number): string;
  version(): number;
  uri(): string;
  setUri(next: string): void;
  /** 外部快照到达：detachForRewrite → innerHTML → scan，与 MarkdownContent 同三步。 */
  rewrite(nextText: string, nextVersion?: number): void;
  open(index: number): HTMLElement;
  type(block: HTMLElement, text: string): void;
  /** 把「当前活动单元文本空间的 `[from,to)`」注入成选区（E3）。 */
  select(from: number, to: number): void;
  /** 同上，但两个端点分别落在两个节点上（跨 `<li>` 的选区长这样）。 */
  selectPoints(start: DomPoint, end: DomPoint): void;
  /** 选区消失（真浏览器里焦点进 `<input>` 就是这一形态）并刷一次工具条。 */
  clearSelection(): void;
  flush(): Promise<void>;
}

/** 选区端点（与 `selection-map.ts` 的 `DomPoint` 同形）。 */
interface DomPoint {
  node: Node;
  offset: number;
}

const cleanups: Array<() => void> = [];

function setup(options: SetupOptions = {}): Harness {
  let text = options.text ?? TWO_BLOCKS;
  let version = options.version ?? 1;
  let documentUri = options.documentUri ?? DOC_URI;
  const container = document.createElement("div");
  container.className = "readora-document";
  document.body.appendChild(container);
  const requests: EditSubmitRequest[] = [];
  const submit =
    options.submit ??
    (async () => {
      version += 1;
      return { version };
    });
  const port: EditPort = {
    submit(request) {
      requests.push(request);
      return submit(request);
    },
    documentUri: () => documentUri,
    version: () => version
  };
  /** 注入的选区：`select` 写它，`selection` 读它。 */
  let injected: FormatSelection | null = null;
  const layer = createEditLayer({
    port,
    source: () => text,
    onResume: options.onResume,
    selection: options.selection ?? (() => injected)
  });

  function write(): void {
    container.innerHTML = staticHtml(text);
    container.setAttribute("data-readora-document-version", String(version));
  }

  function activeBlock(): HTMLElement {
    const key = layer.snapshot().activeRangeKey;
    const block = key === null ? null : findByRange(key);
    if (!block) {
      throw new Error("no active block: call open() first");
    }
    return block;
  }

  function findByRange(rangeKey: string): HTMLElement | null {
    return container.querySelector<HTMLElement>(`[${SOURCE_RANGE_ATTRIBUTE}="${rangeKey}"]`);
  }

  /**
   * 注入选区后补一发 `keyup`：真实浏览器里选中就是 keyup / mouseup / `selectionchange`
   * 之一，而工具条的可点性正是被它们刷新的。少这一发就是在测一个不存在的时序。
   */
  function inject(selection: FormatSelection, block: HTMLElement): void {
    injected = selection;
    block.dispatchEvent(new Event("keyup", { bubbles: true }));
  }

  write();
  layer.scan(container);
  layer.setAvailable(true);
  layer.setEditMode(true);
  cleanups.push(() => {
    layer.destroy();
    container.remove();
  });

  return {
    container,
    layer,
    requests,
    block(index) {
      const block = container.children[index] as HTMLElement;
      if (!block) {
        throw new Error(`block ${index} missing`);
      }
      return block;
    },
    blockByRange(rangeKey) {
      return findByRange(rangeKey);
    },
    rangeKey(index) {
      return this.block(index).getAttribute(SOURCE_RANGE_ATTRIBUTE) as string;
    },
    version: () => version,
    uri: () => documentUri,
    setUri(next) {
      documentUri = next;
    },
    rewrite(nextText, nextVersion = version + 1) {
      text = nextText;
      version = nextVersion;
      // 与 MarkdownContent 同三步：少一步「摘」就是在测一个不存在的时序。
      layer.detachForRewrite();
      write();
      layer.scan(container);
    },
    open(index) {
      const block = this.block(index);
      block.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
      return block;
    },
    type(block, next) {
      block.textContent = next;
    },
    select(from, to) {
      const block = activeBlock();
      // `normalize` 不是多余一步：真浏览器打字会把相邻文本节点合起来，
      // 而 jsdom 的 `Range#insertNode` 不会 —— 上一步刚插完标记，不合就会
      // 拿到一个只占半句的节点，下标语义与真浏览器对不上。
      block.normalize();
      const node = firstTextNode(block);
      inject({ start: { node, offset: from }, end: { node, offset: to } }, block);
    },
    selectPoints(start, end) {
      inject({ start, end }, activeBlock());
    },
    clearSelection() {
      injected = null;
      activeBlock().dispatchEvent(new Event("keyup", { bubbles: true }));
    },
    flush() {
      return new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
    }
  };
}

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
  vi.restoreAllMocks();
});

function ctrlEnter(block: HTMLElement): void {
  block.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, cancelable: true })
  );
}

function escape(block: HTMLElement): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  block.dispatchEvent(event);
  return event;
}

function focusOut(block: HTMLElement, relatedTarget: EventTarget | null): void {
  block.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget }));
}

function rejectWith(code: string): Promise<never> {
  // `HostBridge` 的 reject 消息形状（ARC-005 §6）：本层就靠这一串取错误码。
  return Promise.reject(new Error(`Readora: ${code}: stubbed rejection`));
}

function card(container: HTMLElement): HTMLElement | null {
  return container.parentElement?.querySelector(`.${EDIT_CONFLICT_CLASS}`) ?? null;
}

/** 块内第一个文本节点：形态 A 的段落/标题与形态 B 的整块都只有一个，够用。 */
function firstTextNode(block: HTMLElement): Text {
  const walker = block.ownerDocument?.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  const found = walker?.nextNode();
  if (!found) {
    throw new Error(`no text node in ${block.tagName}`);
  }
  return found as Text;
}

/** 工具条挂在 `body` 上（决策 4），所以取证不从正文容器里找。 */
function toolbarRoot(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>(`.${EDIT_TOOLBAR_CLASS}`);
}

function toolbarCount(): number {
  return document.body.querySelectorAll(`.${EDIT_TOOLBAR_CLASS}`).length;
}

function toolButton(action: string): HTMLButtonElement {
  const button = toolbarRoot()?.querySelector<HTMLButtonElement>(
    `[data-readora-action="${action}"]`
  );
  if (!button) {
    throw new Error(`toolbar action "${action}" missing`);
  }
  return button;
}

function levelButton(level: number): HTMLButtonElement {
  const button = toolbarRoot()?.querySelector<HTMLButtonElement>(
    `[data-readora-level="${level}"]`
  );
  if (!button) {
    throw new Error(`toolbar level "${level}" missing`);
  }
  return button;
}

/** 点一枚动作按钮（disabled 按钮收不到 click，这本身就是 §6.3 屏蔽那一条的断言）。 */
function clickTool(action: string): void {
  toolButton(action).click();
}

function note(container: HTMLElement): string | null {
  return container.querySelector(".readora-inline-note")?.textContent ?? null;
}

function cardButtons(node: HTMLElement): string[] {
  return Array.from(node.querySelectorAll("button")).map((button) =>
    (button.textContent ?? "").trim()
  );
}

function clickCardButton(node: HTMLElement, label: string): void {
  const button = Array.from(node.querySelectorAll("button")).find(
    (candidate) => (candidate.textContent ?? "").trim() === label
  ) as HTMLButtonElement | undefined;
  if (!button) {
    throw new Error(`card button "${label}" missing`);
  }
  button.click();
}

describe("认领表（§6.1 / §15-5）", () => {
  test("四类顶层区块拿把手，表格 / 分隔线 / 代码 / 公式不拿", () => {
    const h = setup({
      text: "段落。\n\n## 标题\n\n> 引用\n\n- 项\n\n| a |\n| - |\n| 1 |\n\n---\n\n```js\nlet a = 1\n```\n\n$$\nx^2\n$$\n"
    });
    const marked = Array.from(h.container.querySelectorAll(`[${EDITABLE_ATTRIBUTE}]`)).map(
      (node) => `${node.tagName}:${node.getAttribute(EDITABLE_ATTRIBUTE)}`
    );
    expect(marked).toEqual([
      "P:paragraph",
      "H2:heading",
      "BLOCKQUOTE:blockquote",
      "UL:list"
    ]);
    // 没被认领的那些块上连 tabindex 都不该有（键盘 Tab 序列不被污染）。
    expect(h.container.querySelector("table")?.getAttribute("tabindex")).toBeNull();
    expect(h.container.querySelector("hr")?.getAttribute("tabindex")).toBeNull();
    expect(h.container.querySelector(".readora-math")?.hasAttribute(EDITABLE_ATTRIBUTE)).toBe(false);
  });

  test("没有源行范围的区块不认领（合成节点走同一条挡箭）", () => {
    const h = setup();
    const synthetic = h.container.ownerDocument.createElement("p");
    synthetic.className = "readora-paragraph";
    synthetic.textContent = "没有 range 的合成节点";
    h.container.appendChild(synthetic);
    h.layer.scan(h.container);
    expect(synthetic.hasAttribute(EDITABLE_ATTRIBUTE)).toBe(false);
    synthetic.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(synthetic.getAttribute("contenteditable")).toBeNull();
  });

  test("非 file: 文档（setAvailable(false)）：把手与双击入口同时关闭", () => {
    const h = setup({ documentUri: "untitled:Untitled-1" });
    h.layer.setAvailable(false);
    expect(h.container.querySelectorAll(`[${EDITABLE_ATTRIBUTE}]`)).toHaveLength(0);
    h.block(1).dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(h.block(1).getAttribute("contenteditable")).toBeNull();
    expect(h.requests).toHaveLength(0);
  });
});

describe("把手只随 editMode 增删（§7.1 / §7.2）", () => {
  test("关掉开关 = 属性摘净 + 正文回到静态产物", () => {
    const h = setup();
    expect(h.container.querySelectorAll('[tabindex="0"]')).toHaveLength(3);
    h.layer.setEditMode(false);
    expect(h.container.querySelectorAll(`[${EDITABLE_ATTRIBUTE}]`)).toHaveLength(0);
    expect(h.container.querySelectorAll('[tabindex="0"]')).toHaveLength(0);
    expect(h.container.querySelectorAll(`[${EDIT_STATE_ATTRIBUTE}]`)).toHaveLength(0);
    expect(h.container.innerHTML).toBe(staticHtml(TWO_BLOCKS));
  });

  test("键盘可达：Enter 在把手上激活，不需要每块一个按钮节点", () => {
    const h = setup();
    const block = h.block(1);
    expect(block.getAttribute("tabindex")).toBe("0");
    expect(h.container.querySelectorAll("button")).toHaveLength(0);
    block.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    expect(block.getAttribute("contenteditable")).toBe("true");
  });

  test("Enter 在没把手的区块上不激活、也不吞事件", () => {
    const h = setup();
    const heading = h.block(0);
    // 标题本身是认领的，先把它关掉：模拟「这一块不可编辑」。
    heading.removeAttribute(EDITABLE_ATTRIBUTE);
    const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    heading.dispatchEvent(event);
    expect(heading.getAttribute("contenteditable")).toBeNull();
    expect(event.defaultPrevented).toBe(false);
  });

  test("重挂只从 idle 态发生：活动单元与冲突块上的 Enter 都不算激活和弦", async () => {
    // 浏览器里那个真实陷阱：`Ctrl+Enter` 的 keydown 先跑单元自己的监听（提交在
    // 那里发起），被拒的 `park` 在两次监听之间的那个微任务检查点落地，然后事件
    // 才冒到容器。那时 `active` 已空，光靠「同一块不重复激活」挡不住重挂，而
    // 重挂按判据重算形态 —— 块里是未提交的输入，判据必然落到形态 B 并把源文本
    // 盖回去，草稿就这么没了（e2e ⑤ 第一次就是这么红的）。
    const h = setup({ submit: () => rejectWith(READORA_ERROR_CODES.EDIT_STALE) });
    const block = h.open(1);
    block.textContent = "第一段。[草稿]";
    ctrlEnter(block);
    await h.flush();
    expect(block.getAttribute(EDIT_STATE_ATTRIBUTE)).toBe(EDIT_CONFLICT_STATE);

    // 冲突态：Enter 不得重挂，也不得吞掉（那是搜索面板与别的监听器的按键）。
    const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    block.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(block.getAttribute("contenteditable")).toBeNull();
    expect(block.textContent).toBe("第一段。[草稿]");

    // 活动态同理：单元内的 Enter 是换行，不该被当成一次重新激活。
    const fresh = setup();
    const para = fresh.open(1);
    expect(para.getAttribute(EDIT_STATE_ATTRIBUTE)).toBe(EDIT_ACTIVE_STATE);
    const newline = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    para.dispatchEvent(newline);
    expect(newline.defaultPrevented).toBe(false);
    expect(para.getAttribute(EDIT_STATE_ATTRIBUTE)).toBe(EDIT_ACTIVE_STATE);
  });

  test("Ctrl+Enter 不触发把手激活（提交和弦只属于单元）", () => {
    const h = setup();
    const block = h.block(1);
    const event = new KeyboardEvent("keydown", {
      key: "Enter",
      ctrlKey: true,
      bubbles: true,
      cancelable: true
    });
    block.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(block.getAttribute("contenteditable")).toBeNull();
  });
});

describe("单元挂载与退出（§7.4）", () => {
  test("激活态把可编辑与无障碍属性一次性上齐", () => {
    const h = setup();
    const block = h.open(1);
    expect(block.getAttribute("contenteditable")).toBe("true");
    expect(block.getAttribute("spellcheck")).toBe("false");
    expect(block.getAttribute("role")).toBe("textbox");
    expect(block.getAttribute("aria-multiline")).toBe("true");
    expect(block.getAttribute("aria-label")).toBe("Edit paragraph");
    expect(block.getAttribute(EDIT_STATE_ATTRIBUTE)).toBe("active");
    expect(block.getAttribute(EDIT_MODE_ATTRIBUTE)).toBe("text");
  });

  test("同一时刻只有一个活动单元：换块即取消上一块", () => {
    const h = setup();
    const first = h.open(1);
    h.type(first, "改了一半");
    const second = h.open(2);
    expect(first.getAttribute("contenteditable")).toBeNull();
    // 上一块未提交的输入被还原，不是悄悄留在正文里。
    expect(first.textContent).toBe("第一段。");
    expect(second.getAttribute("contenteditable")).toBe("true");
    expect(h.layer.snapshot().activeRangeKey).toBe(h.rangeKey(2));
    expect(h.requests).toHaveLength(0);
  });

  test("Escape：取消并还原 DOM，且抢在搜索面板之前吃掉按键", () => {
    const h = setup();
    const block = h.open(1);
    const before = block.innerHTML;
    h.type(block, "不该留下的输入");
    const event = escape(block);
    expect(event.defaultPrevented).toBe(true);
    expect(block.innerHTML).toBe(before);
    // 回到把手态（idle），不是卡在 active。
    expect(block.getAttribute(EDIT_STATE_ATTRIBUTE)).toBe("idle");
    expect(block.getAttribute(EDIT_MODE_ATTRIBUTE)).toBeNull();
    expect(h.layer.snapshot().activeRangeKey).toBeNull();
    expect(h.requests).toHaveLength(0);
  });

  test("提交成功：请求字段取自提交那一刻，单元转 idle 并销毁", async () => {
    const h = setup({ version: 4 });
    const block = h.open(1);
    h.type(block, "第一段改过了");
    ctrlEnter(block);
    expect(h.requests).toEqual([
      {
        documentUri: DOC_URI,
        range: { startLine: 2, endLine: 2 },
        newText: "第一段改过了",
        baseVersion: 4
      }
    ]);
    await h.flush();
    expect(block.getAttribute("contenteditable")).toBeNull();
    expect(block.getAttribute(EDIT_STATE_ATTRIBUTE)).toBe("idle");
    expect(h.layer.snapshot()).toEqual({ activeRangeKey: null, parkedRangeKeys: [] });
    expect(card(h.container)).toBeNull();
  });

  test("heading 改字保留 `##` 前缀（marker 复用落到请求里）", async () => {
    const h = setup();
    const block = h.open(0);
    h.type(block, "新标题");
    ctrlEnter(block);
    await h.flush();
    expect(h.requests[0]?.newText).toBe("# 新标题");
    expect(h.requests[0]?.range).toEqual({ startLine: 0, endLine: 0 });
  });

  test("没改过就不发消息（省掉一次空版本号前进）", async () => {
    const h = setup();
    const block = h.open(1);
    ctrlEnter(block);
    focusOut(block, null);
    await h.flush();
    expect(h.requests).toHaveLength(0);
    expect(block.getAttribute("contenteditable")).toBeNull();
  });

  test("blur 到单元内部与 Lightbox 都不算离开；算离开的那两种才提交", async () => {
    const h = setup();
    const block = h.open(1);
    h.type(block, "输入中");
    // (a) 落到自己内部的节点
    focusOut(block, block);
    // (b) 落到 Lightbox（§7.3：暂时失焦不销毁）
    const lightbox = h.container.ownerDocument.createElement("div");
    lightbox.className = "readora-lightbox";
    const inner = h.container.ownerDocument.createElement("button");
    lightbox.appendChild(inner);
    h.container.parentElement?.appendChild(lightbox);
    focusOut(block, inner);
    // (c) 落到对话框
    const dialog = h.container.ownerDocument.createElement("div");
    dialog.setAttribute("role", "dialog");
    h.container.parentElement?.appendChild(dialog);
    focusOut(block, dialog);
    await h.flush();
    expect(h.requests).toHaveLength(0);
    expect(block.getAttribute("contenteditable")).toBe("true");
    // (d) 落到格式化工具条（E3 加进 KEEP_EDITING 名单的那一形态）：
    //     点一下「加粗」就是一次焦点转移，把它当成「离开单元」= 提交 + 退出编辑。
    const floating = h.container.ownerDocument.createElement("div");
    floating.className = EDIT_TOOLBAR_CLASS;
    const tool = h.container.ownerDocument.createElement("button");
    floating.appendChild(tool);
    h.container.parentElement?.appendChild(floating);
    focusOut(block, tool);
    await h.flush();
    expect(h.requests).toHaveLength(0);
    expect(block.getAttribute("contenteditable")).toBe("true");
    // (e) 落到正文别处 = 提交
    focusOut(block, h.block(2));
    await h.flush();
    expect(h.requests).toHaveLength(1);
    lightbox.remove();
    dialog.remove();
    floating.remove();
  });

  test("IME 组合期间屏蔽提交（§13 R4）", async () => {
    const h = setup();
    const block = h.open(1);
    block.dispatchEvent(new Event("compositionstart", { bubbles: true }));
    h.type(block, "正在拼的词");
    ctrlEnter(block);
    focusOut(block, null);
    await h.flush();
    expect(h.requests).toHaveLength(0);
    expect(block.getAttribute("contenteditable")).toBe("true");
    block.dispatchEvent(new Event("compositionend", { bubbles: true }));
    focusOut(block, null);
    await h.flush();
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]?.newText).toBe("正在拼的词");
  });

  test("粘贴只吃 text/plain，富文本进不了正文（§9.3）", () => {
    const h = setup();
    const block = h.open(1);
    const event = new Event("paste", { bubbles: true, cancelable: true }) as Event & {
      clipboardData?: { getData(kind: string): string };
    };
    event.clipboardData = {
      getData: (kind) => (kind === "text/plain" ? "纯文本" : "<b>粗</b>")
    };
    block.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(block.querySelector("b")).toBeNull();
    expect(block.textContent).toContain("纯文本");
    expect(block.innerHTML).not.toContain("<b>");
  });

  test("粘贴没有纯文本时只提示，不插入 HTML", () => {
    const h = setup();
    const block = h.open(1);
    const before = block.innerHTML;
    const event = new Event("paste", { bubbles: true, cancelable: true }) as Event & {
      clipboardData?: { getData(kind: string): string };
    };
    event.clipboardData = { getData: (kind) => (kind === "text/plain" ? "" : "<img src=x>") };
    block.dispatchEvent(event);
    expect(block.innerHTML).toBe(before);
    const note = h.container.querySelector(".readora-inline-note");
    expect(note?.getAttribute("role")).toBe("status");
    expect(note?.textContent).toContain("plain text");
    h.container.querySelector(".readora-inline-note")?.remove();
  });

  test("形态 B（判据不成立）：显示源文本，提交原样写回不补前缀", async () => {
    const h = setup({ text: "普通 **粗** 文本\n" });
    const block = h.open(0);
    expect(block.getAttribute(EDIT_MODE_ATTRIBUTE)).toBe("source");
    // 进入编辑就看到字面 Markdown —— 把渲染结果当源提交就是一次反解析。
    expect(block.textContent).toBe("普通 **粗** 文本");
    h.type(block, "普通 **粗** 文本与更多");
    ctrlEnter(block);
    await h.flush();
    expect(h.requests[0]?.newText).toBe("普通 **粗** 文本与更多");
  });

  test("超过阈值（§9.5）：拒绝激活，只在原地处给一行说明", () => {
    const huge = "字".repeat(EDIT_BLOCK_MAX_SOURCE_LENGTH + 1);
    const h = setup({ text: `${huge}\n` });
    const block = h.block(0);
    block.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(block.getAttribute("contenteditable")).toBeNull();
    expect(h.container.querySelector(".readora-inline-note")?.textContent).toContain("too large");
    expect(h.requests).toHaveLength(0);
  });
});

describe("提交被拒的冲突保全（§5.3 / §5.4，分歧 3）", () => {
  const CASES: Array<[string, "stale" | "rangeInvalid" | "applyFailed", string[]]> = [
    [
      READORA_ERROR_CODES.EDIT_STALE,
      "stale",
      ["Re-edit from the latest source", "Replace anyway", "Discard"]
    ],
    [
      READORA_ERROR_CODES.EDIT_RANGE_INVALID,
      "rangeInvalid",
      ["Re-edit from the latest source", "Discard"]
    ],
    [
      READORA_ERROR_CODES.EDIT_APPLY_FAILED,
      "applyFailed",
      ["Re-edit from the latest source", "Discard"]
    ]
  ];

  for (const [code, reason, buttons] of CASES) {
    test(`${code} → 文案 \`${reason}\` 与动作集 ${buttons.length} 枚，DOM 一字不动`, async () => {
      const h = setup({ submit: () => rejectWith(code) });
      const block = h.open(1);
      h.type(block, "写不进去的输入");
      ctrlEnter(block);
      await h.flush();
      const node = card(h.container) as HTMLElement;
      expect(node).not.toBeNull();
      expect(node.getAttribute("data-readora-edit-reason")).toBe(reason);
      expect(node.getAttribute("role")).toBe("status");
      expect(node.textContent).toContain(EDIT_CONFLICT_MESSAGES[reason]);
      expect(cardButtons(node)).toEqual(buttons);
      // 三枚文案互不相同（§5.3 不许合成一句）
      expect(
        new Set(CASES.map(([, own]) => EDIT_CONFLICT_MESSAGES[own])).size
      ).toBe(3);
      // 输入还在原地：单元转 conflict，节点没被动过。
      expect(block.textContent).toBe("写不进去的输入");
      expect(block.getAttribute(EDIT_STATE_ATTRIBUTE)).toBe("conflict");
      expect(node.parentElement).toBe(h.container);
      expect(h.layer.snapshot().parkedRangeKeys).toEqual([h.rangeKey(1)]);
    });
  }

  test("没有错误码的失败按 EDIT_APPLY_FAILED 兜底", async () => {
    const h = setup({ submit: () => Promise.reject(new Error("boom")) });
    const block = h.open(1);
    h.type(block, "输入");
    ctrlEnter(block);
    await h.flush();
    expect(card(h.container)?.getAttribute("data-readora-edit-reason")).toBe("applyFailed");
  });

  test("外部快照到达：活动节点被摘下又插回同 rangeKey，节点身份不变", async () => {
    const h = setup();
    const block = h.open(1);
    h.type(block, "正在输入的段落");
    const untouched = h.block(2).outerHTML;
    // 别人存了盘：新快照里第二段变了，第一段那几行还在原位。
    h.rewrite("# 标题\n\n第一段。\n\n第二段被别人改了。\n");
    const stillMine = h.block(1);
    // 分歧 3 的仲裁：保住的是**同一个 DOM 节点**，不是重建一份看起来一样的。
    expect(stillMine).toBe(block);
    expect(stillMine.textContent).toContain("正在输入的段落");
    expect(stillMine.getAttribute(EDIT_STATE_ATTRIBUTE)).toBe("conflict");
    // 正文其余部分 = 新快照的产物（卡片插在保住的那块之后，所以按 rangeKey 取）。
    expect(h.blockByRange("4:4")?.outerHTML).toBe(untouched.replace("第二段。", "第二段被别人改了。"));
    expect(card(h.container)?.getAttribute("data-readora-edit-reason")).toBe("stale");
  });

  test("新快照里没有这个 rangeKey：保住的内容接到正文末尾，不丢", () => {
    const h = setup();
    const block = h.open(2);
    h.type(block, "这块被别人删了但我的输入要保住");
    h.rewrite("# 标题\n\n只剩一段了。\n");
    expect(block.parentElement).toBe(h.container);
    // 接在末尾，紧跟着的就是那张卡。
    expect(block.nextElementSibling?.classList.contains(EDIT_CONFLICT_CLASS)).toBe(true);
    expect(block.textContent).toContain("我的输入要保住");
  });

  test("卡片上的「强制替换」：以当前快照版本重发原输入", async () => {
    let attempt = 0;
    const h = setup({
      submit: () => {
        attempt += 1;
        if (attempt === 1) {
          return rejectWith(READORA_ERROR_CODES.EDIT_STALE);
        }
        return Promise.resolve({ version: 10 });
      }
    });
    const block = h.open(1);
    h.type(block, "强制替换后的段落。");
    ctrlEnter(block);
    await h.flush();
    // 陈旧之后新快照才到：版本号已经前进了。
    h.rewrite("# 标题\n\n别人改过的第一段。\n\n第二段。\n", 9);
    const node = card(h.container) as HTMLElement;
    const force = Array.from(node.querySelectorAll("button")).find(
      (button) => button.textContent === "Replace anyway"
    ) as HTMLButtonElement;
    force.click();
    await h.flush();
    expect(h.requests).toHaveLength(2);
    // 第二笔用的是**当前**快照版本 + 原输入，不是第一次那枚陈旧的。
    expect(h.requests[1]).toEqual({
      documentUri: DOC_URI,
      range: { startLine: 2, endLine: 2 },
      newText: "强制替换后的段落。",
      baseVersion: 9
    });
    expect(card(h.container)).toBeNull();
    expect(h.layer.snapshot().parkedRangeKeys).toEqual([]);
    expect(block.textContent).toBe("强制替换后的段落。");
  });

  test("卡片上的「放弃」：还原成进入编辑前的静态形态", async () => {
    const h = setup({ submit: () => rejectWith(READORA_ERROR_CODES.EDIT_STALE) });
    const block = h.open(1);
    h.type(block, "不要了");
    ctrlEnter(block);
    await h.flush();
    const before = card(h.container) as HTMLElement;
    const discard = Array.from(before.querySelectorAll("button")).find(
      (button) => button.textContent === "Discard"
    ) as HTMLButtonElement;
    discard.click();
    expect(card(h.container)).toBeNull();
    expect(h.layer.snapshot().parkedRangeKeys).toEqual([]);
    // 未被顶掉过 → 还原成进入编辑时那份快照，回到把手态
    expect(block.textContent).toBe("第一段。");
    expect(block.getAttribute(EDIT_STATE_ATTRIBUTE)).toBe("idle");
    expect(block.getAttribute(EDIT_MODE_ATTRIBUTE)).toBeNull();
  });

  test("重写后放弃：放回去的是新快照那一份静态产物，不是我的输入", () => {
    const h = setup();
    const block = h.open(1);
    h.type(block, "正在输入");
    h.rewrite("# 标题\n\n第一段改过了。\n\n第二段。\n");
    const node = card(h.container) as HTMLElement;
    (Array.from(node.querySelectorAll("button")).find(
      (button) => button.textContent === "Discard"
    ) as HTMLButtonElement).click();
    expect(h.blockByRange("2:2")?.textContent).toBe("第一段改过了。");
    expect(h.blockByRange("2:2")).not.toBe(block);
    // 放回去的就是新快照那一份静态产物（把手属性除外：编辑模式还开着）。
    expect(h.blockByRange("2:2")?.innerHTML).toBe(staticBlockHtml(
      "# 标题\n\n第一段改过了。\n\n第二段。\n",
      "2:2"
    ));
    expect(h.blockByRange("4:4")?.innerHTML).toBe(staticBlockHtml(
      "# 标题\n\n第一段改过了。\n\n第二段。\n",
      "4:4"
    ));
  });

  test("重写后「以最新源重新编辑」：初值换成新快照的源，形态按判据重跑", () => {
    const h = setup({ text: TWO_BLOCKS });
    const block = h.open(1);
    h.type(block, "我的输入");
    // 新快照里这一行的内容变成了一行带标记的源 → 判据不成立 → 重挂必须是形态 B。
    h.rewrite("# 标题\n\n**别人改过的**段落\n\n第二段。\n");
    const node = card(h.container) as HTMLElement;
    (Array.from(node.querySelectorAll("button")).find(
      (button) => button.textContent === "Re-edit from the latest source"
    ) as HTMLButtonElement).click();
    const reopened = h.blockByRange("2:2") as HTMLElement;
    expect(reopened.getAttribute("contenteditable")).toBe("true");
    expect(reopened.getAttribute(EDIT_MODE_ATTRIBUTE)).toBe("source");
    expect(reopened.textContent).toBe("**别人改过的**段落");
    expect(card(h.container)).toBeNull();
  });

  test("自己那一次写回的回声不弹卡片（expectedEcho 作废 parked）", async () => {
    let resolveSubmit: ((result: DocumentEditResult) => void) | undefined;
    const h = setup({
      submit: () =>
        new Promise<DocumentEditResult>((resolve) => {
          resolveSubmit = resolve;
        })
    });
    const block = h.open(1);
    h.type(block, "提交在途");
    ctrlEnter(block);
    expect(h.requests).toHaveLength(1);
    // 在途期间外部快照先到：单元被摘走持有。
    h.rewrite("# 标题\n\n提交在途\n\n第二段。\n", 7);
    expect(h.layer.snapshot().parkedRangeKeys).toEqual([h.rangeKey(1)]);
    resolveSubmit?.({ version: 7 });
    await h.flush();
    // 回声版本号 == 提交返回值 → parked 作废，不再诱导一次假冲突。
    h.layer.scan(h.container);
    expect(h.layer.snapshot().parkedRangeKeys).toEqual([]);
    expect(card(h.container)).toBeNull();
  });
});

describe("挂起与换文档（§7.3 / §5.4）", () => {
  test("搜索打开 × 未输入：单元直接销毁，不弹卡片", () => {
    const h = setup();
    const block = h.open(1);
    h.layer.setSuspended(true);
    expect(block.getAttribute("contenteditable")).toBeNull();
    expect(block.textContent).toBe("第一段。");
    expect(card(h.container)).toBeNull();
    expect(h.layer.snapshot().parkedRangeKeys).toEqual([]);
    expect(h.container.querySelectorAll(`[${EDITABLE_ATTRIBUTE}]`)).toHaveLength(0);
  });

  test("搜索打开 × 有输入：走同一保全机制，卡片只给继续与放弃", () => {
    const h = setup();
    const block = h.open(1);
    h.type(block, "搜索打开前打的字");
    h.layer.setSuspended(true);
    const node = card(h.container) as HTMLElement;
    expect(node.getAttribute("data-readora-edit-reason")).toBe("search");
    expect(node.textContent).toContain(EDIT_CONFLICT_MESSAGES.search);
    expect(cardButtons(node)).toEqual(["Continue editing", "Discard"]);
    // 挂起比冲突多一步「还静态产物」：搜索高亮与导出取帧都读的是屏上正文，
    // 未提交的输入只能留在卡片里，不得继续占着正文节点（ARC-008 §16.1）。
    expect(block.textContent).toBe("第一段。");
    expect(block.getAttribute("contenteditable")).toBeNull();
    expect(node.querySelector(".readora-edit-conflict-text")?.textContent).toBe(
      "搜索打开前打的字"
    );
  });

  test("「继续编辑」先请宿主关搜索，解除挂起时把草稿重挂回同一块", async () => {
    const resumes: string[] = [];
    const h = setup({ onResume: () => resumes.push("resume") });
    const block = h.open(1);
    h.type(block, "待继续");
    h.layer.setSuspended(true);
    const node = card(h.container) as HTMLElement;
    clickCardButton(node, "Continue editing");
    // 挂起信号属于宿主，本层不得当场自行解除（否则搜索还开着就在编辑）
    expect(resumes).toEqual(["resume"]);
    expect(card(h.container)).toBeNull();
    expect(h.layer.snapshot().parkedRangeKeys).toEqual([]);
    expect(block.getAttribute("contenteditable")).toBeNull();
    // 搜索关掉 → `setSuspended(false)` 到达 → 补上那一次重挂
    h.layer.setSuspended(false);
    expect(h.container.querySelector("p [contenteditable], p[contenteditable]")).toBe(block);
    expect(block.textContent).toBe("待继续");
    // 初值仍取静态产物：这一次激活天然 dirty，失焦就把等了很久的草稿交出去
    ctrlEnter(block);
    await h.flush();
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]?.newText).toBe("待继续");
  });

  test("导出那种无条件挂起：「继续编辑」当场重挂，不等宿主", () => {
    const h = setup();
    const block = h.open(1);
    h.type(block, "导完接着写");
    h.layer.suspend();
    expect(block.textContent).toBe("第一段。");
    clickCardButton(card(h.container) as HTMLElement, "Continue editing");
    expect(block.getAttribute("contenteditable")).toBe("true");
    expect(block.textContent).toBe("导完接着写");
  });

  test("草稿回位对 list / blockquote 也成立：写入是读取的逐条反向", () => {
    const h = setup({ text: "# T\n\n> 甲段。\n>\n> 乙段。\n\n- 一\n- 二\n" });
    // 1) 引用：两份段落中间是空行，反向写入得还原成两个 `p`
    const quote = h.open(1);
    quote.innerHTML = "<p>甲段改。</p><p>乙段。</p>";
    h.layer.suspend();
    clickCardButton(card(h.container) as HTMLElement, "Continue editing");
    expect(renderedTextOf(quote, "blockquote")).toBe("甲段改。\n\n乙段。");
    // 2) 列表：一行一个 `li`，行数变多也能原样读回
    const list = h.open(2);
    list.innerHTML = "<li>一</li><li>二</li><li>三新增</li>";
    h.layer.suspend();
    clickCardButton(card(h.container) as HTMLElement, "Continue editing");
    expect(renderedTextOf(list, "list")).toBe("一\n二\n三新增");
  });

  test("导出前的 suspend() 与 setSuspended(true) 同一机制", () => {
    const h = setup();
    const block = h.open(1);
    h.type(block, "导出别带上我");
    h.layer.suspend();
    expect(block.getAttribute("contenteditable")).toBeNull();
    expect(block.textContent).toBe("第一段。");
    expect(card(h.container)?.getAttribute("data-readora-edit-reason")).toBe("search");
  });

  test("换文档：parked 属于上一篇，直接丢弃", () => {
    const h = setup();
    const block = h.open(1);
    h.type(block, "上一篇的输入");
    h.layer.suspend();
    expect(card(h.container)).not.toBeNull();
    h.setUri("file:///vault/other.md");
    h.rewrite("# 另一篇\n\n内容。\n");
    expect(card(h.container)).toBeNull();
    expect(h.layer.snapshot().parkedRangeKeys).toEqual([]);
    expect(h.container).not.toContain(block);
  });

  test("resetForDocument() 连活动单元一起撤", () => {
    const h = setup();
    const block = h.open(1);
    h.type(block, "换文档时丢掉");
    h.layer.resetForDocument();
    expect(block.getAttribute("contenteditable")).toBeNull();
    expect(h.layer.snapshot()).toEqual({ activeRangeKey: null, parkedRangeKeys: [] });
  });

  test("destroy() 之后双击不再激活", () => {
    const h = setup();
    h.layer.destroy();
    const block = h.block(1);
    block.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(block.getAttribute("contenteditable")).toBeNull();
    expect(h.container.querySelector(`.${EDIT_CONFLICT_CLASS}`)).toBeNull();
  });
});

/* ==================== E3：行内格式化（ARC-009 §6.3 / §7.4） ====================
 *
 * 下面每一段都在问同一件事的不同侧面：纯字符串层算出的那对标记，会不会被写进
 * **正确的那个 DOM 位置**、能不能跟着单元一起消失。动作本体（逐行包、空行段、
 * 解包两种形状）在 `inline-format.spec.ts` 里穷举过，这里只测接线。
 */

const LATIN = "# Heading\n\nAlpha paragraph one.\n\n- first item\n- second item\n";
const HEAD_DOC = "# Heading\n\n## Section two\n\n段落。\n";

describe("工具条生命周期（决策 4 明记的五条断言）", () => {
  test("editMode 开着但没有活动单元：body 上没有工具条", () => {
    const h = setup();
    expect(toolbarCount()).toBe(0);
    const block = h.open(1);
    expect(toolbarCount()).toBe(1);
    // 单元销毁即收起（决策 7：Escape 一次就退整次编辑，不做「先收工具条」）。
    escape(block);
    expect(toolbarCount()).toBe(0);
  });

  test("正文重写后工具条不在（活动节点被摘走，浮层不能继续飘着）", () => {
    const h = setup({ text: LATIN });
    h.open(1);
    expect(toolbarCount()).toBe(1);
    h.rewrite(`${LATIN}\n追加。\n`);
    expect(toolbarCount()).toBe(0);
  });

  test("提交成功后工具条不在（单元已销毁）", async () => {
    const h = setup({ text: LATIN });
    const block = h.open(1);
    h.type(block, "Alpha paragraph one. 改了");
    ctrlEnter(block);
    await h.flush();
    expect(toolbarCount()).toBe(0);
  });

  test("挂起（suspend / setSuspended）收起工具条", () => {
    const h = setup({ text: LATIN });
    h.open(1);
    h.layer.suspend();
    expect(toolbarCount()).toBe(0);
    h.open(1);
    h.layer.setSuspended(true);
    expect(toolbarCount()).toBe(0);
  });

  test("换文档与 destroy() 之后 body 上零残留", () => {
    const h = setup({ text: LATIN });
    h.open(1);
    h.layer.resetForDocument();
    expect(toolbarCount()).toBe(0);
    h.open(1);
    h.layer.destroy();
    expect(toolbarCount()).toBe(0);
    // 不靠「下一个用例忘了清」发现泄漏：直接数 body。
    expect(document.body.querySelectorAll(`.${EDIT_TOOLBAR_CLASS}`)).toHaveLength(0);
  });
});

describe("格式化动作（§6.3 主链路）", () => {
  test("加粗：DOM 里现出标记，提交出去的 newText 带同一对", async () => {
    const h = setup({ text: LATIN });
    const block = h.open(1);
    h.select(6, 15);
    expect(toolButton("bold").disabled).toBe(false);
    clickTool("bold");
    expect(readEditableText(block, "paragraph")).toBe("Alpha **paragraph** one.");
    ctrlEnter(block);
    expect(h.requests.map((request) => request.newText)).toEqual(["Alpha **paragraph** one."]);
    expect(h.requests[0]?.range).toEqual({ startLine: 2, endLine: 2 });
    await h.flush();
  });

  test("同一段再选整块标记再点一次 = 解包回原串（幂等的接管层版）", () => {
    const h = setup({ text: LATIN });
    const block = h.open(1);
    h.select(6, 15);
    clickTool("bold");
    h.select(6, 19);
    clickTool("bold");
    expect(readEditableText(block, "paragraph")).toBe("Alpha paragraph one.");
    expect(h.requests).toHaveLength(0);
  });

  test("跨行选区逐行包裹，且给一句说明（决策 2）", () => {
    const h = setup({ text: LATIN });
    const block = h.open(2);
    const [firstItem, secondItem] = Array.from(block.querySelectorAll("li"));
    if (!firstItem || !secondItem) {
      throw new Error("夹具丢了 `<li>`：两个端点分别要落在两个列表项上");
    }
    h.selectPoints(
      { node: firstTextNode(firstItem), offset: 0 },
      { node: firstTextNode(secondItem), offset: 11 }
    );
    clickTool("bold");
    // 每一行自己一对：`- **一**\n- **二**`，不是跨过 `<li>` 边界的 `**一\n二**`。
    expect(readEditableText(block, "list")).toBe("**first item**\n**second item**");
    expect(note(h.container)).toBe(EDIT_MULTILINE_WRAP_NOTE);
  });

  test("两行引用之间那条空行没被包上标记（决策 2 第 2 条）", () => {
    const h = setup({ text: "# Heading\n\n> 甲\n>\n> 乙\n" });
    const block = h.open(1);
    const [firstQuote, secondQuote] = Array.from(block.querySelectorAll("p"));
    if (!firstQuote || !secondQuote) {
      throw new Error("夹具丢了引用段的两个 `<p>`");
    }
    h.selectPoints(
      { node: firstTextNode(firstQuote), offset: 0 },
      { node: firstTextNode(secondQuote), offset: 1 }
    );
    clickTool("bold");
    expect(readEditableText(block, "blockquote").split("\n")).toEqual(["**甲**", "", "**乙**"]);
  });

  test("形态 B：标记插在行首 `- ` 之后而不是把它拆开（决策 2 第 3 条）", () => {
    const h = setup({ text: "- ![alt](img.png)\n" });
    const block = h.open(0);
    expect(block.getAttribute(EDIT_MODE_ATTRIBUTE)).toBe("source");
    h.select(0, 17);
    clickTool("bold");
    expect(block.textContent).toBe("- **![alt](img.png)**");
  });

  test("选区落在行内代码里：置灰 + 一句说明，源不出现 `**`", () => {
    const h = setup({ text: "使用 `code` 时注意\n" });
    const block = h.open(0);
    // 渲染抹掉了反引号 → 判据不成立 → 形态 B，文本里带字面的 `` `code` ``。
    expect(block.getAttribute(EDIT_MODE_ATTRIBUTE)).toBe("source");
    h.select(5, 7);
    expect(toolButton("bold").disabled).toBe(true);
    expect(note(h.container)).toBe(EDIT_INSIDE_CODE_NOTE);
    clickTool("bold");
    clickTool("link");
    expect(block.textContent).toBe("使用 `code` 时注意");
    expect(h.requests).toHaveLength(0);
  });

  test("脚注只插引用：编号取文档已有最大值 +1，不新增行（决策 6）", async () => {
    const h = setup({ text: "# Heading\n\nAlpha paragraph one.\n\nGamma [^1] reference.\n" });
    const block = h.open(1);
    h.select(6, 15);
    clickTool("footnote");
    const after = readEditableText(block, "paragraph");
    expect(after).toBe("Alpha paragraph[^2] one.");
    expect(after.split("\n")).toHaveLength(1);
    expect(note(h.container)).toBe(EDIT_FOOTNOTE_NOTE);
    ctrlEnter(block);
    await h.flush();
    expect(h.requests[0]?.newText).toBe("Alpha paragraph[^2] one.");
    expect(h.requests[0]?.range).toEqual({ startLine: 2, endLine: 2 });
  });

  test("链接：URL 输入框展开时单元不销毁也不提交，回车才写出 [词](url)", async () => {
    const h = setup({ text: LATIN });
    const block = h.open(1);
    h.select(6, 15);
    clickTool("link");
    expect(block.getAttribute("contenteditable")).toBe("true");
    expect(h.requests).toHaveLength(0);
    const input = toolbarRoot()?.querySelector<HTMLInputElement>(
      `.${EDIT_TOOLBAR_CLASS}__url-input`
    );
    expect(input).not.toBeNull();
    input!.value = "https://example.com";
    input!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })
    );
    expect(readEditableText(block, "paragraph")).toBe(
      "Alpha [paragraph](https://example.com) one."
    );
    await h.flush();
    expect(h.requests).toHaveLength(0);
  });

  test("链接另一种形态：选区被输入框拿走后，包的是展开那一行抄下的下标", async () => {
    const h = setup({ text: LATIN });
    const block = h.open(1);
    h.select(6, 15);
    clickTool("link");
    // e2e 实测：焦点一进 URL 输入框，`selection.toString()` 就是空串。jsdom 不会自己
    // 这么干，所以把「选区已经没了」这个前提装上 —— 验的是 `onUrlOpen` 那一手记忆，
    // 没有它这一步会退化成「什么都没包」，而屏幕上看着只是「回车没反应」。
    h.clearSelection();
    expect(toolbarRoot()?.querySelector<HTMLButtonElement>(`[data-readora-action="bold"]`)
      ?.disabled).toBe(true);
    const input = toolbarRoot()?.querySelector<HTMLInputElement>(
      `.${EDIT_TOOLBAR_CLASS}__url-input`
    );
    expect(input).not.toBeNull();
    input!.value = "https://example.com";
    input!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })
    );
    expect(readEditableText(block, "paragraph")).toBe(
      "Alpha [paragraph](https://example.com) one."
    );
    await h.flush();
    expect(h.requests).toHaveLength(0);
  });

  test("一端映射不出来：不动结构，只在能映射那端插成对标记 + 说明（§6.3 降级）", () => {
    const h = setup({ text: LATIN });
    const block = h.open(1);
    // 注释节点不在任何一条文本遍历里 → `offsetOf` 返回 `null`，就是那条降级的入口。
    const comment = block.ownerDocument!.createComment("不是内容");
    block.appendChild(comment);
    h.selectPoints(
      { node: firstTextNode(block), offset: 6 },
      { node: comment, offset: 0 }
    );
    clickTool("bold");
    expect(block.textContent).toBe("Alpha ****paragraph one.");
    expect(note(h.container)).toBe(EDIT_SELECTION_UNMAPPED_NOTE);
  });

  test("选区跨出单元：夹回单元内；两端都在外面则什么都不做（§6.3）", () => {
    const h = setup({ text: LATIN });
    const block = h.open(1);
    const outside = document.createTextNode("我在单元外");
    h.selectPoints(
      { node: firstTextNode(block), offset: 6 },
      { node: outside, offset: 2 }
    );
    clickTool("bold");
    expect(readEditableText(block, "paragraph")).toBe("Alpha **paragraph one.**");
    // 两端都在外：不动、不提交、不提示。
    h.selectPoints({ node: outside, offset: 0 }, { node: outside, offset: 2 });
    clickTool("italic");
    expect(readEditableText(block, "paragraph")).toBe("Alpha **paragraph one.**");
    expect(h.requests).toHaveLength(0);
  });
});

describe("heading 级别（决策 5）", () => {
  test("只改级别不改文本仍发出提交，newText 首行是 ###；DOM 一个字节不动", async () => {
    const h = setup({ text: HEAD_DOC });
    const block = h.open(1);
    const before = block.innerHTML;
    expect(levelButton(2).getAttribute("aria-pressed")).toBe("true");
    levelButton(3).click();
    expect(block.innerHTML).toBe(before);
    expect(block.textContent).toBe("Section two");
    // 这一句就是本轮最容易漏的那个缺陷：`dirty()` 只比文本就会漏判，提交不会发出。
    ctrlEnter(block);
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]?.newText).toBe("### Section two");
    expect(h.requests[0]?.range).toEqual({ startLine: 2, endLine: 2 });
    await h.flush();
  });

  test("非标题区块不出级别组", () => {
    const h = setup({ text: LATIN });
    h.open(1);
    expect(
      toolbarRoot()?.querySelector<HTMLElement>(`.${EDIT_TOOLBAR_CLASS}__levels`)?.hidden
    ).toBe(true);
  });

  test("setext 标题（形态 B）解析不出 ATX 前缀：六枚全灰 + 一行说明，不猜", () => {
    const h = setup({ text: "标题\n======\n\n段落。\n" });
    const block = h.open(0);
    expect(block.getAttribute(EDIT_MODE_ATTRIBUTE)).toBe("source");
    const disabled = Array.from(
      toolbarRoot()?.querySelectorAll<HTMLButtonElement>("[data-readora-level]") ?? []
    ).map((button) => button.disabled);
    expect(disabled).toEqual([true, true, true, true, true, true]);
    expect(note(h.container)).toBe(EDIT_LEVEL_UNAVAILABLE_NOTE);
    expect(block.textContent).toBe("标题\n======");
  });
});

describe("`E` 键（§7.1 / ARC-004 §4.5）", () => {
  function pressE(block: HTMLElement, key = "e"): KeyboardEvent {
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    block.dispatchEvent(event);
    return event;
  }

  test("idle 区块上按 e 与 E 都激活，且吞掉按键", () => {
    const h = setup();
    const event = pressE(h.block(1));
    expect(event.defaultPrevented).toBe(true);
    expect(h.block(1).getAttribute("contenteditable")).toBe("true");

    const upper = setup();
    expect(pressE(upper.block(0), "E").defaultPrevented).toBe(true);
    expect(upper.block(0).getAttribute("contenteditable")).toBe("true");
  });

  test("Ctrl+E / Alt+E / Meta+E 不激活（那是宿主的和弦）", () => {
    const h = setup();
    for (const modifiers of [
      { ctrlKey: true },
      { altKey: true },
      { metaKey: true }
    ] as const) {
      const event = new KeyboardEvent("keydown", {
        key: "e",
        ...modifiers,
        bubbles: true,
        cancelable: true
      });
      h.block(1).dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    }
    expect(h.block(1).getAttribute("contenteditable")).toBeNull();
  });

  test("活动单元与冲突块上的 `e` 不是重挂：idle-only 护栏（与 E2 那条微任务用例同形）", async () => {
    const h = setup({ text: LATIN, submit: () => rejectWith(READORA_ERROR_CODES.EDIT_STALE) });
    const block = h.open(1);
    h.type(block, "Alpha [草稿]");
    ctrlEnter(block);
    await h.flush();
    expect(block.getAttribute(EDIT_STATE_ATTRIBUTE)).toBe(EDIT_CONFLICT_STATE);
    // 被拒的 `park` 正好落在两次监听之间，那一刻 `active` 已空 —— 只靠「同一块不重复
    // 激活」挡不住重挂，而重挂会按判据落到形态 B 并把源文本盖回块里抹掉草稿。
    expect(pressE(block).defaultPrevented).toBe(false);
    expect(block.getAttribute("contenteditable")).toBeNull();
    expect(block.textContent).toBe("Alpha [草稿]");

    // 活动态：那个 `e` 是一个字，不是快捷键。
    const fresh = setup({ text: LATIN });
    const para = fresh.open(1);
    expect(pressE(para).defaultPrevented).toBe(false);
    expect(para.getAttribute(EDIT_STATE_ATTRIBUTE)).toBe(EDIT_ACTIVE_STATE);
  });

  test("editMode 关 / 非 file: / 挂起：`e` 一律不响应", () => {
    const off = setup();
    off.layer.setEditMode(false);
    expect(pressE(off.block(1)).defaultPrevented).toBe(false);
    expect(off.block(1).getAttribute("contenteditable")).toBeNull();

    const remote = setup({ documentUri: "untitled:Untitled-1" });
    remote.layer.setAvailable(false);
    expect(pressE(remote.block(1)).defaultPrevented).toBe(false);
    expect(remote.block(1).getAttribute("contenteditable")).toBeNull();

    // 挂起时把手已摘（`refreshAffordances` 那一支），键位跟着哑；
    // `activateByRangeKey` 里的 `suspended` 前置是第二道。
    const held = setup();
    held.layer.setSuspended(true);
    expect(pressE(held.block(1)).defaultPrevented).toBe(false);
    expect(held.block(1).getAttribute("contenteditable")).toBeNull();
  });

  test("非可编辑区块（表格）上的 `e` 不激活、不吞键", () => {
    const h = setup({ text: "# Heading\n\n| a |\n| - |\n| 1 |\n" });
    const table = h.container.querySelector("table") as HTMLElement;
    const event = pressE(table);
    expect(event.defaultPrevented).toBe(false);
    expect(table.getAttribute("contenteditable")).toBeNull();
  });
});
