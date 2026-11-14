/**
 * 图表挂载层（ARC-003 §6 / §7 / §10，STORY-05-03、IMP-001 §9.5）。
 *
 * M2 的产物把 Mermaid 源码留在 `<pre class="readora-diagram-source">` 里并标
 * `data-readora-diagram-state="pending"`；本层是唯一的接管通道：
 *
 * - 源码取自 `<pre>` 的 textContent，不新增 data 属性（避免扩大 Sanitizer 可信面）；
 * - 懒挂载：进入视口（含 300px 余量）才交给引擎，长文档首屏不铺全量布局；
 * - 引擎产物先过 SVG 安全处理再由引擎插入容器，失败只降级这一张图；
 * - 状态实时写回 `data-readora-diagram-state`，样式与测试共用同一口径；
 * - 工具栏只做指令转发（zoom / fit / Fullscreen / Copy Source），
 *   缩放恒开启（zoom: true）：否则正文栏里那些没溢出的图，缩放按钮点了
 *   什么都不发生（引擎在未溢出的 `auto` 下直接 early-return）；
 * - 全屏按钮用图标不用文案，两态各自给可读名（§10.6）；
 * - 正文重写或组件卸载时 destroy 全部实例并解绑监听，不留悬挂订阅。
 *
 * 这里的 DOM 全部用 createElement + textContent 构造：正文的 innerHTML
 * 写入点只有 MarkdownContent 一处（IMP-001 §8.4），附加层不得新开写入面。
 */
import {
  DIAGRAM_ID_PREFIX,
  createDiagramEngine,
  type DiagramEngine,
  type DiagramError,
  type MountedDiagram
} from "@readora/diagram-core";
import { isDelimitedSizeValue } from "@readora/markdown-core";
import { ICON_CLASS, ICON_STROKE_WIDTH, ICON_VIEWBOX } from "../app/Icon";
import { copyCodeText } from "./interactions";
import { createLazyObserver, type ObserverFactory, type ObserverHandle } from "./viewport";

export const DIAGRAM_STATE_ATTRIBUTE = "data-readora-diagram-state";
export const DIAGRAM_WRAPPER_SELECTOR = ".readora-diagram";
const SOURCE_SELECTOR = ".readora-diagram-source";
export const DIAGRAM_ACTION_ATTRIBUTE = "data-readora-diagram-action";
export const DIAGRAM_CONTAINER_CLASS = "readora-diagram-container";
export const DIAGRAM_TOOLBAR_CLASS = "readora-diagram-toolbar";
const ERROR_CLASS = "readora-diagram-error";
const SOURCE_OPEN_CLASS = "readora-diagram--source-open";
export const DIAGRAM_FULLSCREEN_CLASS = "readora-diagram--fullscreen";
export const DIAGRAM_TOOL_CLASS = "readora-diagram-tool";
const TOOL_ICON_CLASS = "readora-diagram-tool--icon";
const SVG_NS = "http://www.w3.org/2000/svg";
// 围栏块属性（M10）：渲染器只把事实写成 data-*，生效地点在本层。
const CODE_BLOCK_ATTRIBUTE = "data-readora-diagram-code-block";
const FILENAME_ATTRIBUTE = "data-readora-diagram-filename";
const WIDTH_ATTRIBUTE = "data-readora-width";
const HEIGHT_ATTRIBUTE = "data-readora-height";
const FILENAME_CLASS = "readora-diagram-filename";

/** 懒挂载视口余量：比图片略大，图表布局代价高但用户滚动预期也高。 */
export const DIAGRAM_ROOT_MARGIN = "300px";

/** 工具栏倍率步进（放大一档 / 缩小一档）。 */
export const ZOOM_IN_FACTOR = 1.25;
export const ZOOM_OUT_FACTOR = 0.8;

export type DiagramLayerState = "pending" | "mounting" | "rendered" | "failed";

