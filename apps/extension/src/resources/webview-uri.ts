/**
 * Webview 资源 URI（ARC-008 §7.3）。
 *
 * 两件事必须同时成立：
 * 1. 本地绝对路径不出 Host —— Webview 只拿到 asWebviewUri 后的 https: 形态；
 * 2. 改图要能刷新 —— query 里带 mtime-size 版本号，URI 变了浏览器缓存才不命中。
 *    VS Code 的 webview 资源处理器按 URI 寻址，不比较文件内容，
 *    所以版本号必须进 URI 本身，而不是靠额外的 cache-busting 参数。
 */
import * as vscode from "vscode";

export interface ResourceStamp {
  readonly mtimeMs: number;
  readonly size: number;
}

/** 版本号：截断到整数毫秒 + 字节数，稳定且可读。 */
export function contentVersion(stamp: ResourceStamp): string {
  return `${Math.trunc(stamp.mtimeMs).toString(36)}-${Math.trunc(stamp.size).toString(36)}`;
}

/** 带版本号的本地 URI（Host 侧使用，绝不外发）。 */
export function versionedFileUri(uri: vscode.Uri, stamp: ResourceStamp): vscode.Uri {
  return uri.with({ query: contentVersion(stamp), fragment: "" });
}

export interface WebviewUriTarget {
  asWebviewUri(uri: vscode.Uri): vscode.Uri;
}

/** 外发给 Webview 的最终 URI 字符串。 */
export function asWebviewResourceUri(
  target: WebviewUriTarget,
  uri: vscode.Uri,
  stamp: ResourceStamp
): string {
  return target.asWebviewUri(versionedFileUri(uri, stamp)).toString();
}

/** 去掉 query / fragment，得到可作缓存键前缀的规范化 URI。 */
export function canonicalFileUri(uri: vscode.Uri): vscode.Uri {
  return uri.with({ query: "", fragment: "" });
}
