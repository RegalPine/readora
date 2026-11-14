/**
 * @readora/contracts 公共入口。
 *
 * Host 与 Webview 引用同一套协议定义（IMP-002 STORY-01-02）；
 * 本包不依赖任何 apps 包、VS Code API 或 Node.js 内置模块。
 */
export * from "./envelope";
export * from "./message-types";
export * from "./schemas";
export * from "./protocol";
