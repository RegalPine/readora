/**
 * 单个可编辑区块的挂载与交互（ARC-009 §7.4 / §9.3，E2）。
 *
 * 一个 unit 就是「一个顶层区块 + 它此刻的编辑形态」。它只做四件事：
 * 1. `activate()`：把区块变成 contenteditable 并接上五个监听；**形态 B 还要先把
 *    显示内容换成源文本**（见下面那段「为什么形态 B 必须改写一次 DOM」）；
 * 2. 读回用户输入（用 `source-text` 里那个**同一个** `readEditableText`，
 *    于是判据与提交读的是同一条路径，不会出现「判据说相等、提交读出来不等」）；
 * 3. 组装要写回的文本（形态 A 补前缀，形态 B 原样）；
 * 4. 退出时把属性摘净，必要时把 DOM 恢复到进入时的样子。
 *
 * 它**不**碰桥、不持有 version、不知道冲突怎么处理 —— 那些是接管层的事。
 * 分层的理由是 ARC-009 §8：单元是纯 DOM 对象，能在 jsdom 里被逐条断言，
 * 不需要为了测一个键盘分支去起一个浏览器。
 *
 * **为什么形态 B 必须改写一次 DOM**：判据不成立意味着渲染抹掉了标记
 * （`**粗**` 已是「粗」）。此时若把屏上那份渲染结果当源提交，就是一次 DOM→源的
 * 反解析（§9.4 禁止的那件事）。所以初值取源文本原样、显示内容也换成它，用户改的
 * 就是字面上的 Markdown。写入走 `createTextNode` + `replaceChildren`，
 * **不解析任何标记**，与下面 `cancel` 那条 innerHTML 例外是两回事。
 *
 * **为何还要多一条 `draft`**：挂起（搜索打开 / 导出取帧）必须把正文还给静态产物，
 * 而用户那份未提交的输入得回得来。「继续编辑」传的就是它，写入见
 * {@link writeEditableText}；**初值仍取静态产物**，所以重新挂上的这一次天然 dirty，
 * 用户一失焦就会提交，不会因为「屏幕上看起来一样」被当成没改过。
 *
 * 唯一允许由附加层写 `innerHTML` 的地方在 {@link EditUnit.cancel}：
 * 形态 A 的初值是渲染文本而不是源文本，用户取消后浏览器改过的 DOM **不会**自己
 * 变回去，不显式恢复就是把「取消」变成「悄悄改掉正文」。这与
 * `MarkdownContent` 头注的「innerHTML 写入点只有一处」是有意登记的例外，
 * 只写这一个节点自己在进入时的那份快照，不写兄弟、不写正文容器。
 *
 * **第二处 DOM 写入例外**是 {@link EditUnit.applyTextSplice}（E3）：行内格式化要
 * 把纯字符串层算出的新文本写回区块。它与上面那处性质不同 —— 只用
 * `Range#deleteContents` + `createTextNode`（软换行配 `<br>`），**不解析任何标记**，
 * 也不写 `innerHTML`，所以不构成第二条 HTML 写入通道（ARC-009 §9.4 / ARC-008 §14.5）。
 */
import { showInlineNote } from "../interactions";
import { withHeadingLevel } from "./inline-format";
import { createSelectionMapper } from "./selection-map";
import {
  composeNewText,
  markerLengthOf,
  parseBlockSource,
  readEditableText,
  type BlockSource,
  type EditBlockType,
  type EditMode
} from "./source-text";

/** 单元状态：写在 DOM 上，CSS 与测试都按它分支，不在 JS 里另存一份。 */
export const EDIT_STATE_ATTRIBUTE = "data-readora-edit-state";
/** 本单元挂在哪一形态上（`text` = 改字，`source` = 改源）。 */
export const EDIT_MODE_ATTRIBUTE = "data-readora-edit";
/** 「这一块可以编辑」的把手标记，值就是区块类型。 */
export const EDITABLE_ATTRIBUTE = "data-readora-editable";
export const EDIT_CONFLICT_CLASS = "readora-edit-conflict";

export const EDIT_IDLE_STATE = "idle";
export const EDIT_ACTIVE_STATE = "active";
export const EDIT_CONFLICT_STATE = "conflict";

