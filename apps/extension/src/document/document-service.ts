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
      version: open?.version ?? 0,
      text
    };
  }
}