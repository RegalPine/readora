/**
 * 编辑写回（F12 · ARC-009 §5.2）。
 *
 * 本模块不 import vscode：宿主模型与 `WorkspaceEdit` 经端口注入，真机实现在
 * `vscode-port.ts`。于是「一条写回要过几道判断、每道失败说哪个错误码」这套
 * 决策阶梯能整体单测（`__tests__/edit-service.spec.ts`）。
 *
 * 三条不可让的口径，都靠**端口集合的形状**保证而不是靠注释承诺：
 * 1. **不写盘。** 端口里没有 `save`，只有 `applyLineReplacement` —— 效果落在
 *    `TextDocument` 模型上，撤销栈与脏态归宿主（ARC-009 §5.2、§9.1）。
 * 2. **不新增刷新机制。** 端口里没有 `postMessage` / `pushUpdate`：回声走既有的
 *    `onDidChangeTextDocument` → `document.update` 那一条链（ARC-004 §9.2）。
 * 3. **绝不留部分效果。** 阶梯上任一步不过就抛错，`applyLineReplacement` 一次
 *    都不调；拒收之后模型零变化，用户手里那段文本还在（ARC-009 §5.4）。
 *
 * 乐观锁比的是**快照空间的版本**（`snapshotVersionOf`），不是宿主模型的
 * `version`：投递给 View 的那个数字来自前者，而文档没在文本编辑器里打开时它是
 * `0`、走 `openTextDocument` 之后是 `1`。照「模型 version ≠ baseVersion」字面
 * 实现，每一个只在阅读器里打开的文档第一次写回都会被判陈旧。
 */
import {
  READORA_ERROR_CODES,
  type DocumentEditPayload,
  type DocumentEditResult
} from "@readora/contracts";
import { ReaderError } from "../errors";

/** 会话的可写回性事实：本模块不认识 ReaderSession / WebviewPanel。 */
export interface EditSessionInfo {
  readonly documentUri: string;
  readonly hasPanel: boolean;
}

/** 宿主文档模型的两件事实：行数与快照空间的版本。 */
export interface EditModel {
  readonly lineCount: number;
  readonly snapshotVersion: number;
}

export interface LineReplacement {
  readonly documentUri: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly newText: string;
}

export interface EditServicePorts {
  /** 会话是否还在、还有面板。会话不在与面板已释放同样返回 `null`。 */
  sessionOf(sessionId: string): EditSessionInfo | null;
  /** URI 协议名（`file` / `untitled` / `vscode-vfs` …）；无法解析时返回空串。 */
  schemeOf(documentUri: string): string;
  /** 取模型；打不开（已删除、无权限）返回 `null`。 */
  modelOf(documentUri: string): Promise<EditModel | null>;
  /**
   * 把 `[startLine, endLine]`（0 基闭区间）替换成 `newText`。
   * 成功返回替换**之后**的模型快照，宿主拒绝时返回 `null` —— 端口不藏副作用，
   * 也不自己去推 View（那是既有的变更事件在做的事）。
   */
  applyLineReplacement(input: LineReplacement): Promise<EditModel | null>;
}

export class EditService {
  constructor(private readonly ports: EditServicePorts) {}

  /**
   * 一次写回。错误码即用户看到的下一步动作，因此阶梯顺序不可调：
   * 「会话没了」与「文档不对」都发生在读模型之前，而陈旧判定必须先于范围
   * 合法性 —— 版本已经对不上时，行数本身就不可信，报 `rangeInvalid` 会把用户
   * 引向「重开编辑器」而不是「重新同步」。
   */
  async editDocument(
    payload: DocumentEditPayload,
    sessionId: string
  ): Promise<DocumentEditResult> {
    const session = this.ports.sessionOf(sessionId);
    if (!session || !session.hasPanel) {
      // 与 `application.ts` 的 sessionDocumentUri() 同口径：会话不在就是「你不再
      // 是那个被授权的阅读器」，复用 RESOURCE_DENIED，不为此再造一枚错误码。
      throw new ReaderError(
        READORA_ERROR_CODES.RESOURCE_DENIED,
        "The requesting reader session is no longer active."
      );
    }

    // 字符串全等比较，不做归一化：payload.documentUri 一律不可用于授权，
    // 会话那一份才是唯一权威（ARC-008 §16.1）。归一化会造出第二个「什么叫同一个
    // 文件」的定义，而 View 手里的字符串本来就是从会话快照里抄出来的。
    if (payload.documentUri !== session.documentUri) {
      throw new ReaderError(
        READORA_ERROR_CODES.TARGET_INVALID,
        "document.edit refers to a document other than the session's."
      );
    }

    // WorkspaceEdit 只对本地文件模型有意义：虚拟文档（untitled、VS Code Remote
    // 的只读文件系统）上没有「源行范围」这个概念（ARC-009 §9.2）。
    if (this.ports.schemeOf(payload.documentUri) !== "file") {
      throw new ReaderError(
        READORA_ERROR_CODES.TARGET_INVALID,
        `Only local files can be edited: ${payload.documentUri}`
      );
    }

    const model = await this.ports.modelOf(payload.documentUri);
    if (!model) {
      throw new ReaderError(
        READORA_ERROR_CODES.DOCUMENT_UNREADABLE,
        `Cannot open the document for editing: ${payload.documentUri}`
      );
    }

    if (payload.baseVersion !== model.snapshotVersion) {
      throw new ReaderError(
        READORA_ERROR_CODES.EDIT_STALE,
        `The document changed after version ${payload.baseVersion}; re-sync before editing.`
      );
    }

    const { startLine, endLine } = payload.range;
    // 倒挂与越界在这里判而不在 Schema 判：形状错误只能回 payload.invalid，
    // 而这两种情况的用户语义是「把手作废」（ARC-009 §5.3）。
    // 不钳位、不截断：悄悄少改几行比拒绝一次更糟。
    if (endLine < startLine || endLine >= model.lineCount) {
      throw new ReaderError(
        READORA_ERROR_CODES.EDIT_RANGE_INVALID,
        `Source range ${startLine}:${endLine} is no longer valid in a ${model.lineCount}-line document.`
      );
    }

    const applied = await this.ports.applyLineReplacement({
      documentUri: payload.documentUri,
      startLine,
      endLine,
      newText: payload.newText
    });
    if (!applied) {
      throw new ReaderError(
        READORA_ERROR_CODES.EDIT_APPLY_FAILED,
        "The workbench refused to apply the edit. The file may be read-only or locked."
      );
    }

    return { version: applied.snapshotVersion };
  }
}
