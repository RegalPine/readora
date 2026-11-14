/**
 * 导出序列化层（M11 · 导出链路）。
 *
 * 交付物的正文来自**屏幕上这一份 DOM**，不是 Host 的第二套渲染：渲染管线只跑在
 * Webview（IMP-001 §4.2），Sanitizer 需要真实 DOM，KaTeX 与 Pele 的产物也在这里 ——
 * 重渲染一次就会有两套口径，用户点导出看到的却是要另算的东西。
 *
 * 因此本层的动作被严格限制成三种，且全部作用在**克隆件**上（屏幕不受扰动）：
 * 1. 删节点：只删交互专属层造出来的东西，名单与本层「谁造了这些节点」同源；
 * 2. 删属性：`data-readora-code-editor-state` 一删，markdown.css 那条 `[state="mounted"]
 *    .readora-code-pre{display:none}` 就不成立了，静态 `<pre>` 自己回到可见 ——
 *    代码块的导出不需要第二条渲染路径，也不需要动任何 CSS；
 * 3. 摘引用：`img[src]` 全部摘掉。屏上的 src 是 `vscode-webview://` 的会话内地址，
 *    写进文件就是死链 + 本地结构泄露；Host 侧按 `data-readora-image` 的原始引用
 *    重新走一遍资源策略再内联成 data:，与屏上同源的那道闸门一个都不绕过。
 *
 * 明确**保留**的：`data-readora-diagram-state` / `readora-diagram--source-open` /
 * `data-readora-image-state` 与同名 class / `data-readora-image` / `data-readora-mime` /
 * 块属性 `data-readora-width|height`，以及净化后内联的图表 SVG。它们与屏上显隐同源，
 * 删掉就等于交付物比屏幕少东西（远程被拦的图必须仍是占位卡，这是锁定口径）。
 *
 * 这里不新增任何文本节点，也不写 innerHTML：唯一的内容改写是把 `<mark>` 高亮
 * 摊回它自己的子节点（只降包裹不删字符）。
 */
import { CONTENT_WIDTH_VARIABLE, FONT_SIZE_VARIABLE, LINE_HEIGHT_VARIABLE } from "../app/theme";
import { CODE_EDITOR_HOST_CLASS, CODE_EDITOR_STATE_ATTRIBUTE } from "./code-editor/code-editor-layer";
import {
  DIAGRAM_ACTION_ATTRIBUTE,
  DIAGRAM_FULLSCREEN_CLASS,
  DIAGRAM_TOOLBAR_CLASS,
  DIAGRAM_TOOL_CLASS
} from "./diagram-layer";
import { DOCUMENT_ROOT_SELECTOR } from "./heading-query";
import {
  ELEMENT_SELECTOR as IMAGE_ELEMENT_SELECTOR,
  HINT_SELECTOR as IMAGE_HINT_SELECTOR,
  REFERENCE_ATTRIBUTE as IMAGE_REFERENCE_ATTRIBUTE,
  STATE_ATTRIBUTE as IMAGE_STATE_ATTRIBUTE
} from "./image-layer";
import { DOCUMENT_VERSION_ATTRIBUTE, SEARCH_HIT_ID_ATTRIBUTE } from "./search-engine";

/** 滚动主体：量 PNG 视口宽度要看它，不是看正文容器（`contentWidth` 与视口可以不一致）。 */
const CANVAS_SELECTOR = "main.readora-canvas";
/** 资源解析后写在包裹层上的会话内摘要 id：交付物里没有任何东西能解引用它。 */
const RESOURCE_ID_ATTRIBUTE = "data-readora-resource-id";
/** 正文里唯一的图片元素选择器与 src 属性名共用一处出口，见 detachImageSources。 */
const IMG_SELECTOR = "img";

/**
 * 交互专属节点：删干净的理由是「它们在文件里按不动，却会占住一块视觉」。
 * 名单每一项都来自造它的那一层（code-editor / diagram / image / markdown-core 渲染器），
 * 不在此处凭印象补名字。
 */
export const INTERACTIVE_SELECTORS = [
  `.${CODE_EDITOR_HOST_CLASS}`,
  `.${DIAGRAM_TOOLBAR_CLASS}`,
  `.${DIAGRAM_TOOL_CLASS}`,
  `[${DIAGRAM_ACTION_ATTRIBUTE}]`,
  ".readora-code-copy",
  "button[data-readora-copy]",
  IMAGE_HINT_SELECTOR
].join(", ");

/** 搜索高亮：导出件里没有「下一个命中」，包裹必须降掉，字符一个都不能少。 */
export const SEARCH_HIT_EXPORT_SELECTOR = `mark[${SEARCH_HIT_ID_ATTRIBUTE}]`;

export interface ExportDocumentResult {
  /** 净化后的正文片段（不含 `<html>` / `<body>`，组装在 Host）。 */
  bodyHtml: string;
  /** 根元素上的三个偏好变量声明，缩放已折进字号（zoom.ts 口径）。 */
  rootStyleText: string;
  /** 导出件画布宽：PNG 的 `--window-size` 用它，避免留白带。 */
  canvasWidthPx: number;
  /** 正文整高：PNG 按它出整页，PDF 不管（分页由 `@page` 决定）。 */
  contentHeightPx: number;
  /** 正文容器上的版本标记：Host 与在途会话比对，陈旧帧直接丢。 */
  version: number;
}

function stripInteractive(root: HTMLElement): void {
  for (const node of Array.from(root.querySelectorAll(INTERACTIVE_SELECTORS))) {
    node.remove();
  }
}

/**
 * 代码块回到静态视图：删一个属性就够，规则本身在 markdown.css，不是本层的职责。
 *
 * `failed` 态同样要删：接管失败时 `<pre>` 本来就可显示，删属性是无害的幂等动作。
 */
