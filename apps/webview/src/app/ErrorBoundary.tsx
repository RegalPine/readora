/**
 * 渲染错误边界（ARC-005 §7）：捕获渲染异常并经 reader.error 上报 Host，
 * 展示降级提示而不是白屏。
 */
import { Component, type ErrorInfo, type ReactNode } from "react";
import type { HostBridge } from "../bridge/host-bridge";

interface ErrorBoundaryProps {
  bridge: HostBridge;
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    const stack = error.stack ?? info.componentStack ?? null;
    this.props.bridge.notify("reader.error", {
      code: "readora.webview.render",
      message: (error.message || "Unknown render error").slice(0, 2048),
      stack: stack ? stack.slice(0, 8192) : null
    });
  }

  override render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="readora-error" role="alert">
          <h1>Readora hit a rendering error</h1>
          <p>{this.state.error.message}</p>
        </div>
      );
    }
    return this.props.children;
  }
}