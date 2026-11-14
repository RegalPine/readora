/**
 * 首屏投递门控测试（ARC-004 §8.7 / AUD-001 §13.5）。
 *
 * 覆盖：建面板时零投递、reader.ready 后才投递、重复 ready 不重复投递、
 * 超限文档不建面板、dispose 清理暂存、链接策略、unsupported 路由、
 * 版本防旧覆盖、state.save 会话校验。
 */
import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("vscode", async () => await import("../__stubs__/vscode"));

import type * as vscode from "vscode";
import {
  createEnvelope,
  READORA_ERROR_CODES,
  type DocumentSnapshot,
  type ExportDataPayload,
  type ExportFormat,
  type MetricsReportPayload,
  type MessageResponse,
  type ReaderPreferences,
  type ResourceResolvePayload
} from "@readora/contracts";
import { ReaderError } from "../errors";
import { MessageDispatcher } from "../messaging/dispatcher";
import { registerMessageHandlers } from "../messaging/handlers";
import { SessionManager, type ReaderSession } from "../session/session-manager";
import { WebviewManager } from "../webview/webview-manager";
import {
  createdPanels,
  resetVscodeStub,
  Uri,
  type FakePanel
} from "../__stubs__/vscode";

const DOCUMENT_URI = "file:///tmp/doc.md";

const preferences: ReaderPreferences = {
  theme: "auto",
  fontSize: 16,
  lineHeight: 1.75,
  contentWidth: 820,
  showOutline: true,
  typography: "newsreader",
  themePreset: "default"
};

function snapshot(overrides: Partial<DocumentSnapshot> = {}): DocumentSnapshot {
  return {
    documentUri: DOCUMENT_URI,
    languageId: "markdown",
    version: 1,
    text: "# Hello Readora",
    ...overrides
  };
}

function createHarness() {
  const sessions = new SessionManager();
  const dispatcher = new MessageDispatcher();
  const openedExternal: string[] = [];
  const resolved: { payload: ResourceResolvePayload; sessionId: string }[] = [];
  const navigated: { uri: string; sessionId: string }[] = [];
  const patched: { key: string; value: unknown }[] = [];
  const metrics: { payload: MetricsReportPayload; sessionId: string }[] = [];
  const exportRequests: { sessionId: string; format: ExportFormat }[] = [];
  const exportFrames: { payload: ExportDataPayload; sessionId: string }[] = [];
  const webviews = new WebviewManager({
    extensionUri: Uri.file("/ext") as unknown as vscode.Uri,
    dispatcher,
    sessions,
    getPreferences: () => preferences,
    resolveTheme: () => ({ mode: "dark", source: "product" }),
    resolveCustomCss: () => ({ ok: true as const, css: "" }),
    workspaceFolders: () => [],
    onSessionDisposed: (session) => sessions.disposeSession(session)
  });
  registerMessageHandlers(dispatcher, {
    deliverPending: (sessionId) => webviews.deliverPending(sessionId),
    saveReadingState: (sessionId, documentUri, state) => {
      const session = sessions.getById(sessionId);
      if (!session || session.documentUri !== documentUri) {
        throw new ReaderError(READORA_ERROR_CODES.TARGET_INVALID, "session mismatch");
      }
      session.readingState = state;
    },
    openExternal: async (uri) => {
      openedExternal.push(uri);
      return true;
    },
    navigate: async (uri, sessionId) => {
      navigated.push({ uri, sessionId });
    },
    resolveResource: async (payload, sessionId) => {
      resolved.push({ payload, sessionId });
      return {
        resourceId: "res-0123456789abcdef",
        webviewUri: "https://stub.vscode-cdn.net/tmp/img.png?1-3",
        mimeType: "image/png",
        kind: payload.kind,
        byteSize: 3,
        version: "1-3"
      };
    },
    reportError: () => undefined,
    patchConfig: async (key, value) => {
      patched.push({ key, value });
      // 夹具不做值域校验（那是 ConfigurationService 的职责），这里只记录调用。
      return { ...preferences, [key]: value } as ReaderPreferences;
    },
    reportMetrics: (payload, sessionId) => {
      metrics.push({ payload, sessionId });
    },
    // M11 两条补设通道：本夹具只验证投递门控与会话归属，导出本身由 ExportService
    // 的单测负责，于是这里只记录调用而不模拟任何写盘。
    requestExport: async (sessionId, format) => {
      exportRequests.push({ sessionId, format });
    },
    onExportData: async (payload, sessionId) => {
      exportFrames.push({ payload, sessionId });
    }
  });
  return {
    sessions,
    dispatcher,
    webviews,
    openedExternal,
    resolved,
    navigated,
    patched,
    metrics,
    exportRequests,
    exportFrames
  };
}

