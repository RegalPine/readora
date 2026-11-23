/**
 * 编辑接管层：把 E0 的源位置锚点消费成可就地编辑的界面（ARC-009 §6 / §7 / §8，E2）。
 *
 * 职责边界三条：
 * 1. **只认领顶层区块**。E0 只给 `document.children` 那一层标
 *    `data-readora-source-range`（ARC-002 §12.3），所以这里也只在顶层找：
 *    paragraph / heading / blockquote / list / codeBlock / diagramBlock / table
 *    七类认领，其余（公式、`hr`、没有 range 的合成节点）一律不认领 —— 没有
 *    可靠范围就没有「改哪几行」的答案，宁可不给入口。
 * 2. **本层与大纲章节菜单是 View 侧仅有的两个 `document.edit` 发送方**（E7 修订，
 *    ARC-009 §16.7 第 1 条）。不变量守住的是「两处都用同一条出站形态、拿到拒绝都绝
 *    不自作主张重试」：另一处是 `App.runSectionOp`（它改的是区块之间的结构，不属于任何
 *    已认领区块，塞进本层反而要让接管层去理解大纲树）。写回的权威（版本复判、
 *    行范围复判、真的落盘）全在 Host（§5.1），本层拿到拒绝就保全输入。
 * 3. **本层不写正文**。除了 `edit-unit.ts` 里登记过的那两处例外（取消时恢复快照、
 *    E3 的 `applyTextSplice` 只写文本节点），正文 DOM 的
 *    作者永远是 `MarkdownContent` 里那一次 innerHTML。
 *
 * 生命周期与「正文重写」的关系是本层最要紧的一段（§5.4 的落地仲裁）：
 * `MarkdownContent` 每次重写都会销毁并重建附加层，而编辑中的单元不能跟着一起没了
 * —— 用户正在打的字活在 DOM 节点里，源文件里还没有。于是本层**实例跨重写存活**
 * （`MarkdownContent` 只在卸载时 destroy 它）：重写前调 {@link EditLayer.detachForRewrite}
 * 把活动节点从 DOM 摘下由本层持有，重写后在 {@link EditLayer.scan} 里按同一个
 * `rangeKey` 插回去并标成 `conflict`，同时把被顶掉的那块静态产物留着好让「放弃」能还原。
 * 刻意**不**做「抑制重写」：那等于让编辑界面决定用户看不到文件的新内容。
 */
import { READORA_ERROR_CODES, type DocumentEditResult } from "@readora/contracts";
import { SOURCE_RANGE_ATTRIBUTE } from "@readora/markdown-core";
import { bridgeErrorCode } from "../../bridge/bridge-error";
import { showInlineNote } from "../interactions";
import {
  EDIT_BLOCK_MAX_SOURCE_LENGTH,
  EDIT_BLOCK_TOO_LARGE_NOTE,
  EDIT_CONFLICT_MESSAGES,
  EDIT_FOOTNOTE_NOTE,
  EDIT_INSIDE_CODE_NOTE,
  EDIT_LEVEL_UNAVAILABLE_NOTE,
  EDIT_MULTILINE_WRAP_NOTE,
  EDIT_SELECTION_UNMAPPED_NOTE
} from "./limits";
import {
  EDIT_CONFLICT_CLASS,
  EDIT_CONFLICT_STATE,
  EDIT_IDLE_STATE,
  EDIT_STATE_ATTRIBUTE,
  EDITABLE_ATTRIBUTE,
  EDIT_MODE_ATTRIBUTE,
  createEditUnit,
  type EditUnit
} from "./edit-unit";
import {
  createFormatToolbar,
  type FormatToolbar,
  type HeadingLevel,
  type ToolbarState
} from "./format-toolbar";
import { applyInlineAction, insideCodeSpan, type InlineAction } from "./inline-format";
import {
  createSelectionMapper,
  isPointInsideBlock,
  readUnitSelection,
  type FormatSelection
} from "./selection-map";
import {
  EDITABLE_BLOCK_SELECTOR,
  blockTypeOf,
  editModeFor,
  parseRangeKey,
  sliceBlockSource,
  type EditBlockType,
  type EditMode
} from "./source-text";

/** 一条写回请求，字段与 `DocumentEditPayload` 同形（本层不重复声明 Schema）。 */
export interface EditSubmitRequest {
  documentUri: string;
  range: { startLine: number; endLine: number };
  newText: string;
  baseVersion: number;
}

/**
 * 桥的注入口。
 *
 * `documentUri()` / `version()` 是**取值器而不是值**：必须在提交那一刻现读，
 * 缓存下来的那两份正是冲突的来源（ARC-009 §5.2 第 3 步比的就是快照空间的版本）。
 */
export interface EditPort {
  submit(request: EditSubmitRequest): Promise<DocumentEditResult>;
  documentUri(): string;
  version(): number;
}

export interface EditLayerOptions {
  port: EditPort;
  /** 当前文档全文的取值器：切源文本要用，同样不许缓存。 */
  source(): string;
  /**
   * 卡片上的「继续编辑」向上请求一次「把搜索关掉」（§7.3）。
   *
   * 挂起信号是宿主（App 的 `searchOpen`）的，本层不能单方面宣布解除；
   * 不给这个回调时（导出那条无条件挂起、以及没有搜索的单测）就当场自己解。
   */
  onResume?: (() => void) | undefined;
  /**
   * 选区读取器（§6.3 / 决策 4）：默认走 `readUnitSelection`（真 `window.getSelection`）。
   *
   * 为什么留注入口：jsdom 有 `getSelection` 但**它对选区的维护不可依赖**，
   * 拿它断言「选中了哪个词」测的是 jsdom 而不是本层的逻辑。于是单测注入端点
   * （`selection: () => FormatSelection`），真实选区读取交给 e2e。形状沿用
   * `EditPort.documentUri()` / `version()` 那套「取值器不缓存」的先例 —— 每次调用
   * 现读，因为选区在两次动作之间会变。
   */
  selection?: (() => FormatSelection | undefined | null) | undefined;
}

