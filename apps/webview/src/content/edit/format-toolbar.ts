/**
 * 活动单元上方的格式化工具条（ARC-009 §6.3 / §7.4，E3）。
 *
 * 这一层**只**负责节点与定位：不换算下标、不碰提交、不认识 `Range`。动作全部
 * 交回接管层（`edit-layer.ts` 的 `runAction`），于是「六个按钮点了会发生什么」
 * 在 `inline-format.ts` 里被纯字符串穷举，而「按钮什么时候可点、长在哪」在这里
 * 被 DOM 断言。分层的理由与 `edit-unit.ts` 同一处：能在 jsdom 里断言的事不去起浏览器。
 *
 * **挂在 `ownerDocument.body` 上**，不是挂在正文子树里（决策 4，四条理由）：
 * 1. `export-document.ts` 序列化的是正文容器的 `cloneNode(true).innerHTML` ——
 *    挂 body 的工具条**结构上**就进不了交付物，不需要新增一条剥离规则；
 * 2. `search-engine.ts` 的 `ATTACHED_EXCLUDED_SELECTOR` 只在正文子树内生效 ——
 *    同理不需要新增排除项；
 * 3. 正文容器在滚动上下文里，`position: fixed` + 选区矩形只认视口坐标，
 *    不必给容器加定位上下文；
 * 4. 工具条内的 `keydown` 冒泡不到容器，容器上那套 `Enter` / `Space` / `E` 委托
 *    天然不会被输入框误触发。
 *
 * 代价也如实记在这里：**生命周期由接管层负责**（单元销毁、正文重写、挂起、
 * 换文档、`destroy()` 五种场合都要收），收起的方式是从 body 上摘掉节点，
 * 所以「`document.body` 上零残留」是可断言的（`format-toolbar.spec.ts`）。
 *
 * 不用 `Icon` 组件（本轮不动 `Icon.tsx`）：按钮可见内容是字面字形
 * `B` / `I` / `S` / `<>` / `[]` / `[^n]` / `H1`…`H6`，可访问名走 `aria-label`，
 * 与 `editToggle` 的 "Edit mode"、冲突卡片的 "Replace anyway" 同一套英文口径。
 */
import type { InlineAction } from "./inline-format";

/** 工具条根节点的类名：`KEEP_EDITING_SELECTOR`、导出剥离断言都引这一处。 */
export const EDIT_TOOLBAR_CLASS = "readora-edit-toolbar";
export const EDIT_TOOLBAR_ROLE = "toolbar";
export const EDIT_TOOLBAR_ARIA_LABEL = "Formatting";

/** 定位用的估算尺寸：jsdom 里 `getBoundingClientRect` 全是 0，测不了真像素。 */
const TOOLBAR_MARGIN = 8;
const TOOLBAR_ESTIMATED_HEIGHT = 34;
const TOOLBAR_ESTIMATED_WIDTH = 320;

/** heading 的六级 + 六个动作，顺序即键盘顺序（`<>` 排在 `[]` 前，脚注在最后）。 */
const ACTIONS: ReadonlyArray<{ action: InlineAction; glyph: string; label: string }> = [
  { action: "bold", glyph: "B", label: "Bold" },
  { action: "italic", glyph: "I", label: "Italic" },
  { action: "strike", glyph: "S", label: "Strikethrough" },
  { action: "code", glyph: "<>", label: "Inline code" },
  { action: "link", glyph: "[]", label: "Link" },
  { action: "footnote", glyph: "[^n]", label: "Footnote reference" }
];

const LEVELS = [1, 2, 3, 4, 5, 6] as const;

export type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;

/**
 * 工具条的一次呈现所需的全部状态。
 *
 * 之所以是「一个状态对象 + 一次 `show`」而不是逐个 setter：可点性由这些值**联合**
 * 决定（`canWrap` 关四枚、`insideCode` 关另外几枚、`level === null` 关六枚级别按钮），
 * 逐个 setter 会留下「按钮 A 更新了、按钮 B 还停在上一轮」的中间态。
 */
