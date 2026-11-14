/**
 * 标题锚点与大纲（ARC-002 §7.1 / §12.1）。
 *
 * 锚点规则：规范化文本 → 移除标点与符号 → 空白转连字符 → 空值兜底；
 * 重复标题追加序号，保证同一文档内唯一（§7.1 第 4、5 条）。
 * CJK 标题保留原文（\p{L} 不被剔除），避免中文文档锚点全部退化为 section。
 */
import { readNumber } from "./nodes";
import { textOf } from "./nodes";
import type { MarkdownDocument, MarkdownNode, OutlineItem } from "./types";

/**
 * 参与锚点的字符：字母、数字、组合记号（声调等）、下划线、连字符与空白；
 * 其余标点与符号剔除。空白在下一步转连字符，因此 `Hello, World!` → `hello-world`。
 * 保留 `_` 与 `-` 与 GitHub 口径一致，便于从编辑器复制锚点链接。
 */
const NON_SLUG_CHAR = /[^\p{L}\p{N}\p{M}_\-\s]/gu;

export function slugifyHeading(text: string): string {
  const slug = text
    .trim()
    .toLowerCase()
    .replace(NON_SLUG_CHAR, "")
    .replace(/\s+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "section";
}

/**
 * 序号分配器：同一个 base 第二次出现得到 `base-1`，依次递增。
 * 除按 base 计数外还校验已占用的锚点，避免 `abc-1` 这类字面标题与
 * `abc` 的第二个副本撞车（§7.1 第 5 条要求同一文档内唯一）。
 */
export function createAnchorRegistry(): {
  assign: (text: string) => string;
  reserve: (base: string) => string;
  seen: () => number;
} {
  const counters = new Map<string, number>();
  const taken = new Set<string>();
  let total = 0;

  const reserve = (base: string): string => {
    total += 1;
    let used = counters.get(base) ?? 0;
    let candidate = base;
    while (taken.has(candidate)) {
      used += 1;
      candidate = `${base}-${used}`;
    }
    counters.set(base, used);
    taken.add(candidate);
    return candidate;
  };

  return {
    assign: (text: string): string => reserve(slugifyHeading(text)),
    reserve,
    seen: (): number => total
  };
}

/** 大纲必须来自统一 AST，不得由导航模块重新解析 Markdown（§12.2）。 */
export function extractOutline(document: MarkdownDocument): OutlineItem[] {
  const outline: OutlineItem[] = [];
  const walk = (node: MarkdownNode): void => {
    if (node.type === "heading") {
      const title = textOf(node);
      const anchor = node.attributes?.["anchor"];
      outline.push({
        id: node.id,
        title,
        level: readNumber(node, "level") ?? 1,
        anchor: typeof anchor === "string" ? anchor : slugifyHeading(title),
        ...(node.position ? { position: node.position } : {})
      });
      return;
    }
    for (const child of node.children ?? []) {
      walk(child);
    }
  };
  for (const child of document.children) {
    walk(child);
  }
  return outline;
}
