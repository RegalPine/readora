/**
 * 块属性白名单：`{key=value}` 的识别与判定（MPE 借鉴项，M10）。
 *
 * markdown-it 核心不解析块属性（仓库也没有 markdown-it-attrs），
 * 所以这里自持一条 core 规则，与 math / wiki-link 同一条范式：
 * **规则只搬运形状，值不合法就整串不认**，于是判定不成立的写法按原样留在正文里。
 *
 * 三个挂载点（覆盖面按「围栏 + 块级尾随 + 图片尾随」这一档，
 * 不含 `{: …}` 独占行与 `.class` / `#id` 简写，那些登记在未纳入清单）：
 * 1. `fence` 的 info 串尾部：` ```js {code_block=true filename="app.js"} `；
 * 2. 块级尾随：`# 标题 {align=center}`、段落尾随、列表项尾随、脚注定义尾随、
 *    表格最后一格尾随（归整张表）；
 * 3. 图片尾随：`![alt](path){width=60%}`。
 *
 * 为什么「任一不合格就整体拒绝」而不是逐键忽略：后者会让 `{"port": 8080}`
 * 这种 JSON 尾巴被吃掉一半（`port` 不在白名单 ⇒ 静默删掉整段），
 * 而「一半生效」是最难排查的那类失效。整体拒绝 ⇒ 正文一个字都不少。
 *
 * 为什么不写 `style`：Sanitizer 把 `style` 限域在公式子树内（sanitizer.ts 的
 * `restrictMathMarkup`），子树外一律剥除；放开限域等于扩大可达面。
 * 因此产物只有 `data-align` / `data-readora-width` / `data-readora-height`，
 * 尺寸由 Webview 的接管层落地 —— 那两层本来就是这些属性的唯一作者。
 */
import type { StateCore } from "markdown-it";
import type { Token } from "./parser";

/** 规则名（与 `readora.math_span` 同一前缀口径）。 */
export const ATTR_RULE_NAME = "readora.attrs";

/** 白名单键名：只有显式登记的键能被识别，其余一律整体拒绝。 */
export const ALIGN_ATTR = "align";
export const WIDTH_ATTR = "width";
export const HEIGHT_ATTR = "height";
export const CODE_BLOCK_ATTR = "code_block";
export const HEADER_ATTR = "header";
export const FILENAME_ATTR = "filename";
export const DIAGRAM_ID_ATTR = "diagram_id";
export const DIAGRAM_TITLE_ATTR = "diagram_title";

/** env 里的被拒记录键：管线据此产出 info 诊断（index.ts）。 */
export const ATTR_ENV_KEY = "readoraAttrs";

export const FILENAME_MAX_LENGTH = 120;

const SIZE_MAX_LENGTH = 16;
const SIZE_PATTERN = /^\d+(\.\d+)?(px|%)?$/;
const ALIGN_VALUES = new Set(["left", "center", "right"]);
const BOOLEAN_VALUES = new Set(["true", "false"]);

export function isDelimitedSizeValue(value: string): boolean {
  return value.length > 0 && value.length <= SIZE_MAX_LENGTH && SIZE_PATTERN.test(value);
}

/**
 * 文件名值：纯文本展示用，因此拒绝控制字符与 HTML 特殊字符；
 * 并**拒绝 `@` 前缀**—— MPE 的 `filename=@README.md` 是文件导入语法，
 * 本批不实现文件包含，不能留一个「看起来能用其实不通」的形态。
 */
export function isAllowedFilenameValue(value: string): boolean {
  if (value.length === 0 || value.length > FILENAME_MAX_LENGTH) {
    return false;
  }
  if (value.startsWith("@") || value.startsWith("#")) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) {
      return false;
    }
  }
  return !value.includes("<") && !value.includes(">") && !value.includes('"') && !value.includes("&");
}

const VALIDATORS: Record<string, (value: string) => boolean> = {
  [ALIGN_ATTR]: (value) => ALIGN_VALUES.has(value),
  [WIDTH_ATTR]: isDelimitedSizeValue,
  [HEIGHT_ATTR]: isDelimitedSizeValue,
  [CODE_BLOCK_ATTR]: (value) => BOOLEAN_VALUES.has(value),
  [HEADER_ATTR]: (value) => BOOLEAN_VALUES.has(value),
  [FILENAME_ATTR]: isAllowedFilenameValue,
  [DIAGRAM_ID_ATTR]: (value) => /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value),
  [DIAGRAM_TITLE_ATTR]: (value) => {
    if (value.length === 0 || value.length > 120 || /[<>]/.test(value)) return false;
    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      if (code < 0x20 || code === 0x7f) return false;
    }
    return true;
  }
};

