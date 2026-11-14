/**
 * AST 节点读取辅助：attributes 是弱类型容器（ARC-002 §4.3），
 * 统一在此收口类型判定，渲染器不得自行 as 断言。
 */
import type { MarkdownNode } from "./types";

export function readString(node: MarkdownNode, key: string): string | undefined {
  const value = node.attributes?.[key];
  return typeof value === "string" ? value : undefined;
}

export function readNonEmpty(node: MarkdownNode, key: string): string | undefined {
  const value = readString(node, key);
  return value && value.length > 0 ? value : undefined;
}

export function readNumber(node: MarkdownNode, key: string): number | undefined {
  const value = node.attributes?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function readBoolean(node: MarkdownNode, key: string): boolean | undefined {
  const value = node.attributes?.[key];
  return typeof value === "boolean" ? value : undefined;
}

/** 递归收集节点纯文本（用于大纲标题与 aria-label），不解析 HTML。 */
export function textOf(node: MarkdownNode): string {
  if (!node.children || node.children.length === 0) {
    return node.value ?? "";
  }
  return node.children.map(textOf).join("");
}
