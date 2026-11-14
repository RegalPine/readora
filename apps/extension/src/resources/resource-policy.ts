/**
 * 资源策略（ARC-008 §6.2，IMP-002 TASK-08-03）。
 *
 * 取值只来自 Host 配置：文档正文里的属性、Front Matter、链接文本
 * 都没有改变策略的通道，Webview 侧也不接受「请求即授权」。
 * M3 默认只放行工作区内的本地位图与 Markdown，外部图片与 data: 一律拦。
 */
import type { ResourceKind } from "@readora/contracts";

/** 位图大小上限默认值（readora.resources.maxImageSizeMb）。 */
export const DEFAULT_MAX_IMAGE_MB = 10;
/** 配置允许取值区间（manifest 与代码双向锁定，越界回退默认值）。 */
export const MAX_IMAGE_MB_RANGE = { min: 1, max: 50 } as const;

export const BYTES_PER_MB = 1024 * 1024;

/** 位图白名单（image/svg+xml 受 allowSvg 单独控制）。 */
export const IMAGE_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/svg+xml"
] as const;

/** document kind 只允许 Markdown 本身，跨文档跳转不得变成读源码文件。 */
export const DOCUMENT_MIME_TYPES = ["text/markdown"] as const;

const MIME_BY_EXTENSION: ReadonlyMap<string, string> = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".svg", "image/svg+xml"],
  [".md", "text/markdown"],
  [".markdown", "text/markdown"]
]);

export interface ResourcePolicy {
  /** 工作区内本地资源总开关；关闭时只拒绝一切本地解析请求。 */
  readonly allowWorkspaceResources: boolean;
  /** 外部（http/https）图片自动加载：M3 默认关闭且不在交付范围。 */
  readonly allowExternalImages: boolean;
  /** data: URI 图片：默认关闭（可内联任意内容，属高风险面）。 */
  readonly allowDataImages: boolean;
  /** 本地 SVG：允许解析，但永远以 <img> 语境加载，绝不内联。 */
  readonly allowSvg: boolean;
  /** 单资源字节上限（由 maxImageSizeMb 换算）。 */
  readonly maxResourceSize: number;
  readonly allowedMimeTypes: readonly string[];
  /** 缓存键组成部分：策略变化后旧缓存必须失效。 */
  readonly version: string;
}

export interface ResourcePolicyInput {
  readonly allowWorkspaceResources?: boolean;
  readonly allowExternalImages?: boolean;
  readonly allowDataImages?: boolean;
  readonly allowSvg?: boolean;
  readonly maxImageSizeMb?: number;
}

function clampMb(raw: number | undefined): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return DEFAULT_MAX_IMAGE_MB;
  }
  return Math.min(MAX_IMAGE_MB_RANGE.max, Math.max(MAX_IMAGE_MB_RANGE.min, raw));
}

function mimeTypesFor(allowSvg: boolean): readonly string[] {
  const images = allowSvg
    ? IMAGE_MIME_TYPES
    : IMAGE_MIME_TYPES.filter((mime) => mime !== "image/svg+xml");
  return [...images, ...DOCUMENT_MIME_TYPES];
}

/** 构造策略：所有越界/缺失输入都回退到安全默认（拒绝多于放行）。 */
export function createResourcePolicy(input: ResourcePolicyInput = {}): ResourcePolicy {
  const allowSvg = input.allowSvg ?? true;
  const allowedMimeTypes = mimeTypesFor(allowSvg);
  const policy: ResourcePolicy = {
    allowWorkspaceResources: input.allowWorkspaceResources ?? true,
    allowExternalImages: input.allowExternalImages ?? false,
    allowDataImages: input.allowDataImages ?? false,
    allowSvg,
    maxResourceSize: clampMb(input.maxImageSizeMb) * BYTES_PER_MB,
    allowedMimeTypes,
    version: ""
  };
  return { ...policy, version: policyVersion(policy) };
}

