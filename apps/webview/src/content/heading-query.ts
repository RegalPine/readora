/**
 * 标题元素查询（ARC-007 §5.1：锚点由渲染管线统一生成，导航层只消费）。
 *
 * 两条查找路径必须同源，否则「点击正文锚点」与「点击目录」会走到不同元素上：
 * 1. `getElementById(anchor)` —— 常规路径；
 * 2. `[data-readora-heading="anchor"]` 镜像 —— DOMPurify 开着 SANITIZE_DOM 保护，
 *    与 document 具名属性冲突的 id 会被剥离（例如标题「Images」的 `id="images"`），
 *    但渲染器同时写下的 data-* 镜像仍在。
 *
 * 正文锚点点击（interactions.ts）与目录定位（heading-locator.ts）都调这里。
 */

export function findHeading(
  root: Document | HTMLElement,
  anchor: string
): HTMLElement | null {
  if (anchor.length === 0) {
    return null;
  }
  const doc = "ownerDocument" in root ? (root.ownerDocument ?? root) : root;
  const byId = doc.getElementById(anchor);
  if (byId && contains(root, byId)) {
    return byId;
  }
  // contains() 只接受 Node，跨 realm 或已脱离文档的节点直接放弃镜像查找。
  if (typeof root.contains !== "function") {
    return null;
  }
  const mirror = Array.from(root.querySelectorAll("[data-readora-heading]")).find(
    (element) => element.getAttribute("data-readora-heading") === anchor
  );
  return mirror ? (mirror as HTMLElement) : null;
}

function contains(root: Document | HTMLElement, element: HTMLElement): boolean {
  return "contains" in root ? root.contains(element) : false;
}

/** 正文容器（搜索与高亮的唯一作用域，ARC-007 §9.4「搜索范围限定当前文档」）。 */
export const DOCUMENT_ROOT_SELECTOR = ".readora-document";

export function documentRoot(doc: Document = document): HTMLElement | null {
  return doc.querySelector<HTMLElement>(DOCUMENT_ROOT_SELECTOR);
}