export interface ToolbarState {
  /** 选区两端都映射得出下标（空选区也算 false：包裹需要东西可包）。 */
  canWrap: boolean;
  /** 选区落在已有的 code span 里。 */
  insideCode: boolean;
  isHeading: boolean;
  /** 当前级别；`null` = 解析不出 ATX 前缀（setext 标题等），六枚按钮置灰。 */
  level: HeadingLevel | null;
  /** 锚点：选区矩形的左上角（视口坐标）。 */
  rect: { top: number; left: number };
}

export interface ToolbarHandlers {
  onAction(action: InlineAction): void;
  onLevel(level: HeadingLevel): void;
  /**
   * URL 输入框**即将展开**的那一刻（e2e 抓到的浏览器行为，ARC-009 §16.6）。
   *
   * Chromium 的文档选区属于当前焦点控件：焦点一进 `<input>`，正文里那段选区就没了
   * （`selection.toString()` 实测返回空串）。所以「要包裹哪一段」必须在**失焦之前**
   * 换算成下标交给接管层记住 —— 这一条回调存在的全部理由就是这一个时间差，
   * 因此它必须在 `urlInput.focus()` 之前发出。
   */
  onUrlOpen(): void;
  /** URL 输入框的提交（回车或 Apply）；空白串交回接管层按 `blocked` 处理。 */
  onLink(url: string): void;
}

export interface FormatToolbar {
  readonly root: HTMLElement;
  show(state: ToolbarState): void;
  hide(): void;
  destroy(): void;
  /** 链接 URL 输入框是否展开着（接管层据此决定失焦要不要提交）。 */
  readonly awaitingUrl: boolean;
}

/** 选区矩形的最小结构需求（不要求真 `DOMRect`，见下面 `placeToolbar` 的注释）。 */
export type SelectionBox = Pick<DOMRect, "top" | "bottom" | "left">;

export interface Viewport {
  width: number;
  height: number;
}

/**
 * 纯函数：选区矩形 + 视口 → 工具条左上角。
 *
 * 三条规则：默认浮在选区**上方**；上方放不下（贴顶）就翻到下方；左右一律夹进
 * 视口内。参数不收 `DOMRect` 而是收它的三个字段，因为 jsdom 的
 * `getBoundingClientRect()` 返回全零矩形 —— 收字面量才能让这条边界逻辑在单测里
 * 被真的断言到（真实像素在 e2e 与 playwright-cli 取证里各断言一次）。
 */
export function placeToolbar(box: SelectionBox, viewport: Viewport): { top: number; left: number } {
  const width = Math.min(TOOLBAR_ESTIMATED_WIDTH, Math.max(0, viewport.width - TOOLBAR_MARGIN * 2));
  let top = box.top - TOOLBAR_ESTIMATED_HEIGHT - TOOLBAR_MARGIN;
  if (top < TOOLBAR_MARGIN) {
    const below = box.bottom + TOOLBAR_MARGIN;
    // 下面也放不下（贴底）：贴着视口底边放，不让工具条跑屏。
    top = Math.max(
      TOOLBAR_MARGIN,
      Math.min(below, viewport.height - TOOLBAR_ESTIMATED_HEIGHT - TOOLBAR_MARGIN)
    );
  }
  const left = Math.min(
    Math.max(TOOLBAR_MARGIN, box.left),
    Math.max(TOOLBAR_MARGIN, viewport.width - width - TOOLBAR_MARGIN)
  );
  return { top, left };
}

/** 四枚「有选区才有意义」的按钮 + 代码按钮 + 脚注，各自的可点判据。 */
function isActionDisabled(entry: { action: InlineAction }, state: ToolbarState): boolean {
  if (entry.action === "footnote") {
    // 脚注引用是纯插入，光标处就能插（决策 6）。
    return false;
  }
  if (entry.action === "code") {
    // `code` 自己走解包，所以只受 `canWrap` 约束，不受 `insideCode` 约束。
    return !state.canWrap;
  }
  return !state.canWrap || state.insideCode;
}

