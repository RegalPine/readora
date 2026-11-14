/**
 * 自定义 CSS 的净化与判定（PRD-001 F08-011 / ARC-008 的不可信输入边界）。
 *
 * ARC-006 没有写预设与自定义 CSS 的任何条款（全篇 0 命中），所以这套规则是本批
 * 定案并登记偏差（README「能力边界」M6 小节）。三条结构性决定：
 *
 * 1. **注入的是重新生成的 AST，不是原文**。css-tree 的 parse 是容错的
 *    （`.readora-x { color: red` 也能解析出节点），正因为注入的是 `generate()` 的
 *    产物，被截断的残句、注释里的 `</style>`、字符串里的尖括号都进不了 HTML ——
 *    过滤与转义不再是两件需要同时做对的事。
 * 2. **任一违规整段拒绝**，不做「丢掉坏规则、留下好规则」。半采纳会让用户以为
 *    自己的 CSS 生效了，实际只生效了一部分，属于最难排查的那类错误。
 * 3. **选择器必须落在阅读器自己的类名/属性作用域内**（`.readora-*` 或
 *    `[data-readora-*]`）。自定义 CSS 是「微调阅读版面」的能力，不是覆盖宿主 UI
 *    或注入 `html`/`body`/`*` 全量规则的入口。
 */
import { generate, parse, walk } from "css-tree";

/** 默认长度上限，与 `readora.customCss` 的 manifest `maxLength` 同值。 */
export const DEFAULT_CUSTOM_CSS_MAX_CHARS = 32_768;

/** 允许的 at-rule（小写、不含 `@`）。其余一律整段拒绝。 */
export const ALLOWED_AT_RULE_NAMES = ["media", "supports"] as const;

/**
 * 禁止的属性名（小写）。
 *
 * `behavior` / `-moz-binding` 是 IE 与旧 Firefox 的「CSS 里执行代码」入口；
 * `filter` 本身保留（毛玻璃要用），但值里的 `progid:` 单独拒。
 */
export const FORBIDDEN_CUSTOM_CSS_PROPERTIES = [
  "behavior",
  "-moz-binding",
  "binding",
  "expression"
] as const;

export interface CustomCssPolicy {
  /** 长度上限（字符数）。超出即拒绝，不截断。 */
  maxChars?: number;
}

export type CustomCssResult =
  | { ok: true; css: string }
  | { ok: false; reason: string };

