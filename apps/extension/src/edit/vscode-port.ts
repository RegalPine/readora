/**
 * EditServicePorts 的 VS Code 实现（ARC-009 §5.2 的第 2、5、6 步）。
 *
 * 与 `export/vscode-ports.ts`、`resources/vscode-port.ts` 同口径：**单测不覆盖本文件**，
 * 它只做转译，判断全部留在 `edit-service.ts` 里（哪一步失败、报哪个错误码）。
 *
 * 一处必须说清楚的顺序：`modelOf` 先读快照空间的版本、**再**决定要不要
 * `openTextDocument`。反过来写（拿刚打开那个模型的 `version` 当基准）会让每一个
 * 「只在阅读器里打开、没进文本编辑器」的文档第一笔写回就被判 `edit.stale` ——
 * 快照侧报 `0`（`snapshotVersionOf`），刚打开的模型报 `1`，两个数字看起来只差 1，
 * 却分属「没打开」和「刚打开」两个时刻。版本空间的唯一权威在
 * `document/document-service.ts` 的 `snapshotVersionOf`，两侧都从这里取。
 */
import * as vscode from "vscode";
import { READORA_ERROR_CODES } from "@readora/contracts";
import { snapshotVersionOf } from "../document/document-service";
import type {
  EditModel,
  EditServicePorts,
  EditSessionInfo,
  LineReplacement
} from "./edit-service";

/**
 * 写回侧只用到 `warn`：三道失败（打不开 / 抛异常 / 宿主返回 false）都是
 * 「这一次没改成」，不是需要 error 级别的崩溃。形状与 `DiagnosticsSink` 兼容。
 */
export interface EditDiagnostics {
  warn(code: string, message: string): void;
}

export interface EditPortsDependencies {
  /** 会话事实：装配层复用与导出那一条同样的翻译（`ExportSessionInfo` 结构兼容）。 */
  sessionOf(sessionId: string): EditSessionInfo | null;
  /** 宿主侧失败进输出通道（F11-013）：错误响应只回到 View，用户看不见这一行。 */
  diagnostics: EditDiagnostics;
}

export function createEditPorts(deps: EditPortsDependencies): EditServicePorts {
  /** 已打开的文本模型：与 `DocumentService.readSnapshot` 用同一个查找口径。 */
  const findOpen = (documentUri: string): vscode.TextDocument | undefined =>
    vscode.workspace.textDocuments.find(
      (document) => document.uri.toString() === documentUri
    );

  /** 取模型，必要时打开；打不开返回 `null`（不抛：语义差由调用方说）。 */
  async function openOrFind(
    documentUri: string
  ): Promise<vscode.TextDocument | null> {
    const open = findOpen(documentUri);
    if (open) {
      return open;
    }
    try {
      return await Promise.resolve(
        vscode.workspace.openTextDocument(vscode.Uri.parse(documentUri))
      );
    } catch (error) {
      deps.diagnostics.warn(
        READORA_ERROR_CODES.DOCUMENT_UNREADABLE,
        `document.edit cannot open: ${documentUri} (${
          error instanceof Error ? error.message : String(error)
        })`
      );
      return null;
    }
  }

  const modelOf = async (documentUri: string): Promise<EditModel | null> => {
    // 顺序不可倒：先按快照空间读版本，再去碰 `openTextDocument`（见文件头）。
    const snapshotVersion = snapshotVersionOf(findOpen(documentUri));
    const document = await openOrFind(documentUri);
    if (!document) {
      return null;
    }
    return { lineCount: document.lineCount, snapshotVersion };
  };

  return {
    sessionOf: deps.sessionOf,
    // 无法解析的字符串一律返回空串而不是抛出：让 EditService 把它翻译成
    // `target.invalid`（用户语义：这不是一个能编辑的目标），
    // 而不是一条 `internal` 崩溃。
    schemeOf: (documentUri) => {
      try {
        return vscode.Uri.parse(documentUri).scheme;
      } catch {
        return "";
      }
    },
    modelOf,
    async applyLineReplacement(
      input: LineReplacement
    ): Promise<EditModel | null> {
      const uri = vscode.Uri.parse(input.documentUri);
      const document = await openOrFind(input.documentUri);
      if (!document) {
        // 阶梯到这一步之前还打得开，现在打不开了（用户刚关掉、文件被外删）：
        // 算「宿主拒绝这次修改」，不算「文档读不到」—— 用户已经提交了编辑，
        // 他要听到的是「这次没改成」。
        deps.diagnostics.warn(
          READORA_ERROR_CODES.EDIT_APPLY_FAILED,
          `document.edit lost the model before applying: ${input.documentUri}`
        );
        return null;
      }
      const edit = new vscode.WorkspaceEdit();
      // `[startLine, endLine]` 是 0 基**闭**区间，终点取「第 endLine 行的行末」而不是
      // `Position(endLine + 1, 0)`。后者看着只多一行，实际多吃了一个换行符：
      // 被删掉的区块最后一行的行尾换行不在替换范围内，而契约里的 `newText`
      // **不含尾随换行**，于是下一行（区块后的分隔空行）的换行会被拼过来当
      // 新内容的行尾——区块之间的空行隔一个少一个，下一个区块直接贴上来、连解析都会变
      // （ARC-009 §4.1 对锚点收缩提过的同一类事故）。取 `lineAt(endLine)` 的行末
      // 后：新内容恰好占住原区块的字符区间，区块自己的行尾换行原地保留。
      const end = document.lineAt(input.endLine).text.length;
      edit.replace(
        uri,
        new vscode.Range(
          new vscode.Position(input.startLine, 0),
          new vscode.Position(input.endLine, end)
        ),
        input.newText
      );
      let applied: boolean;
      try {
        applied = await Promise.resolve(vscode.workspace.applyEdit(edit));
      } catch (error) {
        deps.diagnostics.warn(
          READORA_ERROR_CODES.EDIT_APPLY_FAILED,
          `document.edit threw while applying: ${input.documentUri} (${
            error instanceof Error ? error.message : String(error)
          })`
        );
        return null;
      }
      if (!applied) {
        deps.diagnostics.warn(
          READORA_ERROR_CODES.EDIT_APPLY_FAILED,
          `document.edit was refused by the workbench: ${input.documentUri}`
        );
        return null;
      }
      // 再问一次而不是自己算新版本号：宿主可能因为合并、撤销栈、只读夹取给出
      // 与我们预期不同的 version。端口不藏副作用，也不猜副作用的结果。
      return modelOf(input.documentUri);
    }
  };
}
