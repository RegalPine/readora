/**
 * 正文交互事件委托（ARC-005 §9.4 / ARC-002 §7.6 / ARC-008 §9）。
 *
 * 渲染产物里没有任何内联脚本（IMP-001 §8.4），全部交互由这一处委托承担：
 * - `a[data-readora-anchor]` → 文档内滚动（锚点在渲染期被 URI 编码，此处解码）；
 * - `a[data-readora-external]` → 交 Host 的 document.open，Webview 不碰 OS API；
 *   同一条选择器也命中 SVG 图表里的 `<a>`（Sanitizer 把 href 改写成了 data 标记）；
 * - `[data-readora-relative]` → 交 Host 解析后打开目标文档（STORY-08-03），
 *   Host 拒绝时回退成行内提示，不让点击静默失败；
 * - `a[data-readora-wikilink]` → 同上，但目标是 `[[文档名]]`（无扩展名、无 href，
 *   STORY-06-03）；Enter / Space 也接，因为无 href 的 `<a>` 浏览器不会合成点击；
 * - `[data-readora-image]` → 已就绪的图开 Lightbox，未就绪的按状态给原因；
 * - `button[data-readora-copy]` → 复制代码，clipboard 不可用时回退 execCommand。
 *
 * 只监听、不改写正文结构；提示节点带 readora- 前缀，样式归 styles/markdown.css。
 */
import { useEffect, useRef } from "react";
import type { ResourceKind } from "@readora/contracts";
import { findHeading } from "./heading-query";
import type { ImageState } from "./image-layer";
import type { ResourceEntry } from "./resource-cache";

export const RELATIVE_LINK_NOTE = "跨文档跳转待资源解析（M3）";
export const IMAGE_NOTE = "图片加载待资源解析（M3）";
export const IMAGE_NOT_READY_NOTE = "图片尚未就绪，无法放大查看";
/**
 * Wiki Link 未命中的就地提示（STORY-06-03）。
 *
 * 措辞说的是「这篇里没找到」而不是「出错了」：Host 的判据是文件是否存在
 * （readora.wikilink.missing），Obsidian 那套「点未存在的笔记会新建它」
 * 不是阅读器的语义，这里也不承诺。
 */
export const WIKI_LINK_MISSING_NOTE = "未找到目标文档";

/** 交给 Lightbox 的展示输入：src 为空串表示还没有可放大的字节。 */
export interface ImageActivationRequest {
  reference: string;
  alt: string;
  state: ImageState;
  src: string;
  reason: string | null;
}

export interface ContentInteractionHandlers {
  /** 外链交给 Host（document.open），由 Host 做 scheme 策略与 OS 打开。 */
  openExternal(uri: string): void;
  /** 相对链接交给 Host（document.navigate）；返回是否已被接受。 */
  navigate(reference: string): Promise<boolean>;
  /** 图片点击：请求上层打开 Lightbox 覆盖层。 */
  openImage(request: ImageActivationRequest): void;
  /** 资源解析：交 Host 的 resource.resolve；去重与契约复判在请求层完成。 */
  resolveResource(reference: string, kind?: ResourceKind): Promise<ResourceEntry>;
}

type CopyState = "idle" | "copied" | "failed";

const NOTE_CLASS = "readora-inline-note";
const COPY_LABEL = "Copy";
const COPY_RESET_MS = 1600;
const NOTE_REMOVE_MS = 4000;

function closestOf<T extends Element>(target: EventTarget | null, selector: string): T | null {
  if (!(target instanceof Element)) {
    return null;
  }
  return target.closest<T>(selector);
}

/** 锚点 href 在渲染期按 URI 规则编码，DOM id 却是原始文本，跳转前需解码。 */
function decodeAnchor(value: string): string {
  const raw = value.startsWith("#") ? value.slice(1) : value;
  try {
    return decodeURIComponent(raw);
  } catch {
    // 非法百分号序列：按原文尝试定位，绝不抛穿。
    return raw;
  }
}

function findAnchorTarget(container: HTMLElement, anchor: string): HTMLElement | null {
  // 与目录定位同源的查找（id 命中优先，DOMPurify 剥离 id 时回退 data-* 镜像）。
  const target = findHeading(container, anchor);
  return target && container.contains(target) ? target : null;
}

function scrollToAnchor(container: HTMLElement, anchor: string): void {
  const target = findAnchorTarget(container, anchor);
  if (!target) {
    return;
  }
  target.scrollIntoView({ behavior: "smooth", block: "start" });
  // 焦点跟随，键盘用户读完锚点内容后不会丢失位置。
  target.setAttribute("tabindex", "-1");
  target.focus({ preventScroll: true });
}

