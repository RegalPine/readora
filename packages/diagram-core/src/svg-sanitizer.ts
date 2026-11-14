/**
 * SVG 安全处理（ARC-003 §9 / ARC-008 §10）。
 *
 * 引擎自产的 SVG 也不能免检：「不允许因为图表已经由 Pele 生成，就跳过产品安全校验」
 * （ARC-008 §10.3 第 4 条）。这里做三层收敛：
 * 1. DOMPurify 的 SVG profile + 主动元素黑名单（脚本、SMIL 动画、foreignObject）；
 * 2. 逐节点复判：剥事件属性、剥非局部引用、`<a>` 的 href 改写成 data 标记交 Host 打开；
 * 3. style 内的 url( 引用整体剥离（禁止危险外部资源引用）。
 *
 * fail-closed：任何一步认为不安全就返回 null，由调用方展示错误态，
 * 绝不退化为「未经清洗直接 innerHTML」（ARC-003 §9.3）。
 */
import DOMPurify from "dompurify";
import { ALLOWED_LINK_SCHEMES, MAX_SVG_OUTPUT_CHARACTERS } from "./limits";

/** 活动内容与外部载体：SVG profile 放行，本层显式禁掉。 */
const SVG_FORBID_TAGS: readonly string[] = [
  "script",
  "foreignObject",
  "animate",
  "animateset",
  "animatetransform",
  "animatemotion",
  "animateline",
  "animatecolor",
  "set",
  "discard",
  "audio",
  "video",
  "iframe",
  "object",
  "embed",
  "handler",
  "listener"
];

/** 安全处理失败成因：错误卡按此给出可行动说明，不暴露原文。 */
export type SvgSanitizeReason =
  | "empty-svg"
  | "over-output-limit"
  | "sanitizer-unavailable"
  | "sanitizer-threw"
  | "no-svg-root"
  | "active-content";

/** 复判后仍带危险属性的节点数等统计，供诊断使用。 */
export interface SvgSanitizationOutcome {
  node: Node | null;
  /** 被本层剥掉的项（属性名或元素名），只用于日志与测试断言，不外泄内容原文。 */
  removed: string[];
  /** node 为 null 时的成因。 */
  reason?: SvgSanitizeReason;
}

