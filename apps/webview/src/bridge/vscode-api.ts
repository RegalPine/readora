/**
 * acquireVsCodeApi 单例封装（ARC-005 §5）。
 *
 * VS Code 只允许调用一次 acquireVsCodeApi；
 * 非 Webview 环境（如误在浏览器打开）立即报错，不静默降级。
 */

export interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

let cached: VsCodeApi | undefined;

export function getVsCodeApi(): VsCodeApi {
  if (!cached) {
    if (typeof acquireVsCodeApi !== "function") {
      throw new Error(
        "Readora: acquireVsCodeApi is unavailable; the reader must run inside a VS Code webview."
      );
    }
    cached = acquireVsCodeApi();
  }
  return cached;
}