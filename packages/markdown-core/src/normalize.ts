/**
 * P01 Source Normalizer（ARC-002 §2.2）。
 *
 * 只做不影响 CommonMark 语义的标准化：
 * - 去 BOM；
 * - CRLF / CR → LF；
 * - 清理除 \t \n 之外的 C0 控制字符与孤立的 \u0000（避免属性注入与解析异常）。
 *
 * 刻意不裁剪行尾空白：CommonMark 用行尾两个及以上空格表示硬换行（§7.2 换行支持），
 * 裁剪会改变文档语义。
 */

const BOM = /^\uFEFF/;
const CRLF = /\r\n?/g;
// eslint-disable-next-line no-control-regex -- 目的正是剔除控制字符
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

export function normalizeSource(source: string): string {
  return source.replace(BOM, "").replace(CRLF, "\n").replace(CONTROL_CHARS, "");
}

/**
 * 真实行数：文件末尾的换行不额外产生一行。
 * 供 AST 根节点计算 endLine，避免「最后一行了无内容却被计入位置」。
 */
export function countSourceLines(text: string): number {
  if (text.length === 0) {
    return 1;
  }
  const body = text.endsWith("\n") ? text.slice(0, -1) : text;
  return body.split("\n").length;
}