const EVENT_ATTRIBUTE = /^on[a-z]/i;
/** 只放行 `url(#local)` 形态的内部引用，外部 url() 一律剥掉 style。 */
const EXTERNAL_URL_IN_STYLE = /url\s*\(\s*["']?(?!#)[^)]/i;
const LOCAL_REFERENCE = /^#/;

/** 活动内容判定的第二道闸：按 localName 比对，不受 CSS 大小写规则影响。 */
const ACTIVE_LOCAL_NAMES = new Set(SVG_FORBID_TAGS.map((tag) => tag.toLowerCase()));

function hasAllowedScheme(href: string): boolean {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return false;
  }
  const scheme = url.protocol.replace(/:$/, "").toLowerCase();
  return ALLOWED_LINK_SCHEMES.some((allowed) => allowed.toLowerCase() === scheme);
}

function attributesOf(element: Element): string[] {
  const names: string[] = [];
  for (let index = 0; index < element.attributes.length; index += 1) {
    const attribute = element.attributes.item(index);
    if (attribute) {
      names.push(attribute.name);
    }
  }
  return names;
}

/**
 * 逐节点复判：DOMPurify 之后仍然存在的活动/外链风险在这里兜底清掉。
 * `<a>` 的链接语义保留为 data-readora-external，由正文事件委托交给 Host 决策，
 * 这样图表里的链接与正文外链走同一条策略通道（ARC-004 §8.7 / ARC-008 §8.2）。
 */
function enforceSvgPolicy(root: Element, removed: string[]): void {
  const elements = [root, ...Array.from(root.querySelectorAll("*"))];
  for (const element of elements) {
    const tagName = element.localName.toLowerCase();
    for (const name of attributesOf(element)) {
      const value = element.getAttribute(name) ?? "";
      if (EVENT_ATTRIBUTE.test(name)) {
        element.removeAttribute(name);
        removed.push(`${tagName}@${name}`);
        continue;
      }
      if (name === "target" || name === "sandbox") {
        element.removeAttribute(name);
        removed.push(`${tagName}@${name}`);
        continue;
      }
      if (name === "style" && EXTERNAL_URL_IN_STYLE.test(value)) {
        element.removeAttribute(name);
        removed.push(`${tagName}@style`);
        continue;
      }
      if (name === "href" || name === "xlink:href") {
        if (tagName === "a") {
          if (hasAllowedScheme(value)) {
            element.setAttribute("data-readora-external", value);
          }
          element.removeAttribute(name);
          removed.push(`${tagName}@${name}`);
          continue;
        }
        // use / 其它元素的引用只允许指向文档内部 id，外链引用一律断开。
        if (!LOCAL_REFERENCE.test(value)) {
          element.removeAttribute(name);
          removed.push(`${tagName}@${name}`);
        }
      }
    }
  }
}

function findSvgElement(root: Node): Element | null {
  if (root instanceof Element && root.localName.toLowerCase() === "svg") {
    return root;
  }
  if (!(root instanceof Element) && !(root instanceof DocumentFragment)) {
    return null;
  }
  for (const child of Array.from(root.children)) {
    if (child.localName.toLowerCase() === "svg") {
      return child;
    }
  }
  return null;
}

function containsActiveContent(root: Element): boolean {
  for (const element of [root, ...Array.from(root.querySelectorAll("*"))]) {
    if (ACTIVE_LOCAL_NAMES.has(element.localName.toLowerCase())) {
      return true;
    }
  }
  return false;
}

export function sanitizeSvgDetailed(svg: string): SvgSanitizationOutcome {
  const removed: string[] = [];

  if (svg.trim().length === 0) {
    return { node: null, removed, reason: "empty-svg" };
  }
  if (svg.length > MAX_SVG_OUTPUT_CHARACTERS) {
    return { node: null, removed, reason: "over-output-limit" };
  }
  if (DOMPurify.isSupported !== true) {
    return { node: null, removed, reason: "sanitizer-unavailable" };
  }

  let fragment: DocumentFragment;
  try {
    fragment = DOMPurify.sanitize(svg, {
      USE_PROFILES: { svg: true, svgFilters: true },
      FORBID_TAGS: [...SVG_FORBID_TAGS],
      ALLOW_DATA_ATTR: true,
      ALLOW_ARIA_ATTR: true,
      SANITIZE_DOM: true,
      SANITIZE_NAMED_PROPS: true,
      KEEP_CONTENT: false,
      RETURN_DOM: false,
      RETURN_DOM_FRAGMENT: true
    }) as unknown as DocumentFragment;
  } catch {
    return { node: null, removed, reason: "sanitizer-threw" };
  }

  const svgElement = findSvgElement(fragment);
  if (svgElement === null) {
    // 清洗后连 <svg> 根都没剩下：内容整体不可信，交给错误态而不是原样插入。
    return { node: null, removed, reason: "no-svg-root" };
  }

  enforceSvgPolicy(svgElement, removed);

  if (containsActiveContent(svgElement)) {
    // 复判后仍有主动内容：整体拒绝，不返回「洗过一半」的节点。
    return { node: null, removed, reason: "active-content" };
  }

  svgElement.parentNode?.removeChild(svgElement);
  svgElement.setAttribute("data-readora-diagram-svg", "sanitized");
  return { node: svgElement, removed };
}

/** SVG → 可安全插入的节点；null 表示安全处理失败（调用方必须走错误态）。 */
export function sanitizeSvgToNode(svg: string): Node | null {
  return sanitizeSvgDetailed(svg).node;
}