function openPanel(harness: ReturnType<typeof createHarness>): {
  session: ReaderSession;
  panel: FakePanel;
} {
  const { session } = harness.sessions.getOrCreate(DOCUMENT_URI);
  harness.webviews.open(
    session,
    snapshot(),
    preferences,
    -1 as vscode.ViewColumn
  );
  const panel = createdPanels[0];
  if (!panel) {
    throw new Error("panel was not created");
  }
  return { session, panel };
}

const flush = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

function envelopeTypes(panel: FakePanel): string[] {
  return panel.webview.postedMessages
    .filter((message): message is { type: string } =>
      typeof message === "object" && message !== null && "type" in message
    )
    .map((message) => message.type);
}

function responses(panel: FakePanel): MessageResponse[] {
  return panel.webview.postedMessages.filter(
    (message): message is MessageResponse =>
      typeof message === "object" && message !== null && "success" in message
  );
}

beforeEach(() => {
  resetVscodeStub();
});

describe("reader.ready 门控投递", () => {
  test("创建面板时不投递任何消息，HTML 已注入 CSP", () => {
    const harness = createHarness();
    const { panel } = openPanel(harness);
    expect(panel.webview.postedMessages).toHaveLength(0);
    expect(panel.webview.html).toContain("Content-Security-Policy");
    expect(panel.viewType).toBe("readora");
  });

  test("reader.ready 之后才投递 document.load 与 theme.update", async () => {
    const harness = createHarness();
    const { panel } = openPanel(harness);
    panel.webview.receive(createEnvelope("reader.ready", {}));
    await flush();
    const types = envelopeTypes(panel);
    expect(types).toContain("document.load");
    expect(types).toContain("theme.update");
  });

  test("theme.update 同时带明暗与来源两个轴", async () => {
    const harness = createHarness();
    const { panel } = openPanel(harness);
    panel.webview.receive(createEnvelope("reader.ready", {}));
    await flush();
    const message = panel.webview.postedMessages.find(
      (raw): raw is { type: string; payload: unknown } =>
        typeof raw === "object" && raw !== null && (raw as { type?: string }).type === "theme.update"
    );
    expect(message?.payload).toEqual({ theme: "dark", source: "product" });
  });

  test("建面板时 HTML 已预置主题属性（不等 theme.update）", () => {
    const harness = createHarness();
    const { panel } = openPanel(harness);
    expect(panel.webview.html).toContain('data-readora-theme="dark"');
    expect(panel.webview.html).toContain('data-readora-scheme="dark"');
  });

  test("归一结果没变就不重发 theme.update（ARC-006 §11.1 不重建 Reader Shell）", async () => {
    const harness = createHarness();
    const { panel } = openPanel(harness);
    panel.webview.receive(createEnvelope("reader.ready", {}));
    await flush();
    const themeCount = (): number =>
      envelopeTypes(panel).filter((type) => type === "theme.update").length;
    expect(themeCount()).toBe(1);
    // 与首帧一致的解析结果：product 模式下换宿主主题不该打扰已上色的页面。
    harness.webviews.broadcastTheme({ mode: "dark", source: "product" });
    expect(themeCount()).toBe(1);
    harness.webviews.broadcastTheme({ mode: "light", source: "product" });
    expect(themeCount()).toBe(2);
  });

  test("重复 reader.ready 不会重复投递 document.load", async () => {
    const harness = createHarness();
    const { panel } = openPanel(harness);
    panel.webview.receive(createEnvelope("reader.ready", {}));
    await flush();
    panel.webview.receive(createEnvelope("reader.ready", {}));
    await flush();
    const loads = envelopeTypes(panel).filter((type) => type === "document.load");
    expect(loads).toHaveLength(1);
  });

  test("超限文档在创建面板之前被拒绝", () => {
    const harness = createHarness();
    const { session } = harness.sessions.getOrCreate(DOCUMENT_URI);
    const oversized = snapshot({ text: "x".repeat(2_000_001) });
    expect(() =>
      harness.webviews.open(session, oversized, preferences, -1 as vscode.ViewColumn)
    ).toThrow(ReaderError);
    expect(createdPanels).toHaveLength(0);
  });

  test("面板 dispose 后暂存被清理，迟到的 ready 不投递", async () => {
    const harness = createHarness();
    const { session, panel } = openPanel(harness);
    panel.dispose();
    await flush();
    expect(session.isDisposed).toBe(true);
    panel.webview.receive(createEnvelope("reader.ready", {}));
    await flush();
    expect(envelopeTypes(panel)).not.toContain("document.load");
  });
});

