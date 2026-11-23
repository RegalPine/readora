/**
 * P07 / P08 HTML Security Sanitizer（ARC-002 §11 / IMP-001 §8.4）。
 *
 * Sanitizer 与 CSP 是两层不同的安全措施，不互相替代（§11.5）：
 * CSP 由 Host 的 HTML 模板负责，本模块只负责把渲染产物收敛到白名单。
 *
 * 失败一律 fail-closed：DOMPurify 不可用或抛错时返回转义纯文本，
 * 绝不回退未经验证的 HTML（§14.3 第 6 条）。
 */
import DOMPurify from "dompurify";
import { MATH_CONTAINER_CLASS } from "./math";
import { escapeHtml } from "./escape";
import { RENDER_DIAGNOSTIC_CODES } from "./diagnostics";
import { SOURCE_RANGE_ATTRIBUTE, SOURCE_RANGE_PATTERN } from "./source-range";
import type {
  HtmlSanitizer,
  RenderDiagnostic,
  SanitizationPolicy,
  SanitizeOutcome
} from "./types";

/**
 * ARC-002 §11.3 策略：默认不放行原始 HTML、不放行 SVG。
 *
 * scheme 白名单为 http / https / mailto / 文档内锚点。mailto 只代表「万一出现
 * mailto href，清洗层不吞掉它」；真正把链接交给 Host 打开的判定在 links.ts，
 * 按 ARC-008 §8.3 仍只放行 http/https，未批准的自定义协议一律降级为纯文本。
 */
export const DEFAULT_SANITIZATION_POLICY: SanitizationPolicy = {
  allowHtml: false,
  allowSvg: false,
  allowExternalLinks: true,
  allowedUrlSchemes: ["http", "https", "mailto"]
};

/**
 * 白名单标签。`img` 的存在只为提供图片的语义结构（ARC-002 §7.5 / 计划 §图片），
 * `src` 在 FORBID_ATTR 中被全局禁掉，因此本层永不触发任何图片请求；
 * M3 的 resource.resolve 通过后由应用层补上可加载的形态。
 */
const ALLOWED_TAGS = [
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "p",
  "br",
  "hr",
  "strong",
  "em",
  "del",
  "code",
  "pre",
  "blockquote",
  "ul",
  "ol",
  "li",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
  "a",
  "img",
  "div",
  "span",
  "button"
];

const ALLOWED_ATTR = [
  "id",
  "class",
  "href",
  "title",
  "alt",
  "rel",
  "type",
  "start",
  "scope",
  "colspan",
  "rowspan",
  "data-align",
  "role",
  "tabindex"
];

/*
 * 【本表不需要加 data-*】`data-readora-width|height`、`data-readora-code-lang`、
 * `data-readora-source-range` 都不在白名单里却都能活下来，因为下面传的是
 * `ALLOW_DATA_ATTR: true`：DOMPurify 对匹配 `DATA_ATTR` 的名字直接 `return true`，
 * 连值都不查（源码注「We don't need to check the value; it's always URI safe」）。
 * 所以新增一个 `data-readora-*` 属性不需要改本表；需要的是另加值形状校验——
 * 就是下面那个 stripMalformedSourceRanges，别误以为往白名单里塞一行才是放行。
 */

/**
 * ── 数学公式标记白名单（IMP-001 §10.3 末段）────────────────────────────
 *
 * IMP-001 点名的这套常量（`MATH_MARKUP_TAGS` / `MATH_MARKUP_ATTRIBUTES` /
 * `MATH_MARKUP_SCOPE`）在 ARC-002 §11 里并没有对应定义 —— 属文档缺口，
 * 名字与取值以本文件为准，README 登记偏差。
 *
 * 为什么必须扩面：KaTeX 的排版全靠内联 `style`（`height` / `vertical-align` /
 * `top`），`\sqrt` 与伸缩定界符还依赖 `svg` + `path`。按基础白名单清洗会把公式
 * 拆成一堆没有位置的裸文本。
 *
 * 为什么不能直接把 `style` 并进全局白名单：那样文档自带的 HTML 也能拿到内联样式，
 * 等于向整篇开放 style。这里的做法是**先放行、后限域**：DOMPurify 用并集白名单
 * 清洗一次，再在返回的 DOM 上走一遍 `restrictMathMarkup`，把不在 `.readora-math`
 * 子树里的公式标签与公式属性逐条剥掉。「扩了白名单」与「扩了可达面」是两件事，
 * 后者由这一遍限域负责保证 —— 这也正是 §10.3「文档自带的 HTML 取不到这些标签与
 * 属性」的可执行形态。
 */