export interface DiagramLayerDeps {
  /** 引擎注入点：单测替成 mock 以断言 Adapter 契约的调用序列。 */
  engine?: DiagramEngine;
  /** 观察器注入点：无 IntersectionObserver 的环境（jsdom）退化为立即激活。 */
  createObserver?: ObserverFactory;
  /** 复制注入点：默认复用正文代码块同一套 clipboard 回退。 */
  copy?: (text: string) => Promise<boolean>;
  /** 全屏注入点：真实环境走 Fullscreen API，测试断言只关心 class 翻转。 */
  requestFullscreen?: (element: HTMLElement) => void;
  exitFullscreen?: () => void;
}

export interface DiagramLayer {
  /** 扫描容器内待渲染图表；重复调用幂等，已接管的不会二次挂载。 */
  scan(container: Element): number;
  /** 主题同步：只切 class，颜色由 CSS 变量求值，不重排布局（ARC-003 §8.2）。 */
  syncTheme(theme: string): void;
  /** 字体度量变化时才重算布局（字号偏好变更走这里，主题变更不走）。 */
  refreshAll(): void;
  /** 当前接管的实例数（测试与 harness 取证用）。 */
  readonly instanceCount: number;
  stateOf(wrapper: Element): DiagramLayerState | null;
  destroy(): void;
}

interface DiagramRecord {
  wrapper: HTMLElement;
  container: HTMLElement;
  source: string;
  mounted: MountedDiagram | null;
  card: HTMLElement | null;
  onError: (error: DiagramError) => void;
}

interface ToolDefinition {
  action: string;
  /** 文案按钮的文本；图标按钮留空，免得与图标同时出现。 */
  label: string;
  title: string;
  /** 图标形态（目前只有全屏）：不写文案，两态取 FULLSCREEN_ICONS / FULLSCREEN_TITLES。 */
  icon?: boolean;
}

const TOOLS: readonly ToolDefinition[] = [
  { action: "zoom-in", label: "＋", title: "Zoom in" },
  { action: "zoom-out", label: "－", title: "Zoom out" },
  // 只留一枚归位按钮（产品反馈：去掉 1:1 保留 Fit）：Fit = 整图都看得见。
  // 原先并列的 1:1（图纸原始像素，宽图靠拖动看溢出部分）与它在窄图上同义，
  // 在宽图上又是一个「看了不知道下一步做什么」的第二档，不如只留 Fit。
  // 名字也继续分开：顶栏那颗文档缩放按钮已经占着 “Reset zoom”。
  { action: "fit", label: "Fit", title: "Fit whole diagram" },
  { action: "fullscreen", label: "", title: "Fullscreen", icon: true },
  { action: "copy-source", label: "Copy Source", title: "Copy diagram source" }
];

/**
 * 全屏两态图标：四角括号朝外 = 进入，朝内 = 退出。
 *
 * 口径与 Icon.tsx 一致（同一套 viewBox / currentColor / 描边宽度，名字也从那里
 * import，不让两处漂移），但几何必须在这里手搭 DOM：工具栏是 imperative 构造的
 * （见文件头「createElement + textContent」那条），塞不进 React 组件。
 */
const FULLSCREEN_ICONS = {
  enter: "M4 10V4h6M20 10V4h-6M20 14v6h-6M4 14v6h6",
  exit: "M10 4v6H4M14 4v6h6M14 20v-6h6M10 20v-6H4"
} as const;

/** 图标不承载文本，所以读屏名字得跟着状态换：“Fullscreen” 标在退出态是说谎。 */
const FULLSCREEN_TITLES = { enter: "Fullscreen", exit: "Exit fullscreen" } as const;

/** 工具栏图标边长：顶栏用的 16 在这里会把按钮顶高半档。 */
const TOOL_ICON_SIZE = 14;