/** 三枚属性 + 卡片 class：导出剥离与搜索排除共用这一份名单。 */
export const EDIT_DOM_ATTRIBUTES = [
  EDIT_STATE_ATTRIBUTE,
  EDIT_MODE_ATTRIBUTE,
  EDITABLE_ATTRIBUTE
] as const;

const PASTE_PLAIN_ONLY_NOTE = "Only plain text can be pasted here.";

/** 失焦后要把焦点交给这些东西时不算「离开单元」（ARC-009 §7.3）。
 *
 * `.readora-edit-toolbar` 是 E3 加的：工具条挂在 `body` 上，点了按钮就是
 * 一次焦点转移，不在名单里会把「点加粗」变成「失焦提交 + 退出编辑」。
 */
const KEEP_EDITING_SELECTOR = [
  ".readora-lightbox",
  ".readora-diagram--fullscreen",
  ".readora-edit-toolbar",
  '[role="dialog"]'
].join(", ");

export interface EditUnitOptions {
  block: HTMLElement;
  type: EditBlockType;
  rangeKey: string;
  /** 本区块的源文本（已由接管层按 `rangeKey` 切出）。 */
  source: string;
  mode: EditMode;
  /**
   * 挂起前那份未提交的输入。给了它，`activate()` 就把区块内容写成它（而初值
   * 仍取静态产物）；不给，区块保持屏上现有的渲染结果（形态 B 则换成源文本）。
   */
  draft?: string | undefined;
  /** 提交意图：单元自己不发请求，交回接管层去问 Host。 */
  onSubmit(unit: EditUnit): void;
  /** Escape：接管层负责放弃输入并清理卡片。 */
  onEscape(unit: EditUnit): void;
}

export interface EditUnit {
  readonly block: HTMLElement;
  readonly type: EditBlockType;
  readonly rangeKey: string;
  readonly mode: EditMode;
  readonly source: string;
  /** 进入编辑时读到的文本，`dirty()` 与它比。 */
  readonly initialText: string;
  /** 当前用户输入。 */
  text(): string;
  /** 要写回文件的那段文本：形态 A 补前缀，形态 B 原样。 */
  newText(): string;
  /** 文本变了，或 heading 的前缀被改过（决策 5：只改级别不改文本也算 dirty）。 */
  dirty(): boolean;
  /**
   * 把「单元文本空间」的 `[from, to)` 换成 `text`（E3 的格式化出口）。
   *
   * 写的是文本节点与 `<br>`，不解析标记；两端落不到 DOM 上时返回 `false`
   * 且**一个字节都不动**（§6.3 的「宁可不写也不能写坏」）。
   */
  applyTextSplice(from: number, to: number, text: string): boolean;
  /**
   * 改 heading 级别（决策 5）。形态 A 只改 `markers[0]`，DOM 一个字符都不动；
   * 形态 B 对首行做文本空间拼接。解析不出 ATX 前缀（setext、`#` 后无空格）
   * 时返回 `false`，不猜。
   */
  setLevel(level: 1 | 2 | 3 | 4 | 5 | 6): boolean;
  /** 本块当前的 heading 级别；不是标题或解析不出 ATX 前缀即 `null`。 */
  headingLevel(): 1 | 2 | 3 | 4 | 5 | 6 | null;
  /** 上属性 + 接监听 + 收选区到末尾。 */
  activate(): void;
  /** 摘属性 + 退监听；`restore` 时把 DOM 写回进入时的快照。 */
  deactivate(options?: { restore?: boolean }): void;
  /** 只退监听、不动 DOM 与属性：正文重写前把节点摘下来交给接管层持有。 */
  release(): void;
}

function isInsideBlock(unit: HTMLElement, node: EventTarget | null): boolean {
  if (!(node instanceof Element)) {
    return false;
  }
  return unit === node || unit.contains(node);
}

/**
 * 读回用户输入的读法。
 *
 * 形态 A 读的是渲染结构（与判据同一条路径）；形态 B 的区块里只有一个纯文本节点
 * （`activate` 换进去的源文本），按段落的平铺读法读 = 读用户看到的那串字符。
 * 用 `"paragraph"` 而不是 `block.textContent`：前者会把 `<br>` 还原成换行，而
 * Chromium 在 contenteditable 里敲回车留下的正是 `<br>`。
 */