/**
 * 行内降级提示：同一条提示重复点击时复位计时器，不叠加节点。
 *
 * 导出给编辑接管层复用（ARC-009 §9.5）：「这块太大不适合就地改」与
 * 「这个链接指向不存在的文件」是同一种反馈 —— 说在原地、不打断阅读，
 * 所以走同一个通道、同一个 class，不再造一套提示节点。
 */
export function showInlineNote(anchor: Element, text: string): void {
  const parent = anchor.parentElement;
  if (!parent) {
    return;
  }
  const existing = parent.querySelector(`.${NOTE_CLASS}`);
  if (existing) {
    existing.textContent = text;
    return;
  }
  const note = anchor.ownerDocument?.createElement("span");
  if (!note) {
    return;
  }
  note.className = NOTE_CLASS;
  note.setAttribute("role", "status");
  note.textContent = text;
  anchor.insertAdjacentElement("afterend", note);
  window.setTimeout(() => {
    note.remove();
  }, NOTE_REMOVE_MS);
}

/** 渲染产物里 wiki 引用的选择器：只有一个 data 属性，没有 href（IMP-001 §12.2）。 */
export const WIKI_LINK_SELECTOR = "a[data-readora-wikilink]";

/**
 * wiki 引用的激活：目标原文交 Host 的 document.navigate，落空就行内提示。
 *
 * 这里**不补扩展名、不猜目录、不拼路径**（§12.2）：`[[Note]]` 能不能解析成
 * `Note.md` 是文件系统事实，只有 Host 能回答。View 侧唯一的职责是把点击
 * 换成一次请求，并把「没找到」这件事说在原地处 —— 不弹模态对话框，
 * 因为「点了个不存在的链接」不值得打断阅读。
 */
function activateWikiLink(node: HTMLElement, handlers: ContentInteractionHandlers): void {
  const target = node.getAttribute("data-readora-wikilink") ?? "";
  if (target.length === 0) {
    showInlineNote(node, WIKI_LINK_MISSING_NOTE);
    return;
  }
  void handlers.navigate(target).then((accepted) => {
    if (!accepted) {
      showInlineNote(node, WIKI_LINK_MISSING_NOTE);
    }
  });
}

function codeTextOf(button: Element): string {
  const block = button.closest(".readora-code-block");
  const code = block?.querySelector("pre code") ?? block?.querySelector("pre");
  return code?.textContent ?? "";
}

/** execCommand 回退：VS Code Webview 里 clipboard API 可能因焦点/权限失败。 */
function legacyCopy(doc: Document, text: string): boolean {
  const field = doc.createElement("textarea");
  field.value = text;
  field.setAttribute("readonly", "");
  field.className = "readora-copy-helper";
  doc.body.appendChild(field);
  field.select();
  let ok: boolean;
  try {
    ok = doc.execCommand("copy");
  } catch {
    ok = false;
  }
  field.remove();
  return ok;
}

/** 图表挂载层复用同一套复制通道（工具栏 Copy Source / 错误卡复制）。 */
export async function copyCodeText(text: string): Promise<boolean> {
  const clipboard = navigator.clipboard;
  if (clipboard) {
    try {
      await clipboard.writeText(text);
      return true;
    } catch {
      // 落到 execCommand 回退
    }
  }
  return legacyCopy(document, text);
}

/** 复制状态只改按钮文案与 data 标记，不改正文结构（1.6s 后自动复位）。 */
function markCopyState(button: HTMLElement, state: CopyState): void {
  if (state === "idle") {
    button.textContent = COPY_LABEL;
    button.removeAttribute("data-readora-copy-state");
    return;
  }
  button.textContent = state === "copied" ? "Copied" : "Copy failed";
  button.dataset.readoraCopyState = state;
  window.setTimeout(() => {
    markCopyState(button, "idle");
  }, COPY_RESET_MS);
}

/**
 * 图片点击载荷：地址从 `<img>` 当前 src 取（补 src 的唯一作者是 image-layer），
 * 原因从状态提示节点取，两者都拿不到时回退通用文案。
 */
function readImageRequest(wrapper: HTMLElement): ImageActivationRequest {
  const state = (wrapper.getAttribute("data-readora-image-state") ?? "pending") as ImageState;
  const img = wrapper.querySelector("img");
  const hint = wrapper.querySelector(".readora-image-hint");
  const src = img?.getAttribute("src") ?? "";
  return {
    reference: wrapper.getAttribute("data-readora-image") ?? "",
    alt: img?.getAttribute("alt") ?? "",
    state,
    // 非 ready 一律不给地址：状态位与 src 必须同源，不能各说各话。
    src: state === "ready" ? src : "",
    reason: hint?.textContent ?? (state === "pending" ? IMAGE_NOTE : IMAGE_NOT_READY_NOTE)
  };
}

