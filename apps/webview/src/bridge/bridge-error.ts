/**
 * Host 桥错误码的还原（ARC-005 §6 / ARC-009 §5.3）。
 *
 * `HostBridge.request` 把失败响应 reject 成一条 `Error`，消息形状固定是
 * `Readora: <code>: <message>`（`host-bridge.ts` 的 `entry.reject`）。这个形状在
 * E1 之前只有一处消费方（资源解析），解析逻辑就住在那一层里；E2 的编辑冲突需要
 * 按三枚错误码分支，于是把它提出来共用。
 *
 * 刻意**不改** `HostBridge` 的 reject 消息格式，也不改成 reject 一个带 `code`
 * 字段的自定义 Error：那个格式已有别的调用方按串解析（资源降级提示直接把它当
 * 原因文案显示），改格式是跨层破坏，收益只是省一个正则。
 */

/** reject 消息的固定前缀。 */
export const BRIDGE_ERROR_PREFIX = "Readora: ";

/** 只认 `readora.` 打头的码，其余一律当没有码（不猜）。 */
const ERROR_CODE_PATTERN = /^(readora\.[a-zA-Z][a-zA-Z0-9.]*):/u;

export interface BridgeErrorParts {
  code: string;
  message: string;
}

/**
 * 从 reject 出来的 unknown 里取 `{code, message}`。
 *
 * 取不到码就用调用方给的 `fallback`：资源侧的兜底是 `resource.unreadable`，
 * 编辑侧的兜底是 `edit.applyFailed` —— 两者语义不同（「读不到」与「写不进」），
 * 所以兜底必须由调用方交出，这层不替它们决定。
 *
 * `message` 交出的是**去掉前缀之后的整串**（含码本身），与提取前的
 * `parseResourceFailure` 逐字节一致：降级提示把这串直接显示给用户，改它会改文案。
 */
export function bridgeErrorParts(error: unknown, fallbackCode: string): BridgeErrorParts {
  const raw = error instanceof Error ? error.message : String(error ?? "unknown");
  const withoutPrefix = raw.startsWith(BRIDGE_ERROR_PREFIX)
    ? raw.slice(BRIDGE_ERROR_PREFIX.length)
    : raw;
  const match = ERROR_CODE_PATTERN.exec(withoutPrefix);
  return { code: match?.[1] ?? fallbackCode, message: withoutPrefix };
}

/** 只要错误码的场合。 */
export function bridgeErrorCode(error: unknown, fallbackCode: string): string {
  return bridgeErrorParts(error, fallbackCode).code;
}