type ConflictReason = "stale" | "rangeInvalid" | "applyFailed" | "search";

interface ParkedEdit {
  rangeKey: string;
  type: EditBlockType;
  mode: EditMode;
  /** 用户当时输入的那段文本：卡片要显示它，「强制替换」要重发它。 */
  text: string;
  reason: ConflictReason;
  /** 装着未提交输入的那个节点。 */
  node: HTMLElement;
  /** 该单元，留着是为了「放弃」能把 DOM 还原成进入编辑时的样子。 */
  unit: EditUnit;
  /** 重写后顶掉我们这块的那一份静态产物；「放弃」时放回去。 */
  replaced: HTMLElement | null;
}

export interface EditLayer {
  /** 正文重写完成后调用：保全仲裁 + 把手重刷。可反复调用。 */
  scan(container: HTMLElement): void;
  /** 重写**之前**调用：把活动单元所在的节点从 DOM 里摘下来持有。 */
  detachForRewrite(): void;
  setEditMode(on: boolean): void;
  /** `file:` 判据：为假则把手与双击入口同时关闭。 */
  setAvailable(on: boolean): void;
  /** 搜索面板开合（§7.3）：为真即挂起编辑。 */
  setSuspended(on: boolean): void;
  /**
   * 无条件挂起一次（ARC-008 §16.1）：导出取帧之前调用，保证交出去的正文
   * 里没有正在输入的那一块。与 `setSuspended(true)` 同一机制，但不是一个信号源。
   */
  suspend(): void;
  /** 换文档：丢弃与旧文档绑定的 parked 与持有节点。 */
  resetForDocument(): void;
  destroy(): void;
  /** 只读取证用（单测用），产品代码不读。 */
  snapshot(): { activeRangeKey: string | null; parkedRangeKeys: string[] };
}

function reasonOfCode(code: string): ConflictReason {
  if (code === READORA_ERROR_CODES.EDIT_STALE) {
    return "stale";
  }
  return code === READORA_ERROR_CODES.EDIT_RANGE_INVALID ? "rangeInvalid" : "applyFailed";
}