describe("入站消息路由", () => {
  test("document.open 拒绝 file:// 链接", async () => {
    const harness = createHarness();
    const { panel } = openPanel(harness);
    panel.webview.receive(
      createEnvelope("document.open", { uri: "file:///etc/passwd" })
    );
    await flush();
    const response = responses(panel)[0];
    expect(response?.success).toBe(false);
    expect(response?.error?.code).toBe(READORA_ERROR_CODES.LINK_REJECTED);
    expect(harness.openedExternal).toHaveLength(0);
  });

  test("document.open 放行 https 链接", async () => {
    const harness = createHarness();
    const { panel } = openPanel(harness);
    panel.webview.receive(
      createEnvelope("document.open", { uri: "https://example.com/doc" })
    );
    await flush();
    const response = responses(panel)[0];
    expect(response?.success).toBe(true);
    expect(harness.openedExternal).toEqual(["https://example.com/doc"]);
  });

  test("resource.resolve 已注册：处理器结果作为成功载荷回传", async () => {
    const harness = createHarness();
    const { session, panel } = openPanel(harness);
    panel.webview.receive(
      createEnvelope("resource.resolve", {
        documentUri: DOCUMENT_URI,
        reference: "./img.png"
      })
    );
    await flush();
    const response = responses(panel)[0];
    expect(response?.success).toBe(true);
    expect(response?.payload).toMatchObject({
      webviewUri: "https://stub.vscode-cdn.net/tmp/img.png?1-3",
      mimeType: "image/png",
      kind: "image"
    });
    expect(harness.resolved).toHaveLength(1);
    expect(harness.resolved[0]?.sessionId).toBe(session.id);
    expect(harness.resolved[0]?.payload.kind).toBe("image");
  });

  test("resource.resolve 缺 reference 时按 INVALID_PAYLOAD 拒绝，不进处理器", async () => {
    const harness = createHarness();
    const { panel } = openPanel(harness);
    panel.webview.receive(
      createEnvelope("resource.resolve", { documentUri: DOCUMENT_URI })
    );
    await flush();
    const response = responses(panel)[0];
    expect(response?.success).toBe(false);
    expect(response?.error?.code).toBe(READORA_ERROR_CODES.INVALID_PAYLOAD);
    expect(harness.resolved).toHaveLength(0);
  });

  test("document.navigate 把会话 id 一并交给处理器（相对跳转需基准文档）", async () => {
    const harness = createHarness();
    const { session, panel } = openPanel(harness);
    panel.webview.receive(
      createEnvelope("document.navigate", { uri: "../docs/next.md" })
    );
    await flush();
    expect(responses(panel)[0]?.success).toBe(true);
    expect(harness.navigated).toEqual([
      { uri: "../docs/next.md", sessionId: session.id }
    ]);
  });

  test("非法信封返回 INVALID_MESSAGE", async () => {
    const harness = createHarness();
    const { panel } = openPanel(harness);
    panel.webview.receive({ garbage: true });
    await flush();
    const response = responses(panel)[0];
    expect(response?.success).toBe(false);
    expect(response?.error?.code).toBe(READORA_ERROR_CODES.INVALID_MESSAGE);
  });

  test("host-to-view 消息不得由 Webview 发起", async () => {
    const harness = createHarness();
    const { panel } = openPanel(harness);
    panel.webview.receive(createEnvelope("document.load", {}));
    await flush();
    const response = responses(panel)[0];
    expect(response?.success).toBe(false);
    expect(response?.error?.code).toBe(READORA_ERROR_CODES.UNSUPPORTED_MESSAGE);
  });

  test("state.save 文档不匹配时拒绝", async () => {
    const harness = createHarness();
    const { panel } = openPanel(harness);
    panel.webview.receive(
      createEnvelope("state.save", {
        documentUri: "file:///tmp/other.md",
        state: { scrollTop: 10, activeHeadingId: null }
      })
    );
    await flush();
    const response = responses(panel)[0];
    expect(response?.success).toBe(false);
    expect(response?.error?.code).toBe(READORA_ERROR_CODES.TARGET_INVALID);
  });

  test("state.save 匹配时写入会话阅读状态", async () => {
    const harness = createHarness();
    const { session, panel } = openPanel(harness);
    panel.webview.receive(
      createEnvelope("state.save", {
        documentUri: DOCUMENT_URI,
        state: { scrollTop: 42, activeHeadingId: "heading-1" }
      })
    );
    await flush();
    const response = responses(panel)[0];
    expect(response?.success).toBe(true);
    expect(session.readingState).toEqual({
      scrollTop: 42,
      activeHeadingId: "heading-1"
    });
  });
});

describe("增量更新版本护栏", () => {
  test("迟到的旧版本不得覆盖新版本", async () => {
    const harness = createHarness();
    const { session, panel } = openPanel(harness);
    session.documentVersion = 5;
    harness.webviews.pushUpdate(
      session,
      snapshot({ version: 3, text: "old" }),
      preferences
    );
    harness.webviews.pushUpdate(
      session,
      snapshot({ version: 6, text: "new" }),
      preferences
    );
    const updates = panel.webview.postedMessages.filter(
      (message): message is { type: string; payload: { version: number } } =>
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        (message as { type: string }).type === "document.update"
    );
    expect(updates).toHaveLength(1);
    expect(updates[0]?.payload.version).toBe(6);
  });
});