export function createFormatToolbar(
  target: HTMLElement,
  handlers: ToolbarHandlers
): FormatToolbar {
  const doc = target.ownerDocument;
  const root = doc.createElement("div");
  root.className = EDIT_TOOLBAR_CLASS;
  root.setAttribute("role", EDIT_TOOLBAR_ROLE);
  root.setAttribute("aria-label", EDIT_TOOLBAR_ARIA_LABEL);
  // 默认不显示：`hidden` 而不是 `display:none`，让「在不在屏上」是一个可断言的属性。
  root.hidden = true;

  const buttons: HTMLButtonElement[] = [];
  const actionButtons = new Map<InlineAction, HTMLButtonElement>();
  const levelButtons = new Map<HeadingLevel, HTMLButtonElement>();
  for (const entry of ACTIONS) {
    const button = makeButton(entry.glyph, entry.label);
    button.dataset.readoraAction = entry.action;
    button.addEventListener("click", () => {
      if (entry.action === "link") {
        toggleUrlRow();
        return;
      }
      handlers.onAction(entry.action);
    });
    actionButtons.set(entry.action, button);
    buttons.push(button);
    root.appendChild(button);
  }

  const levelGroup = doc.createElement("div");
  levelGroup.className = `${EDIT_TOOLBAR_CLASS}__levels`;
  for (const level of LEVELS) {
    const button = makeButton(`H${level}`, `Heading level ${level}`);
    button.dataset.readoraLevel = String(level);
    button.addEventListener("click", () => {
      handlers.onLevel(level);
    });
    levelButtons.set(level, button);
    levelGroup.appendChild(button);
    buttons.push(button);
  }
  root.appendChild(levelGroup);

  // 链接 URL：工具条内的一行输入，展开时单元不能被销毁（决策 4 的 mousedown 护栏
  // 与 KEEP_EDITING 名单一起保证「点了链接按钮不会先把编辑关掉」）。
  const urlRow = doc.createElement("div");
  urlRow.className = `${EDIT_TOOLBAR_CLASS}__url`;
  urlRow.hidden = true;
  const urlInput = doc.createElement("input");
  urlInput.type = "url";
  urlInput.className = `${EDIT_TOOLBAR_CLASS}__url-input`;
  urlInput.setAttribute("aria-label", "Link URL");
  urlInput.setAttribute("placeholder", "https://example.com");
  const urlApply = makeButton("Apply", "Apply link");
  urlApply.type = "button";
  let awaitingUrl = false;
  urlApply.addEventListener("click", () => {
    submitUrl();
  });
  urlInput.addEventListener("keydown", (event) => {
    const keyboard = event as KeyboardEvent;
    if (keyboard.key === "Enter") {
      keyboard.preventDefault();
      submitUrl();
      return;
    }
    if (keyboard.key === "Escape") {
      // 嵌套提示优先：Escape 先收起 URL 输入，不退整次编辑（E2 的 Escape 语义不变，
      // 那条路径没有 URL 输入框参与）。
      keyboard.preventDefault();
      closeUrlRow();
    }
  });
  urlRow.append(urlInput, urlApply);
  root.appendChild(urlRow);

  root.addEventListener("keydown", onKeyNav);
  // 全件 `mousedown` 一律 preventDefault：焦点转移不能让选区丢（§6.3 的降级前提）。
  // 输入框自己需要焦点，所以在 preventDefault 之后显式 focus 回去。
  root.addEventListener("mousedown", (event) => {
    const mouse = event as MouseEvent;
    const node = mouse.target instanceof Element ? mouse.target : null;
    if (!node || !node.closest("button, input")) {
      return;
    }
    mouse.preventDefault();
    if (node.closest(`.${EDIT_TOOLBAR_CLASS}__url-input`) || node === urlInput) {
      urlInput.focus();
    }
  });

  let visible = false;

  function makeButton(glyph: string, label: string): HTMLButtonElement {
    const button = doc.createElement("button");
    button.type = "button";
    button.className = `${EDIT_TOOLBAR_CLASS}__button`;
    button.textContent = glyph;
    button.setAttribute("aria-label", label);
    button.tabIndex = -1;
    return button;
  }

  function focusables(): HTMLElement[] {
    const list: HTMLElement[] = [...actionButtons.values()];
    if (levelGroup.hidden === false) {
      list.push(...levelButtons.values());
    }
    if (!urlRow.hidden) {
      list.push(urlInput, urlApply);
    }
    return list;
  }

  /** roving tabindex：整条工具条在 tab 序列里只占一格，内部走方向键（照 ExportMenu）。 */
  function onKeyNav(event: KeyboardEvent): void {
    const keys = ["ArrowLeft", "ArrowRight", "Home", "End"];
    if (!keys.includes(event.key)) {
      return;
    }
    const items = focusables().filter((item) => !isDisabled(item));
    if (items.length === 0) {
      return;
    }
    event.preventDefault();
    const active = doc.activeElement;
    let index = items.findIndex((item) => item === active);
    if (event.key === "Home") {
      index = 0;
    } else if (event.key === "End") {
      index = items.length - 1;
    } else if (index < 0) {
      index = 0;
    } else {
      index = (index + (event.key === "ArrowRight" ? 1 : -1) + items.length) % items.length;
    }
    const next = items[index];
    if (!next) {
      return;
    }
    for (const item of focusables()) {
      item.tabIndex = item === next ? 0 : -1;
    }
    next.focus();
  }

  function isDisabled(item: HTMLElement): boolean {
    return item instanceof HTMLButtonElement ? item.disabled : false;
  }

  function toggleUrlRow(): void {
    if (urlRow.hidden) {
      urlRow.hidden = false;
      awaitingUrl = true;
      urlInput.tabIndex = 0;
      urlApply.tabIndex = -1;
      // 顺序是这条路径上唯一容易做错的一处：先让接管层抄走选区，再把焦点交出去。
      handlers.onUrlOpen();
      urlInput.focus();
      return;
    }
    closeUrlRow();
  }

  function closeUrlRow(): void {
    urlRow.hidden = true;
    urlInput.value = "";
    awaitingUrl = false;
    // 只要这一行收起，焦点就不该还留在输入框里（三条路径：提交、Escape、`hide`）。
    // 未聚焦时 `blur()` 是无害的幂等动作，所以不必先问 `activeElement`。
    urlInput.blur();
  }

  function submitUrl(): void {
    const url = urlInput.value.trim();
    // 先收行（连带交回焦点），再交回接管层：它接下来要 `addRange` 还原选区，
    // 而焦点还在 `<input>` 里时文档选区落不下去（与 `onUrlOpen` 是同一件事的两端）。
    closeUrlRow();
    handlers.onLink(url);
  }

  return {
    root,
    get awaitingUrl() {
      return awaitingUrl;
    },
    show(state: ToolbarState) {
      for (const entry of ACTIONS) {
        const button = actionButtons.get(entry.action);
        if (!button) {
          continue;
        }
        button.disabled = isActionDisabled(entry, state);
      }
      levelGroup.hidden = !state.isHeading;
      for (const [level, button] of levelButtons) {
        const current = state.level === level;
        button.setAttribute("aria-pressed", current ? "true" : "false");
        // 当前级别不需要再点一次；`level === null` 是「解析不出 ATX 前缀」，六枚全灰。
        button.disabled = state.level === null || current;
      }
      if (awaitingUrl) {
        urlInput.disabled = false;
      }
      position(state);
      if (!visible) {
        // 挂 body：见文件头注的四条理由。
        (doc.body ?? doc.documentElement).appendChild(root);
        visible = true;
      }
      root.hidden = false;
      let first = focusables().find((item) => !isDisabled(item));
      if (!first) {
        first = focusables()[0];
      }
      for (const item of focusables()) {
        item.tabIndex = item === first ? 0 : -1;
      }
    },
    hide() {
      closeUrlRow();
      root.hidden = true;
      if (visible) {
        root.remove();
        visible = false;
      }
    },
    destroy() {
      root.removeEventListener("keydown", onKeyNav);
      closeUrlRow();
      root.remove();
      visible = false;
    }
  };

  function position(state: ToolbarState): void {
    const view = doc.defaultView;
    const viewport: Viewport = {
      width: view?.innerWidth ?? 0,
      height: view?.innerHeight ?? 0
    };
    const placed = placeToolbar(
      { top: state.rect.top, bottom: state.rect.top + TOOLBAR_ESTIMATED_HEIGHT, left: state.rect.left },
      viewport
    );
    root.style.position = "fixed";
    root.style.top = `${placed.top}px`;
    root.style.left = `${placed.left}px`;
  }
}
