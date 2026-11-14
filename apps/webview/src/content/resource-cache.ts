/**
 * 资源解析请求层（ARC-008 §8 / §16.1 第 10 条）。
 *
 * Webview 永远不拼路径、不猜本地位置：只把文档内原样引用交给 Host，
 * 由 Host 做解析、授权与 asWebviewUri。本层负责三件事：
 * 1. 同一引用的并发请求合并（in-flight Map），一张图重复扫到只发一次；
 * 2. 响应复判：Host 消息不可信，载荷必须过 ResourceResolveResultSchema，
 *    不合契约一律降级为 missing（绝不把未校验字段直接写进 DOM）；
 * 3. 把 Host 的错误码还原成可展示的原因。
 */
import {
  READORA_ERROR_CODES,
  ResourceResolveResultSchema,
  type ResourceKind,
  type ResourceResolveResult
} from "@readora/contracts";

export type ResourceEntry =
  | { ok: true; result: ResourceResolveResult }
  | { ok: false; code: string; message: string };

/** 只用到 request 能力，便于与 HostBridge 解耦（ARC-005 §6）。 */
export interface ResourceRequester {
  request(type: "resource.resolve", payload: unknown): Promise<unknown>;
}

const ERROR_CODE_PATTERN = /^(readora\.[a-zA-Z][a-zA-Z0-9.]*):/;

/**
 * HostBridge 把失败响应 reject 成 `Readora: <code>: <message>`，
 * 这里只认已知前缀，取不到就归 unreadable —— 不猜、不静默成功。
 */
export function parseResourceFailure(error: unknown): { code: string; message: string } {
  const raw = error instanceof Error ? error.message : String(error ?? "unknown");
  const withoutPrefix = raw.startsWith("Readora: ") ? raw.slice("Readora: ".length) : raw;
  const match = ERROR_CODE_PATTERN.exec(withoutPrefix);
  if (match) {
    return { code: match[1] ?? READORA_ERROR_CODES.RESOURCE_UNREADABLE, message: withoutPrefix };
  }
  return { code: READORA_ERROR_CODES.RESOURCE_UNREADABLE, message: withoutPrefix };
}

function contractViolation(): ResourceEntry {
  return {
    ok: false,
    code: READORA_ERROR_CODES.RESOURCE_UNREADABLE,
    message: "Host response did not match the resource contract."
  };
}

export class ResourceRequestCache {
  private readonly inflight = new Map<string, Promise<ResourceEntry>>();

  constructor(
    private readonly requester: ResourceRequester,
    private readonly documentUri: string
  ) {}

  get pendingCount(): number {
    return this.inflight.size;
  }

  private static key(reference: string, kind: ResourceKind): string {
    return `${kind}\u0000${reference}`;
  }

  /** 同一引用（含 kind）只问 Host 一次；结果在 clear() 前复用。 */
  resolve(reference: string, kind: ResourceKind = "image"): Promise<ResourceEntry> {
    const key = ResourceRequestCache.key(reference, kind);
    const existing = this.inflight.get(key);
    if (existing) {
      return existing;
    }
    const request = this.requester
      .request("resource.resolve", {
        documentUri: this.documentUri,
        reference,
        kind
      })
      .then((payload): ResourceEntry => {
        const parsed = ResourceResolveResultSchema.safeParse(payload);
        return parsed.success ? { ok: true, result: parsed.data } : contractViolation();
      })
      .catch((error: unknown): ResourceEntry => {
        const failure = parseResourceFailure(error);
        return { ok: false, ...failure };
      });
    this.inflight.set(key, request);
    // 请求结束后仍保留结果：结果与内容版本挂钩，只在正文重写时统一清理。
    return request;
  }

  /** 正文重写 / 文档切换：丢弃全部结果，下次扫描重新问 Host（改图能刷新的前提）。 */
  clear(): void {
    this.inflight.clear();
  }

  invalidate(reference: string, kind: ResourceKind = "image"): void {
    this.inflight.delete(ResourceRequestCache.key(reference, kind));
  }
}
