/**
 * Frontmatter 提取（ARC-002 §4.2 Frontmatter 节点 / §12.1 metadata）。
 *
 * 只支持阅读场景需要的浅层结构：`key: value`、引号值、内联数组 `[a, b]`、
 * 块序列 `- item`。刻意不引入 YAML 依赖，也不解析嵌套对象；
 * 未闭合或非法行一律保留为正文 / 跳过并给出 info 诊断，绝不影响整篇渲染（§14.3）。
 *
 * M6（STORY-06-02）起额外交出 **properties 名单**：PRD-003 §4.6 要展示的「属性卡片」
 * 需要每个键的类型与原文，而 `DocumentMetadata` 只有 title / description / tags
 * 三个槽位，装不下 `status: draft`、`aliases: [...]` 这类自定义属性。类型只做
 * **字面量分类**（`classifyFrontmatterValue`），不解析、不求值、不执行任何表达式：
 * `date: 2024-01-01` 是「长得像日期的字符串」，不是 `new Date(...)` 的调用；
 * `{{7*7}}` 与 `=1+1` 就是文本。这一条是 STORY-06-02 的验收线，不是实现偷懒。
 *
 * 输入必须已经过 normalizeSource（行分隔统一为 \n）。
 */
import { RENDER_DIAGNOSTIC_CODES } from "./diagnostics";
import type {
  DocumentMetadata,
  FrontmatterProperty,
  FrontmatterValueKind,
  RenderDiagnostic
} from "./types";

export interface FrontmatterOutcome {
  body: string;
  metadata: DocumentMetadata;
  diagnostics: RenderDiagnostic[];
}

/**
 * 属性值类型（Obsidian Properties 的四类 + 兜底文本），定义在 types.ts（与
 * DocumentMetadata 同处），此处只转出，避免两个名字各管一份口径。
 *
 * 判定顺序固定：先列表、再布尔、再日期、再数字，最后文本。
 * 顺序决定 `1` 是 number 而不是 text、`[a]` 是 list 而不是 text —— 反过来写
 * 会得到一张所有格子都是字符串的表，那就没有排版的意义了。
 */
export type { FrontmatterProperty, FrontmatterValueKind } from "./types";

/** 属性上限：再多的键值表格在正文上方已不可读，也说明这份 Frontmatter 不正常。 */
export const FRONTMATTER_PROPERTY_LIMIT = 64;

const TAG_KEYS = new Set(["tags", "keywords"]);

const BOOLEAN_VALUES = new Map<string, boolean>([
  ["true", true],
  ["false", false]
]);

/** ISO 日期：`YYYY-MM-DD`，允许尾随 `T`/空格 + 时间，允许方括号包裹的 Obsidian 写法。 */
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

const NUMBER_PATTERN = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

