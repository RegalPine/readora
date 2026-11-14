/**
 * 扩展输出通道（PRD-001 F11-013 / F11-014）。
 *
 * 之前 Host 侧只用 `console.error` / `console.warn`：用户在 VS Code 里看不到
 * 任何 Readora 日志（输出面板里没有它的条目），激活异常、消息校验失败、
 * 自定义 CSS 被拒都成了静默失败。本模块把这些收敛到一个命名通道
 * `Readora`，同时承载 F11-014 的渲染指标。
 *
 * 三条口径：
 * 1. 通道懒创建 + 不自动 `show()`：激活时抢焦点的下方面板比静默失败更烦人；
 * 2. 每行 `<ISO 时间> [级别] 代码: 消息`，指标行固定 `metric` 前缀便于 grep；
 * 3. 通道写入失败（宿主 API 异常）不得反噬调用方，一律吞掉。
 */
import * as vscode from "vscode";
import { READORA_PRODUCT_NAME } from "./constants";

export const DIAGNOSTIC_LEVELS = ["info", "warn", "error", "metric"] as const;
export type DiagnosticLevel = (typeof DIAGNOSTIC_LEVELS)[number];

/** 已写入的行，供测试断言（真实通道里就是面板内容，无需另存）。 */
export interface DiagnosticsSink {
  readonly channelName: string;
  info(code: string, message: string): void;
  warn(code: string, message: string): void;
  error(code: string, message: string): void;
  /** F11-014：一条命名指标，字段以 `key=value` 平铺。 */
  metric(name: string, fields: Record<string, string | number>): void;
  dispose(): void;
}

function format(level: DiagnosticLevel, code: string, message: string): string {
  return `${new Date().toISOString()} [${level}] ${code}: ${message}`;
}

function flatten(fields: Record<string, string | number>): string {
  return Object.entries(fields)
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");
}

/**
 * 真实宿主实现：`window.createOutputChannel`。
 * 无头测试里由 `__stubs__/vscode.ts` 的同名 API 承接，行会落进 `outputLines`。
 */
export function createDiagnostics(
  name: string = READORA_PRODUCT_NAME
): DiagnosticsSink {
  let channel: vscode.OutputChannel | undefined;
  const append = (line: string): void => {
    try {
      channel ??= vscode.window.createOutputChannel(name);
      channel.appendLine(line);
    } catch {
      // 输出通道本身故障不能升级成阅读器不可用。
    }
  };
  return {
    channelName: name,
    info: (code, message) => append(format("info", code, message)),
    warn: (code, message) => append(format("warn", code, message)),
    error: (code, message) => append(format("error", code, message)),
    metric: (name2, fields) =>
      append(format("metric", name2, flatten(fields))),
    dispose(): void {
      channel?.dispose();
      channel = undefined;
    }
  };
}
