/**
 * Host Bridge（ARC-005 §6 / ARC-004 §8）。
 *
 * - request：信封 id 关联响应，超时拒绝（默认 10s）；
 * - notify：即发即忘（reader.ready / state.save / reader.error）；
 * - subscribe：只接收注册表内 host-to-view 消息，payload 经 Schema 校验；
 * - 非法信封与方向不符的消息一律丢弃。
 *
 * 依赖（api / 消息源）全部注入，可在 node 环境独立单测。
 */
import {
  createEnvelope,
  MessageResponseSchema,
  MESSAGE_REGISTRY,
  parsePayload,
  validateEnvelope,
  type MessageType
} from "@readora/contracts";
import type { VsCodeApi } from "./vscode-api";

export interface MessageSource {
  addEventListener(
    type: "message",
    listener: (event: { data: unknown }) => void
  ): void;
  removeEventListener(
    type: "message",
    listener: (event: { data: unknown }) => void
  ): void;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export const REQUEST_TIMEOUT_MS = 10_000;

export class HostBridge {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly subscribers = new Map<
    MessageType,
    Set<(payload: unknown) => void>
  >();
  private readonly listener = (event: { data: unknown }): void => {
    this.handleIncoming(event.data);
  };
  private counter = 0;
  private disposed = false;

  constructor(
    private readonly api: VsCodeApi,
    private readonly source: MessageSource
  ) {
    source.addEventListener("message", this.listener);
  }

  private nextId(): string {
    this.counter += 1;
    return `view-${Date.now().toString(36)}-${this.counter.toString(36)}`;
  }

  /** 请求-响应：id 关联，超时拒绝。 */
  request<T>(
    type: MessageType,
    payload: unknown,
    timeoutMs: number = REQUEST_TIMEOUT_MS
  ): Promise<T> {
    const envelope = createEnvelope(type, payload, this.nextId());
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(envelope.id);
        reject(new Error(`Readora: request "${type}" timed out.`));
      }, timeoutMs);
      this.pending.set(envelope.id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer
      });
      this.api.postMessage(envelope);
    });
  }

  /** 即发即忘通知。 */
  notify(type: MessageType, payload: unknown): void {
    this.api.postMessage(createEnvelope(type, payload, this.nextId()));
  }

  /** 订阅 host-to-view 消息；返回取消订阅函数。 */
  subscribe<T>(type: MessageType, handler: (payload: T) => void): () => void {
    let handlers = this.subscribers.get(type);
    if (!handlers) {
      handlers = new Set();
      this.subscribers.set(type, handlers);
    }
    const wrapped = handler as (payload: unknown) => void;
    handlers.add(wrapped);
    return () => {
      handlers.delete(wrapped);
    };
  }

  private handleIncoming(raw: unknown): void {
    if (this.disposed) {
      return;
    }

    // 响应分支：按 success 字段识别，Schema 校验后按 id 关联。
    if (typeof raw === "object" && raw !== null && "success" in raw) {
      const parsed = MessageResponseSchema.safeParse(raw);
      if (!parsed.success) {
        return;
      }
      const response = parsed.data;
      const entry = this.pending.get(response.id);
      if (!entry) {
        return;
      }
      this.pending.delete(response.id);
      clearTimeout(entry.timer);
      if (response.success) {
        entry.resolve(response.payload);
      } else {
        const detail = response.error
          ? `${response.error.code}: ${response.error.message}`
          : "request failed";
        entry.reject(new Error(`Readora: ${detail}`));
      }
      return;
    }

    // 通知分支：信封校验 + 方向检查 + payload 校验。
    const envelope = validateEnvelope(raw);
    if (!envelope) {
      return;
    }
    if (MESSAGE_REGISTRY[envelope.type].direction !== "host-to-view") {
      return;
    }
    const parsed = parsePayload<unknown>(envelope.type, envelope.payload);
    if (!parsed.ok) {
      return;
    }
    const handlers = this.subscribers.get(envelope.type);
    if (!handlers) {
      return;
    }
    for (const handler of [...handlers]) {
      handler(parsed.value);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.source.removeEventListener("message", this.listener);
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error("Readora: bridge disposed."));
    }
    this.pending.clear();
    this.subscribers.clear();
  }
}