function makeSvgIcon(owner: Document, path: string): SVGElement {
  const svg = owner.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", ICON_CLASS);
  svg.setAttribute("width", String(TOOL_ICON_SIZE));
  svg.setAttribute("height", String(TOOL_ICON_SIZE));
  svg.setAttribute("viewBox", ICON_VIEWBOX);
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", String(ICON_STROKE_WIDTH));
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const shape = owner.createElementNS(SVG_NS, "path");
  shape.setAttribute("d", path);
  svg.append(shape);
  return svg;
}

const COPY_RESET_MS = 1600;

function docOf(element: Element): Document {
  return element.ownerDocument;
}

function makeButton(
  owner: Document,
  action: string,
  label: string,
  title: string,
  iconPath?: string
): HTMLButtonElement {
  const button = owner.createElement("button");
  button.type = "button";
  button.className = iconPath === undefined ? DIAGRAM_TOOL_CLASS : `${DIAGRAM_TOOL_CLASS} ${TOOL_ICON_CLASS}`;
  button.setAttribute(DIAGRAM_ACTION_ATTRIBUTE, action);
  button.setAttribute("title", title);
  button.setAttribute("aria-label", title);
  // 图标不走 textContent：这里只开 createElementNS 一个写入面，不新增 innerHTML。
  if (iconPath === undefined) {
    button.textContent = label;
  } else {
    button.append(makeSvgIcon(owner, iconPath));
  }
  return button;
}

/** 源码取自 `<pre>` 的 textContent：渲染期已反转义，这里不再做任何加工。 */
export function diagramSourceOf(wrapper: Element): string | null {
  const pre = wrapper.querySelector(SOURCE_SELECTOR);
  const text = pre?.textContent;
  if (text === undefined || text.trim().length === 0) {
    return null;
  }
  return text;
}

/**
 * 尺寸生效（M10 块属性）：`data-readora-width|height` 落在接管容器上。
 *
 * 与图片接管层同一条口径：渲染层不写 `style`（Sanitizer 把 `style` 限域在公式子树
 * 内），谁是这些元素的样式唯一作者谁就负责生效；值先过 `isDelimitedSizeValue`，
 * 不合法就不写。百分比走 `max-*`：图比栏宽时收缩，图本来就窄时不放大。
 */
function applySizes(wrapper: Element, container: HTMLElement): void {
  const sizes: readonly [string, string][] = [
    [WIDTH_ATTRIBUTE, "width"],
    [HEIGHT_ATTRIBUTE, "height"]
  ];
  for (const [attribute, property] of sizes) {
    const value = wrapper.getAttribute(attribute);
    if (value === null || !isDelimitedSizeValue(value)) {
      continue;
    }
    container.style.setProperty(/%\s*$/.test(value) ? `max-${property}` : property, value);
  }
}

export function diagramStateOf(wrapper: Element): DiagramLayerState | null {
  const raw = wrapper.getAttribute(DIAGRAM_STATE_ATTRIBUTE);
  return raw === "pending" || raw === "mounting" || raw === "rendered" || raw === "failed"
    ? raw
    : null;
}

/**
 * `code_block=true` 的展开态（M10）：文档声明「这张围栏本来就该把源码摊开」。
 *
 * 为什么要在一串路径之后「按属性重新恢复」：`clearCard()` 无条件 remove
 * `SOURCE_OPEN_CLASS`，而失败卡与重试都必经它 —— 不恢复的话，写了
 * `code_block=true` 的图一旦重挂就静默丢掉初始展开态，用户看到的是
 * 「刚才还展开的源码没了」。恢复只读文档声明的属性，不读用户操作：
 * 手动收起之后归 class 自己管，本层不再插手。
 */
function paintSourceToggle(wrapper: Element, open: boolean): void {
  const toggle = wrapper.querySelector(`[${DIAGRAM_ACTION_ATTRIBUTE}="toggle-source"]`);
  if (!toggle) {
    return;
  }
  toggle.setAttribute("aria-expanded", open ? "true" : "false");
  toggle.textContent = open ? "收起源码" : "展开源码";
}