/**
 * 绑定委托监听，返回解绑函数。
 * 容器复用同一实例时只绑一次（MarkdownContent 负责生命周期）。
 */
export function attachContentInteractions(
  container: HTMLElement,
  handlers: ContentInteractionHandlers
): () => void {
  const onClick = (event: MouseEvent): void => {
    const anchor = closestOf<HTMLAnchorElement>(event.target, "a[data-readora-anchor]");
    if (anchor) {
      event.preventDefault();
      scrollToAnchor(container, decodeAnchor(anchor.dataset.readoraAnchor ?? anchor.getAttribute("href") ?? ""));
      return;
    }

    const external = closestOf<HTMLElement>(event.target, "a[data-readora-external]");
    if (external) {
      event.preventDefault();
      // 先读属性再读 dataset：SVG 元素的 dataset 在部分实现里不可用，
      // 而图表里的 <a> 与正文外链必须走同一条委托（ARC-008 §10.3 第 4 条）。
      const uri =
        external.getAttribute("data-readora-external") ??
        external.dataset.readoraExternal ??
        external.getAttribute("href") ??
        "";
      if (uri.length > 0) {
        handlers.openExternal(uri);
      }
      return;
    }

    const wiki = closestOf<HTMLElement>(event.target, WIKI_LINK_SELECTOR);
    if (wiki) {
      // 没有 href，所以默认行为本来也无从发生；preventDefault 是防住将来
      // 有人给这条 `<a>` 补一个猜测出来的 href（那会把跳转语义交回浏览器）。
      event.preventDefault();
      activateWikiLink(wiki, handlers);
      return;
    }

    const relative = closestOf<HTMLElement>(event.target, "[data-readora-relative]");
    if (relative) {
      event.preventDefault();
      const reference = relative.getAttribute("data-readora-relative") ?? "";
      if (reference.length === 0) {
        showInlineNote(relative, RELATIVE_LINK_NOTE);
        return;
      }
      void handlers.navigate(reference).then((accepted) => {
        if (!accepted) {
          showInlineNote(relative, RELATIVE_LINK_NOTE);
        }
      });
      return;
    }

    const image = closestOf<HTMLElement>(event.target, "[data-readora-image]");
    if (image) {
      event.preventDefault();
      const request = readImageRequest(image);
      if (request.src.length === 0) {
        // pending / missing / blocked：没有可放大的字节，只把原因说清楚。
        showInlineNote(image, request.reason ?? IMAGE_NOT_READY_NOTE);
        return;
      }
      handlers.openImage(request);
      return;
    }

    const copy = closestOf<HTMLElement>(event.target, "button[data-readora-copy]");
    if (copy) {
      event.preventDefault();
      void copyCodeText(codeTextOf(copy)).then((ok) => {
        markCopyState(copy, ok ? "copied" : "failed");
      });
    }
  };

  container.addEventListener("click", onClick);

  /**
   * 键盘激活（STORY-06-03 的无障碍底线）。
   *
   * 无 href 的 `<a>` 加了 `tabindex="0"` 能聚焦，但浏览器**不会**为它把 Enter
   * 合成一次 click —— 那是带 href 的链接才有的默认行为。于是键盘用户按下去
   * 毫无反应，比不给焦点更糟。这里显式接住 Enter 与 Space（Space 顺手 preventDefault，
   * 否则页面会跟着滚动），让两条激活通道走同一个 activateWikiLink。
   */
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.defaultPrevented || event.repeat) {
      return;
    }
    if (event.key !== "Enter" && event.key !== " " && event.key !== "Spacebar") {
      return;
    }
    const wiki = closestOf<HTMLElement>(event.target, WIKI_LINK_SELECTOR);
    if (!wiki) {
      return;
    }
    event.preventDefault();
    activateWikiLink(wiki, handlers);
  };
  container.addEventListener("keydown", onKeyDown);

  return () => {
    container.removeEventListener("click", onClick);
    container.removeEventListener("keydown", onKeyDown);
  };
}

/**
 * 编辑手册弹层面板的类名（常量定在这一侧，因为 `TOP_OVERLAY_SELECTOR` 要用它）：
 * `app/EditHelpDialog.tsx` 反过来 import 本模块，常量不能让组件那份做权威，
 * 否则 content → app → content 就是一个环。
 */
export const EDIT_HELP_DIALOG_CLASS = "readora-edit-help-dialog";

