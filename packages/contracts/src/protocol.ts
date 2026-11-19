/**
 * 消息注册表与校验入口（ARC-004 §8.4 路由 / §8.5 处理约束）。
 *
 * 消息类型必须在注册表中定义；payload 必须经过 Schema 校验；
 * 未注册类型返回统一 unsupported 错误，不接受动态执行。
 */
import type { z } from "zod";
import {
  PROTOCOL_VERSION,
  type MessageEnvelope,
  type MessageError,
  type MessageResponse,
  READORA_ERROR_CODES
} from "./envelope";
import {
  MESSAGE_DIRECTIONS,
  isMessageType,
  type MessageDirection,
  type MessageType
} from "./message-types";
import {
  ConfigPatchPayloadSchema,
  ConfigUpdatePayloadSchema,
  DocumentLoadPayloadSchema,
  DocumentNavigatePayloadSchema,
  DocumentOpenPayloadSchema,
  DocumentUpdatePayloadSchema,
  ExportCapturePayloadSchema,
  ExportDataPayloadSchema,
  ExportRequestPayloadSchema,
  MessageEnvelopeSchema,
  MetricsReportPayloadSchema,
  ReaderErrorPayloadSchema,
  ReaderReadyPayloadSchema,
  ResourceResolvePayloadSchema,
  ResourceResolveResultSchema,
  StateRestorePayloadSchema,
  StateSavePayloadSchema,
  ThemeUpdatePayloadSchema,
  ViewStatePayloadSchema
} from "./schemas";

export interface MessageDefinition {
  direction: MessageDirection;
  payloadSchema: z.ZodType;
}

/** 权威注册表：17 条消息（ARC-004 §8.3 的 11 条 + M4/M6 补设 3 条 + M11 补设 3 条）逐一定义方向与 payload Schema。 */
export const MESSAGE_REGISTRY: Record<MessageType, MessageDefinition> = {
  "reader.ready": {
    direction: MESSAGE_DIRECTIONS["reader.ready"],
    payloadSchema: ReaderReadyPayloadSchema
  },
  "document.load": {
    direction: MESSAGE_DIRECTIONS["document.load"],
    payloadSchema: DocumentLoadPayloadSchema
  },
  "document.update": {
    direction: MESSAGE_DIRECTIONS["document.update"],
    payloadSchema: DocumentUpdatePayloadSchema
  },
  "document.open": {
    direction: MESSAGE_DIRECTIONS["document.open"],
    payloadSchema: DocumentOpenPayloadSchema
  },
  "document.navigate": {
    direction: MESSAGE_DIRECTIONS["document.navigate"],
    payloadSchema: DocumentNavigatePayloadSchema
  },
  // resource.resolve：view-to-host 请求，成功响应载荷另见 RESPONSE_PAYLOAD_SCHEMAS。
  "resource.resolve": {
    direction: MESSAGE_DIRECTIONS["resource.resolve"],
    payloadSchema: ResourceResolvePayloadSchema
  },
  "theme.update": {
    direction: MESSAGE_DIRECTIONS["theme.update"],
    payloadSchema: ThemeUpdatePayloadSchema
  },
  "config.update": {
    direction: MESSAGE_DIRECTIONS["config.update"],
    payloadSchema: ConfigUpdatePayloadSchema
  },
  // config.patch：M6 补设的 View → Host 偏好写回通道（Reader Settings 弹层）。
  "config.patch": {
    direction: MESSAGE_DIRECTIONS["config.patch"],
    payloadSchema: ConfigPatchPayloadSchema
  },
  // metrics.report：M6 补设的 View → Host 只读指标上报（F11-014），Host 不回复。
  "metrics.report": {
    direction: MESSAGE_DIRECTIONS["metrics.report"],
    payloadSchema: MetricsReportPayloadSchema
  },
  "state.save": {
    direction: MESSAGE_DIRECTIONS["state.save"],
    payloadSchema: StateSavePayloadSchema
  },
  "state.restore": {
    direction: MESSAGE_DIRECTIONS["state.restore"],
    payloadSchema: StateRestorePayloadSchema
  },
  "reader.error": {
    direction: MESSAGE_DIRECTIONS["reader.error"],
    payloadSchema: ReaderErrorPayloadSchema
  },
  // reader.viewState：M4 补设的 Host → View 视图状态通道（依据 ARC-004 §6.2 推导，见 message-types 偏差说明）。
  "reader.viewState": {
    direction: MESSAGE_DIRECTIONS["reader.viewState"],
    payloadSchema: ViewStatePayloadSchema
  },
  // export.*：M11 补设的导出通道（顶栏菜单/命令面板 → 保存对话框 → View 交回正文）。
  // export.data 的成功响应刻意留空载荷（与 metrics.report 同一口径）：导出结果由 Host
  // 自己的通知告诉用户，不往 View 回传文件路径。
  "export.request": {
    direction: MESSAGE_DIRECTIONS["export.request"],
    payloadSchema: ExportRequestPayloadSchema
  },
  "export.capture": {
    direction: MESSAGE_DIRECTIONS["export.capture"],
    payloadSchema: ExportCapturePayloadSchema
  },
  "export.data": {
    direction: MESSAGE_DIRECTIONS["export.data"],
    payloadSchema: ExportDataPayloadSchema
  }
};

