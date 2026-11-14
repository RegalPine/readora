/**
 * 标题定位（ARC-007 §5.3 / §5.4，ADR-007-02）。
 *
 * 导航层只消费渲染管线给出的锚点，不生成第二套 slug 规则：
 * 标题元素由 markdown-core 写成 `<h2 id="anchor" data-readora-heading="anchor">`，
 * 这里按 id 取元素，取不到时回退镜像属性 —— DOMPurify 的 SANITIZE_DOM 保护
 * 会剥离与 document 具名属性冲突的 id（如标题「Images」），镜像 data-* 仍在，
 * 与 interactions.ts 的锚点回退保持同一口径。
 *
 * §12：标题 ID 不存在 → 取消定位并让调用方回退，绝不抛穿到正文。
 */
import { findHeading } from "./heading-query";

export interface NavigateOptions {
  /** 留空即按「平滑滚动，但尊重 prefers-reduced-motion」的默认口径（§5.3）。 */
  behavior?: ScrollBehavior;
  block?: ScrollLogicalPosition;
}

export interface HeadingLocator {
  /** 定位到标题；返回是否真的找到了元素（§8.2 第 3～5 步的判据）。 */
  navigateTo(headingId: string, options?: NavigateOptions): boolean;
  /** 标题当前是否存在于 DOM（文档更新后判断该保留还是回退，§8.4）。 */
  has(headingId: string): boolean;
}

/** 用户是否要求减少动态效果（Webview 无 matchMedia 时按「不减弱」处理）。 */
export function prefersReducedMotion(win: Window | undefined = window): boolean {
  if (!win || typeof win.matchMedia !== "function") {
    return false;
  }
  try {
    return win.matchMedia("(prefers-reduced-motion: reduce)").matches === true;
  } catch {
    return false;
  }
}

export function createHeadingLocator(
  doc: Document = document,
  win: Window | undefined = window
): HeadingLocator {
  const locate = (headingId: string): HTMLElement | null =>
    headingId.length === 0 ? null : findHeading(doc, headingId);

  return {
    navigateTo(headingId: string, options: NavigateOptions = {}): boolean {
      const element = locate(headingId);
      if (!element || typeof element.scrollIntoView !== "function") {
        return false;
      }
      const behavior: ScrollBehavior =
        options.behavior ?? (prefersReducedMotion(win) ? "auto" : "smooth");
      // 顶部预留由 CSS 的 scroll-margin-top 承担（§5.4），逻辑里不算像素偏移。
      element.scrollIntoView({ behavior, block: options.block ?? "start" });
      return true;
    },
    has(headingId: string): boolean {
      return locate(headingId) !== null;
    }
  };
}

/** 进程内共享的定位器：标题定位是无状态操作，无需每个组件各建一份。 */
let shared: HeadingLocator | null = null;

export function headingLocator(): HeadingLocator {
  shared ??= createHeadingLocator();
  return shared;
}
