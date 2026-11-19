/**
 * 资源解析服务（ARC-008 §7 / §9，IMP-002 TASK-08-01）。
 *
 * 一次 resolve 的固定顺序，任何一步不过即返回对应错误码，绝不部分放行：
 * 外部引用判定 → 引用解析 → 授权根与符号链接 → 策略/MIME → stat（存在/大小）
 * → 缓存命中 → 组装 ResourceResolveResult。
 *
 * 缓存只存 Host 侧事实（本地 URI、mtime、size、MIME、resourceId），
 * 不存 webviewUri：asWebviewUri 的结果按面板隔离，跨会话复用会把
 * A 面板的授权前缀发给 B 面板。
 */
import * as vscode from "vscode";
import { createHash } from "node:crypto";
import {
  READORA_ERROR_CODES,
  type ReadoraErrorCode,
  type ResourceKind,
  type ResourceResolveResult
} from "@readora/contracts";
import { canonicalFileUri, contentVersion, versionedFileUri, type ResourceStamp } from "./webview-uri";
import { resourceCacheKey, ResourceCache } from "./cache";
import { verifyBoundary } from "./boundary";
import {
  classifyExternalReference,
  decideExternalReference,
  decideMimeType,
  type ResourcePolicy
} from "./resource-policy";
import { resolveReference } from "./path-resolver";

export interface ResourceStat extends ResourceStamp {
  readonly isFile: boolean;
}

export interface ResourceServicePorts {
  policy(): ResourcePolicy;
  /** 文件不存在返回 null；读取失败抛错（映射为 unreadable）。 */
  stat(uri: vscode.Uri): Promise<ResourceStat | null>;
  /** 同上口径读字节：缺失返回 null，失败抛错。M11 导出内联的唯一字节出口。 */
  readFile(uri: vscode.Uri): Promise<Uint8Array | null>;
  realpath(path: string): Promise<string>;
  workspaceFolders(): readonly string[];
}

export interface ResolveRequest {
  readonly documentUri: string;
  readonly reference: string;
  readonly kind: ResourceKind;
  /** 当前会话面板的 URI 转换器；由调用方注入，本模块不碰 panel。 */
  asWebviewUri(uri: vscode.Uri): string;
}

export type ResourceFailure = { ok: false; code: ReadoraErrorCode; message: string };

export type ResourceResolveOutcome =
  | { ok: true; result: ResourceResolveResult }
  | ResourceFailure;

/** 跨文档跳转的结果：给 Host 用的本地 file: URI，绝不给 Webview 回传路径。 */
export type DocumentTargetOutcome = { ok: true; uri: vscode.Uri } | ResourceFailure;

/**
 * 导出内联的结果：MIME 与 base64，**不含任何路径**（ARC-008 §7.3 同一口径）。
 * 交付物要的是能自包含的字节，本地路径在这里一次都不该出现。
 */
export type InlineReadOutcome =
  | { ok: true; mimeType: string; base64: string }
  | ResourceFailure;

interface ResolvedRecord extends ResourceStamp {
  readonly fileUri: string;
  readonly mimeType: string;
  readonly resourceId: string;
}

function fail(code: ReadoraErrorCode, message: string): ResourceFailure {
  return { ok: false, code, message };
}

/** 稳定资源标识：只暴露摘要，不暴露本地绝对路径（ARC-008 §7.3）。 */
export function computeResourceId(canonicalPath: string): string {
  return `res-${createHash("sha256").update(canonicalPath).digest("hex").slice(0, 16)}`;
}

/**
 * wiki 引用的扩展名候选（STORY-06-03）。
 *
 * 判据是**最后一段是个纯名字**：既不带点（`Note` 而不是 `logo.png` / `a.md` /
 * `archive.tar.gz`），也不带查询串或锚点（`Note?x` / `Note#intro`）。
 * 带点的引用都是作者已经点名的文件，不该被补成 `logo.png.md`；带 `?`/`#` 的
 * 引用会被 resolveReference 先剥掉后缀部分，补出来的候选绕回同一个路径，
 * 白问文件系统不说，还会把普通相对链接的错误码改成 wiki 专用的那一个。
 *
 * 这一条区分的是「文档名」与「文件名」：拿它去试所有引用会把非 Markdown
 * 资源的错误码也一起改掉（有用例锁住）。代价是笔记名里带点（`Note.v2`）时
 * 不会被补候选 —— 它按原文去找 `Note.v2`，找不到就报 notFound。
 */
export function markdownCandidates(reference: string): string[] {
  const last = reference.split(/[\\/]/).pop() ?? "";
  // 带查询串或锚点的引用不是一个「笔记名」：resolveReference 会先把它们剥掉，
  // 于是补出的候选（`Note#intro.md`）剥完又回到同一个路径，白问两遍文件系统，
  // 还会把一条普通相对链接的错误码改成 wiki 专用的那一个。
  if (last.includes("?") || last.includes("#")) {
    return [];
  }
  const bare = last.trim();
  if (bare.length === 0 || bare.includes(".")) {
    return [];
  }
  return [`${reference}.md`, `${reference}.markdown`];
}