function policyVersion(policy: ResourcePolicy): string {
  const flags = [
    policy.allowWorkspaceResources ? "ws" : "no-ws",
    policy.allowExternalImages ? "ext" : "no-ext",
    policy.allowDataImages ? "data" : "no-data",
    policy.allowSvg ? "svg" : "no-svg"
  ].join(".");
  return `${flags}/${policy.maxResourceSize.toString(36)}/${policy.allowedMimeTypes
    .map((mime) => mime.replace(/^image\//, "i:").replace(/^text\//, "t:"))
    .join(",")}`;
}

/** 扩展名 → MIME；未知扩展名返回 null（等同不支持）。 */
export function mimeTypeForPath(fsPath: string): string | null {
  const lower = fsPath.toLowerCase();
  const dot = lower.lastIndexOf(".");
  if (dot === -1) {
    return null;
  }
  const slash = Math.max(lower.lastIndexOf("/"), lower.lastIndexOf("\\"));
  if (dot < slash) {
    return null;
  }
  return MIME_BY_EXTENSION.get(lower.slice(dot)) ?? null;
}

/**
 * unsupported = 不认识这种载荷（能力边界）；
 * denied = 认识但策略不放行（授权边界）。错误码映射依赖这个区分。
 */
export type MimeTypeDecision =
  | { allowed: true; mimeType: string }
  | { allowed: false; mimeType: string | null; denial: "unsupported" | "denied"; reason: string };

/** kind + 扩展名 + 策略白名单三重判定，任一不过即拒。 */
export function decideMimeType(
  policy: ResourcePolicy,
  fsPath: string,
  kind: ResourceKind
): MimeTypeDecision {
  const mimeType = mimeTypeForPath(fsPath);
  if (!mimeType) {
    return {
      allowed: false,
      mimeType: null,
      denial: "unsupported",
      reason: `Unsupported file extension for "${shortName(fsPath)}".`
    };
  }
  const expected: readonly string[] =
    kind === "document" ? DOCUMENT_MIME_TYPES : IMAGE_MIME_TYPES;
  if (!expected.includes(mimeType)) {
    return {
      allowed: false,
      mimeType,
      denial: "unsupported",
      reason:
        kind === "document"
          ? `Only Markdown documents can be opened in the reader (got ${mimeType}).`
          : `MIME type ${mimeType} is not an accepted image type.`
    };
  }
  if (!policy.allowedMimeTypes.includes(mimeType)) {
    return {
      allowed: false,
      mimeType,
      denial: "denied",
      reason: `${mimeType} is disabled by the resource policy.`
    };
  }
  return { allowed: true, mimeType };
}

/** 非本地引用（http/https/data）的分类；本地相对引用返回 null。 */
export function classifyExternalReference(
  reference: string
): "external" | "data" | null {
  const value = reference.trim();
  if (/^data:/i.test(value)) {
    return "data";
  }
  if (/^https?:\/\//i.test(value) || /^\/\//i.test(value)) {
    return "external";
  }
  return null;
}

export type ExternalDecision = { allowed: true } | { allowed: false; reason: string };

/**
 * 外部引用的策略判定。即使 Webview 已按 kind 短路成 blocked，
 * Host 仍要独立拒绝一次：Webview 消息不可信（ARC-008 §16.1 第 10 条）。
 */
export function decideExternalReference(
  policy: ResourcePolicy,
  reference: string
): ExternalDecision {
  const kind = classifyExternalReference(reference);
  if (kind === null) {
    return { allowed: true };
  }
  if (kind === "data") {
    return policy.allowDataImages
      ? { allowed: true }
      : {
          allowed: false,
          reason: "data: resources are blocked by readora.resources.allowDataImages."
        };
  }
  return policy.allowExternalImages
    ? { allowed: true }
    : {
        allowed: false,
        reason: "Remote images are blocked by readora.resources.allowExternalImages."
      };
}

function shortName(fsPath: string): string {
  const index = Math.max(fsPath.lastIndexOf("/"), fsPath.lastIndexOf("\\"));
  return index === -1 ? fsPath : fsPath.slice(index + 1);
}
