/**
 * 资源链路装配测试（ARC-008 §7 / §10，STORY-08-01 / 08-02 / 08-04）。
 *
 * 走真实的 createReaderApplication：命令 → 面板 → reader.ready →
 * resource.resolve / document.navigate，端口用 vscode stub 的内存文件系统。
 * 目的是让「接线」本身被断言，而不是只测各模块内部逻辑。
 */
import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("vscode", async () => await import("../__stubs__/vscode"));

// node:fs.realpath 在单测里没有可信的虚拟文件系统可依赖，改为「文件登记过才算存在」，
// 这样符号链接与越权判定仍由 boundary 的逻辑决定，而不是由宿主机目录结构决定。
vi.mock("node:fs/promises", () => ({
  realpath: async (path: unknown) => {
    const key = String(path);
    if (!fileStates.has(key)) {
      throw Object.assign(new Error(`ENOENT: ${key}`), { code: "ENOENT" });
    }
    return key;
  }
}));

import type * as vscode from "vscode";
import {
  createEnvelope,
  READORA_ERROR_CODES,
  type DocumentLoadPayload,
  type MessageResponse,
  type ResourceResolveResult
} from "@readora/contracts";
import { createReaderApplication } from "../application";
import { contentVersion } from "../resources/webview-uri";
import {
  commandHandlers,
  createdPanels,
  fileStates,
  FileType,
  resetVscodeStub,
  readFileCalls,
  statCalls,
  Uri,
  workspace,
  type FakePanel
} from "../__stubs__/vscode";

const DOC = "file:///docs/src/read.md";
const DOC_TEXT = "# Hello Readora\n";
const LOGO_PATH = "/docs/src/assets/logo.png";
const LOGO_STAT = { type: FileType.File, size: 2048, mtime: 100 };

function seedFileSystem(): void {
  fileStates.set("/docs/src/read.md", {
    type: FileType.File,
    size: DOC_TEXT.length,
    mtime: 100
  });
  fileStates.set(LOGO_PATH, LOGO_STAT);
  fileStates.set("/docs/guide.md", { type: FileType.File, size: 16, mtime: 7 });
  fileStates.set("/etc/passwd.png", { type: FileType.File, size: 8, mtime: 1 });
  workspace.workspaceFolders = [
    {
      uri: Uri.file("/docs") as unknown as vscode.Uri,
      name: "docs",
      index: 0
    }
  ];
}

const flush = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