type Plan = { ok: true; record: ResolvedRecord; uri: vscode.Uri } | ResourceFailure;

export class ResourceService {
  private readonly cache = new ResourceCache<ResolvedRecord>();

  constructor(private readonly ports: ResourceServicePorts) {}

  get cacheSize(): number {
    return this.cache.size;
  }

  /** session / 扩展释放时调用：不保留任何跨会话的解析结果。 */
  clearCache(): void {
    this.cache.clear();
  }

  async resolve(request: ResolveRequest): Promise<ResourceResolveOutcome> {
    const planned = await this.plan(request);
    if (!planned.ok) {
      return planned;
    }
    const { record } = planned;
    const stamp: ResourceStamp = { mtimeMs: record.mtimeMs, size: record.size };
    const uri = versionedFileUri(vscode.Uri.parse(record.fileUri), stamp);
    return {
      ok: true,
      result: {
        resourceId: record.resourceId,
        webviewUri: request.asWebviewUri(uri),
        mimeType: record.mimeType,
        kind: request.kind,
        byteSize: record.size,
        version: contentVersion(stamp)
      }
    };
  }

  /**
   * 导出内联用的读取（M11）：**复用同一条 plan**，只把出口从「一个 URI」换成「base64」。
   *
   * 这是刻意的：屏上能显示什么，导出件就能带什么，反之亦然。另开一条「直接按路径读
   * 字节」的通道等于把外部引用判定、授权根、realpath、MIME 白名单与大小上限这五道
   * 闸门全部绕开，而「导出比屏上多能读东西」是安全语义上的倒退。
   * 失败时原样回传 plan 的错误码（denied / unsupported / tooLarge / notFound），
   * 由调用方决定是保留占位卡还是报错 —— 本层不翻译语义。
   */
  async readInline(request: {
    documentUri: string;
    reference: string;
    kind: ResourceKind;
  }): Promise<InlineReadOutcome> {
    const planned = await this.plan(request);
    if (!planned.ok) {
      return planned;
    }
    let bytes: Uint8Array | null;
    try {
      bytes = await this.ports.readFile(planned.uri);
    } catch (error) {
      return fail(
        READORA_ERROR_CODES.RESOURCE_UNREADABLE,
        `The resource could not be read: ${error instanceof Error ? error.message : "unknown failure"}`
      );
    }
    if (!bytes) {
      return fail(
        READORA_ERROR_CODES.RESOURCE_NOT_FOUND,
        `Resource not found: ${shortName(request.reference)}`
      );
    }
    return {
      ok: true,
      mimeType: planned.record.mimeType,
      base64: Buffer.from(bytes).toString("base64")
    };
  }

  /**
   * 跨文档跳转用的解析（kind=document）：只回本地 URI，不生成 webviewUri ——
   * 文档内容必须走 Host 的 readSnapshot，不能让 Webview 拿 URL 自行取字节。
   *
   * M6（STORY-06-03）起补 wiki 引用候选：`[[Note]]` 按 Obsidian 口径不带扩展名，
   * 而「以当前文档目录为基准 + 存在性检查」正是本方法已有的能力，于是候选
   * 只是把同一套 plan 跑第二遍（`Note.md` → `Note.markdown`），不新开解析通道。
   *
   * 补不补候选由 `markdownCandidates` 决定，而它只对「最后一段不带点」的引用
   * 说话。因此这里的两条出口各有明确语义：带扩展名的普通相对链接原样返回自己的
   * 错误码（`nope.md` 是 notFound、`logo.png` 是 unsupported，都不被改写）；
   * 不带点的 wiki 名原文那一试必然落空（无扩展名的文件过不了 document 的
   * MIME 判定），紧接着才轮到候选。
   */
  async resolveDocument(request: {
    documentUri: string;
    reference: string;
  }): Promise<DocumentTargetOutcome> {
    const planned = await this.plan({ ...request, kind: "document" });
    if (planned.ok) {
      return { ok: true, uri: planned.uri };
    }
    const candidates = markdownCandidates(request.reference);
    if (candidates.length === 0) {
      return planned;
    }
    // 「不给读 / 读不了 / 超限」类判定与扩展名无关：换个后缀再问一遍只会把
    // 同一条拒绝刷成第二条日志，也不会改变结论。只有「这个位置不是可读的
    // Markdown 文档」（不存在，或存在但扩展名不认识）才值得补候选 —— 后者
    // 正是 `[[Note]]` 撞上同名的无扩展名文件时的情形，此时 Note.md 该赢。
    if (
      planned.code !== READORA_ERROR_CODES.RESOURCE_NOT_FOUND &&
      planned.code !== READORA_ERROR_CODES.RESOURCE_UNSUPPORTED
    ) {
      return planned;
    }
    for (const candidate of candidates) {
      const attempt = await this.plan({
        documentUri: request.documentUri,
        reference: candidate,
        kind: "document"
      });
      if (attempt.ok) {
        return { ok: true, uri: attempt.uri };
      }
      // 权限与大小类失败不再往下试候选：那是「这个位置不给读」的判定，
      // 换个扩展名重问一遍只会把同一条拒绝刷成两条日志。
      if (attempt.code !== READORA_ERROR_CODES.RESOURCE_NOT_FOUND) {
        return attempt;
      }
    }
    return fail(
      READORA_ERROR_CODES.WIKILINK_MISSING,
      `No Markdown document matches [[${request.reference}]] (tried ${[
        request.reference,
        ...candidates
      ].join(", ")}).`
    );
  }

