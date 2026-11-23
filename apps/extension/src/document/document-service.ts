/**
 * 文档快照服务（ARC-004 §9）。
 *
 * 文档读取一律走 workspace.fs（禁止 node:fs，ARC-008 资源边界）；
 * 编辑器内已打开且 dirty 的文档优先取 TextDocument，保证所见即所得。
 * 超限文档在此抛出 DOCUMENT_TOO_LARGE，调用方必须在创建面板之前捕获
 * （ARC-004 §8.7 第 4 条：超限早报，不留空白面板）。
 */
import * as vscode from "vscode";
import {
  DOCUMENT_TEXT_MAX_LENGTH,
  READORA_ERROR_CODES,
  type DocumentSnapshot
} from "@readora/contracts";
import { ReaderError } from "../errors";

/**
 * 快照空间的版本号（ARC-009 §5.2 第 3 步的唯一权威）。
 *
 * 文档**没有在文本编辑器里打开**时这里是 `0`，而任何走 `openTextDocument` 的
 * 路径拿到的新模型是 `1` —— 这两个数字属于同一个空间但不同时刻，所以
 * 「乐观锁比对的版本」必须一律取投递给 View 的那一份（`document.load/update`
 * 里的 `version` 就是从这条式子算出来的），不能一会儿用快照、一会儿用模型。
 * 编辑写回（`edit/edit-service.ts`）复用同一个函数，版本空间只有一处定义。
 */
export function snapshotVersionOf(open: { version: number } | undefined): number {
  return open?.version ?? 0;
}

export class DocumentService {
  async readSnapshot(uri: vscode.Uri): Promise<DocumentSnapshot> {
    const key = uri.toString();
    const open = vscode.workspace.textDocuments.find(
      (document) => document.uri.toString() === key
    );

    let text: string;
    if (open && open.isDirty) {
      text = open.getText();
    } else {
      let bytes: Uint8Array;
      try {
        bytes = await vscode.workspace.fs.readFile(uri);
      } catch {
        throw new ReaderError(
          READORA_ERROR_CODES.DOCUMENT_UNREADABLE,
          `Cannot read document: ${key}`
        );
      }
      // UTF-8 字节数 >= 字符数，先做快速预检再精确校验。
      if (bytes.byteLength > DOCUMENT_TEXT_MAX_LENGTH) {
        throw new ReaderError(
          READORA_ERROR_CODES.DOCUMENT_TOO_LARGE,
          `Document exceeds the ${DOCUMENT_TEXT_MAX_LENGTH} character limit: ${key}`
        );
      }
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        throw new ReaderError(
          READORA_ERROR_CODES.DOCUMENT_UNREADABLE,
          `Document is not valid UTF-8: ${key}`
        );
      }
    }

    if (text.length > DOCUMENT_TEXT_MAX_LENGTH) {
      throw new ReaderError(
        READORA_ERROR_CODES.DOCUMENT_TOO_LARGE,
        `Document exceeds the ${DOCUMENT_TEXT_MAX_LENGTH} character limit: ${key}`
      );
    }

    return {
      documentUri: key,
      languageId: open?.languageId ?? "markdown",
      version: snapshotVersionOf(open),
      text
    };
  }
}