/** 允许挂尾随属性的块级 token。 */
const BLOCK_TARGETS = new Set([
  "heading_open",
  "paragraph_open",
  "blockquote_open",
  "list_item_open",
  "footnote_def_open",
  // 表格的尾随写法只能落在表级：`th_open` / `td_open` 不在目标集里，
  // 于是 `{…}` 写在单元格里不会被误当成整个表的能力（单元格对齐仍走 `:---:`）。
  "table_open"
]);

function isSpace(code: number): boolean {
  return code === 0x20 || code === 0x09;
}

/**
 * 每个挂载点能**真正渲出来**的键。
 *
 * 为什么需要这一层：`{width=60%}` 写在段落尾巴上不会消失 —— 段落渲染器不读 width，
 * 于是「花括号被吃了、什么也没发生」。给了渲不出的属性比不给更糟（静默失效），
 * 因此不兼容的键直接整体拒绝：整串留在正文 + 一条 ATTRS_REJECTED。
 */
const BLOCK_KEYS: ReadonlySet<string> = new Set([ALIGN_ATTR]);
const IMAGE_KEYS: ReadonlySet<string> = new Set([WIDTH_ATTR, HEIGHT_ATTR]);

/**
 * 严格 `k=v` / `k="v"` 扫描：键必须命中白名单（可进一步限定到挂载点可用集）、
 * 值必须过形状校验、键不得重复。任何一条不满足 ⇒ 返回 null（整体拒绝），绝不返回「一部分」。
 */
export function scanAttributePairs(
  inner: string,
  allowedKeys?: ReadonlySet<string>
): [string, string][] | null {
  const pairs: [string, string][] = [];
  const seen = new Set<string>();
  let pos = 0;
  while (pos < inner.length) {
    while (pos < inner.length && isSpace(inner.charCodeAt(pos))) {
      pos += 1;
    }
    if (pos >= inner.length) {
      break;
    }
    const keyStart = pos;
    while (pos < inner.length && inner.charCodeAt(pos) !== 0x3d && !isSpace(inner.charCodeAt(pos))) {
      pos += 1;
    }
    const key = inner.slice(keyStart, pos);
    if (key.length === 0 || inner.charCodeAt(pos) !== 0x3d) {
      return null;
    }
    pos += 1;
    while (pos < inner.length && isSpace(inner.charCodeAt(pos))) {
      pos += 1;
    }
    let value: string;
    if (inner.charCodeAt(pos) === 0x22 || inner.charCodeAt(pos) === 0x27) {
      const quote = inner.charCodeAt(pos);
      const close = inner.indexOf(String.fromCharCode(quote), pos + 1);
      if (close < 0) {
        return null;
      }
      value = inner.slice(pos + 1, close);
      pos = close + 1;
    } else {
      const valueStart = pos;
      while (pos < inner.length && !isSpace(inner.charCodeAt(pos))) {
        pos += 1;
      }
      value = inner.slice(valueStart, pos);
    }
    const validate = VALIDATORS[key];
    if (!validate || seen.has(key) || !validate(value)) {
      return null;
    }
    if (allowedKeys && !allowedKeys.has(key)) {
      return null;
    }
    seen.add(key);
    pairs.push([key, value]);
  }
  return pairs.length > 0 ? pairs : null;
}

/** 花括号内文 → 属性表；任一处不合即 null。 */
export function parseAttributeString(inner: string): Record<string, string> | null {
  const pairs = scanAttributePairs(inner);
  if (!pairs) {
    return null;
  }
  const attributes: Record<string, string> = {};
  for (const [key, value] of pairs) {
    attributes[key] = value;
  }
  return attributes;
}

/**
 * 取文本尾部完整闭合的 `{…}`：要求最后一段以 `}` 收尾、内部不再出现花括号，
 * 且开括号前不是反斜杠（`\{` 是 LaTeX 的转义花括号，属正文）。
 */
export function matchTrailingBraces(
  text: string,
  from = 0
): { inner: string; start: number; end: number } | null {
  if (!text.endsWith("}")) {
    return null;
  }
  const start = text.lastIndexOf("{");
  if (start < from) {
    return null;
  }
  if (start > 0 && text.charCodeAt(start - 1) === 0x5c) {
    return null;
  }
  const inner = text.slice(start + 1, text.length - 1);
  if (inner.length === 0 || inner.includes("{") || inner.includes("}")) {
    return null;
  }
  return { inner, start, end: text.length };
}