  /** 完整校验链；kind 决定是否允许非 Markdown 载荷。 */
  private async plan(request: {
    documentUri: string;
    reference: string;
    kind: ResourceKind;
  }): Promise<Plan> {
    const policy = this.ports.policy();

    const external = classifyExternalReference(request.reference);
    if (external !== null) {
      const decision = decideExternalReference(policy, request.reference);
      if (!decision.allowed) {
        return fail(READORA_ERROR_CODES.RESOURCE_DENIED, decision.reason);
      }
      // 策略放行但 M3 不抓取远端字节：诚实声明能力边界，不假装成功。
      return fail(
        READORA_ERROR_CODES.RESOURCE_UNSUPPORTED,
        `Resolving ${external} references on the host side is not delivered in M3.`
      );
    }

    const resolved = resolveReference(
      { documentUri: request.documentUri },
      request.reference
    );
    if (!resolved.ok) {
      if (resolved.reason === "absolute") {
        return fail(READORA_ERROR_CODES.RESOURCE_DENIED, resolved.message);
      }
      return fail(READORA_ERROR_CODES.RESOURCE_UNSUPPORTED, resolved.message);
    }
    if (!policy.allowWorkspaceResources) {
      return fail(
        READORA_ERROR_CODES.RESOURCE_DENIED,
        "Workspace resource access is disabled by readora.resources.allowWorkspaceResources."
      );
    }

    const target = canonicalFileUri(resolved.uri);

    // 顺序即错误码语义：先确认「是否存在」（notFound），再确认「是否有权读」
    // （denied），最后才是大小/类型限制。反过来会让缺失的图片报成越权。
    let stat: ResourceStat | null;
    try {
      stat = await this.ports.stat(target);
    } catch (error) {
      return fail(
        READORA_ERROR_CODES.RESOURCE_UNREADABLE,
        `The resource could not be read: ${error instanceof Error ? error.message : "unknown failure"}`
      );
    }
    if (!stat || !stat.isFile) {
      return fail(
        READORA_ERROR_CODES.RESOURCE_NOT_FOUND,
        `Resource not found: ${shortName(request.reference)}`
      );
    }

    // boundary 一定在缓存查询之前：键不含文档作用域，
    // 命中缓存也不得复用「另一个文档根」下得出的授权结论。
    const boundary = await verifyBoundary(
      target.path,
      request.documentUri,
      this.ports.workspaceFolders(),
      { realpath: this.ports.realpath }
    );
    if (!boundary.ok) {
      return fail(READORA_ERROR_CODES.RESOURCE_DENIED, boundary.message);
    }

    const mimeDecision = decideMimeType(policy, target.fsPath, request.kind);
    if (!mimeDecision.allowed) {
      // 扩展名/类别不认识属能力边界；被策略显式关掉的属授权拒绝。
      return fail(
        mimeDecision.denial === "unsupported"
          ? READORA_ERROR_CODES.RESOURCE_UNSUPPORTED
          : READORA_ERROR_CODES.RESOURCE_DENIED,
        mimeDecision.reason
      );
    }

    if (stat.size > policy.maxResourceSize) {
      return fail(
        READORA_ERROR_CODES.RESOURCE_TOO_LARGE,
        `Resource is ${stat.size} bytes, above the ${policy.maxResourceSize} byte limit.`
      );
    }

    const key = resourceCacheKey({
      uri: target.toString(),
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      policyVersion: policy.version
    });
    const hit = this.cache.get(key);
    if (hit) {
      return { ok: true, record: hit, uri: target };
    }
    const record: ResolvedRecord = {
      fileUri: target.toString(),
      mimeType: mimeDecision.mimeType,
      resourceId: computeResourceId(boundary.canonicalPath),
      mtimeMs: stat.mtimeMs,
      size: stat.size
    };
    this.cache.set(key, record);
    return { ok: true, record, uri: target };
  }
}

function shortName(reference: string): string {
  const trimmed = reference.trim();
  const index = trimmed.lastIndexOf("/");
  return index === -1 ? trimmed : trimmed.slice(index + 1);
}
