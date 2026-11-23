/**
 * 写回链路装配测试（STORY-13-02 · ARC-009 §12 的 E1 判据）。
 *
 * 走真实的 `createReaderApplication` + vscode stub：面板 → `document.edit` →
 * 宿主模型变更 → 既有的防抖刷新 → `document.update` 回声。阶梯本身的逐码断言在
 * `edit-service.spec.ts`，这里锁的是**接线**与两条硬口径：
 *
 * - **不写盘**（§16.1 第 22 条）：`writtenFiles` 空、`saveCalls` 空、
 *   `fileStates` 的 size / mtime 零变化 —— 效果只落在宿主模型上。
 * - **不新增刷新机制**：回声只由 `onDidChangeTextDocument` 触发，测试不推任何
 *   自定义事件，`FILE_EVENT_DEBOUNCE_MS` 之后 View 收到的就是新模型那一帧。
 *
 * 第一条用例是本轮的取证：文档只在阅读器里打开（没有 `TextDocument`）时，
 * 第一笔写回**必须成功**。按 ARC-009 §5.2 字面（比宿主模型 version）实现会在这里
 * 跑红 —— 快照侧报 0、`openTextDocument` 之后模型报 1。
 */
import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("vscode", async () => await import("../__stubs__/vscode"));

import type * as vscode from "vscode";
import {
  createEnvelope,
  READORA_ERROR_CODES,
  type DocumentEditPayload,
  type DocumentEditResult,
  type DocumentLoadPayload,
  type MessageResponse
} from "@readora/contracts";
import { FILE_EVENT_DEBOUNCE_MS, READORA_VIEW_TYPE } from "../constants";
import { createReaderApplication } from "../application";
import {
  commandHandlers,
  commands,
  createdPanels,
  documentTexts,
  fileStates,
  FileType,
  resetVscodeStub,
  saveCalls,
  Uri,
  writtenFiles,
  workspace,
  type FakePanel,
  type StubTextDocument
} from "../__stubs__/vscode";

const DOC = "file:///docs/src/read.md";
const DOC_PATH = "/docs/src/read.md";
/** 区块「alpha/beta/gamma」占 2..4 行（0 基），前后各有一行分隔空行。 */
const DOC_TEXT = "# Title\n\nalpha\nbeta\ngamma\n\nlast line\n";
const BLOCK_TEXT = "## Rewritten";
/** 替换后：新区块占住 2..4 行，前后两个分隔空行都还在。 */
const EDITED_TEXT = "# Title\n\n## Rewritten\n\nlast line\n";
const NEIGHBOUR = "file:///docs/src/other.md";
/**
 * 一个未保存的新缓冲区（`File > New Untitled Markdown`）：scheme 是 `untitled`，
 * 宿主允许用 readora 打开它，于是它会成为一个「有会话、有面板、但不能写回」的目标。
 */
const UNTITLED = "untitled:/Untitled-1.md";
const UNTITLED_PATH = "/Untitled-1.md";

function seedFileSystem(): void {
  fileStates.set(DOC_PATH, {
    type: FileType.File,
    size: DOC_TEXT.length,
    mtime: 100
  });
  fileStates.set("/docs/src/other.md", { type: FileType.File, size: 8, mtime: 5 });
  fileStates.set(UNTITLED_PATH, { type: FileType.File, size: 8, mtime: 1 });
  documentTexts.set(DOC_PATH, DOC_TEXT);
  documentTexts.set("/docs/src/other.md", "# Other\n");
}

/** 假定时器下的一次「把微任务与到期定时器都跑干净」：ms 内的事件全部落地。 */
async function run(ms = 0): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

function responses(panel: FakePanel): MessageResponse<unknown>[] {
  return panel.webview.postedMessages.filter(
    (message): message is MessageResponse<unknown> =>
      typeof message === "object" &&
      message !== null &&
      "success" in message &&
      "id" in message
  );
}

function delivered(panel: FakePanel, type: string): unknown[] {
  return panel.webview.postedMessages.filter(
    (message) =>
      typeof message === "object" &&
      message !== null &&
      "type" in message &&
      (message as { type: string }).type === type
  );
}

function lastUpdate(panel: FakePanel): DocumentLoadPayload | undefined {
  const updates = delivered(panel, "document.update");
  const last = updates[updates.length - 1] as
    | { payload: DocumentLoadPayload }
    | undefined;
  return last?.payload;
}

function model(): StubTextDocument | undefined {
  return workspace.textDocuments.find(
    (document) => document.uri.toString() === DOC
  );
}

