/**
 * HTML 文本转义（ARC-002 §8.3「代码内容必须进行 HTML 转义」的通用底座）。
 */

const ESCAPE_MAP: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;"
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ESCAPE_MAP[character] ?? character);
}

/** 属性值转义：与文本转义同口径，调用方负责加引号。 */
export function escapeAttribute(value: string): string {
  return escapeHtml(value);
}
