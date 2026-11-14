/**
 * 图表错误模型与转换（ARC-003 §10.1 / §10.2 / §10.3）。
 *
 * 引擎原始异常不得直达用户：本模块把任意 unknown 异常收敛成
 * 带分类、带位置、不含堆栈的 DiagramError，再派生诊断码。
 */
import type { DiagramDiagnostic, DiagramError, DiagramErrorKind } from "./types";

/** 诊断错误码（与 markdown-core 的 readora.render.* 命名同构）。 */
export const DIAGRAM_ERROR_CODES = {
  SYNTAX: "readora.diagram.syntax",
  UNSUPPORTED: "readora.diagram.unsupported",
  NOT_REGISTERED: "readora.diagram.not-registered",
  OVER_LIMIT: "readora.diagram.over-limit",
  SECURITY: "readora.diagram.security",
  RUNTIME: "readora.diagram.runtime"
} as const;

export type DiagramErrorCode = (typeof DIAGRAM_ERROR_CODES)[keyof typeof DIAGRAM_ERROR_CODES];

/** SVG 安全处理失败：必须走错误态，绝不回退未经验证的插入（ARC-003 §9.3）。 */
export class DiagramSecurityError extends Error {
  readonly kind = "security" as const;

  constructor(message: string) {
    super(message);
    this.name = "DiagramSecurityError";
  }
}

/** 源码超限。 */
export class DiagramLimitError extends Error {
  readonly kind = "over-limit" as const;

  constructor(message: string) {
    super(message);
    this.name = "DiagramLimitError";
  }
}

/** 识别得出类型但本产品未启用该类型。 */
export class DiagramNotRegisteredError extends Error {
  readonly kind = "unsupported" as const;

  constructor(readonly diagramType: string) {
    super(`Diagram type "${diagramType}" is not enabled in this reader.`);
    this.name = "DiagramNotRegisteredError";
  }
}

/**
 * Adapter 向上层传递渲染失败时使用的载体：结构化成因随异常一起走，
 * 避免只留一句 message 让上层无法分类（ARC-003 §10.1）。
 */
export class DiagramRenderError extends Error {
  constructor(readonly detail: DiagramError) {
    super(detail.message);
    this.name = "DiagramRenderError";
  }
}

const KIND_TO_CODE: Record<DiagramErrorKind, DiagramErrorCode> = {
  syntax: DIAGRAM_ERROR_CODES.SYNTAX,
  unsupported: DIAGRAM_ERROR_CODES.UNSUPPORTED,
  "over-limit": DIAGRAM_ERROR_CODES.OVER_LIMIT,
  security: DIAGRAM_ERROR_CODES.SECURITY,
  layout: DIAGRAM_ERROR_CODES.RUNTIME,
  resource: DIAGRAM_ERROR_CODES.RUNTIME,
  runtime: DIAGRAM_ERROR_CODES.RUNTIME
};

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return "Diagram rendering failed.";
}

/**
 * 引擎错误的鸭子类型识别：只读 code / line / column，不 import 引擎类型，
 * 因此 diagram-core 的非 Adapter 模块可以独立单测（IMP-001 §9.3）。
 */
export function toDiagramError(error: unknown): DiagramError {
  if (error instanceof DiagramRenderError) {
    // Adapter 已经归过分层，二次转换必须保持成因不变。
    return error.detail;
  }
  if (error instanceof DiagramSecurityError) {
    return { kind: "security", message: error.message };
  }
  if (error instanceof DiagramLimitError) {
    return { kind: "over-limit", message: error.message };
  }
  if (error instanceof DiagramNotRegisteredError) {
    return {
      kind: "unsupported",
      code: DIAGRAM_ERROR_CODES.NOT_REGISTERED,
      message: error.message
    };
  }

  const record = (typeof error === "object" && error !== null ? error : {}) as Record<
    string,
    unknown
  >;
  const line = readNumber(record["line"]);
  const column = readNumber(record["column"]);
  const position =
    line === undefined && column === undefined
      ? undefined
      : { ...(line === undefined ? {} : { line }), ...(column === undefined ? {} : { column }) };

  switch (record["code"]) {
    // 引擎把「语法能过但语义不成立」单列，对用户而言同属源码问题，共用一套错误卡。
    case "syntax":
    case "semantic":
      return { kind: "syntax", message: messageOf(error), ...(position ? { source: position } : {}) };
    case "unsupported-diagram":
      return {
        kind: "unsupported",
        message: messageOf(error),
        ...(position ? { source: position } : {})
      };
    case "limit":
      return { kind: "over-limit", message: messageOf(error) };
    default:
      return { kind: "runtime", message: messageOf(error), ...(position ? { source: position } : {}) };
  }
}

export function toDiagramDiagnostic(error: DiagramError): DiagramDiagnostic {
  const code = error.code ?? KIND_TO_CODE[error.kind];
  return {
    code,
    severity: error.kind === "unsupported" ? "warning" : "error",
    message: error.message.slice(0, 240),
    ...(error.source ? { source: error.source } : {})
  };
}