export function createEditLayer(options: EditLayerOptions): EditLayer {
  const { port } = options;
  let container: HTMLElement | null = null;
  let attached = false;
  let editMode = false;
  let available = true;
  let suspended = false;
  /** 挂起的两个信号源：搜索面板开合（宿主）与导出取帧（无条件、一次性）。 */
  let suspendedBySignal = false;
  let suspendedByCall = false;
  /** 「继续编辑」时仍挂在搜索上的那份输入：等下一次解除挂起时补挂。 */
  let resumePending: { rangeKey: string; text: string } | null = null;
  let active: EditUnit | null = null;
  let documentUri = port.documentUri();
  /** 刚提交成功那一次期望的回声：回声到达即说明源里已经有这份内容了。 */
  let expectedEcho: { version: number; rangeKey: string } | null = null;
  const parked = new Map<string, ParkedEdit>();
  const cards = new Map<string, HTMLElement>();
  /** 工具条整层一枚（挂在 `body` 上，见 `format-toolbar.ts` 文件头注）。 */
  let toolbar: FormatToolbar | null = null;
  /** 上一次呈现的状态：滚动 / 缩放时只换 rect 重定位，不重算选区。 */
  let toolbarState: ToolbarState | null = null;
  /**
   * URL 输入框展开那一刻抄下的选区下标（E3，`format-toolbar.ts` 的 `onUrlOpen`）。
   *
   * 为什么需要它：Chromium 的文档选区属于当前焦点控件，焦点一进 URL 输入框正文里
   * 那段选区就没了（e2e 实测 `selection.toString()` 返回空串）。**记的是下标而不是
   * `Range`**：DOM 会跟着那一次插入变，下标才是纯函数认得的坐标。
   */
  let pendingLink: { from: number; to: number } | null = null;

  function rangeKeyOf(block: Element): string | null {
    return block.getAttribute(SOURCE_RANGE_ATTRIBUTE);
  }

  /** 认领 = 顶层 + 命中标签名 + 有合法 rangeKey，三个条件缺一不认领（§15-5）。 */
  function claimedBlocks(root: HTMLElement): HTMLElement[] {
    return Array.from(root.querySelectorAll<HTMLElement>(EDITABLE_BLOCK_SELECTOR)).filter(
      (block) => block.parentElement === root && blockTypeOf(block) !== null && rangeKeyOf(block) !== null
    );
  }

  function blockByRangeKey(root: HTMLElement, rangeKey: string): HTMLElement | null {
    const match = root.querySelector<HTMLElement>(
      `[${SOURCE_RANGE_ATTRIBUTE}="${rangeKey}"]`
    );
    return match && match.parentElement === root && blockTypeOf(match) !== null ? match : null;
  }

  function sourceOf(rangeKey: string): string | null {
    return sliceBlockSource(options.source(), rangeKey);
  }

  /** 把手：只随 `editMode` / `available` / `suspended` 增删，不重建任何节点。 */
  function refreshAffordances(): void {
    if (!container) {
      return;
    }
    const on = editMode && available && !suspended;
    for (const block of claimedBlocks(container)) {
      if (active?.block === block) {
        continue;
      }
      if (block.getAttribute(EDIT_STATE_ATTRIBUTE) === EDIT_CONFLICT_STATE) {
        // 冲突态由卡片负责，把手让位，免得 hover 又诱导出一个编辑框。
        block.removeAttribute("tabindex");
        block.removeAttribute(EDITABLE_ATTRIBUTE);
        continue;
      }
      const type = blockTypeOf(block);
      if (!type) {
        continue;
      }
      if (on) {
        block.setAttribute("tabindex", "0");
        block.setAttribute(EDITABLE_ATTRIBUTE, type);
        block.setAttribute(EDIT_STATE_ATTRIBUTE, EDIT_IDLE_STATE);
      } else {
        block.removeAttribute("tabindex");
        block.removeAttribute(EDITABLE_ATTRIBUTE);
        block.removeAttribute(EDIT_STATE_ATTRIBUTE);
      }
    }
  }

  function stripUnitAttributes(block: HTMLElement): void {
    block.removeAttribute("contenteditable");
    block.removeAttribute("spellcheck");
    block.removeAttribute("role");
    block.removeAttribute("aria-multiline");
    block.removeAttribute("aria-label");
    block.removeAttribute(EDIT_MODE_ATTRIBUTE);
  }

  function dropCard(rangeKey: string): void {
    cards.get(rangeKey)?.remove();
    cards.delete(rangeKey);
  }

  /**
   * 取消活动单元：DOM 还原到进入编辑时那份快照（§9.4「取消要真的取消」）。
   * 快照已含接管层静态产物（CodeMirror 宿主 / 图表 SVG），无需再清状态属性。
   */
  function cancelActive(unit: EditUnit): void {
    if (active === unit) {
      active = null;
    }
    hideToolbar();
    unit.deactivate({ restore: true });
    unit.block.removeAttribute(EDIT_STATE_ATTRIBUTE);
  }

  function cardButton(card: HTMLElement, label: string, onClick: () => void): void {
    const doc = card.ownerDocument ?? document;
    const button = doc.createElement("button");
    button.type = "button";
    button.className = "readora-edit-conflict-action";
    button.textContent = label;
    button.addEventListener("click", onClick);
    card.appendChild(button);
  }

  /**
   * 冲突卡片（§5.3）。
   *
   * 三枚错误码的文案与动作集必须不同：`stale` 给「强制替换」，因为最新源里
   * 那块多半还在；`rangeInvalid` 的把手已作废、`applyFailed` 是宿主拒写，
   * 两者都没有「再试一次同样的东西」这条出路，硬给一个重试按钮是骗人。
   * `search` 是挂起不是失败，所以只有「继续编辑」与「放弃」。
   */
  function showCard(anchor: HTMLElement, entry: ParkedEdit): void {
    const doc = anchor.ownerDocument ?? document;
    dropCard(entry.rangeKey);
    const card = doc.createElement("div");
    card.className = EDIT_CONFLICT_CLASS;
    card.setAttribute("role", "status");
    card.setAttribute("data-readora-edit-reason", entry.reason);
    const summary = doc.createElement("p");
    summary.className = "readora-edit-conflict-reason";
    summary.textContent = EDIT_CONFLICT_MESSAGES[entry.reason];
    card.appendChild(summary);
    // 未提交的输入抄一份进卡片：节点被重写顶掉时它仍是可手选、可复制的文本。
    const kept = doc.createElement("pre");
    kept.className = "readora-edit-conflict-text";
    kept.textContent = entry.text;
    card.appendChild(kept);
    if (entry.reason === "stale") {
      cardButton(card, "Re-edit from the latest source", () => {
        restartFromLatestSource(entry);
      });
      cardButton(card, "Replace anyway", () => {
        forceReplace(entry);
      });
    } else if (entry.reason === "search") {
      cardButton(card, "Continue editing", () => {
        resumeFrom(entry);
      });
    } else {
      cardButton(card, "Re-edit from the latest source", () => {
        restartFromLatestSource(entry);
      });
    }
    cardButton(card, "Discard", () => {
      abandon(entry.rangeKey);
    });
    card.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        abandon(entry.rangeKey);
      }
    });
    anchor.insertAdjacentElement("afterend", card);
    cards.set(entry.rangeKey, card);
  }

  /** 提交被拒 / 挂起：DOM 一律不动，把输入记进 parked（§5.4）。 */
  function park(unit: EditUnit, reason: ConflictReason): void {
    if (active === unit) {
      active = null;
    }
    hideToolbar();
    unit.release();
    stripUnitAttributes(unit.block);
    unit.block.setAttribute(EDIT_STATE_ATTRIBUTE, EDIT_CONFLICT_STATE);
    const entry: ParkedEdit = {
      rangeKey: unit.rangeKey,
      type: unit.type,
      mode: unit.mode,
      text: unit.text(),
      reason,
      node: unit.block,
      unit,
      replaced: null
    };
    parked.set(unit.rangeKey, entry);
    showCard(unit.block, entry);
  }

  /** 放弃：把这块还原成静态产物，清卡片。 */
  function abandon(rangeKey: string): void {
    const entry = parked.get(rangeKey);
    dropCard(rangeKey);
    parked.delete(rangeKey);
    if (!entry) {
      return;
    }
    if (entry.node.isConnected) {
      if (entry.replaced) {
        entry.node.replaceWith(entry.replaced);
        entry.replaced.removeAttribute(EDIT_STATE_ATTRIBUTE);
      } else {
        // 没被顶掉过：单元自己那份进入时的快照就是静态产物，直接还原。
        // 快照已含接管层静态产物，无需再清状态属性。
        entry.unit.deactivate({ restore: true });
        entry.node.removeAttribute(EDIT_STATE_ATTRIBUTE);
      }
    }
    refreshAffordances();
  }

  /**
   * 卡片上的「继续编辑」（§7.3）：解除挂起并把那份输入重新挂上。
   *
   * 挂起时正文已还给静态产物（否则导出会带走草稿），所以这里的「重挂」是拿
   * `parked.text` 重新激活一次，而不是「DOM 一直没动」。搜索是宿主的状态，
   * 本层只向上发一个 `onResume` 请求；它把 `editSuspended` 改回假，下一次
   * `setSuspended(false)` 到达时补上重挂。导出那种无条件挂起则当场自己解。
   */
  function resumeFrom(entry: ParkedEdit): void {
    const rangeKey = entry.rangeKey;
    dropCard(rangeKey);
    parked.delete(rangeKey);
    resumePending = { rangeKey, text: entry.text };
    suspendedByCall = false;
    options.onResume?.();
    if (suspendedBySignal) {
      refreshAffordances();
      return;
    }
    applySuspension();
  }

  /**
   * 卡片上的「以最新源重新编辑」。
   *
   * 初值换成**新快照**该范围的源，形态按判据重跑一遍 —— 源变了判据也可能变，
   * 记着旧形态硬提交就是一次反解析。用户的旧输入留在卡片文本里可手选，
   * 不做「自动塞回输入框」：那会把两份内容混成一份他不知道的文本。
   */
  function restartFromLatestSource(entry: ParkedEdit): void {
    const root = container;
    const source = sourceOf(entry.rangeKey);
    if (!root || source === null) {
      // 新快照里没有这一块了（整段被删）：把手作废，只能放弃。
      abandon(entry.rangeKey);
      if (root) {
        showInlineNote(root, EDIT_CONFLICT_MESSAGES.rangeInvalid);
      }
      return;
    }
    if (entry.node.isConnected) {
      if (entry.replaced) {
        entry.node.replaceWith(entry.replaced);
      } else {
        entry.unit.deactivate({ restore: true });
      }
    }
    const target = entry.replaced ?? entry.node;
    dropCard(entry.rangeKey);
    parked.delete(entry.rangeKey);
    target.removeAttribute(EDIT_STATE_ATTRIBUTE);
    activateBlock(target, entry.rangeKey, source);
  }

  /** 卡片上的「强制替换」：以当前快照版本重发原 rangeKey + 原输入。 */
  function forceReplace(entry: ParkedEdit): void {
    const range = parseRangeKey(entry.rangeKey);
    if (!range) {
      abandon(entry.rangeKey);
      return;
    }
    void port
      .submit({
        documentUri: port.documentUri(),
        range,
        newText: entry.text,
        baseVersion: port.version()
      })
      .then(
        (result) => {
          expectedEcho = { version: result.version, rangeKey: entry.rangeKey };
          abandonKeepingContent(entry);
        },
        (error: unknown) => {
          entry.reason = reasonOfCode(
            bridgeErrorCode(error, READORA_ERROR_CODES.EDIT_APPLY_FAILED)
          );
          showCard(entry.node, entry);
        }
      );
  }

  /** 强制替换成功：清卡片与 parked，但保留那块 DOM（它就是刚写进源的形态）。 */
  function abandonKeepingContent(entry: ParkedEdit): void {
    dropCard(entry.rangeKey);
    parked.delete(entry.rangeKey);
    entry.node.removeAttribute(EDIT_STATE_ATTRIBUTE);
    refreshAffordances();
  }

  /**
   * 真正把区块挂成活动单元；返回**是否真的进入了编辑**。
   *
   * 返回值只被双击入口用：进入编辑的那一次双击要 `stopPropagation`，免得同一
   * 次双击又被 Pele 图表引擎当成缩放手势（它接管了拖拽 / 滚轮 / 双击）——
   * 图表会在进入编辑那一刻被放大。没进入编辑（超阈值 / 非认领块）则不管，
   * 阅读态下双击图仍归 Pele 缩放。
   */
  function activateBlock(
    block: HTMLElement,
    rangeKey: string,
    source: string,
    draft?: string
  ): boolean {
    const type = blockTypeOf(block);
    if (!type) {
      return false;
    }
    if (source.length > EDIT_BLOCK_MAX_SOURCE_LENGTH) {
      // 阈值只拦「就地编辑」这一种交互：提示走行内通道，不新增提示节点种类（§9.5）。
      showInlineNote(block, EDIT_BLOCK_TOO_LARGE_NOTE);
      return false;
    }
    // 同一时刻只有一个活动单元。
    if (active) {
      cancelActive(active);
    }
    block.removeAttribute("tabindex");
    const unit = createEditUnit({
      block,
      type,
      rangeKey,
      source,
      mode: editModeFor(source, type, block),
      draft,
      onSubmit: submitUnit,
      onEscape: (target) => {
        cancelActive(target);
        refreshAffordances();
      }
    });
    active = unit;
    unit.activate();
    syncToolbar();
    return true;
  }

  function activateAt(rangeKey: string, draft?: string): void {
    if (!container) {
      return;
    }
    const block = blockByRangeKey(container, rangeKey);
    const source = sourceOf(rangeKey);
    if (block && source !== null) {
      activateBlock(block, rangeKey, source, draft);
    }
  }

  function activateByRangeKey(block: HTMLElement): boolean {
    const rangeKey = rangeKeyOf(block);
    if (rangeKey === null || !editMode || !available || suspended) {
      return false;
    }
    if (active?.block === block) {
      return false;
    }
    const source = sourceOf(rangeKey);
    if (source === null) {
      return false;
    }
    return activateBlock(block, rangeKey, source);
  }

  function submitUnit(unit: EditUnit): void {
    const range = parseRangeKey(unit.rangeKey);
    if (!range) {
      cancelActive(unit);
      return;
    }
    if (!unit.dirty()) {
      // 没改过就不发消息：一次空提交会让 Host 的 version 前进，白排一次回声。
      cancelActive(unit);
      refreshAffordances();
      return;
    }
    void port
      .submit({
        documentUri: port.documentUri(),
        range,
        newText: unit.newText(),
        baseVersion: port.version()
      })
      .then(
        (result) => {
          expectedEcho = { version: result.version, rangeKey: unit.rangeKey };
          // 内容已落进源：单元转 idle 并销毁，等新快照推回来把静态形态换成它。
          if (active === unit) {
            active = null;
          }
          hideToolbar();
          unit.deactivate();
          unit.block.removeAttribute(EDIT_STATE_ATTRIBUTE);
          refreshAffordances();
        },
        (error: unknown) => {
          // 三枚错误码的 DOM 一律不动：用户的输入还在原地。
          park(unit, reasonOfCode(bridgeErrorCode(error, READORA_ERROR_CODES.EDIT_APPLY_FAILED)));
        }
      );
  }

  /**
   * 选区端点 → 单元文本下标（§6.3）。
   *
   * 两条不同的降级在这里先分流，上层才能各走各的：
   * - 两端都在本单元外 → `null`（什么都不做，工具条也不出现）；
   * - 只有一端在外 → **夹回单元内**（按 0 / `length` 截断），选区拖过把手不算错；
   * - 在内但映射不出下标 → 保留 `null` 的那一格，交给 `applyInlineAction` 走
   *   「不动结构、只插一对字面标记」那条路（§6.3 后半句）。
   */
  function selectionOffsets(unit: EditUnit): { from: number | null; to: number | null } | null {
    const selection = options.selection ? options.selection() : readUnitSelection(unit.block);
    if (!selection) {
      return null;
    }
    const startInside = isPointInsideBlock(unit.block, selection.start);
    const endInside = isPointInsideBlock(unit.block, selection.end);
    if (!startInside && !endInside) {
      return null;
    }
    const mapper = createSelectionMapper(unit.block, unit.type, unit.mode);
    return {
      from: startInside ? mapper.offsetOf(selection.start) : 0,
      to: endInside ? mapper.offsetOf(selection.end) : mapper.length
    };
  }

  /** 工具条锚点：选区矩形优先，读不到就退回区块自己的矩形（jsdom 全零，真像素归 e2e）。 */
  function anchorRect(unit: EditUnit): { top: number; left: number } {
    const view = unit.block.ownerDocument?.defaultView;
    const selection =
      view && typeof view.getSelection === "function" ? view.getSelection() : null;
    // `typeof` 那道拦问不能省：jsdom 的 `Range` **没有** `getBoundingClientRect`，
    // 直接调会抛穿整个 dblclick 路径（真浏览器里有，而单测里本就该走区块矩形分支）。
    const range = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
    const box = range && typeof range.getBoundingClientRect === "function"
      ? range.getBoundingClientRect()
      : null;
    if (box && (box.top !== 0 || box.left !== 0)) {
      return { top: box.top, left: box.left };
    }
    const fallback = unit.block.getBoundingClientRect();
    return { top: fallback.top, left: fallback.left };
  }

  function hideToolbar(): void {
    toolbarState = null;
    pendingLink = null;
    toolbar?.hide();
  }

  /** 懒建：工具条要 `ownerDocument`，而接管层在第一次 `scan` 之前不认识任何节点。 */
  function toolbarFor(owner: HTMLElement): FormatToolbar {
    if (!toolbar) {
      toolbar = createFormatToolbar(owner, {
        onAction: (action) => runAction(action),
        onLevel: (level) => changeLevel(level),
        onLink: (url) => runAction("link", url),
        onUrlOpen: () => {
          // 失焦之前把选区换算成下标抄下来：下一行 `urlInput.focus()` 就把选区拿走了
          const offsets = active ? selectionOffsets(active) : null;
          pendingLink =
            offsets && offsets.from !== null && offsets.to !== null
              ? { from: offsets.from, to: offsets.to }
              : null;
        },
        onCancel: () => {
          // 与区块上那枚 `Escape` 同一条出口（`activateBlock` 里 `onEscape` 那两句）：
          // DOM 还原成进入编辑时那份快照，一个 `document.edit` 都不发。工具条自己在
          // `cancelActive` 里被摘掉 —— 在它的子节点上摘它是安全的，而 `deactivate`
          // 先退监听再摘属性，不会顺手把那一次焦点转移变成提交。
          const unit = active;
          if (!unit) {
            return;
          }
          cancelActive(unit);
          refreshAffordances();
        }
      });
    }
    return toolbar;
  }

  /**
   * 把工具条刷成「活动单元此刻的样子」（§6.3）。
   *
   * 由四种事件驱动：激活、选区变（keyup / mouseup / `selectionchange`）、
   * 动作落地后、挂起与重写。它们全部汇到这一个函数，是为了让「按钮什么时候可点」
   * 只有一个答案 —— 分散在各处 setter 就会留下「bold 更新了、code 还停在上一轮」。
   */
  function syncToolbar(): void {
    const unit = active;
    if (!unit || !editMode || !available || suspended
      || unit.type === "codeBlock" || unit.type === "diagramBlock" || unit.type === "table"
      || unit.type === "mathBlock") {
      hideToolbar();
      return;
    }
    const text = unit.text();
    const offsets = selectionOffsets(unit);
    const from = offsets?.from ?? null;
    const to = offsets?.to ?? null;
    const mapped = offsets !== null && from !== null && to !== null;
    const lineStart = from === null ? 0 : text.lastIndexOf("\n", from - 1) + 1;
    const previous = toolbarState;
    toolbarState = {
      // collapsed 的选区包不出东西；有一端映射不出来则留给 §6.3 的降级支。
      canWrap: offsets !== null && !(mapped && from === to),
      insideCode: from !== null && insideCodeSpan(text, lineStart, from),
      isHeading: unit.type === "heading",
      level: unit.headingLevel(),
      rect: anchorRect(unit)
    };
    // 两个「按钮为什么是灰的」要说在**置灰的那一次**，而不是等用户去点：
    // disabled 按钮收不到 click，把提示只写在动作里就永远读不到（决策 5 / §6.3）。
    // `previous` 那个对比是为了不每敲一键就重说一遍同一句。
    if (toolbarState.isHeading && toolbarState.level === null && previous?.level !== null) {
      showInlineNote(unit.block, EDIT_LEVEL_UNAVAILABLE_NOTE);
    } else if (toolbarState.insideCode && previous?.insideCode !== true) {
      showInlineNote(unit.block, EDIT_INSIDE_CODE_NOTE);
    }
    toolbarFor(unit.block).show(toolbarState);
  }

  /** 滚动 / 视口变化：只换 rect 重定位，不重算选区（`position: fixed` 只认视口坐标）。 */
  function relocateToolbar(): void {
    if (!toolbar || !toolbarState || !active) {
      return;
    }
    toolbarState = { ...toolbarState, rect: anchorRect(active) };
    toolbar.show(toolbarState);
  }

  /** 把纯函数算出的新选区还原回 DOM：「再点一次同一个按钮」就是解包的入口。 */
  function restoreSelection(unit: EditUnit, from: number, to: number): void {
    const owner = unit.block.ownerDocument;
    const view = owner?.defaultView;
    if (!owner || !view || typeof view.getSelection !== "function") {
      return;
    }
    // 链接那一条路径上焦点跑到过 URL 输入框里（`closeUrlRow` 已经把它交出来），
    // 而焦点不在正文时 `addRange` 落下去的选区看不见也接不住后续按键。
    // 先 focus 后 addRange：反了会被 focus 把刚设好的选区收到块首。
    if (owner.activeElement !== unit.block) {
      unit.block.focus({ preventScroll: true });
    }
    // 新建一次模型：上一步的 splice 已经改过 DOM，旧的下标表属于另一个形态。
    const mapper = createSelectionMapper(unit.block, unit.type, unit.mode);
    const start = mapper.pointAt(from);
    const end = mapper.pointAt(to);
    if (!start || !end) {
      return;
    }
    try {
      const range = owner.createRange();
      range.setStart(start.node, start.offset);
      range.setEnd(end.node, end.offset);
      const selection = view.getSelection();
      if (!selection) {
        return;
      }
      selection.removeAllRanges();
      selection.addRange(range);
    } catch {
      // 还原失败不致命：标记已落进 DOM，用户自己再选一次即可。
    }
  }

  /**
   * 一次格式化动作（§6.3 的主链路）。
   *
   * 取选区 → 换算下标 → 纯函数算新文本与逐条替换 → 从后往前写回 DOM →
   * 还原选区 → 刷工具条。写回顺序是这条链上唯一容易做错的一处：`edits` 按输入
   * 下标升序，而每一条写下去都会让它后面那些下标失效，所以**倒着写**。
   * 也不拼平整块：对 `list` 来说整块拼平会跨过 `<li>` 边界把结构拆掉。
   */
  function runAction(action: InlineAction, url?: string): void {
    const unit = active;
    if (!unit) {
      return;
    }
    // 链接：此刻文档选区已经在 URL 输入框手里，包的是展开那一行抄下的下标。
    const offsets =
      action === "link" && pendingLink !== null ? pendingLink : selectionOffsets(unit);
    pendingLink = null;
    const outcome = applyInlineAction({
      action,
      text: unit.text(),
      from: offsets?.from ?? null,
      to: offsets?.to ?? null,
      type: unit.type,
      mode: unit.mode,
      url,
      documentText: options.source()
    });
    if (outcome.kind === "blocked") {
      if (outcome.reason === "inside-code") {
        // 「什么都没做」必须说一句：按钮在工具条上已置灰，键盘路径仍可能递到这里。
        showInlineNote(unit.block, EDIT_INSIDE_CODE_NOTE);
      }
      return;
    }
    const edits = outcome.kind === "degraded" ? [outcome.edit] : outcome.edits;
    for (let index = edits.length - 1; index >= 0; index -= 1) {
      const edit = edits[index];
      if (!edit) {
        continue;
      }
      if (!unit.applyTextSplice(edit.from, edit.to, edit.insert)) {
        // 写不下去就停在这里：每一条 edit 自己就是一对完整的标记，少写几条只是
        // 少做一件事，不会留下孤立的 `**`（§6.3「宁可不写也不能写出损坏的源」）。
        showInlineNote(unit.block, EDIT_SELECTION_UNMAPPED_NOTE);
        syncToolbar();
        return;
      }
    }
    // 降级那一支只把光标落在两个标记之间（`caret`），不还原选区。
    const restored =
      outcome.kind === "degraded"
        ? { from: outcome.caret, to: outcome.caret }
        : { from: outcome.from, to: outcome.to };
    restoreSelection(unit, restored.from, restored.to);
    if (outcome.kind === "degraded") {
      showInlineNote(unit.block, EDIT_SELECTION_UNMAPPED_NOTE);
    } else if (action === "footnote") {
      showInlineNote(unit.block, EDIT_FOOTNOTE_NOTE);
    } else if (outcome.multiline) {
      // 决策 2 第 4 条：跨行逐行包要说一句，这件事与用户点的「加粗」语义不完全同。
      showInlineNote(unit.block, EDIT_MULTILINE_WRAP_NOTE);
    }
    syncToolbar();
  }

  /** 改 heading 级别（决策 5）：形态 A 不动 DOM，只改 marker 覆盖。 */
  function changeLevel(level: HeadingLevel): void {
    const unit = active;
    if (!unit) {
      return;
    }
    if (!unit.setLevel(level)) {
      showInlineNote(unit.block, EDIT_LEVEL_UNAVAILABLE_NOTE);
      return;
    }
    syncToolbar();
  }

  function onSelectionMaybeChanged(): void {
    // 只跟着活动单元走：静态阅读态里选文本不该弹出一个编辑工具条。
    if (active) {
      syncToolbar();
    }
  }

  /** 重写前把活动节点摘下来持有（连同它身上未提交的输入）。 */
  function detachForRewrite(): void {
    hideToolbar();
    if (!active) {
      return;
    }
    const unit = active;
    active = null;
    unit.release();
    stripUnitAttributes(unit.block);
    parked.set(unit.rangeKey, {
      rangeKey: unit.rangeKey,
      type: unit.type,
      mode: unit.mode,
      text: unit.text(),
      // 外部快照把正在编辑的这块顶掉了：语义上就是「你编辑期间文件变了」。
      reason: suspended ? "search" : "stale",
      node: unit.block,
      unit,
      replaced: null
    });
    unit.block.parentNode?.removeChild(unit.block);
  }

  /** 重写后：把持有的节点插回同 rangeKey 的位置，插不回去就接在正文末尾。 */
  function reinsertHeld(root: HTMLElement): void {
    for (const entry of parked.values()) {
      entry.replaced = null;
      if (entry.node.parentNode !== root) {
        const fresh = blockByRangeKey(root, entry.rangeKey);
        if (fresh) {
          fresh.replaceWith(entry.node);
          // 留住被顶掉的那一份：放弃时要能回到静态产物。
          entry.replaced = fresh;
        } else {
          root.appendChild(entry.node);
        }
      }
      entry.node.setAttribute(EDIT_STATE_ATTRIBUTE, EDIT_CONFLICT_STATE);
      showCard(entry.node, entry);
    }
  }

  function onDoubleClick(event: MouseEvent): void {
    const target =
      event.target instanceof Element ? event.target.closest<HTMLElement>(EDITABLE_BLOCK_SELECTOR) : null;
    if (!target || target.parentElement !== container) {
      return;
    }
    // 真的进入编辑才拦停：冒泡阶段抢在任何下游监听（尤其是图表 Pele 的双击缩放）
    // 之前。注册在捕获阶段，所以这里是整个正文子树最早收到 dblclick 的一环。
    if (activateByRangeKey(target)) {
      event.stopPropagation();
    }
  }

  function onKeyDown(event: KeyboardEvent): void {
    const key = event.key;
    // `e` / `E`（E3）与 Enter / Space 同一条委托：修饰键让路（`Ctrl+E` 是宿主的
    // 「重命名符号」那一类全局和弦，`Alt+E` 同理），`Ctrl+Enter` 是提交和弦。
    if (key !== "Enter" && key !== " " && key !== "Spacebar" && key !== "e" && key !== "E") {
      return;
    }
    // 修饰键让路：`Ctrl+Enter` 是提交和弦，由单元自己处理；这里只认裸 Enter / Space / E。
    if (event.ctrlKey || event.metaKey || event.altKey) {
      return;
    }
    const target =
      event.target instanceof Element
        ? event.target.closest<HTMLElement>(`[${EDITABLE_ATTRIBUTE}]`)
        : null;
    if (!target || target.parentElement !== container) {
      return;
    }
    // 只从 idle 态激活。单元内的 `Enter` 是换行，冲突块上的按键也不该重挂：
    // 重挂要按判据重算形态，而那一刻块里是**未提交的输入**，判据必然不成立 →
    // 落到形态 B → 把源文本盖回块里，草稿就这么被抹掉了。浏览器会在同一个
    // keydown 事件上先跑完单元自己的监听（提交在那里发起），中间让出一个
    // 微任务检查点，被拒的 `park` 正好落在两次监听之间 —— 那时 `active` 已空，
    // 光靠「同一块不重复激活」挡不住。活动单元里敲 `e` 同样走这道护栏：那个 `e`
    // 是一个字，不是快捷键（§15 E3 的 idle-only 护栏，新键复用而不是另写判据）。
    if (target.getAttribute(EDIT_STATE_ATTRIBUTE) !== EDIT_IDLE_STATE) {
      return;
    }
    // 键盘可达：不新增每块按钮节点，激活靠 `Enter` / `Space` / `E`（§7.1）。
    event.preventDefault();
    activateByRangeKey(target);
  }

  /**
   * 挂起与恢复：`setSuspended` 与导出前的 `suspend` 共用这一条路径。
   *
   * 挂起比冲突多一步「还静态产物」：正在输入的草稿退回块内显示的话，导出取帧
   * 就会把一段**未落盘的草稿**写进交付物（ARC-008 §16.1），而搜索高亮也会跟它打架。
   * 输入本身不丢：`park` 已经把它抓成卡片里的可选文本，「继续编辑」从新快照重挂。
   * 提交被拒那一路**不**走这里：那里用户需要看到自己刚写的东西（§5.4）。
   *
   * 「到底挂没挂」不是一个参数说了算，而是两个信号的或：只认最后一个写它的信号，
   * 导出那一次临时挂起就会被搜索面板的一次开关顺带解开（反之亦然）。
   */
  function applySuspension(): void {
    const on = suspendedBySignal || suspendedByCall;
    suspended = on;
    if (on && active) {
      const unit = active;
      if (unit.dirty()) {
        // 脏：走同一套保全机制，卡片只给「继续编辑」与「放弃」。
        park(unit, "search");
        unit.deactivate({ restore: true });
      } else {
        cancelActive(unit);
      }
    } else if (!on && resumePending) {
      const pending = resumePending;
      resumePending = null;
      activateAt(pending.rangeKey, pending.text);
    }
    refreshAffordances();
    syncToolbar();
  }

  function reset(): void {
    hideToolbar();
    if (active) {
      active.release();
      stripUnitAttributes(active.block);
      active.block.removeAttribute(EDIT_STATE_ATTRIBUTE);
      active = null;
    }
    resumePending = null;
    for (const key of [...cards.keys()]) {
      dropCard(key);
    }
    for (const entry of parked.values()) {
      entry.node.remove();
    }
    parked.clear();
    expectedEcho = null;
  }

  return {
    scan(root) {
      const previousUri = documentUri;
      documentUri = port.documentUri();
      if (previousUri !== documentUri) {
        // 用户主动切走：parked 里是另一篇文档的输入，留着只会误提交到别处。
        reset();
      }
      const version = Number(root.getAttribute("data-readora-document-version"));
      if (expectedEcho && Number.isInteger(version) && version === expectedEcho.version) {
        // 正常回声：这一版就是我们自己写回去的那次，未提交输入不再是分歧。
        parked.delete(expectedEcho.rangeKey);
        expectedEcho = null;
      }
      // 卡片绑在旧节点上，随重写一并作废后按 parked 重建。
      for (const key of [...cards.keys()]) {
        dropCard(key);
      }
      if (!attached) {
        // 捕获阶段：要在图表引擎（挂在容器内子节点上）之前拿到双击，才能决定
        // 「进入编辑」时拦停它，不让同一次双击顺带把图缩放掉。
        root.addEventListener("dblclick", onDoubleClick, true);
        root.addEventListener("keydown", onKeyDown);
        // 工具条跟着选区走：选区只在三个地方变 —— 键盘、鼠标、以及宿主自己
        // 改选区（`selectionchange` 是唯一能覆盖全部三种的那个事件，但它在
        // 单元外也会响，所以 `onSelectionMaybeChanged` 里先问一句有没有活动单元）。
        root.addEventListener("keyup", onSelectionMaybeChanged);
        root.addEventListener("mouseup", onSelectionMaybeChanged);
        root.ownerDocument?.addEventListener("selectionchange", onSelectionMaybeChanged);
        const view = root.ownerDocument?.defaultView;
        // 滚动是捕获阶段才收得到（正文滚动容器不是 window），工具条要跟着重定位。
        view?.addEventListener("scroll", relocateToolbar, true);
        view?.addEventListener("resize", relocateToolbar);
        attached = true;
      }
      container = root;
      reinsertHeld(root);
      refreshAffordances();
      // 重写之后 `active` 已被 `detachForRewrite` 清空 → 这里同时兑现「正文重写后工具条不在」。
      syncToolbar();
    },
    detachForRewrite() {
      detachForRewrite();
    },
    setEditMode(on) {
      editMode = on;
      if (!on && active) {
        cancelActive(active);
      }
      refreshAffordances();
      syncToolbar();
    },
    setAvailable(on) {
      available = on;
      if (!on && active) {
        // 不可写就别让人开始改：正在改的还原回去，不给「改了但注定写不进」。
        cancelActive(active);
      }
      refreshAffordances();
      syncToolbar();
    },
    setSuspended(on) {
      suspendedBySignal = on;
      applySuspension();
    },
    suspend() {
      suspendedByCall = true;
      applySuspension();
    },
    resetForDocument() {
      reset();
    },
    destroy() {
      reset();
      if (container && attached) {
        container.removeEventListener("dblclick", onDoubleClick, true);
        container.removeEventListener("keydown", onKeyDown);
        container.removeEventListener("keyup", onSelectionMaybeChanged);
        container.removeEventListener("mouseup", onSelectionMaybeChanged);
        container.ownerDocument?.removeEventListener("selectionchange", onSelectionMaybeChanged);
        const view = container.ownerDocument?.defaultView;
        view?.removeEventListener("scroll", relocateToolbar, true);
        view?.removeEventListener("resize", relocateToolbar);
        attached = false;
      }
      // 工具条挂在 body 上，不摘就是 `destroy()` 后飘在屏上的一块残留（决策 4 的代价）。
      toolbar?.destroy();
      toolbar = null;
      toolbarState = null;
      for (const key of [...cards.keys()]) {
        dropCard(key);
      }
      container = null;
    },
    snapshot() {
      return {
        activeRangeKey: active?.rangeKey ?? null,
        parkedRangeKeys: [...parked.keys()]
      };
    }
  };
}
