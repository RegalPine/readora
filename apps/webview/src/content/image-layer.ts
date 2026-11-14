/**
 * 图片激活层（ARC-008 §8 / §9，STORY-08-02，AUD-001 F06-006）。
 *
 * M2 的产物里 `<img>` 有结构但没有 src（Sanitizer 禁 src，IMP-001 §12.2）；
 * 本层是唯一的补 src 通道，四种状态写在容器上：
 *   pending  尚未解析（初始）
 *   ready    已解析并已加载
 *   missing  解析或加载失败（附原因，F06-006）
 *   blocked  策略拦截（远端 / data:，M3 不抓取）
 *
 * 本地 SVG 一律走 `<img>`，永不内联：`<img>` 语境里 SVG 内的脚本不执行，
 * 这是不依赖 Sanitizer 也成立的纵深防御。
 */
import type { ResourceKind } from "@readora/contracts";
import { READORA_ERROR_CODES } from "@readora/contracts";
import { isDelimitedSizeValue } from "@readora/markdown-core";
import type { ResourceEntry } from "./resource-cache";
import { createLazyObserver, type ObserverFactory, type ObserverHandle } from "./viewport";

export type ImageState = "pending" | "ready" | "missing" | "blocked";

export const STATE_ATTRIBUTE = "data-readora-image-state";
// 下面三项同时服务 M11 导出序列化器：引用原文是 Host 重新走策略读文件的唯一线索，
// 导出层必须与接管层认同一个属性名，不能自己再编一个。
export const REFERENCE_ATTRIBUTE = "data-readora-image";
const WRAPPER_SELECTOR = `[${REFERENCE_ATTRIBUTE}]`;
export const HINT_SELECTOR = ".readora-image-hint";
export const ELEMENT_SELECTOR = ".readora-image-element";
// 块属性落地通道（M10）：渲染器只写 data-*，尺寸在这里与 src 同一个作者赋值。
const WIDTH_ATTRIBUTE = "data-readora-width";
const HEIGHT_ATTRIBUTE = "data-readora-height";

/** 懒加载视口外余量（ARC-008 §9.2：首屏不该为远处的图发请求）。 */
export const IMAGE_ROOT_MARGIN = "200px";

export type RemoteKind = "local" | "remote" | "data";

export function classifyReference(reference: string): RemoteKind {
  const value = reference.trim();
  if (/^data:/i.test(value)) {
    return "data";
  }
  if (/^https?:\/\//i.test(value) || /^\/\//i.test(value)) {
    return "remote";
  }
  return "local";
}

const MISSING_REASONS: Record<string, string> = {
  [READORA_ERROR_CODES.RESOURCE_NOT_FOUND]: "本地图片不存在或不可读",
  [READORA_ERROR_CODES.RESOURCE_DENIED]: "超出允许范围，或策略不允许该资源",
  [READORA_ERROR_CODES.RESOURCE_TOO_LARGE]: "图片超出大小上限",
  [READORA_ERROR_CODES.RESOURCE_UNSUPPORTED]: "该资源类型暂不支持",
  [READORA_ERROR_CODES.RESOURCE_UNREADABLE]: "无法读取该资源"
};

export const BLOCKED_REMOTE_REASON = "外部图片默认不加载（readora.resources.allowExternalImages）";
export const BLOCKED_DATA_REASON = "data: 图片默认不加载（可读性差且可内联任意内容）";
export const LOAD_FAILED_REASON = "图片数据加载失败";
export const EMPTY_REFERENCE_REASON = "图片引用为空";

export function reasonForFailure(code: string): string {
  return MISSING_REASONS[code] ?? "解析失败";
}

export interface ImageLayerDeps {
  /** 交 Host 解析；实现见 ResourceRequestCache。 */
  resolve(reference: string, kind?: ResourceKind): Promise<ResourceEntry>;
  /** 观察器注入点：测试用假实现断言懒加载触发次数；无 API 环境退化为立即激活。 */
  createObserver?: ObserverFactory;
}

export interface ImageLayer {
  /** 扫描容器内所有待解析图片；重复调用幂等（已激活的不会重问）。 */
  scan(container: Element): number;
  /** 丢弃观察器与在途结果（正文重写 / 卸载时调用）。 */
  destroy(): void;
}

const STATE_CLASSES: readonly ImageState[] = ["pending", "ready", "missing", "blocked"];

function hintOf(wrapper: Element): Element | null {
  return wrapper.querySelector(HINT_SELECTOR);
}

/**
 * 状态写入容器：属性给测试与交互层读，同名 class 给样式表用（两套口径必须同源）。
 * ready 才移除提示节点，失败态保证有文案可读 —— 包括 ready 之后退回失败的场景。
 */
export function setState(wrapper: HTMLElement, state: ImageState, reason?: string): void {
  wrapper.setAttribute(STATE_ATTRIBUTE, state);
  for (const candidate of STATE_CLASSES) {
    wrapper.classList.remove(`readora-image--${candidate}`);
  }
  wrapper.classList.add(`readora-image--${state}`);
  const hint = hintOf(wrapper);
  if (state === "ready") {
    hint?.remove();
    return;
  }
  if (reason === undefined) {
    return;
  }
  if (hint) {
    hint.textContent = reason;
    return;
  }
  /*
   * ready 时提示节点已被移除，但解码失败（load 且 naturalWidth 为 0、
   * 或 error 事件）会把状态退回 missing：此时必须重建节点，
   * 否则「这张图为什么没了」就没有出口（F06-006）。
   */
  const created = wrapper.ownerDocument.createElement("span");
  created.className = "readora-image-hint";
  created.setAttribute("role", "status");
  created.textContent = reason;
  wrapper.append(created);
}

