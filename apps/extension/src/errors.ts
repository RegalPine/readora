/**
 * Host 侧统一业务错误（ARC-004 §8.5：处理失败必须返回统一错误结构）。
 * 错误码取自 contracts 的 READORA_ERROR_CODES，不得自造字符串。
 */
import type { ReadoraErrorCode } from "@readora/contracts";

export class ReaderError extends Error {
  readonly code: ReadoraErrorCode;

  constructor(code: ReadoraErrorCode, message: string) {
    super(message);
    this.name = "ReaderError";
    this.code = code;
  }
}

export function toErrorMessage(error: unknown): string {
  if (error instanceof ReaderError) {
    return `Readora: ${error.message}`;
  }
  if (error instanceof Error) {
    return `Readora: ${error.message}`;
  }
  return "Readora: an unexpected error occurred.";
}