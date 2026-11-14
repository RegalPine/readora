/**
 * 相对引用解析（ARC-008 §5.3 / §5.4，IMP-002 TASK-08-01-01）。
 *
 * 一律用 URI 的 path 做定位，不做字符串拼路径后再 parse：
 * 空格、Unicode、URL 编码在 URI 语义下才有唯一解释。
 *
 * 关于 `..`：ARC-008 §5.1 明确要求 `../assets/logo.png` 这类
 * 「文档目录之上、工作区之内」的引用必须能解析，因此本模块不禁止 `..`，
 * 而是先解码归一、再交给 boundary 判定是否越出授权根。
 * 编码穿越（`%2e%2e%2f`、双重编码）在解码后与明文 `../` 走同一条路，
 * 不存在「绕过检查」的第二条通道。
 */
import * as vscode from "vscode";
import { posix } from "node:path";

/** 带 scheme 的绝对引用（http:、file:、data: 等）。 */
const SCHEME_PREFIX = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
/** 协议相对引用：//host/path，等价于外链。 */
const PROTOCOL_RELATIVE = /^\/\//;
/** 仅锚点：#heading，属站内跳转，不是资源。 */
const FRAGMENT_ONLY = /^#/;

export type ReferenceRejectionReason =
  | "empty"
  | "fragment-only"
  | "absolute"
  | "undecodable"
  | "outside-document";

export interface ReferenceContext {
  /** 当前文档的绝对 URI 字符串（Host 侧来源，不经 Webview 拼接）。 */
  readonly documentUri: string;
}

export type ReferenceOutcome =
  | { ok: true; uri: vscode.Uri; reference: string }
  | { ok: false; reason: ReferenceRejectionReason; message: string };

function reject(reason: ReferenceRejectionReason, message: string): ReferenceOutcome {
  return { ok: false, reason, message };
}

/** 引用是否自带 scheme（file:/http:/data: 等）；协议相对 //host/x 也算绝对。 */
export function isAbsoluteReference(reference: string): boolean {
  const value = reference.trim();
  return SCHEME_PREFIX.test(value) || PROTOCOL_RELATIVE.test(value);
}

/** 只解码一次：双重编码（%252e）解码后是字面量 %2e，会被当作文件名本身。 */
export function decodeReference(raw: string): string | null {
  if (!raw.includes("%")) {
    return raw;
  }
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

/** 去掉引用自带的 query / fragment：它们不参与文件系统定位。 */
function stripQueryAndFragment(reference: string): string {
  const hashIndex = reference.indexOf("#");
  const head = hashIndex === -1 ? reference : reference.slice(0, hashIndex);
  const queryIndex = head.indexOf("?");
  return queryIndex === -1 ? head : head.slice(0, queryIndex);
}

/** 文档所在目录；无法解析（非 file: / 无路径）时返回 null。 */
export function documentDirectory(documentUri: string): vscode.Uri | null {
  const parsed = vscode.Uri.parse(documentUri);
  if (parsed.scheme !== "file" || parsed.path.length === 0) {
    return null;
  }
  const directory = posix.dirname(parsed.path);
  if (directory === "." || directory.length === 0) {
    return null;
  }
  return parsed.with({ path: directory, query: "", fragment: "" });
}

/**
 * 把文档内引用解析为绝对 file: URI。
 *
 * 拒绝清单（返回 ok:false，由调用方映射错误码）：
 * 空引用、仅锚点、带 scheme 的绝对引用、协议相对引用、解码失败、非 file 文档。
 */
export function resolveReference(
  context: ReferenceContext,
  rawReference: string
): ReferenceOutcome {
  const reference = rawReference.trim();
  if (reference.length === 0) {
    return reject("empty", "Resource reference is empty.");
  }
  if (FRAGMENT_ONLY.test(reference)) {
    return reject("fragment-only", "Anchor-only references are not resources.");
  }
  if (SCHEME_PREFIX.test(reference) || PROTOCOL_RELATIVE.test(reference)) {
    return reject(
      "absolute",
      "Absolute references are resolved by the link policy, not the resource resolver."
    );
  }
  const decoded = decodeReference(stripQueryAndFragment(reference));
  if (decoded === null) {
    return reject("undecodable", "Resource reference contains invalid percent-encoding.");
  }
  const base = documentDirectory(context.documentUri);
  if (!base) {
    return reject("outside-document", "The current document has no local directory.");
  }
  // 反斜杠按分隔符处理：..\x 会归一成 ../x，随后由 boundary 判定是否越界。
  const segments = decoded.replace(/\\/g, "/");
  const joined = posix.normalize(`${base.path}/${segments}`);
  if (!joined.startsWith("/")) {
    return reject("outside-document", "Resolved path escaped the document root.");
  }
  return { ok: true, uri: base.with({ path: joined, query: "", fragment: "" }), reference };
}
