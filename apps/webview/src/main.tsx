/**
 * Webview 入口（ARC-005 §3）。
 * Bridge 在此创建并注入 App / ErrorBoundary，保证单例与可测试性。
 */
// 必须排在所有会拉起契约 Schema 的 import 之前：zod 在构造 object 解析器时探测
// 「能不能把字符串编译成代码」，严格 CSP 下那次探测会被浏览器记成一笔违规。
// side-effect 模块是唯一能表达「先于 import 求值」的位置，函数调用太晚了。
import "@readora/contracts/strict-csp";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import { ErrorBoundary } from "./app/ErrorBoundary";
import { HostBridge } from "./bridge/host-bridge";
import { getVsCodeApi } from "./bridge/vscode-api";
// 样式分层引入，顺序即层叠顺序（PRD-003 §13.4）：字体与 token 在最前，浮层在最后。
// KaTeX 的样式固定占最底层第一格（IMP-001 §10.3 / PRD-003 §13.4 不变量）：它只定义
// .katex 系列类的排版，任何 readora 自有样式都应当能覆盖它，所以必须在八条自有样式之前。
import "katex/dist/katex.min.css";
import "./styles/fonts.css";
import "./styles/tokens.css";
import "./styles/tailwind.css";
import "./styles/base.css";
import "./styles/markdown.css";
import "./styles/components.css";
import "./styles/shell.css";
import "./styles/lightbox-search.css";
import "./styles/edit-help.css";

const container = document.getElementById("root");
if (!container) {
  throw new Error("Readora: #root container not found.");
}

const bridge = new HostBridge(getVsCodeApi(), window);

createRoot(container).render(
  <StrictMode>
    <ErrorBoundary bridge={bridge}>
      <App bridge={bridge} />
    </ErrorBoundary>
  </StrictMode>
);