export const MATH_MARKUP_SCOPE = MATH_CONTAINER_CLASS;

/** 只在公式子树内允许的标签（`span` 已在基础白名单内，不重复列）。 */
export const MATH_MARKUP_TAGS = ["svg", "path", "line", "g", "rect", "circle", "use"] as const;

/** 只在公式子树内允许的属性（`class` / `aria-hidden` / `title` 已在基础白名单内）。 */
export const MATH_MARKUP_ATTRIBUTES = [
  "style",
  "d",
  "viewbox",
  "preserveaspectratio",
  "width",
  "height",
  "xmlns",
  "x",
  "y",
  "x1",
  "x2",
  "y1",
  "y2"
] as const;

const MATH_TAG_SET: ReadonlySet<string> = new Set<string>(MATH_MARKUP_TAGS);
const MATH_ATTR_SET: ReadonlySet<string> = new Set<string>(MATH_MARKUP_ATTRIBUTES);

/**
 * DOMPurify 在属性名通过 ALLOWED_ATTR 之后还会做一次「值检查」：非 URI-safe
 * 属性的值必须匹配 ALLOWED_URI_REGEXP 或为空，否则整条属性被静默丢弃
 * （purify 源码 `_isValidAttribute`，3.4.17 第 2166-2167 行）。
 *
 * 下面这些属性存的是枚举值与数字而非 URI，须显式并入 URI-safe 集合，
 * 否则渲染产物会缺 rel / start / type / scope 等语义属性；
 * ALLOWED_URI_REGEXP 因此只继续约束真正的 URI 属性（href）。
 *
 * 公式属性同样要并进来：`d="M1 1"`、`viewBox="0 0 400 400"`、`width="0.8em"`
 * 全都过不了 URI 正则，不并入就会得到一堆没有形状的公式壳（见下 MATH_MARKUP_*）。
 * 「全局放开这些属性名」并不等于「文档可以任意使用它们」—— 限域遍历会在
 * 清洗之后把子树外的它们逐条剥掉，两件事分别可断言。
 */
const URI_SAFE_ATTRIBUTES = [
  "rel",
  "type",
  "start",
  "scope",
  "colspan",
  "rowspan",
  "tabindex",
  ...MATH_MARKUP_ATTRIBUTES
];

/**
 * 限域遍历：返回被剥掉的公式标记条数（用于诊断）。
 *
 * 公式标签在子树外**整节点删除**而不是拆壳留文本 —— 一个不该出现的 `<svg>`
 * 里没有可读内容，留下子节点只会把绘图路径当正文吐出来。
 */
function restrictMathMarkup(root: Element): number {
  // 一次性快照：删除节点会让实时遍历漏掉后续兄弟。
  const elements = Array.from(root.querySelectorAll("*"));
  let stripped = 0;
  for (const element of elements) {
    if (element.closest(`.${MATH_MARKUP_SCOPE}`) !== null) {
      continue;
    }
    if (MATH_TAG_SET.has(element.tagName.toLowerCase())) {
      stripped += 1;
      element.remove();
      continue;
    }
    for (const name of Array.from(element.attributes, (item) => item.name.toLowerCase())) {
      if (MATH_ATTR_SET.has(name)) {
        element.removeAttribute(name);
        stripped += 1;
      }
    }
  }
  return stripped;
}

/**
 * 源行范围锚点的值形状遍历（ARC-002 §12.3 门禁 3）。
 *
 * 先说清这不是在堵漏洞：parser 以 `html: false` 运行，文档自带的 HTML 在
 * `htmlBlockRenderer` 那一层就被转义成可见文本，所以文档侧没有任何能写入自定义
 * 属性的路径。它防的是**我们自己**：属性值是 `sourceRangeValue` 拼出来的行号，
 * `NaN:NaN` / `-1:-1` 这类编程错误一旦被下游当成合法范围，后果是按错的行改文件。
 * 剥掉就是「该区块不可编辑」，留下就是一个可能改错位置的锚点，两者不可同日而语。
 *
 * `data-*` 不进 URI 值校验（见 ALLOWED_ATTR 上方注），所以 DOMPurify 本体不会替
 * 我们校这个形状，必须自己走一遍。
 *
 * @returns 被剥掉的条数（命中即记 `source-range-stripped` 诊断，不静默）。
 */