function restoreStaticCode(root: HTMLElement): void {
  for (const block of Array.from(root.querySelectorAll(`[${CODE_EDITOR_STATE_ATTRIBUTE}]`))) {
    block.removeAttribute(CODE_EDITOR_STATE_ATTRIBUTE);
  }
}

/** 全屏是面板内的视图态，带进文件等于交付物一打开就占满用户的屏幕。 */
function dropTransientViews(root: HTMLElement): void {
  for (const node of Array.from(root.querySelectorAll(`.${DIAGRAM_FULLSCREEN_CLASS}`))) {
    node.classList.remove(DIAGRAM_FULLSCREEN_CLASS);
  }
}

/**
 * 高亮 unwrap：`mark` 换成它自己原来的子节点。
 *
 * 走 DocumentFragment + replaceChildren，不碰 innerHTML —— 后者会把整棵子树重新
 * 解析一遍，等于给导出加了一条「字符串 → DOM」的注入口，而本层的全部论证建立在
 * 「源是已净化 DOM，处理只有删」。
 */
function unwrapSearchHits(root: HTMLElement): void {
  for (const mark of Array.from(root.querySelectorAll(SEARCH_HIT_EXPORT_SELECTOR))) {
    const parent = mark.parentNode;
    if (parent === null) {
      continue;
    }
    const fragment = mark.ownerDocument.createDocumentFragment();
    fragment.replaceChildren(...Array.from(mark.childNodes));
    parent.replaceChild(fragment, mark);
  }
}

/**
 * 图片摘 src：屏上的 src 只在本次会话可解（`vscode-webview://`），摘掉之后
 * 交付物里任何 `<img>` 都不带可执行的外部引用；Host 再按原始引用补 data:。
 *
 * `state` 为 `blocked` / `missing` 的包裹层由 Host 判定「不补 src」，因此这里
 * 一视同仁地摘：状态属性与同名 class 都在，占位卡与失败卡的形状照旧。
 */
function detachImageSources(root: HTMLElement): void {
  for (const img of Array.from(root.querySelectorAll(IMG_SELECTOR))) {
    img.removeAttribute("src");
    img.removeAttribute("srcset");
  }
  for (const node of Array.from(root.querySelectorAll(`[${RESOURCE_ID_ATTRIBUTE}]`))) {
    node.removeAttribute(RESOURCE_ID_ATTRIBUTE);
  }
}

/**
 * 三个偏好变量：先读行内，再读 computed。
 *
 * 行内优先是因为 `applyTheme` 是这三个变量的唯一作者（写在根元素的 `style` 上），
 * 读行内 = 读那一帧生效的偏好本身；computed 只在不曾下发偏好时兜出 tokens.css 的
 * 缺省值，否则一份没设过字号的导出会连 16px 都不带。读不到就整个跳过，不拼空
 * 声明 —— 输出形态固定为 `--x: <value>`，Host 侧只会拼 `:root{…}` 一层。
 */
export function exportRootStyleText(root: HTMLElement): string {
  const owner = root.ownerDocument;
  const computed = owner === undefined ? undefined : owner.defaultView?.getComputedStyle(root);
  const parts: string[] = [];
  for (const name of [FONT_SIZE_VARIABLE, LINE_HEIGHT_VARIABLE, CONTENT_WIDTH_VARIABLE]) {
    const inline = root.style.getPropertyValue(name).trim();
    const value = inline.length > 0 ? inline : (computed?.getPropertyValue(name) ?? "").trim();
    if (value.length === 0) {
      continue;
    }
    parts.push(`${name}: ${value}`);
  }
  return parts.join("; ");
}

function versionOf(root: HTMLElement): number {
  const raw = Number(root.getAttribute(DOCUMENT_VERSION_ATTRIBUTE));
  return Number.isInteger(raw) && raw >= 0 ? raw : 0;
}

/**
 * 序列化当前正文。
 *
 * 量的两个数取自**live 容器**（克隆件没有布局），正文取自克隆件：一次调用里两者
 * 必须是同一帧，因此本函数只能在渲染落地后被调用（App 侧只在 `export.capture`
 * 到达时调用，那时正文与屏幕一致）。
 */
export function serializeExportDocument(
  root: HTMLElement,
  canvas?: HTMLElement | null
): ExportDocumentResult {
  const clone = root.cloneNode(true) as HTMLElement;
  stripInteractive(clone);
  unwrapSearchHits(clone);
  restoreStaticCode(clone);
  dropTransientViews(clone);
  detachImageSources(clone);
  const host = canvas ?? root.ownerDocument?.querySelector<HTMLElement>(CANVAS_SELECTOR) ?? null;
  return {
    bodyHtml: clone.innerHTML,
    rootStyleText: exportRootStyleText(root),
    canvasWidthPx: Math.max(0, Math.round(host?.offsetWidth ?? root.offsetWidth)),
    contentHeightPx: Math.max(0, Math.round(root.scrollHeight)),
    version: versionOf(root)
  };
}

/** 找不到正文容器：交给调用方报错，本层不猜第二个选择器。 */
export function exportDocumentRoot(doc: Document = document): HTMLElement | null {
  return doc.querySelector<HTMLElement>(DOCUMENT_ROOT_SELECTOR);
}

/** 供 Host 侧策略复述的图片状态（blocked / missing 不参与内联）。 */
export function imageStateOfExport(node: Element): string | null {
  return node.getAttribute(IMAGE_STATE_ATTRIBUTE);
}

export { IMAGE_REFERENCE_ATTRIBUTE, IMAGE_ELEMENT_SELECTOR };