/** 「像不像一次属性书写」：只在含 `键=` 形态时才记被拒诊断，避免 JSON 例子刷屏。 */
const ATTEMPT_PATTERN = /[a-zA-Z_][a-zA-Z0-9_-]*\s*=/;

function recordRejection(
  env: Record<string, unknown>,
  raw: string,
  source: { startLine: number; endLine: number } | undefined
): void {
  const bucket = (env[ATTR_ENV_KEY] ??= []) as { raw: string; line?: number }[];
  bucket.push(source ? { raw, line: source.startLine } : { raw });
}

/** 把属性表写进 token.attrs（markdown-it 的 attrs 形态：[name, value] 数组）。 */
function attach(token: Token, pairs: [string, string][]): void {
  const attrs = token.attrs ?? (token.attrs = []);
  for (const [key, value] of pairs) {
    attrs.push([key, value]);
  }
}

function applyFenceAttrs(tokens: Token[], env: Record<string, unknown>): void {
  for (const token of tokens) {
    if (token.type !== "fence") {
      continue;
    }
    const info = token.info ?? "";
    const braces = matchTrailingBraces(info, 0);
    if (!braces) {
      continue;
    }
    const pairs = scanAttributePairs(braces.inner);
    if (pairs) {
      attach(token, pairs);
      token.info = info.slice(0, braces.start).trimEnd();
    } else if (ATTEMPT_PATTERN.test(braces.inner)) {
      recordRejection(env, braces.inner, token.map ? { startLine: token.map[0], endLine: token.map[1] } : undefined);
    }
  }
}

/** 行内 children 的尾部文本：图片尾随与块级尾随共用一次扫描，各写各的落点。 */
function applyInlineAttrs(
  inline: Token,
  blockOpen: Token | null,
  env: Record<string, unknown>
): void {
  const children = inline.children ?? [];
  const source = inline.map ? { startLine: inline.map[0], endLine: inline.map[1] } : undefined;

  for (let index = children.length - 1; index >= 0; index -= 1) {
    const child = children[index] as Token;
    if (child.type !== "text") {
      continue;
    }
    const previous = index > 0 ? (children[index - 1] as Token) : null;

    // 形态 A：紧跟 image 的文本（可以一个空格分开）以 `{` 开头 —— 属性归图片。
    if (previous?.type === "image") {
      const offset = child.content.length - child.content.trimStart().length;
      if (child.content.charCodeAt(offset) !== 0x7b) {
        continue;
      }
      const leading = leadingBraces(child.content.slice(offset));
      if (!leading) {
        continue;
      }
      const pairs = scanAttributePairs(leading.inner, IMAGE_KEYS);
      if (pairs) {
        attach(previous, pairs);
        consume(children, index, child.content.slice(offset + leading.end));
        return;
      }
      recordRejection(env, leading.inner, source);
      continue;
    }

    // 形态 B：整段最后一个文本以 `{…}` 收尾 —— 属性归它所属的块级 token。
    if (index !== children.length - 1 || !blockOpen || !BLOCK_TARGETS.has(blockOpen.type)) {
      continue;
    }
    const trailing = matchTrailingBraces(child.content);
    if (!trailing) {
      continue;
    }
    // 剩下的文本末尾空白一并去掉：消费掉的应是「一段尾注」而不是「一段尾注加一个空格」。
    const rest = child.content.slice(0, trailing.start).replace(/\s+$/, "");
    // 剩余文本里还留着未闭合 / 另一半花括号 ⇒ 形状可疑，一个字节都不动。
    if (rest.includes("{") || rest.includes("}")) {
      continue;
    }
    const pairs = scanAttributePairs(trailing.inner, BLOCK_KEYS);
    if (!pairs) {
      if (ATTEMPT_PATTERN.test(trailing.inner)) {
        recordRejection(env, trailing.inner, source);
      }
      continue;
    }
    attach(blockOpen, pairs);
    consume(children, index, rest);
    return;
  }
}

/** 用消费后剩下的文本替换该节点；文本被吃空即摘掉这个节点。 */
function consume(children: Token[], index: number, rest: string): void {
  const child = children[index] as Token;
  child.content = rest;
  if (child.content.length === 0) {
    children.splice(index, 1);
  }
}