/**
 * 比搜索浮层更靠上的覆盖层。PRD-002 §10.3 只写了搜索「支持 Escape 关闭」，
 * §9.2 的 Lightbox 也各自收一次 Escape —— 两层都监听就会一次按键收两层，
 * 所以关闭优先级定在这一层：Lightbox / 图表全屏 / 手册 > 搜索。
 *
 * `.readora-edit-help-dialog` 是编辑手册弹层（ARC-009 §7.5）：它自己收 Escape 并
 * `preventDefault`，这一项只是双保险 —— 挂在 body 上的浮层收不到正文容器里的
 * 快捷键委托，优先级得在 document 这一层说清。
 */
export const TOP_OVERLAY_SELECTOR =
  `.readora-lightbox, .readora-diagram--fullscreen, .${EDIT_HELP_DIALOG_CLASS}`;

export interface SearchShortcutHandlers {
  /** cmd/ctrl+f：打开搜索浮层（PRD-002 §10.2 的两条入口之一）。 */
  open(): void;
  /** Escape：关闭搜索浮层；未打开时必须是 no-op。 */
  close(): void;
}

/**
 * 文档级快捷键接管（ARC-004 §4.5：cmd+f 与 Escape 在 Webview 内处理，不占全局键位）。
 *
 * 挂在 document 的冒泡阶段：正文里的元素（含浮层自身）若已 preventDefault 或
 * stopPropagation，就让给它；比搜索更上层的浮层存在时，Escape 不归搜索。
 */
export function useSearchShortcuts(handlers: SearchShortcutHandlers): void {
  const ref = useRef(handlers);
  ref.current = handlers;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented) {
        return;
      }
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "f") {
        event.preventDefault();
        ref.current.open();
        return;
      }
      if (event.key === "Escape" && !document.querySelector(TOP_OVERLAY_SELECTOR)) {
        ref.current.close();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
    };
  }, []);
}

/**
 * `?` 该不该叫出手册（纯函数，无 DOM 假设）。
 *
 * 为什么不把判据就写在监听里：jsdom 不实现 `isContentEditable`（实测恒为
 * `undefined`），拿它做的护栏在单测里永远为假 —— 「单元里敲 `?` 是打一个字」
 * 就只能靠浏览器测。把判据抽成纯函数后，`contenteditable` 这一项改按事件目标
 * 自己的属性判（真浏览器里 `event.target` 就是焦点的那个元素），两种环境同
 * 一个答案；四条让路判据每一条对应一个「按了不该做事」的场合：
 * - `defaultPrevented`：单元里、工具条里、搜索面板里的监听先拿到了这一键；
 * - 更上层的浮层开着（Lightbox / 图表全屏）：那里有自己的键位；
 * - 修饰键：`Ctrl+Shift+/` 一类组合不属于本键位；
 * - 落点在输入件里（`input` / `textarea` / `select` / `contenteditable`）：在那里
 *   打出一个 `?` 比叫出手册才是预期，尤其是正在改的那一块。
 */
export function shouldOpenEditHelp(
  event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "defaultPrevented">,
  target: EventTarget | null,
  topOverlayOpen: boolean
): boolean {
  if (event.key !== "?") {
    return false;
  }
  if (event.ctrlKey || event.metaKey || event.altKey || event.defaultPrevented) {
    return false;
  }
  if (topOverlayOpen) {
    return false;
  }
  const node =
    target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
  if (!node) {
    // 事件源不在文档里（窗口自身等）：不猜，让路。
    return false;
  }
  const tag = node.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
    return false;
  }
  if (node.closest('[contenteditable="true"], [contenteditable=""]') !== null) {
    return false;
  }
  return true;
}

/**
 * 编辑手册的键盘入口 `?`（ARC-009 §7.5）：只在编辑模式开着、且手册自己还没开着时注册。
 *
 * 为什么挂 document 而不是接管的正文容器：把手的激活委托在容器上（§6.3.7 那把
 * `Ctrl` / `Meta` / `Alt` 让路护栏也在那里），但手册这个浮层本身在 `body` 上 ——
 * 挂 body 的浮层收不到容器委托，键位若也挂容器，浮层打开后再按 `?` 就是死区。
 *
 * 键位不进 `contributes.keybindings`，与 `E` / `Ctrl+F` 同一条理由（ARC-004 §4.5）。
 */
export function useEditHelpShortcut(enabled: boolean, onOpen: () => void): void {
  const ref = useRef(onOpen);
  ref.current = onOpen;

  useEffect(() => {
    if (!enabled) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (
        !shouldOpenEditHelp(event, event.target, document.querySelector(TOP_OVERLAY_SELECTOR) !== null)
      ) {
        return;
      }
      event.preventDefault();
      ref.current();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [enabled]);
}
