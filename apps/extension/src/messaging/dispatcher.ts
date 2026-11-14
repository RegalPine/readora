/**
 * 入站消息路由（ARC-004 §8.4 / §8.5）。
 *
 * 流程：信封校验 → 方向检查（只接受 view-to-host）→ 处理器查找
 * （未注册返回统一 unsupported）→ payload Schema 校验 → 执行。
 * 任何一步失败都返回统一错误响应，绝不静默吞掉。
 */
import {
  MESSAGE_REGISTRY,
  READORA_ERROR_CODES,
  createErrorResponse,
  createValidatedSuccessResponse,
  parsePayload,
  validateEnvelope,
  type MessageResponse,
  type MessageType
} from "@readora/contracts";
import { ReaderError } from "../errors";

export interface DispatchContext {
  sessionId: string;
  messageId: string;
}

export type MessageHandler = (
  payload: unknown,
  context: DispatchContext
) => unknown | Promise<unknown>;

function extractRawId(raw: unknown): string | null {
  if (typeof raw === "object" && raw !== null && "id" in raw) {
    const id = (raw as { id: unknown }).id;
    if (typeof id === "string" && id.length > 0 && id.length <= 128) {
      return id;
    }
  }
  return null;
}

export class MessageDispatcher {
  private readonly handlers = new Map<MessageType, MessageHandler>();

  register(type: MessageType, handler: MessageHandler): void {
    this.handlers.set(type, handler);
  }

  async dispatch(
    raw: unknown,
    context: DispatchContext
  ): Promise<MessageResponse<unknown>> {
    const envelope = validateEnvelope(raw);
    if (!envelope) {
      return createErrorResponse(
        extractRawId(raw) ?? context.messageId,
        READORA_ERROR_CODES.INVALID_MESSAGE,
        "Message envelope failed validation."
      );
    }

    const definition = MESSAGE_REGISTRY[envelope.type];
    if (definition.direction !== "view-to-host") {
      return createErrorResponse(
        envelope.id,
        READORA_ERROR_CODES.UNSUPPORTED_MESSAGE,
        `Message "${envelope.type}" is host-to-view and cannot be sent by the webview.`
      );
    }

    const handler = this.handlers.get(envelope.type);
    if (!handler) {
      return createErrorResponse(
        envelope.id,
        READORA_ERROR_CODES.UNSUPPORTED_MESSAGE,
        `No handler registered for "${envelope.type}".`
      );
    }

    const parsed = parsePayload<unknown>(envelope.type, envelope.payload);
    if (!parsed.ok) {
      return createErrorResponse(envelope.id, parsed.error.code, parsed.error.message);
    }

    try {
      const result = await handler(parsed.value, {
        sessionId: context.sessionId,
        messageId: envelope.id
      });
      // 带结构化载荷的响应在出口处再过一次契约（ARC-008 §16.1 第 10 条）。
      return createValidatedSuccessResponse(envelope.type, envelope.id, result);
    } catch (error) {
      if (error instanceof ReaderError) {
        return createErrorResponse(envelope.id, error.code, error.message);
      }
      return createErrorResponse(
        envelope.id,
        READORA_ERROR_CODES.INTERNAL,
        error instanceof Error ? error.message : "Unknown handler failure."
      );
    }
  }
}