/** 开头的完整 `{…}` 片段（图片尾随形态：属性串后面可能还有别的文本）。 */
function leadingBraces(text: string): { inner: string; end: number } | null {
  const close = text.indexOf("}");
  if (!text.startsWith("{") || close < 0) {
    return null;
  }
  const inner = text.slice(1, close);
  if (inner.length === 0 || inner.includes("{")) {
    return null;
  }
  return { inner, end: close + 1 };
}

/**
 * 从 inline 往前找**最内层**的块级归属。
 *
 * 不能只看前一个 token：tight 列表 / tight 引用里的 `paragraph_open` 是隐藏包裹，
 * AST 会把它解包掉（ast.ts 的 transparent），属性挂在它身上就跟着丢了；
 * 而表格单元格的 `th_open` / `td_open` 不是目标 —— 本层不支持格级属性，
 * 就地返回 null 让尾随 `{…}` 留在正文（表级尾随由 applyTableAttrs 显式处理）。
 */
function innermostBlockTarget(tokens: Token[], inlineIndex: number): Token | null {
  let depth = 0;
  for (let index = inlineIndex - 1; index >= 0; index -= 1) {
    const token = tokens[index] as Token;
    if (token.nesting === -1) {
      depth += 1;
      continue;
    }
    if (token.nesting !== 1) {
      continue;
    }
    if (depth > 0) {
      depth -= 1;
      continue;
    }
    if (token.type === "paragraph_open" && token.hidden === true) {
      continue;
    }
    return BLOCK_TARGETS.has(token.type) ? token : null;
  }
  return null;
}

/** 与 `table_open` 配对的结束 token 下标（markdown-it 的表格是扁平 token 流）。 */
function matchingCloseIndex(tokens: Token[], openIndex: number): number {
  let depth = 0;
  for (let index = openIndex + 1; index < tokens.length; index += 1) {
    const type = (tokens[index] as Token).type;
    if (type === "table_open") {
      depth += 1;
    } else if (type === "table_close") {
      if (depth === 0) {
        return index;
      }
      depth -= 1;
    }
  }
  return -1;
}

/**
 * 表格尾随：`{…}` 写在最后一格文字后面 ⇒ 属性归整张表。
 *
 * markdown-it 把表格拆成 `table_open … th_open / inline / th_close … table_close`，
 * inline 的前一个 token 永远是 `th_open` / `td_open`，因此通用循环接不到它。
 * 这里只多做一件明确的事：在配对区间内找**最后一个** inline token 试一次尾随形态。
 */
function applyTableAttrs(tokens: Token[], env: Record<string, unknown>): void {
  for (let index = 0; index < tokens.length; index += 1) {
    const open = tokens[index] as Token;
    if (open.type !== "table_open") {
      continue;
    }
    const close = matchingCloseIndex(tokens, index);
    if (close < 0) {
      continue;
    }
    for (let cursor = close - 1; cursor > index; cursor -= 1) {
      const token = tokens[cursor] as Token;
      if (token.type !== "inline") {
        continue;
      }
      applyInlineAttrs(token, open, env);
      break;
    }
    index = close;
  }
}

/**
 * markdown-it core 规则：装在 `inline` 之后（此时行内 children 已就位，
 * 而 linkify / replacements 还没改写文本节点）。
 */
export function attrsRule(state: StateCore): void {
  const env = (state.env ?? {}) as Record<string, unknown>;
  const tokens = state.tokens;
  applyFenceAttrs(tokens, env);
  applyTableAttrs(tokens, env);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] as Token;
    if (token.type !== "inline") {
      continue;
    }
    applyInlineAttrs(token, innermostBlockTarget(tokens, index), env);
  }
}

/** AST 阶段的读取入口：只搬运命中白名单且形状仍合法的键（纵深防御，重复一次判定）。 */
export function whitelistedAttributes(token: Token): Record<string, string> {
  const collected: Record<string, string> = {};
  for (const [key, value] of token.attrs ?? []) {
    const validate = VALIDATORS[key];
    if (validate && typeof value === "string" && validate(value)) {
      collected[key] = value;
    }
  }
  return collected;
}

/** env 里的被拒记录 → 诊断输入（index.ts 负责换成 RenderDiagnostic）。 */
export function rejectedAttributeStrings(env: unknown): { raw: string; line?: number }[] {
  const bucket = (env as Record<string, unknown> | undefined)?.[ATTR_ENV_KEY];
  return Array.isArray(bucket) ? (bucket as { raw: string; line?: number }[]) : [];
}