/** 选择器允许的起始形态：作用域类名，或以它开头的 `[data-readora-*]` 属性选择器。 */
const SCOPED_SELECTOR = /^(?:\.readora-[a-z0-9_-]+|\[data-readora-[a-z0-9_-]+\b)/u;

/** C0/C1 控制字符（制表与换行除外）：它们只用来藏住别的东西，一律拒。 */
// eslint-disable-next-line no-control-regex -- 目的正是识别控制字符
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u;

/** 值里的危险构造。`url(` 单独判断，因为 `data:image/...` 是唯一可接受的形态。 */
const DANGEROUS_VALUE =
  /expression\s*\(|javascript\s*:|vbscript\s*:|progid:|@import|behavior\s*:/iu;

function normalizeSelector(entry: string): string {
  // 嵌套写法（`&.readora-x`、`& .readora-x`）里的 `&` 指向外层选择器，
  // 剥掉之后才能按同一条作用域规则判断。
  return entry.trim().replace(/^&\s*/u, "");
}

function checkSelector(prelude: string): string | null {
  if (prelude.includes("\\")) {
    // 反斜杠转义是 CSS 里最省事的混淆手段（`\2e readora-x`），直接拒。
    return `selector "${prelude}" uses backslash escapes`;
  }
  const entries = prelude.split(",");
  for (const raw of entries) {
    const entry = normalizeSelector(raw);
    if (entry === "") {
      return `selector "${prelude}" has an empty entry`;
    }
    if (!SCOPED_SELECTOR.test(entry)) {
      return `selector "${entry}" must start with .readora- or [data-readora-`;
    }
  }
  return null;
}

function checkDeclaration(
  property: string,
  value: string | null
): string | null {
  const name = property.toLowerCase();
  if ((FORBIDDEN_CUSTOM_CSS_PROPERTIES as readonly string[]).includes(name)) {
    return `property "${name}" is not allowed`;
  }
  if (value === null || value.trim() === "") {
    return `declaration "${name}" has no value`;
  }
  if (DANGEROUS_VALUE.test(value)) {
    return `value of "${name}" contains a blocked construct`;
  }
  const urls = value.match(/url\(\s*([^)]*)\)/giu) ?? [];
  for (const reference of urls) {
    const target = reference
      .replace(/^url\(\s*/iu, "")
      .replace(/\s*\)$/u, "")
      .replaceAll('"', "")
      .replaceAll("'", "")
      .trim();
    if (!/^data:image\/[a-z0-9.+-]+;base64,/iu.test(target)) {
      return `url() in "${name}" must be a base64 data:image reference`;
    }
  }
  return null;
}

/**
 * 净化用户提供的自定义 CSS。
 *
 * 返回 `ok: true` 时 `css` 是重新生成的紧凑文本（不含注释、不含原文任何字节），
 * 可以直接放进 `<style>`；`ok: false` 时 `reason` 要原样进用户可见的诊断日志。
 */
export function sanitizeCustomCss(
  source: string,
  policy: CustomCssPolicy = {}
): CustomCssResult {
  const maxChars = policy.maxChars ?? DEFAULT_CUSTOM_CSS_MAX_CHARS;
  const trimmed = source.replace(/\r\n?/gu, "\n").trim();
  if (trimmed === "") {
    return { ok: true, css: "" };
  }
  if (trimmed.length > maxChars) {
    return {
      ok: false,
      reason: `custom CSS is ${trimmed.length} characters, above the ${maxChars} limit`
    };
  }
  if (CONTROL_CHARACTERS.test(trimmed)) {
    return { ok: false, reason: "custom CSS contains control characters" };
  }

  let ast: ReturnType<typeof parse>;
  try {
    ast = parse(trimmed, { positions: false, parseCustomProperty: false });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `custom CSS could not be parsed: ${message}` };
  }

  let violation: string | null = null;
  const reject = (reason: string): void => {
    violation ??= reason;
  };

  walk(ast, {
    visit: "Atrule",
    enter(node) {
      const name = node.name.toLowerCase();
      if (!(ALLOWED_AT_RULE_NAMES as readonly string[]).includes(name)) {
        reject(`at-rule "@${name}" is not allowed`);
        return;
      }
      if (node.prelude) {
        const prelude = generate(node.prelude);
        if (DANGEROUS_VALUE.test(prelude) || prelude.includes("<")) {
          reject(`prelude of "@${name}" contains a blocked construct`);
        }
      }
    }
  });

  walk(ast, {
    visit: "Rule",
    enter(node) {
      if (violation) {
        return;
      }
      const selector = generate(node.prelude);
      const selectorIssue = checkSelector(selector);
      if (selectorIssue) {
        reject(selectorIssue);
        return;
      }
      if (node.block) {
        for (const item of node.block.children) {
          if (item.type !== "Declaration") {
            // 声明块里出现别的节点（嵌套 Rule / Atrule）由各自 visitor 负责。
            continue;
          }
          const value = item.value ? generate(item.value) : null;
          const declarationIssue = checkDeclaration(item.property, value);
          if (declarationIssue) {
            reject(declarationIssue);
            return;
          }
        }
      }
    }
  });

  if (violation) {
    return { ok: false, reason: violation };
  }

  const css = generate(ast);
  if (css === "") {
    // 只剩注释或空白（AST 里一条规则都没有）：按「未设置」处理，避免留一个空
    // `<style>`。注意 `.readora-a {}` 这种空规则块不算这种情况 —— 它是合法
    // no-op，会原样注入，由调用方决定要不要给用户提示。
    return { ok: true, css: "" };
  }
  if (css.includes("<")) {
    return { ok: false, reason: "custom CSS resolved to text containing '<'" };
  }
  return { ok: true, css };
}