export type ValidatedEnvelope = MessageEnvelope & { type: MessageType };

/**
 * 校验入站信封：结构 + 版本 + 类型注册表。
 * 非法消息返回 null，由调用方拒绝（ARC-004 §8.4 Reject Message）。
 */
export function validateEnvelope(raw: unknown): ValidatedEnvelope | null {
  const parsed = MessageEnvelopeSchema.safeParse(raw);
  if (!parsed.success) {
    return null;
  }
  const envelope = parsed.data;
  if (!isMessageType(envelope.type)) {
    return null;
  }
  return { ...envelope, type: envelope.type };
}

export type PayloadResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: MessageError };

/** 按注册表校验 payload（strict Schema，拒绝未知字段与越界值）。 */
export function parsePayload<T>(
  type: MessageType,
  payload: unknown
): PayloadResult<T> {
  const definition = MESSAGE_REGISTRY[type];
  const parsed = definition.payloadSchema.safeParse(payload);
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        code: READORA_ERROR_CODES.INVALID_PAYLOAD,
        message: `Invalid payload for ${type}: ${parsed.error.issues
          .map((issue) => issue.message)
          .join("; ")}`
      }
    };
  }
  return { ok: true, value: parsed.data as T };
}

let envelopeCounter = 0;

/** 构造出站信封（Host 与 Webview 共用；id 关联请求与响应）。 */
export function createEnvelope<T>(
  type: MessageType,
  payload: T,
  id?: string
): MessageEnvelope<T> {
  envelopeCounter += 1;
  return {
    id: id ?? `msg-${Date.now().toString(36)}-${envelopeCounter.toString(36)}`,
    type,
    version: PROTOCOL_VERSION,
    payload
  };
}

export function createSuccessResponse<T>(
  id: string,
  payload?: T
): MessageResponse<T> {
  return payload === undefined
    ? { id, success: true }
    : { id, success: true, payload };
}

export function createErrorResponse(
  id: string,
  code: string,
  message: string
): MessageResponse<never> {
  return { id, success: false, error: { code, message } };
}

/**
 * 响应载荷注册表：请求方向的消息里只有 resource.resolve 带结构化
 * 成功载荷，Host 发送前必须过一遍（ARC-008 §16.1 第 10 条：Webview 侧还要再复判一次）。
 */
export const RESPONSE_PAYLOAD_SCHEMAS: Partial<
  Record<MessageType, z.ZodType>
> = {
  "resource.resolve": ResourceResolveResultSchema
};

/**
 * 构造已校验的成功响应：载荷不合契约时返回错误响应，
 * 让「Host 自己发错」在出口处就被挡住，而不是留给 Webview 兜底。
 */
export function createValidatedSuccessResponse<T>(
  type: MessageType,
  id: string,
  payload: T
): MessageResponse<T> {
  const schema = RESPONSE_PAYLOAD_SCHEMAS[type];
  if (!schema) {
    return createSuccessResponse(id, payload);
  }
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    return createErrorResponse(
      id,
      READORA_ERROR_CODES.INVALID_PAYLOAD,
      `Invalid response payload for ${type}: ${parsed.error.issues
        .map((issue) => issue.message)
        .join("; ")}`
    );
  }
  return createSuccessResponse(id, payload);
}