function responses(panel: FakePanel): MessageResponse<unknown>[] {
  return panel.webview.postedMessages.filter(
    (message): message is MessageResponse<unknown> =>
      typeof message === "object" &&
      message !== null &&
      "success" in message &&
      "id" in message
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
  await flush();
  const panel = createdPanels[0];
  if (!panel) {
    throw new Error("reader panel was not created");
  }
  panel.webview.receive(createEnvelope("reader.ready", {}));
  await flush();
  return panel;
}

async function ask(
  panel: FakePanel,
  type: "resource.resolve" | "document.navigate",
  payload: Record<string, unknown>
): Promise<MessageResponse<unknown>> {
  const before = panel.webview.postedMessages.length;
  panel.webview.receive(createEnvelope(type, payload));
  await flush();
  const response = responses(panel)[responses(panel).length - 1];
  if (!response || panel.webview.postedMessages.length === before) {
    throw new Error(`${type} produced no response`);
  }
  return response;
}

describe("资源装配", () => {
  beforeEach(() => {
    resetVscodeStub();
    seedFileSystem();
  });

  test("localResourceRoots 增补文档目录与所属工作区 folder", async () => {
    const panel = await createWiredApp();
    const roots = (
      panel.showOptions as { localResourceRoots: { toString(): string }[] }
    ).localResourceRoots.map((root) => root.toString());
    expect(roots).toContain("file:///ext/dist/webview");
    expect(roots).toContain("file:///ext/resources");
    expect(roots).toContain("file:///docs/src");
    expect(roots).toContain("file:///docs");
    expect(roots).not.toContain("file:///");
  });

  test("document.load 仍只在 reader.ready 之后投递（门控不变）", async () => {
    const app = createReaderApplication({
      extensionUri: Uri.file("/ext") as unknown as vscode.Uri
    } as unknown as vscode.ExtensionContext);
    app.activate();
    await commandHandlers.get("readora.openReader")?.(Uri.parse(DOC));
    await flush();
    const panel = createdPanels[0];
    if (!panel) {
      throw new Error("panel missing");
    }
    expect(panel.webview.postedMessages).toHaveLength(0);
    panel.webview.receive(createEnvelope("reader.ready", {}));
    await flush();
    expect(panel.webview.postedMessages.length).toBeGreaterThan(0);
    app.dispose();
  });

  test("resource.resolve 端到端：返回带版本号的 webview URI，不含本地路径", async () => {
    const panel = await createWiredApp();
    const response = await ask(panel, "resource.resolve", {
      documentUri: DOC,
      reference: "assets/logo.png"
    });
    expect(response.success).toBe(true);
    const result = response.payload as ResourceResolveResult;
    expect(result.mimeType).toBe("image/png");
    expect(result.kind).toBe("image");
    expect(result.byteSize).toBe(2048);
    expect(result.version).toBe(contentVersion({ mtimeMs: 100, size: 2048 }));
    expect(result.webviewUri).toBe(
      `https://stub.vscode-cdn.net${LOGO_PATH}?${result.version}`
    );
    expect(result.webviewUri).not.toContain("file://");
    expect(result.resourceId).toMatch(/^res-[0-9a-f]{16}$/);
  });

  test("kind 省略时按 image 处理，显式 document 走 Markdown 白名单", async () => {
    const panel = await createWiredApp();
    const implicit = await ask(panel, "resource.resolve", {
      documentUri: DOC,
      reference: "assets/logo.png"
    });
    expect((implicit.payload as ResourceResolveResult).kind).toBe("image");

    const wrongKind = await ask(panel, "resource.resolve", {
      documentUri: DOC,
      reference: "assets/logo.png",
      kind: "document"
    });
    expect(wrongKind.success).toBe(false);
    expect(wrongKind.error?.code).toBe(READORA_ERROR_CODES.RESOURCE_UNSUPPORTED);

    const self = await ask(panel, "resource.resolve", {
      documentUri: DOC,
      reference: "read.md",
      kind: "document"
    });
    expect(self.success).toBe(true);
    expect((self.payload as ResourceResolveResult).mimeType).toBe("text/markdown");
  });

  test("payload 自带别的 documentUri 不得换取授权根", async () => {
    const panel = await createWiredApp();
    const forged = await ask(panel, "resource.resolve", {
      documentUri: "file:///etc/passwd.png",
      reference: "../../etc/passwd.png"
    });
    expect(forged.success).toBe(false);
    expect(forged.error?.code).toBe(READORA_ERROR_CODES.RESOURCE_DENIED);
    expect(forged.error?.message).toContain("session");
  });

  test("越出授权根的引用被拒，且绝不读取字节", async () => {
    const panel = await createWiredApp();
    readFileCalls.length = 0;
    statCalls.length = 0;
    const outcome = await ask(panel, "resource.resolve", {
      documentUri: DOC,
      reference: "../../etc/passwd.png"
    });
    expect(outcome.success).toBe(false);
    expect(outcome.error?.code).toBe(READORA_ERROR_CODES.RESOURCE_DENIED);
    // 允许 stat 探测（否则缺失与越权无法区分），但不允许读取内容。
    expect(statCalls).toContain("/etc/passwd.png");
    expect(readFileCalls).toEqual([]);
  });

  test("远端与 data: 引用默认被策略拒绝", async () => {
    const panel = await createWiredApp();
    for (const reference of ["https://cdn.example.com/a.png", "data:image/png;base64,AAAA"]) {
      const outcome = await ask(panel, "resource.resolve", {
        documentUri: DOC,
        reference
      });
      expect(outcome.success).toBe(false);
      expect(outcome.error?.code).toBe(READORA_ERROR_CODES.RESOURCE_DENIED);
    }
  });

  test("相对 Markdown 引用可跨文档跳转并投递新快照", async () => {
    const panel = await createWiredApp();
    const outcome = await ask(panel, "document.navigate", { uri: "../guide.md" });
    expect(outcome.success).toBe(true);
    await flush();
    expect(createdPanels).toHaveLength(2);
    const second = createdPanels[1];
    if (!second) {
      throw new Error("second panel missing");
    }
    // 新面板同样要等 ready，不能因为「已打开过」就提前投递。
    expect(second.webview.postedMessages).toHaveLength(0);
    second.webview.receive(createEnvelope("reader.ready", {}));
    await flush();
    const payloads = second.webview.postedMessages.filter(
      (message): message is { type: string; payload: DocumentLoadPayload } =>
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        (message as { type: string }).type === "document.load"
    );
    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.payload.documentUri).toBe("file:///docs/guide.md");
  });

  test("相对跳转指向非 Markdown 或不存在文件时报资源错误", async () => {
    const panel = await createWiredApp();
    const image = await ask(panel, "document.navigate", { uri: "assets/logo.png" });
    expect(image.success).toBe(false);
    expect(image.error?.code).toBe(READORA_ERROR_CODES.RESOURCE_UNSUPPORTED);

    const missing = await ask(panel, "document.navigate", { uri: "nope.md" });
    expect(missing.success).toBe(false);
    expect(missing.error?.code).toBe(READORA_ERROR_CODES.RESOURCE_NOT_FOUND);

    const absolute = await ask(panel, "document.navigate", {
      uri: "file:///etc/passwd.md"
    });
    // 绝对路径仍走「直接打开」通道：不存在时是文档错误，不是资源错误。
    expect(absolute.success).toBe(false);
    expect(absolute.error?.code).toBe(READORA_ERROR_CODES.DOCUMENT_UNREADABLE);
    expect(createdPanels).toHaveLength(1);
  });

  test("面板释放后不再受理资源请求，也不留下缓存", async () => {
    const panel = await createWiredApp();
    const first = await ask(panel, "resource.resolve", {
      documentUri: DOC,
      reference: "assets/logo.png"
    });
    expect(first.success).toBe(true);
    panel.dispose();
    await flush();
    const after = await ask(panel, "resource.resolve", {
      documentUri: DOC,
      reference: "assets/logo.png"
    });
    expect(after.success).toBe(false);
    expect(after.error?.code).toBe(READORA_ERROR_CODES.RESOURCE_DENIED);
    expect(after.error?.message).toContain("no longer active");
  });

  test("内容变更后重新解析得到新版本号（不命中陈旧缓存）", async () => {
    const panel = await createWiredApp();
    const before = await ask(panel, "resource.resolve", {
      documentUri: DOC,
      reference: "assets/logo.png"
    });
    fileStates.set(LOGO_PATH, { type: FileType.File, size: 4096, mtime: 220 });
    const after = await ask(panel, "resource.resolve", {
      documentUri: DOC,
      reference: "assets/logo.png"
    });
    const beforeResult = before.payload as ResourceResolveResult;
    const afterResult = after.payload as ResourceResolveResult;
    expect(afterResult.version).toBe(contentVersion({ mtimeMs: 220, size: 4096 }));
    expect(afterResult.version).not.toBe(beforeResult.version);
    expect(afterResult.byteSize).toBe(4096);
  });

  /**
   * STORY-06-03 的 Host 半边：Webview 交出 `Note`（不带扩展名，因为它来自
   * `[[Note]]`），Host 负责补候选并打开。走的是与相对链接同一条
   * document.navigate 通道 —— 这里证明的是「不加第二条通道也能落地」。
   */
  test("[[Note]] 经 document.navigate 补 .md 候选并投递新快照", async () => {
    fileStates.set("/docs/src/Note.md", { type: FileType.File, size: 24, mtime: 9 });
    fileStates.set("/docs/src/Note.markdown", { type: FileType.File, size: 24, mtime: 9 });
    const panel = await createWiredApp();
    const outcome = await ask(panel, "document.navigate", { uri: "Note" });
    expect(outcome.success).toBe(true);
    await flush();
    expect(createdPanels).toHaveLength(2);
    const second = createdPanels[1];
    if (!second) {
      throw new Error("second panel missing");
    }
    second.webview.receive(createEnvelope("reader.ready", {}));
    await flush();
    const payloads = second.webview.postedMessages.filter(
      (message): message is { type: string; payload: DocumentLoadPayload } =>
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        (message as { type: string }).type === "document.load"
    );
    // 候选顺序即语义：Note.md 先被试中，Note.markdown 不该被打开第二次。
    expect(payloads.map((item) => item.payload.documentUri)).toEqual([
      "file:///docs/src/Note.md"
    ]);
  });

  test("两个候选都不存在时回 wikilink.missing，不开新面板", async () => {
    const panel = await createWiredApp();
    const outcome = await ask(panel, "document.navigate", { uri: "Ghost" });
    expect(outcome.success).toBe(false);
    expect(outcome.error?.code).toBe(READORA_ERROR_CODES.WIKILINK_MISSING);
    expect(outcome.error?.message).toContain("[[Ghost]]");
    expect(createdPanels).toHaveLength(1);
  });
});
