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

/** URI path 形态的盘符绝对路径：`/C:/x`（前导斜杠是 URI 语法，不属于文件系统）。 */
const URI_DRIVE_PATH = /^\/([A-Za-z]:)(\/.*)?$/u;

/**
 * URI path → 操作系统路径（boundary 递给 node:fs 之前的唯一一次转换）。
 *
 * 解析层一律在 URI 空间工作（`/C:/x`），这一步是它唯一的出口：把 URI 形态直接交给
 * `node:fs` 在 Windows 上是 `ENOENT`——那多出来的前导斜杠
 * 会被当作「当前盘根下的 `C:` 目录」，realpath 一失败就只能按未验证路径拒绝，
 * 本地图片在 Windows 上全灭。POSIX 上 `/x` 本来就是真路径，原样递下去。
 *
 * 只去前导斜杠、不把分隔符改成反斜杠：node 在 Windows 上两种分隔符都认，
 * 而分隔符形状交给宿主与 `node:path` 才是它的归属。
 */
export function toSystemPath(
  uriPath: string,
  isWindows: boolean = process.platform === "win32"
): string {
  if (!isWindows) {
    return uriPath;
  }
  const drive = URI_DRIVE_PATH.exec(uriPath);
  return drive ? `${drive[1]}${drive[2] ?? ""}` : uriPath;
}

/** 盘符段：`C:` / `c:`，只在路径第一段出现。 */
const DRIVE_SEGMENT = /^[A-Za-z]:$/u;

/**
 * 包含判断用的段序列。
 *
 * 盘符是唯一被刻意放宽的一段：同一个卷在 Windows 上可以写作 `C:` 也可以 `c:`，
 * 而文档 URI 里的形状由宿主给、realpath 结果里的形状由文件系统给，两边不必一致。
 * 折叠只把「同一个卷」判成同一段，不会把别的卷或别的主机带进根内；
 * 其余段仍按大小写敏感比较 —— 宁可多拒，不可多放行。
 */
export function pathSegments(path: string): string[] {
  const normalized = normalizeDirectory(path);
  const segments = normalized.split("/").filter((segment) => segment.length > 0);
  const head = segments[0];
  if (head !== undefined && DRIVE_SEGMENT.test(head)) {
    segments[0] = head.toLowerCase();
  }
  return segments;
}

/** candidate 是否等于 root 或位于 root 之下（按段比较；除盘符外区分大小写）。 */
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
  /**
   * 注入以便单测；生产传 node:fs realpath。
   * 入参已是操作系统路径（`toSystemPath` 转过），实现方不必再懂 URI 语法。
   * 失败视为无法验证。
   */
  realpath(path: string): Promise<string>;
}

/**
 * 两级校验：
 * 1) 解析出的绝对路径必须落在授权根内；
 * 2) realpath 后的真实路径仍须落在同一批根内（挡符号链接逃逸）。
 *
 * 根与 candidate 都在 URI path 空间比较，只有递给 `realpath` 的那一步跳到操作系统
 * 空间；realpath 的回执再用 `normalizeDirectory` 收回来（反斜杠归一为 `/`），
 * 两道校验才不会因为分隔符形状不统一而把合法路径拒在门外。
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
    canonical = normalizeDirectory(await options.realpath(toSystemPath(filePath)));
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
