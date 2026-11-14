/**
 * 授权根与符号链接逃逸防护（ARC-008 §5.1 / §5.2）。
 *
 * 授权根 = 文档所在目录 + 包含该文档的 workspace folder。
 * 只给 docDir 会拒掉 ARC-008 §5.1 明确要求支持的 `../assets/logo.png`
 * （文档在 docs/ 下、图片在仓库根的 assets/ 下），所以两个根必须并存。
 *
 * 包含判断一律按路径**段**比较：`/readora-docs` 不是 `/readora` 的子目录，
 * 字符串前缀比较会把它放行。
 */
import * as vscode from "vscode";
import { posix } from "node:path";

/** 规范化：去掉尾部分隔符、折叠重复分隔符、归一 `.` 段。 */
export function normalizeDirectory(path: string): string {
  const normalized = posix.normalize(path.replace(/\\/g, "/"));
  if (normalized.length <= 1) {
    return "/";
  }
  return normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}

export function pathSegments(path: string): string[] {
  const normalized = normalizeDirectory(path);
  return normalized.split("/").filter((segment) => segment.length > 0);
}

/** candidate 是否等于 root 或位于 root 之下（按段比较，区分大小写）。 */
export function isInside(candidatePath: string, rootPath: string): boolean {
  const candidate = pathSegments(candidatePath);
  const root = pathSegments(rootPath);
  if (root.length === 0) {
    // 根目录 "/" 包含一切绝对路径。
    return candidate.length > 0;
  }
  if (candidate.length < root.length) {
    return false;
  }
  for (let index = 0; index < root.length; index += 1) {
    if (candidate[index] !== root[index]) {
      return false;
    }
  }
  return true;
}

export function isInsideAny(candidatePath: string, roots: readonly string[]): boolean {
  return roots.some((root) => isInside(candidatePath, root));
}

/** 包含该文档的 workspace folder（可能不存在：单文件打开）。 */
export function containingWorkspaceFolder(
  documentPath: string,
  workspaceFolders: readonly string[]
): string | null {
  let best: string | null = null;
  for (const folder of workspaceFolders) {
    const normalized = normalizeDirectory(folder);
    if (!isInside(documentPath, normalized)) {
      continue;
    }
    if (best === null || normalized.length > best.length) {
      best = normalized;
    }
  }
  return best;
}

/**
 * 文档可用的授权根集合。
 * 顺序即优先级：docDir 在前，workspace folder 在后，去重后返回。
 */
export function authorizedRoots(
  documentUri: string,
  workspaceFolders: readonly string[]
): string[] {
  const parsed = vscode.Uri.parse(documentUri);
  if (parsed.scheme !== "file" || parsed.path.length === 0) {
    return [];
  }
  const roots: string[] = [normalizeDirectory(posix.dirname(parsed.path))];
  const folder = containingWorkspaceFolder(parsed.path, workspaceFolders);
  if (folder && !roots.includes(folder)) {
    roots.push(folder);
  }
  return roots;
}

export type BoundaryReason = "outside-roots" | "symlink-escape";

export type BoundaryOutcome =
  | { ok: true; canonicalPath: string }
  | { ok: false; reason: BoundaryReason; message: string };

export interface BoundaryOptions {
  /** 注入以便单测；生产传 node:fs realpath。失败视为无法验证。 */
  realpath(path: string): Promise<string>;
}

/**
 * 两级校验：
 * 1) 解析出的绝对路径必须落在授权根内；
 * 2) realpath 后的真实路径仍须落在同一批根内（挡符号链接逃逸）。
 */
export async function verifyBoundary(
  filePath: string,
  documentUri: string,
  workspaceFolders: readonly string[],
  options: BoundaryOptions
): Promise<BoundaryOutcome> {
  const roots = authorizedRoots(documentUri, workspaceFolders);
  const target = normalizeDirectory(filePath);
  if (roots.length === 0 || !isInsideAny(target, roots)) {
    return {
      ok: false,
      reason: "outside-roots",
      message: "The resource is outside the permitted roots."
    };
  }
  let canonical: string;
  try {
    canonical = normalizeDirectory(await options.realpath(filePath));
  } catch {
    // 无法确认真实路径时按越权处理：宁可拒绝，不可放行未验证的路径。
    return {
      ok: false,
      reason: "symlink-escape",
      message: "The resource could not be canonicalized; access was denied."
    };
  }
  if (!isInsideAny(canonical, roots)) {
    return {
      ok: false,
      reason: "symlink-escape",
      message: "The resource resolves through a link that leaves the permitted roots."
    };
  }
  return { ok: true, canonicalPath: canonical };
}