function imageElement(wrapper: HTMLElement): HTMLImageElement | null {
  return (
    wrapper.querySelector("img") ?? wrapper.querySelector<HTMLImageElement>(ELEMENT_SELECTOR)
  );
}

/**
 * 尺寸生效（M10 块属性）：`![…](…){width=60%}` 的值由渲染器写在容器上，本层把它
 * 赋到 `img.style` —— 与 `img.src` 同一条通道、同一个作者。
 *
 * 渲染层不写 `style` 不是遗漏：Sanitizer 把 `style` 限域在 `.readora-math` 子树内，
 * 正文里任何 `style` 都会被剥掉，放开限域等于扩大可达面。所以「谁是唯一作者，
 * 谁负责生效」。
 *
 * 百分比走 `max-*`：`width: 60%` 会把一张小图硬拉到容器六成长（放大是失真），
 * `max-width: 60%` 只在图本身超宽时收缩 —— 与作者的意图「最宽占六成」一致。
 * 值必须先过 `isDelimitedSizeValue`（形状判定只有 `attrs.ts` 一份作者），
 * 不合法就一个字都不写：留一张原始尺寸的图，比按一个来路不明的数字压扁它更容易发现。
 */
export function applySize(wrapper: HTMLElement, img: HTMLImageElement): void {
  const sizes: readonly [string, string][] = [
    [WIDTH_ATTRIBUTE, "width"],
    [HEIGHT_ATTRIBUTE, "height"]
  ];
  for (const [attribute, property] of sizes) {
    const value = wrapper.getAttribute(attribute);
    if (value === null || !isDelimitedSizeValue(value)) {
      continue;
    }
    img.style.setProperty(/%\s*$/.test(value) ? `max-${property}` : property, value);
  }
}

function applyResolved(wrapper: HTMLElement, entry: ResourceEntry): void {
  if (wrapper.getAttribute(STATE_ATTRIBUTE) === "ready") {
    return;
  }
  const img = imageElement(wrapper);
  if (!entry.ok) {
    setState(wrapper, "missing", reasonForFailure(entry.code));
    return;
  }
  if (entry.result.kind !== "image" || entry.result.webviewUri.length === 0) {
    // 载荷说这是文档，或者地址为空：宁可当作缺失展示，不写可疑 src。
    setState(wrapper, "missing", reasonForFailure(READORA_ERROR_CODES.RESOURCE_UNREADABLE));
    return;
  }
  if (!img) {
    setState(wrapper, "missing", reasonForFailure(READORA_ERROR_CODES.RESOURCE_UNREADABLE));
    return;
  }
  wrapper.setAttribute("data-readora-resource-id", entry.result.resourceId);
  wrapper.setAttribute("data-readora-mime", entry.result.mimeType);
  img.addEventListener("error", () => {
    setState(wrapper, "missing", LOAD_FAILED_REASON);
  });
  img.addEventListener("load", () => {
    if (img.naturalWidth === 0) {
      setState(wrapper, "missing", LOAD_FAILED_REASON);
    }
  });
  applySize(wrapper, img);
  img.src = entry.result.webviewUri;
  setState(wrapper, "ready");
}

export function createImageLayer(deps: ImageLayerDeps): ImageLayer {
  const targets = new Map<HTMLElement, string>();
  const handled = new Set<HTMLElement>();
  let detached = false;
  const observer: ObserverHandle | null = (deps.createObserver ?? createLazyObserver)(activate, {
    rootMargin: IMAGE_ROOT_MARGIN
  });

  function activate(element: HTMLElement): void {
    observer?.unobserve(element);
    const reference = targets.get(element);
    if (reference === undefined || handled.has(element) || detached) {
      return;
    }
    handled.add(element);
    void deps.resolve(reference, "image").then((entry) => {
      // 在途结果回来时正文可能已被重写：旧元素不属于文档，一律丢弃（ARC-008 §9.3）。
      if (detached || !element.isConnected) {
        return;
      }
      applyResolved(element, entry);
    });
  }

  function scan(container: Element): number {
    let queued = 0;
    for (const candidate of Array.from(container.querySelectorAll(WRAPPER_SELECTOR))) {
      const wrapper = candidate as HTMLElement;
      const reference = wrapper.getAttribute(REFERENCE_ATTRIBUTE);
      if (reference === null || wrapper.getAttribute(STATE_ATTRIBUTE) !== "pending") {
        continue;
      }
      const kind = classifyReference(reference);
      if (kind === "local" && reference.trim().length === 0) {
        // 空引用（`![]()`）不是「本地资源解析失败」，而是源码本身不完整：
        // 就地定性与 Host 报同一个原因，省掉一次注定失败的请求。
        setState(wrapper, "missing", EMPTY_REFERENCE_REASON);
        continue;
      }
      if (kind !== "local") {
        // 策略拦截不发请求：Webview 不碰远端字节，也不解 data:。
        setState(wrapper, "blocked", kind === "data" ? BLOCKED_DATA_REASON : BLOCKED_REMOTE_REASON);
        continue;
      }
      targets.set(wrapper, reference);
      queued += 1;
      if (observer) {
        observer.observe(wrapper);
      } else {
        activate(wrapper);
      }
    }
    return queued;
  }

  function destroy(): void {
    detached = true;
    observer?.disconnect();
    targets.clear();
    handled.clear();
  }

  return { scan, destroy };
}
