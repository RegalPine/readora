/**
 * 消息信封与响应模型。
 *
 * 权威来源：ARC-004 §8.2（MessageEnvelope / MessageResponse）。
 * 注意：响应字段为 `payload`（ARC-004 口径），IMP-001 §11.2 的 `data`
 * 为早期草案写法，按治理规则以 ARC-004 为准。
 */

export interface MessageEnvelope<T = unknown> {
  id: string;
  type: string;
  version: 1;
  payload: T;
}

export interface MessageError {
  code: string;
  message: string;
}

export interface MessageResponse<T = unknown> {
  id: string;
  success: boolean;
  payload?: T;
  error?: MessageError;
}

/** 协议版本常量（ARC-004 §8.2：version 固定为 1）。 */
export const PROTOCOL_VERSION = 1 as const;

/** 信封字段长度上限（IMP-001 §11.4：字符串长度必须校验）。 */
export const ENVELOPE_ID_MAX_LENGTH = 128;
export const ENVELOPE_TYPE_MAX_LENGTH = 128;

/**
 * 文档文本上限（M1 工程基线）。
 * Host 在创建面板之前预校验，超限文档早报、不留空白面板
 * （ARC-004 §8.7 第 4 条）。M2 接入 ARC-002 大文档降级策略时对齐。
 */
export const DOCUMENT_TEXT_MAX_LENGTH = 2_000_000;

/** 统一错误码（ARC-004 §8.5：处理失败必须返回统一错误结构）。 */
export const READORA_ERROR_CODES = {
  INVALID_MESSAGE: "readora.message.invalid",
  UNSUPPORTED_MESSAGE: "readora.message.unsupported",
  INVALID_PAYLOAD: "readora.payload.invalid",
  DOCUMENT_TOO_LARGE: "readora.document.tooLarge",
  DOCUMENT_UNREADABLE: "readora.document.unreadable",
  DOCUMENT_DELETED: "readora.document.deleted",
  LINK_REJECTED: "readora.link.rejected",
  // 资源解析（ARC-008 §12.5）：五码分工，denied 与 notFound 必须可区分，
  // 否则用户看不出「文件不存在」和「策略不允许读」。
  RESOURCE_NOT_FOUND: "readora.resource.notFound",
  RESOURCE_DENIED: "readora.resource.denied",
  RESOURCE_TOO_LARGE: "readora.resource.tooLarge",
  RESOURCE_UNSUPPORTED: "readora.resource.unsupported",
  RESOURCE_UNREADABLE: "readora.resource.unreadable",
  TARGET_INVALID: "readora.target.invalid",
  // Wiki Link（STORY-06-03）：`[[Note]]` 没有扩展名，Host 要补 .md / .markdown 两个
  // 候选再判存在性。全部落空时报这一码而不是 readora.resource.notFound ——
  // 用户写下的是 `[[Note]]`，日志里说「找不到 Note」才对得上他看到的字面量。
  WIKILINK_MISSING: "readora.wikilink.missing",
  // 自定义 CSS（F08-011）：拒绝整段注入是策略判断，不是资源读取失败，
  // 因此与 readora.resource.* 分开，用户日志里要能一眼看出「你的 CSS 被拒了」。
  CUSTOM_CSS_REJECTED: "readora.custom-css.rejected",
  // 导出（M11）：三码分工。失败与「找不到浏览器」必须可区分 —— 前者用户
  // 会重试，后者要么去装 Chrome 要么去填 readora.export.chromePath。
  // 用户在保存对话框里取消**不是错误**，不占错误码。
  EXPORT_FAILED: "readora.export.failed",
  EXPORT_BROWSER_NOT_FOUND: "readora.export.browserNotFound",
  EXPORT_TOO_LARGE: "readora.export.tooLarge",
  // 编辑写回（F12 / ARC-009 §5.3）：三码分工，因为用户的下一步动作各不相同 ——
  // stale 是「源文件在我们不知道的时候变了，重新同步后再改」；rangeInvalid 是
  // 「你手里那个编辑把手对应的源行范围已经不存在了，把手作废」；applyFailed 是
  // 「宿主拒绝了这次修改（文件只读、被锁、模型已释放）」。合成一码会让用户
  // 去重试一个重试不了的操作，或者以为改动没生效而白改一遍。
  EDIT_STALE: "readora.edit.stale",
  EDIT_RANGE_INVALID: "readora.edit.rangeInvalid",
  EDIT_APPLY_FAILED: "readora.edit.applyFailed",
  INTERNAL: "readora.internal"
} as const;

export type ReadoraErrorCode =
  (typeof READORA_ERROR_CODES)[keyof typeof READORA_ERROR_CODES];