function textOf(block: HTMLElement, type: EditBlockType, mode: EditMode): string {
  return readEditableText(block, mode === "text" ? type : "paragraph");
}

/** 一段文本按软换行写成子节点：`\n` → `<br>`，与渲染器对硬换行的产物同形。 */
function inlineNodes(doc: Document, text: string): Node[] {
  const nodes: Node[] = [];
  text.split("\n").forEach((line, index) => {
    if (index > 0) {
      nodes.push(doc.createElement("br"));
    }
    nodes.push(doc.createTextNode(line));
  });
  return nodes;
}

/**
 * {@link readEditableText} 四条分支的逐条反向：把一段「单元读法下的文本」写回区块。
 *
 * 只在恢复挂起前的草稿这一处用。写完立即由 `text()` 读回对照，两边共用同一个
 * 分派规则（形态 B 一律按 `paragraph` 平铺），所以不存在「写得进读不出」的第二套约定。
 */
function writeEditableText(block: HTMLElement, type: EditBlockType, text: string): void {
  const doc = block.ownerDocument ?? document;
  if (type === "list") {
    const items = text.split("\n").map((line) => {
      const item = doc.createElement("li");
      item.textContent = line;
      return item;
    });
    block.replaceChildren(...items);
    return;
  }
  if (type === "blockquote") {
    const paragraphs = text.split("\n\n").map((chunk) => {
      const paragraph = doc.createElement("p");
      paragraph.replaceChildren(...inlineNodes(doc, chunk));
      return paragraph;
    });
    block.replaceChildren(...paragraphs);
    return;
  }
  block.replaceChildren(...inlineNodes(doc, text));
}