function unquote(value: string): string {
  return value.trim().replace(/^(["'])(.*)\1$/u, "$2");
}

/**
 * 字面量分类：只做模式匹配，绝不解析成宿主对象。
 *
 * 刻意不调 `Date.parse` / `Number`：卡片显示的就是源码里那几个字符，
 * 一旦格式化就会引入时区与本地化口径（`2024-01-01` 在 UTC+8 与 UTC-5 下
 * 会显示成两个不同的日子），而那不是阅读器该替作者决定的事。
 */
export function classifyFrontmatterValue(raw: string): FrontmatterPropertyDraft {
  const trimmed = raw.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return { kind: "list", text: trimmed, items: parseInlineList(trimmed) };
  }
  const unquoted = unquote(trimmed);
  if (BOOLEAN_VALUES.has(unquoted.toLowerCase())) {
    return { kind: "boolean", text: unquoted };
  }
  if (DATE_PATTERN.test(unquoted)) {
    return { kind: "date", text: unquoted };
  }
  if (NUMBER_PATTERN.test(unquoted)) {
    return { kind: "number", text: unquoted };
  }
  return { kind: "text", text: unquoted };
}

/** classifyFrontmatterValue 的返回形态：还不带 key，尚未落进名单。 */
export interface FrontmatterPropertyDraft {
  kind: FrontmatterValueKind;
  text: string;
  items?: readonly string[];
}

function parseInlineList(value: string): string[] {
  return value
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .split(",")
    .map(unquote)
    .filter((item) => item.length > 0);
}

function findClosingFence(lines: string[]): number {
  for (let index = 1; index < lines.length; index += 1) {
    const line = (lines[index] ?? "").trim();
    if (line === "---" || line === "...") {
      return index;
    }
  }
  return -1;
}

export function extractFrontmatter(source: string): FrontmatterOutcome {
  const empty: DocumentMetadata = { tags: [], properties: [] };
  const lines = source.split("\n");
  if ((lines[0] ?? "").trim() !== "---") {
    return { body: source, metadata: empty, diagnostics: [] };
  }

  const closing = findClosingFence(lines);
  if (closing < 0) {
    return {
      body: source,
      metadata: empty,
      diagnostics: [
        {
          code: RENDER_DIAGNOSTIC_CODES.FRONTMATTER_INVALID,
          severity: "info",
          message: "Frontmatter block is not closed; rendered as document content."
        }
      ]
    };
  }

  const metadata: DocumentMetadata = { tags: [], properties: [] };
  const diagnostics: RenderDiagnostic[] = [];
  const properties: FrontmatterProperty[] = [];
  const block = lines.slice(1, closing);

  let truncated = false;

  /**
   * 落一条属性。
   *
   * 超上限时整条丢弃并只报一次 info 诊断：卡片的作用是让作者看见这篇的元信息，
   * 不是把一份 500 键的表搬进正文上方。丢弃发生在名单层面，正文一个字节都不动。
   */
  const addProperty = (rawKey: string, draft: FrontmatterPropertyDraft): void => {
    if (properties.length >= FRONTMATTER_PROPERTY_LIMIT) {
      if (!truncated) {
        truncated = true;
        diagnostics.push({
          code: RENDER_DIAGNOSTIC_CODES.FRONTMATTER_INVALID,
          severity: "info",
          message: `Frontmatter properties truncated at ${FRONTMATTER_PROPERTY_LIMIT}; the remaining keys are not shown.`
        });
      }
      return;
    }
    properties.push({
      key: rawKey,
      kind: draft.kind,
      text: draft.text,
      ...(draft.items !== undefined ? { items: draft.items } : {})
    });
  };

  let index = 0;
  while (index < block.length) {
    const line = block[index] ?? "";
    index += 1;
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      continue;
    }
    const pair = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(line);
    if (!pair) {
      diagnostics.push({
        code: RENDER_DIAGNOSTIC_CODES.FRONTMATTER_INVALID,
        severity: "info",
        message: `Ignored unparsable frontmatter line: ${trimmed.slice(0, 80)}`
      });
      continue;
    }
    const rawKey = pair[1] ?? "";
    const key = rawKey.toLowerCase();
    const value = (pair[2] ?? "").trim();

    if (value === "") {
      // 块序列：后续 `- item` 行。
      const items: string[] = [];
      while (index < block.length) {
        const next = /^\s*-\s+(.*)$/.exec(block[index] ?? "");
        if (!next) {
          break;
        }
        const item = unquote(next[1] ?? "");
        if (item) {
          items.push(item);
        }
        index += 1;
      }
      if (TAG_KEYS.has(key)) {
        metadata.tags = items;
      }
      addProperty(rawKey, { kind: "list", text: "", items });
      continue;
    }

    if (value.startsWith("[")) {
      const draft = classifyFrontmatterValue(value);
      if (TAG_KEYS.has(key)) {
        // 复一份而不是共用：DocumentMetadata.tags 对外是可写数组，
        // 名单里的 items 是只读快照，两者不能指向同一个实例。
        metadata.tags = [...(draft.items ?? [])];
      }
      addProperty(rawKey, draft);
      continue;
    }

    const draft = classifyFrontmatterValue(value);
    if (key === "title") {
      metadata.title = draft.text;
    } else if (key === "description") {
      metadata.description = draft.text;
    } else if (TAG_KEYS.has(key)) {
      metadata.tags = [draft.text];
    }
    addProperty(rawKey, draft);
  }

  return {
    body: lines.slice(closing + 1).join("\n"),
    metadata: { ...metadata, properties },
    diagnostics
  };
}
