/**
 * 命令目标解析（ARC-004 §4.2 / §4.4）。
 *
 * explorer 上下文传入 Uri 优先；editor 上下文回退活动编辑器；
 * 非 Markdown 目标一律拒绝（TARGET_INVALID 由调用方提示）。
 */
import * as vscode from "vscode";
import { MARKDOWN_EXTENSIONS, MARKDOWN_LANGUAGE_ID } from "../constants";

export function isMarkdownPath(fsPath: string): boolean {
  const lower = fsPath.toLowerCase();
  return MARKDOWN_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

export interface CommandTarget {
  uri: vscode.Uri;
  source: "explorer" | "editor";
}

function isUriLike(value: unknown): value is vscode.Uri {
  return (
    typeof value === "object" &&
    value !== null &&
    "scheme" in value &&
    "fsPath" in value &&
    typeof (value as { scheme: unknown }).scheme === "string"
  );
}

export function isMarkdownDocument(document: vscode.TextDocument): boolean {
  return (
    document.languageId === MARKDOWN_LANGUAGE_ID ||
    isMarkdownPath(document.uri.fsPath)
  );
}

export function resolveCommandTarget(arg: unknown): CommandTarget | null {
  if (isUriLike(arg)) {
    if (arg.scheme === "file" && isMarkdownPath(arg.fsPath)) {
      return { uri: arg, source: "explorer" };
    }
    return null;
  }
  const editor = vscode.window.activeTextEditor;
  if (editor && isMarkdownDocument(editor.document)) {
    return { uri: editor.document.uri, source: "editor" };
  }
  return null;
}