function restoreDeclaredSourceState(wrapper: HTMLElement): void {
  if (wrapper.getAttribute(CODE_BLOCK_ATTRIBUTE) !== "true") {
    return;
  }
  wrapper.classList.add(SOURCE_OPEN_CLASS);
  paintSourceToggle(wrapper, true);
}

export function createDiagramLayer(deps: DiagramLayerDeps = {}): DiagramLayer {
  const engine = deps.engine ?? createDiagramEngine();
  const copy = deps.copy ?? copyCodeText;
  const records = new Map<HTMLElement, DiagramRecord>();
  const queued = new Map<HTMLElement, string>();
  const handled = new Set<HTMLElement>();
  let sequence = 0;
  let theme = "light";
  let detached = false;

  const observer: ObserverHandle | null = (deps.createObserver ?? createLazyObserver)(activate, {
    rootMargin: DIAGRAM_ROOT_MARGIN
  });

  function setState(record: DiagramRecord, state: DiagramLayerState): void {
    record.wrapper.setAttribute(DIAGRAM_STATE_ATTRIBUTE, state);
  }

  function clearCard(record: DiagramRecord): void {
    record.card?.remove();
    record.card = null;
    record.wrapper.classList.remove(SOURCE_OPEN_CLASS);
  }

  /** 错误卡：展开源码 / 复制 / 重试三件事，且只呈现成因不呈现堆栈。 */
  function showError(record: DiagramRecord, error: DiagramError): void {
    const owner = docOf(record.wrapper);
    clearCard(record);

    const card = owner.createElement("div");
    card.className = ERROR_CLASS;
    card.setAttribute("role", "status");
    card.dataset.readoraDiagramErrorKind = error.kind;

    const message = owner.createElement("p");
    message.className = "readora-diagram-error-message";
    message.textContent =
      error.source?.line === undefined
        ? error.message
        : `${error.message} (line ${error.source.line})`;
    card.append(message);

    const actions = owner.createElement("div");
    actions.className = "readora-diagram-error-actions";
    const toggle = makeButton(owner, "toggle-source", "展开源码", "Reveal diagram source");
    toggle.setAttribute("aria-expanded", "false");
    actions.append(
      toggle,
      makeButton(owner, "copy-source", "复制", "Copy diagram source"),
      makeButton(owner, "retry", "重试", "Render this diagram again")
    );
    card.append(actions);

    record.wrapper.append(card);
    record.card = card;
    // 上面 clearCard 拆掉的 `code_block=true` 初始展开态在这里按文档声明补回。
    restoreDeclaredSourceState(record.wrapper);
  }

  function mountInto(record: DiagramRecord): void {
    if (handled.has(record.wrapper) || detached) {
      return;
    }
    handled.add(record.wrapper);
    sequence += 1;
    try {
      record.mounted = engine.mount(record.container, record.source, {
        // zoom: true —— 工具栏那三枚缩放按钮必须恒可用。引擎的 zoomBy / zoomTo 在
        // `always: false`（即原来的 "auto"）且图未溢出时直接 early-return，实测正文栏里
        // 130px 宽的图点 ＋/－/Fit 三档，viewBox 与尺寸一点不动。交互侧代价很小：
        // 引擎的滚轮缩放只在按住 Ctrl/Cmd 时动手，拖动要先进入缩放态，
        // 普通滚轮仍是页面滚动。（ARC-003 §12.2 偏差 D-5 原口径「溢出才接管」在此修正。）
        zoom: true,
        // 同页多图必须各自的 id 前缀，否则 SVG 内部 id 互相打架。
        idPrefix: `${DIAGRAM_ID_PREFIX}${sequence}-`,
        onError: record.onError
      });
    } catch (raw) {
      // 引擎抛穿（理论上不该发生）：留错误卡，其余图表继续渲染。
      record.onError({ kind: "runtime", message: raw instanceof Error ? raw.message : String(raw) });
      return;
    }
    const state = record.mounted.state;
    if (state === "failed") {
      if (record.mounted.error) {
        record.onError(record.mounted.error);
      }
      return;
    }
    setState(record, state === "rendered" ? "rendered" : "mounting");
    restoreDeclaredSourceState(record.wrapper);
  }

  function activate(element: HTMLElement): void {
    observer?.unobserve(element);
    const source = queued.get(element);
    queued.delete(element);
    if (source === undefined) {
      return;
    }
    const record = records.get(element);
    if (!record) {
      return;
    }
    mountInto(record);
  }

  function zoom(record: DiagramRecord, factor: number): void {
    record.mounted?.zoom.zoomBy(factor);
  }

  function toggleFullscreen(record: DiagramRecord): void {
    const wrapper = record.wrapper;
    const full = wrapper.classList.toggle(DIAGRAM_FULLSCREEN_CLASS);
    paintFullscreen(record, full);
    if (full) {
      deps.requestFullscreen?.(wrapper);
    } else {
      deps.exitFullscreen?.();
    }
  }

  /**
   * 全屏按钮的两态：图标与可读名一起换。只改 class 不改按钮的话，退出态上挂着
   * “Fullscreen” 的图标会告诉读屏器「还能再进一次全屏」。
   */
  function paintFullscreen(record: DiagramRecord, active: boolean): void {
    const button = record.wrapper.querySelector<HTMLButtonElement>(
      `[${DIAGRAM_ACTION_ATTRIBUTE}="fullscreen"]`
    );
    if (!button) {
      return;
    }
    const state = active ? "exit" : "enter";
    button.replaceChildren(makeSvgIcon(docOf(button), FULLSCREEN_ICONS[state]));
    button.title = FULLSCREEN_TITLES[state];
    button.setAttribute("aria-label", FULLSCREEN_TITLES[state]);
  }

  async function copySource(record: DiagramRecord, button: HTMLElement): Promise<void> {
    const ok = await copy(record.source);
    button.textContent = ok ? "Copied" : "Copy failed";
    window.setTimeout(() => {
      // 卡片按钮与工具栏按钮的文案是各自固定的，按位置还原。
      button.textContent =
        record.card !== null && button.getAttribute(DIAGRAM_ACTION_ATTRIBUTE) === "copy-source"
          ? "复制"
          : labelFor(button.getAttribute(DIAGRAM_ACTION_ATTRIBUTE));
    }, COPY_RESET_MS);
  }

  function retry(record: DiagramRecord): void {
    clearCard(record);
    handled.delete(record.wrapper);
    const mounted = record.mounted;
    if (mounted) {
      // 先复用实例做真重试；已销毁或从未挂上的回到重新挂载。
      record.mounted = null;
      mounted.destroy();
    }
    mountInto(record);
  }

  function labelFor(action: string | null): string {
    return TOOLS.find((tool) => tool.action === action)?.label ?? "Copy";
  }

  function onClick(event: MouseEvent): void {
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }
    const button = target.closest(`[${DIAGRAM_ACTION_ATTRIBUTE}]`);
    if (!button) {
      return;
    }
    const wrapper = button.closest(DIAGRAM_WRAPPER_SELECTOR);
    if (!(wrapper instanceof HTMLElement)) {
      return;
    }
    const record = records.get(wrapper);
    if (!record) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const action = button.getAttribute(DIAGRAM_ACTION_ATTRIBUTE);
    switch (action) {
      case "zoom-in":
        zoom(record, ZOOM_IN_FACTOR);
        break;
      case "zoom-out":
        zoom(record, ZOOM_OUT_FACTOR);
        break;
      case "fit":
        record.mounted?.zoom.fit();
        break;
      case "fullscreen":
        toggleFullscreen(record);
        break;
      case "copy-source":
        void copySource(record, button as HTMLElement);
        break;
      case "toggle-source": {
        const open = wrapper.classList.toggle(SOURCE_OPEN_CLASS);
        paintSourceToggle(wrapper, open);
        break;
      }
      case "retry":
        retry(record);
        break;
      default:
        break;
    }
  }

  function buildChrome(wrapper: HTMLElement, source: string): DiagramRecord {
    const owner = docOf(wrapper);
    const container = owner.createElement("div");
    container.className = DIAGRAM_CONTAINER_CLASS;
    const toolbar = owner.createElement("div");
    toolbar.className = DIAGRAM_TOOLBAR_CLASS;
    toolbar.setAttribute("role", "toolbar");
    toolbar.setAttribute("aria-label", "Diagram controls");
    // `filename=…`：只开一个 textContent 写入面（与文件头的口径一致），
    // 文本永远不进 innerHTML，恶意文件名最多是一段难看的名字。
    const filename = wrapper.getAttribute(FILENAME_ATTRIBUTE);
    if (filename !== null && filename.length > 0) {
      const label = owner.createElement("span");
      label.className = FILENAME_CLASS;
      label.textContent = filename;
      toolbar.append(label);
    }
    for (const tool of TOOLS) {
      toolbar.append(
        makeButton(
          owner,
          tool.action,
          tool.label,
          tool.title,
          tool.icon === true ? FULLSCREEN_ICONS.enter : undefined
        )
      );
    }
    // 工具栏在容器之前：图先显示、按钮在上沿，符合 F04-031 的读序。
    wrapper.prepend(toolbar);
    wrapper.append(container);
    applySizes(wrapper, container);

    const record: DiagramRecord = {
      wrapper,
      container,
      source,
      mounted: null,
      card: null,
      onError: (error) => {
        setState(record, "failed");
        showError(record, error);
      }
    };
    wrapper.classList.add(`readora-diagram--${theme}`);
    restoreDeclaredSourceState(wrapper);
    return record;
  }

  function scan(container: Element): number {
    let queuedCount = 0;
    for (const candidate of Array.from(container.querySelectorAll(DIAGRAM_WRAPPER_SELECTOR))) {
      const wrapper = candidate as HTMLElement;
      if (records.has(wrapper) || diagramStateOf(wrapper) !== "pending") {
        continue;
      }
      const source = diagramSourceOf(wrapper);
      if (source === null) {
        // 没有源码可接管：保持占位文案，不产生空图容器。
        continue;
      }
      const record = buildChrome(wrapper, source);
      records.set(wrapper, record);
      wrapper.addEventListener("click", onClick);
      queued.set(wrapper, source);
      queuedCount += 1;
      if (observer) {
        observer.observe(wrapper);
      } else {
        activate(wrapper);
      }
    }
    return queuedCount;
  }

  function syncTheme(next: string): void {
    if (next === theme) {
      return;
    }
    theme = next;
    for (const wrapper of [...records.keys()]) {
      wrapper.classList.remove(`readora-diagram--light`, `readora-diagram--dark`);
      wrapper.classList.add(`readora-diagram--${next}`);
    }
  }

  function refreshAll(): void {
    for (const record of [...records.values()]) {
      record.mounted?.refresh();
      const state = record.mounted?.state;
      if (state === "rendered") {
        setState(record, "rendered");
      }
    }
  }

  function destroy(): void {
    detached = true;
    observer?.disconnect();
    for (const record of [...records.values()]) {
      record.wrapper.removeEventListener("click", onClick);
      record.mounted?.destroy();
      record.container.remove();
      record.card?.remove();
      record.wrapper.querySelector(`.${DIAGRAM_TOOLBAR_CLASS}`)?.remove();
    }
    records.clear();
    queued.clear();
    handled.clear();
  }

  return {
    scan,
    syncTheme,
    refreshAll,
    get instanceCount(): number {
      return records.size;
    },
    stateOf: (wrapper) => diagramStateOf(wrapper),
    destroy
  };
}