export function createEditUnit(options: EditUnitOptions): EditUnit {
  const { block, type, rangeKey, source, mode, draft } = options;
  const parsed = parseBlockSource(source, type);
  const initialText = mode === "text" ? readEditableText(block, type) : source;
  // 进入时的 DOM：cancel() 唯一允许恢复的目标。
  const snapshot = block.innerHTML;
  /**
   * 形态 B 取消时按**节点身份**接回的那批原始子节点。
   *
   * `activate()`（source）会 `replaceChildren` 把渲染子节点摘掉换成一个源文本节点，
   * 数组这里先把被摘走的原始节点存下引用。接管层（图表 / 代码块）攥着的是这批节点
   * 里的**活节点** —— Pele 引擎的 viewport / container、CodeMirror 宿主都活在下面。
   * 若取消时用 `innerHTML` 字符串塞回去，塞进去的是同名同形的**新**节点，接管层的
   * 活引用成了游离对象：工具栏按钮点了不动（引擎绑在已脱离的节点上），静态 SVG 还
   * 会冻结在快照那一刻的 viewBox 上（看着像被放大）。按节点身份原样接回，同一批
   * DOM 连同引擎引用一起回位，实时布局与按钮活性都不受影响。形态 A（text）没有这层
   * 耦合（用户直接在渲染节点上改字），仍走上面的字符串恢复把改动冲掉。
   */
  const detachedChildren: Node[] = mode === "source" ? Array.from(block.childNodes) : [];
  let composing = false;
  let active = false;
  /**
   * 被改过的 heading 前缀（决策 5 的形态 A 支路）。
   *
   * 只改级别不改文本时 DOM 一个字节都不动，所以这份覆盖必须自己进 `dirty()`
   * 的比对 —— 只比文本就会漏判，提交不会发出，屏幕上看起来改了、文件里没改。
   */
  let markerOverride: string | null = null;

  function currentParsed(): BlockSource {
    if (markerOverride === null) {
      return parsed;
    }
    const markers = parsed.markers.slice();
    if (markers.length === 0) {
      markers.push(markerOverride);
    } else {
      markers[0] = markerOverride;
    }
    return { ...parsed, markers };
  }

  function markerSignature(): string {
    // 分隔符取 NUL：marker 本身可以是任意空白，用空白拼会混淆「三个空格」与
    // 「两个 marker 各一个空格」。
    return currentParsed().markers.join("\u0000");
  }

  const initialMarkerSignature = markerSignature();

  /** 形态 B 的「首行字面前缀」：长度取 `markerLengthOf`，全仓只那一处定义。 */
  function firstLineMarker(): string {
    const line = unit.text().split("\n")[0] ?? "";
    return line.slice(0, markerLengthOf(line, type));
  }

  /** 可改的 ATX 前缀；判据与 `withHeadingLevel` 同一处，不另写一份正则。 */
  function rewritableMarker(): string | null {
    const marker = mode === "text" ? currentParsed().markers[0] ?? "" : firstLineMarker();
    return withHeadingLevel(marker, 1) === null ? null : marker;
  }

  const unit: EditUnit = {
    block,
    type,
    rangeKey,
    mode,
    source,
    initialText,
    text() {
      return textOf(block, type, mode);
    },
    newText() {
      const edited = unit.text();
      return mode === "text" ? composeNewText(edited, currentParsed()) : edited;
    },
    dirty() {
      return unit.text() !== initialText || markerSignature() !== initialMarkerSignature;
    },
    headingLevel() {
      if (type !== "heading") {
        return null;
      }
      const marker = rewritableMarker();
      if (marker === null) {
        return null;
      }
      const hashes = /^(#{1,6})/u.exec(marker.replace(/^\s+/u, ""))?.[1];
      if (!hashes || hashes.length < 1 || hashes.length > 6) {
        return null;
      }
      return hashes.length as 1 | 2 | 3 | 4 | 5 | 6;
    },
    setLevel(level) {
      if (type !== "heading") {
        return false;
      }
      const marker = mode === "text" ? currentParsed().markers[0] ?? "" : firstLineMarker();
      const next = withHeadingLevel(marker, level);
      if (next === null) {
        return false;
      }
      if (mode === "text") {
        markerOverride = next;
        return true;
      }
      const line = unit.text().split("\n")[0] ?? "";
      return unit.applyTextSplice(0, line.length, `${next}${line.slice(marker.length)}`);
    },
    applyTextSplice(from, to, text) {
      const owner = block.ownerDocument;
      if (!owner) {
        return false;
      }
      // 与 `text()` / 判据同一条遍历（`selection-map.ts` 的文件头注）：这里重新
      // 建一次模型，因为上一轮的 DOM 已经被上一次替换改过了。
      const mapper = createSelectionMapper(block, type, mode);
      const start = mapper.pointAt(from);
      const end = mapper.pointAt(to);
      if (!start || !end) {
        return false;
      }
      const range = owner.createRange();
      try {
        range.setStart(start.node, start.offset);
        range.setEnd(end.node, end.offset);
      } catch {
        // 点不合法（节点已脱离、偏移越界）：不写。
        return false;
      }
      range.deleteContents();
      if (text.length > 0) {
        // `inlineNodes` 而不是一个含 `\n` 的文本节点：contenteditable 里的字面
        // 换行会被浏览器归一化成空格，而 `<br>` 才是 `readEditableText` 认的换行。
        const fragment = owner.createDocumentFragment();
        for (const node of inlineNodes(owner, text)) {
          fragment.appendChild(node);
        }
        range.insertNode(fragment);
      }
      return true;
    },
    activate() {
      if (active) {
        return;
      }
      active = true;
      block.setAttribute(EDIT_STATE_ATTRIBUTE, EDIT_ACTIVE_STATE);
      block.setAttribute(EDIT_MODE_ATTRIBUTE, mode);
      block.setAttribute("contenteditable", "true");
      block.setAttribute("spellcheck", "false");
      block.setAttribute("role", "textbox");
      block.setAttribute("aria-multiline", "true");
      const label = type === "codeBlock" ? "Edit code block source"
        : type === "diagramBlock" ? "Edit diagram source"
        : type === "table" ? "Edit table source"
        : type === "mathBlock" ? "Edit math source"
        : "Edit paragraph";
      block.setAttribute("aria-label", label);
      if (draft !== undefined) {
        // 挂起前那份输入回位：写的是本块自己的 DOM，不动兄弟也不动正文容器。
        writeEditableText(block, mode === "text" ? type : "paragraph", draft);
      } else if (mode === "source") {
        // 见文件头注：形态 B 先把自己显示成源文本，用户改的是字面 Markdown。
        const owner = block.ownerDocument;
        if (owner) {
          block.replaceChildren(owner.createTextNode(source));
        }
      }
      block.addEventListener("keydown", onKeyDown);
      block.addEventListener("focusout", onFocusOut);
      block.addEventListener("paste", onPaste);
      block.addEventListener("compositionstart", onCompositionStart);
      block.addEventListener("compositionend", onCompositionEnd);
      block.focus({ preventScroll: true });
      placeCaretAtEnd(block);
    },
    deactivate(deactivateOptions = {}) {
      block.removeEventListener("keydown", onKeyDown);
      block.removeEventListener("focusout", onFocusOut);
      block.removeEventListener("paste", onPaste);
      block.removeEventListener("compositionstart", onCompositionStart);
      block.removeEventListener("compositionend", onCompositionEnd);
      active = false;
      composing = false;
      block.removeAttribute("contenteditable");
      block.removeAttribute("spellcheck");
      block.removeAttribute("role");
      block.removeAttribute("aria-multiline");
      block.removeAttribute("aria-label");
      block.removeAttribute(EDIT_STATE_ATTRIBUTE);
      block.removeAttribute(EDIT_MODE_ATTRIBUTE);
      if (deactivateOptions.restore) {
        if (mode === "source") {
          // 按节点身份接回摘走的原始子节点，保住接管层的活引擎引用（见上面注释）。
          block.replaceChildren(...detachedChildren);
        } else if (block.innerHTML !== snapshot) {
          block.innerHTML = snapshot;
        }
      }
    },
    release() {
      block.removeEventListener("keydown", onKeyDown);
      block.removeEventListener("focusout", onFocusOut);
      block.removeEventListener("paste", onPaste);
      block.removeEventListener("compositionstart", onCompositionStart);
      block.removeEventListener("compositionend", onCompositionEnd);
      active = false;
      composing = false;
    }
  };
  return unit;

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      // 抢在 `useSearchShortcuts` 之前：它按 `event.defaultPrevented` 让路
      // （interactions.ts），所以这里只 preventDefault 就能同时兑现
      // 「Escape 先退编辑、不退搜索」，不必新增一条全局判据。
      event.preventDefault();
      options.onEscape(unit);
      return;
    }
    if (composing) {
      // IME 组合期间 `Enter` / `Ctrl+Enter` 属于输入法的确认键（§13 R4）。
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      options.onSubmit(unit);
    }
  }

  function onFocusOut(event: FocusEvent): void {
    if (composing) {
      return;
    }
    const target = event.relatedTarget;
    if (isInsideBlock(block, target)) {
      return;
    }
    if (target instanceof Element && target.closest(KEEP_EDITING_SELECTOR)) {
      // Lightbox / 图表全屏 / 对话框接管了焦点：单元必须原地活着（§7.3）。
      return;
    }
    // `relatedTarget === null` 是焦点离开文档（切面板、切窗口）：按提交处理，
    // 静默丢掉用户输入比多提交一次更糟。
    options.onSubmit(unit);
  }

  function onPaste(event: ClipboardEvent): void {
    event.preventDefault();
    const plain = event.clipboardData?.getData("text/plain") ?? "";
    if (plain.length === 0) {
      showInlineNote(block, PASTE_PLAIN_ONLY_NOTE);
      return;
    }
    const document = block.ownerDocument;
    if (!document) {
      return;
    }
    // 只吃 `text/plain`，整条路径不读 `text/html` —— 富文本进不了正文（§9.3）。
    // 不用 `document.execCommand`：jsdom 没有实现，用了这段就只能去浏览器里测。
    const selection = document.defaultView?.getSelection?.() ?? null;
    if (!selection || selection.rangeCount === 0) {
      block.appendChild(document.createTextNode(plain));
      return;
    }
    const range = selection.getRangeAt(0);
    if (!block.contains(range.startContainer)) {
      block.appendChild(document.createTextNode(plain));
      return;
    }
    range.deleteContents();
    range.insertNode(document.createTextNode(plain));
  }

  function onCompositionStart(): void {
    composing = true;
  }

  function onCompositionEnd(): void {
    composing = false;
  }
}

/** 光标收到末尾：进入编辑就接着写，不要选中整块让人一敲就全没了。 */
function placeCaretAtEnd(block: HTMLElement): void {
  const view = block.ownerDocument?.defaultView;
  const document = block.ownerDocument;
  if (!view || !document || typeof view.getSelection !== "function") {
    return;
  }
  const selection = view.getSelection();
  if (!selection) {
    return;
  }
  const range = document.createRange();
  range.selectNodeContents(block);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
}