function stripMalformedSourceRanges(root: Element): number {
  let stripped = 0;
  const elements = Array.from(root.querySelectorAll(`[${SOURCE_RANGE_ATTRIBUTE}]`));
  for (const element of elements) {
    const value = element.getAttribute(SOURCE_RANGE_ATTRIBUTE) ?? "";
    if (!SOURCE_RANGE_PATTERN.test(value)) {
      element.removeAttribute(SOURCE_RANGE_ATTRIBUTE);
      stripped += 1;
      continue;
    }
    // 形状对但区间倒挂（`15:12`）同样不可用：写回会拿到一个空反向的 Range。
    const [start, end] = value.split(":");
    if (Number(start) > Number(end)) {
      element.removeAttribute(SOURCE_RANGE_ATTRIBUTE);
      stripped += 1;
    }
  }
  return stripped;
}

/** 基础白名单与公式白名单的并集：限域发生在清洗之后，所以这里可以放宽。 */
const SANITIZE_TAGS = [...ALLOWED_TAGS, ...MATH_MARKUP_TAGS];
const SANITIZE_ATTR = [...ALLOWED_ATTR, ...MATH_MARKUP_ATTRIBUTES];

/** 只放行文档内锚点与策略允许的 scheme（默认 http/https/mailto）。 */
function uriRegExpFor(policy: SanitizationPolicy): RegExp {
  if (!policy.allowExternalLinks) {
    return /^#/i;
  }
  const schemes = policy.allowedUrlSchemes.length > 0 ? policy.allowedUrlSchemes : ["http", "https"];
  const body = schemes.map((scheme) => scheme.replace(/[^a-z0-9+.-]/gi, "")).join("|");
  return new RegExp(`^(?:#|(?:${body}):)`, "i");
}

const FORBID_TAGS = ["script", "style", "iframe", "object", "embed", "link", "meta", "form"];
/** `src` / `srcdoc` 等一律禁止：图片与其它资源加载属 M3（ARC-008 §8.1）。 */
const FORBID_ATTR = ["src", "srcdoc", "xlink:href", "formaction", "action", "background", "style"];

/**
 * 运行时属性禁列：`style` 从中移出，改由公式限域遍历负责（见上）。
 * `xlink:href` 保持禁止 —— KaTeX 0.19 的 html 输出不使用它，而它一旦放开，
 * 就成了文档侧引用外部 fragment / 数据的入口（ARC-008 §12）。
 */
const FORBID_ATTR_RUNTIME = FORBID_ATTR.filter((name) => name !== "style");

export function sanitizeHtml(html: string, policy: SanitizationPolicy): SanitizeOutcome {
  const diagnostics: RenderDiagnostic[] = [];

  if (DOMPurify.isSupported !== true) {
    diagnostics.push({
      code: RENDER_DIAGNOSTIC_CODES.SANITIZE_FAILED,
      severity: "error",
      message: "HTML sanitizer is unavailable in this environment; content rendered as escaped text."
    });
    return { html: escapeHtml(html), diagnostics };
  }

  try {
    // RETURN_DOM：限域要在 DOM 上做，字符串层面既找不到祖先也删不干净。
    const body = DOMPurify.sanitize(html, {
      ALLOWED_TAGS: SANITIZE_TAGS,
      ALLOWED_ATTR: SANITIZE_ATTR,
      ADD_URI_SAFE_ATTR: URI_SAFE_ATTRIBUTES,
      ALLOW_DATA_ATTR: true,
      ALLOW_ARIA_ATTR: true,
      ALLOWED_URI_REGEXP: uriRegExpFor(policy),
      FORBID_TAGS,
      FORBID_ATTR: FORBID_ATTR_RUNTIME,
      KEEP_CONTENT: true,
      RETURN_DOM: true,
      SANITIZE_DOM: true
    }) as unknown as Element;

    const stripped = restrictMathMarkup(body);
    if (stripped > 0) {
      diagnostics.push({
        code: RENDER_DIAGNOSTIC_CODES.MATH_SCOPE_STRIPPED,
        severity: "warning",
        message: `${stripped} math markup node(s) or attribute(s) outside the formula scope were removed.`
      });
    }

    const malformedRanges = stripMalformedSourceRanges(body);
    if (malformedRanges > 0) {
      diagnostics.push({
        code: RENDER_DIAGNOSTIC_CODES.SOURCE_RANGE_STRIPPED,
        severity: "warning",
        message: `${malformedRanges} block(s) carried a malformed source line range; the attribute was removed, so those blocks stay uneditable.`
      });
    }

    return { html: body.innerHTML, diagnostics };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    diagnostics.push({
      code: RENDER_DIAGNOSTIC_CODES.SANITIZE_FAILED,
      severity: "error",
      message: `Sanitization failed, output escaped instead: ${message.slice(0, 200)}`
    });
    return { html: escapeHtml(html), diagnostics };
  }
}

export const htmlSanitizer: HtmlSanitizer = {
  sanitize: (html, policy) => sanitizeHtml(html, policy)
};