async function createWiredApp(): Promise<FakePanel> {
  const app = createReaderApplication({
    extensionUri: Uri.file("/ext") as unknown as vscode.Uri
  } as unknown as vscode.ExtensionContext);
  app.activate();
  const openReader = commandHandlers.get("readora.openReader");
  if (!openReader) {
    throw new Error("readora.openReader was not registered");
  }
  await openReader(Uri.parse(DOC));
  await run();
  const panel = createdPanels[0];
  if (!panel) {
    throw new Error("reader panel was not created");
  }
  panel.webview.receive(createEnvelope("reader.ready", {}));
  await run();
  return panel;
}

async function edit(
  panel: FakePanel,
  payload: DocumentEditPayload
): Promise<MessageResponse<unknown>> {
  panel.webview.receive(createEnvelope("document.edit", payload));
  await run();
  const all = responses(panel);
  const response = all[all.length - 1];
  if (!response) {
    throw new Error("document.edit produced no response");
  }
  return response;
}

function editPayload(
  overrides: Partial<DocumentEditPayload> = {}
): DocumentEditPayload {
  return {
    documentUri: DOC,
    range: { startLine: 2, endLine: 4 },
    newText: BLOCK_TEXT,
    baseVersion: 0,
    ...overrides
  };
}

describe("document.edit 装配", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetVscodeStub();
    seedFileSystem();
  });

  /**
   * 分歧 1 的取证。投递给 View 的 `version` 是 0（没有 TextDocument），
   * 写回路径又必须 `openTextDocument`（宿主给的模型 version 是 1）——
   * 拿后者当乐观锁基准，这一笔就会被判陈旧。
   */
  test("只在阅读器里打开的文档，第一笔写回成功", async () => {
    const panel = await createWiredApp();
    // 前置事实：快照带出的版本是 0，且此时宿主里没有这篇的 TextDocument。
    const load = delivered(panel, "document.load")[0] as
      | { payload: DocumentLoadPayload }
      | undefined;
    expect(load?.payload.version).toBe(0);
    expect(model()).toBeUndefined();

    const response = await edit(
      panel,
      editPayload({ baseVersion: load?.payload.version ?? 0 })
    );
    expect(response.success).toBe(true);
    // 0 → 2 而不是 0 → 1：第一笔写回逼出一次 `openTextDocument`（宿主给 1），
    // `applyEdit` 自己再加 1。两个数字都在快照空间里，且严格大于 View 手里的 0。
    expect(response.payload).toEqual({ version: 2 } satisfies DocumentEditResult);
    expect(model()?.version).toBe(2);
  });

  test("写回只改宿主模型：脏态亮起，磁盘侧 size / mtime / 写盘次数零变化", async () => {
    const panel = await createWiredApp();
    await edit(panel, editPayload());
    const document = model();
    if (!document) {
      throw new Error("text model should exist after the write-back");
    }
    expect(document.getText()).toBe(EDITED_TEXT);
    expect(document.isDirty).toBe(true);
    // 区块前后的分隔空行都还在：终点取的是行末而不是下一行行首。
    // 8 行 → 6 行（三行区块并成一行），末尾空行照旧计入。
    expect(document.lineCount).toBe(6);
    // 三处「没有落盘」的事实各盯一条出口。
    expect(writtenFiles.size).toBe(0);
    expect(saveCalls).toEqual([]);
    expect(fileStates.get(DOC_PATH)).toEqual({
      type: FileType.File,
      size: DOC_TEXT.length,
      mtime: 100
    });
  });

  test("回声完全走既有链路：防抖之后 document.update 带的就是新模型那一帧", async () => {
    const panel = await createWiredApp();
    const before = panel.webview.postedMessages.length;
    await edit(panel, editPayload());
    // 写回本身不主动推送：防抖窗口内只能多出 `document.edit` 那一条响应，
    // 一帧 `document.update` 都不该已经发出。
    expect(panel.webview.postedMessages.length).toBe(before + 1);
    expect(delivered(panel, "document.update")).toHaveLength(0);

    await run(FILE_EVENT_DEBOUNCE_MS);
    const update = lastUpdate(panel);
    if (!update) {
      throw new Error("document.update echo is missing");
    }
    expect(update.text).toBe(model()?.getText());
    expect(update.version).toBe(model()?.version);
    expect(update.version).toBeGreaterThan(0);
  });

  test("响应带的版本可以直接当下一笔的 baseVersion；过期那个数字被拒", async () => {
    const panel = await createWiredApp();
    const first = await edit(panel, editPayload());
    const version = (first.payload as DocumentEditResult).version;

    const second = await edit(
      panel,
      // 首笔之后「## Rewritten」只占第 2 行，把手跟着收缩。
      editPayload({ baseVersion: version, range: { startLine: 2, endLine: 2 }, newText: "- a\n- b" })
    );
    expect(second.success).toBe(true);
    const next = (second.payload as DocumentEditResult).version;
    expect(next).toBeGreaterThan(version);

    // 同一个 baseVersion 用第二次：这就是「在别处改过」的确定性复现。
    const stale = await edit(panel, editPayload({ baseVersion: version }));
    expect(stale.success).toBe(false);
    expect(stale.error?.code).toBe(READORA_ERROR_CODES.EDIT_STALE);
    expect(model()?.getText()).toBe("# Title\n\n- a\n- b\n\nlast line\n");
  });

  test("endLine 越过最后一行 → rangeInvalid，且模型一个字节都没动", async () => {
    const panel = await createWiredApp();
    await edit(panel, editPayload());
    const snapshotText = model()?.getText();
    const snapshotVersion = model()?.version;

    const response = await edit(
      panel,
      editPayload({
        baseVersion: snapshotVersion ?? 0,
        range: { startLine: 0, endLine: 99 }
      })
    );
    expect(response.success).toBe(false);
    expect(response.error?.code).toBe(READORA_ERROR_CODES.EDIT_RANGE_INVALID);
    expect(model()?.getText()).toBe(snapshotText);
    expect(model()?.version).toBe(snapshotVersion);
    expect(writtenFiles.size).toBe(0);
    expect(saveCalls).toEqual([]);
  });

  test("倒挂范围（Schema 放行的那一种）在 Host 被判 rangeInvalid 而不是 payloadInvalid", async () => {
    const panel = await createWiredApp();
    const response = await edit(panel, editPayload({ range: { startLine: 4, endLine: 2 } }));
    expect(response.success).toBe(false);
    expect(response.error?.code).toBe(READORA_ERROR_CODES.EDIT_RANGE_INVALID);
    expect(response.error?.code).not.toBe(READORA_ERROR_CODES.INVALID_PAYLOAD);
  });

  test("documentUri 指向隔壁文件 → target.invalid，两篇模型的文本都不变", async () => {
    const panel = await createWiredApp();
    const response = await edit(panel, editPayload({ documentUri: NEIGHBOUR }));
    expect(response.success).toBe(false);
    expect(response.error?.code).toBe(READORA_ERROR_CODES.TARGET_INVALID);
    expect(model()).toBeUndefined();
    expect(workspace.textDocuments.some((document) => document.uri.toString() === NEIGHBOUR)).toBe(
      false
    );
  });

  test("载荷形状不合法时仍是 payload.invalid：形状与语义两套错误码互不越界", async () => {
    const panel = await createWiredApp();
    panel.webview.receive(
      createEnvelope("document.edit", {
        documentUri: DOC,
        range: { startLine: -1, endLine: 2 },
        newText: "x",
        baseVersion: 0
      })
    );
    await run();
    const all = responses(panel);
    expect(all[all.length - 1]?.error?.code).toBe(READORA_ERROR_CODES.INVALID_PAYLOAD);
    expect(model()).toBeUndefined();
  });

  test("面板已释放 → 拒收，不留下任何模型", async () => {
    const panel = await createWiredApp();
    panel.dispose();
    await run();
    const response = await edit(panel, editPayload());
    expect(response.success).toBe(false);
    expect(response.error?.code).toBe(READORA_ERROR_CODES.RESOURCE_DENIED);
    expect(model()).toBeUndefined();
  });

  test("非 file scheme 的会话文档拒收（走第③步而不是第②步）", async () => {
    await createWiredApp();
    // 未保存的 Markdown 缓冲区同样能被 readora 打开（provider 不校验 scheme），
    // 于是它成为一个「有会话、有面板、但不能写回」的目标。旧写法把 payload 换成
    // 一个会话之外的 untitled 目标，看着也回 target.invalid，实际只跑到第②步
    // （字符串不全等），第③步在装配层根本没被验证过。
    await commands.executeCommand(
      "vscode.openWith",
      Uri.parse(UNTITLED),
      READORA_VIEW_TYPE
    );
    await run();
    const panel = createdPanels[1];
    if (!panel) {
      throw new Error("untitled reader panel was not created");
    }
    panel.webview.receive(createEnvelope("reader.ready", {}));
    await run();

    // documentUri 与会话文档全等 —— 第②步放行，拒收只能来自 scheme 判定。
    const response = await edit(panel, editPayload({ documentUri: UNTITLED }));
    expect(response.success).toBe(false);
    expect(response.error?.code).toBe(READORA_ERROR_CODES.TARGET_INVALID);
    expect(response.error?.message).toContain("Only local files can be edited");
    // 不为一篇不能写的文档打开宿主模型（脏态、撤销栈都会凭空长出来）。
    expect(
      workspace.textDocuments.some((document) => document.uri.scheme === "untitled")
    ).toBe(false);
  });
});
