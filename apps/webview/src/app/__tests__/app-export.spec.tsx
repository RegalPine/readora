/**
 * App 侧导出接线测试（M11）。
 *
 * 走真实 HostBridge，于是这里同时证明三条补设消息在 View 侧真的能用：
 * 1. 菜单点击只发 `export.request`，**不发** `export.data` —— 没有用户选定的路径，
 *    序列化一次都不该做（那是 capture 之后的事）；
 * 2. `export.capture` 之后交出的载荷必须过契约，且正文里既没有会话内地址也没有
 *    接管层的壳；
 * 3. 同一个 requestId 只交一帧；没有正文时报错而不是交一份空正文。
 */
import { afterEach, describe, expect, test } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  READORA_ERROR_CODES,
  parsePayload,
  type DocumentLoadPayload,
  type ExportDataPayload,
  type ReaderPreferences
} from "@readora/contracts";
import { createBridgeHarness } from "../../__tests__/bridge-harness";
import { App } from "../App";
import { EXPORT_MENU_ATTRIBUTE } from "../ExportMenu";

const DOC_URI = "file:///vault/notes/export.md";

const PREFERENCES: ReaderPreferences = {
  theme: "auto",
  fontSize: 17,
  lineHeight: 1.8,
  contentWidth: 720,
  showOutline: true,
  typography: "newsreader",
  themePreset: "default"
};

const TEXT = [
  "# Export",
  "",
  "Some prose with an image: ![diagram](assets/a.png).",
  "",
  "```ts",
  "const answer = 42",
  "```",
  ""
].join("\n");

afterEach(cleanup);

function setup(load = true) {
  const host = createBridgeHarness();
  render(<App bridge={host.bridge} />);
  if (load) {
    const payload: DocumentLoadPayload = {
      documentUri: DOC_URI,
      languageId: "markdown",
      version: 5,
      text: TEXT,
      preferences: PREFERENCES
    };
    act(() => {
      host.emit("document.load", payload);
      host.emit("theme.update", { theme: "light", source: "product" });
    });
  }
  return host;
}

function openMenu(): void {
  fireEvent.click(screen.getByRole("button", { name: "Export document" }));
}

function dataOf(host: ReturnType<typeof createBridgeHarness>): ExportDataPayload[] {
  return host.sent("export.data") as ExportDataPayload[];
}

describe("菜单点击 → export.request", () => {
  test("选一档只发意图，不发正文", () => {
    const host = setup();
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Export as PDF" }));
    expect(host.sent("export.request")).toEqual([{ format: "pdf" }]);
    expect(host.sent("export.data")).toHaveLength(0);
  });

  test("三档各自落到正确的 format，且菜单收起", () => {
    for (const [label, format] of [
      ["Export as HTML", "html"],
      ["Export as PDF", "pdf"],
      ["Export as PNG", "png"]
    ] as const) {
      cleanup();
      const host = setup();
      const trigger = screen.getByRole("button", { name: "Export document" });
      expect(trigger.getAttribute("aria-expanded")).toBe("false");
      openMenu();
      expect(trigger.getAttribute("aria-expanded")).toBe("true");
      fireEvent.click(screen.getByRole("menuitem", { name: label }));
      expect(host.sent("export.request")).toEqual([{ format }]);
      expect(trigger.getAttribute("aria-expanded")).toBe("false");
      expect(document.querySelector(`[${EXPORT_MENU_ATTRIBUTE}]`)).not.toBeNull();
    }
  });

  test("专注模式下没有导出入口（顶栏整体收起是现有口径）", () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Enter focus mode" }));
    expect(screen.queryByRole("button", { name: "Export document" })).toBeNull();
  });
});

describe("export.capture → export.data", () => {
  test("交出的载荷过契约，且带着当前文档的 uri 与版本", () => {
    const host = setup();
    act(() => {
      host.emit("export.capture", { requestId: "exp-1", format: "html" });
    });
    const [payload] = dataOf(host);
    expect(payload).toBeDefined();
    expect(parsePayload("export.data", payload).ok).toBe(true);
    expect(payload?.documentUri).toBe(DOC_URI);
    expect(payload?.version).toBe(5);
    expect(payload?.requestId).toBe("exp-1");
    expect(payload?.format).toBe("html");
  });

  test("正文里没有会话内地址、没有接管层的壳", () => {
    const host = setup();
    act(() => {
      host.emit("export.capture", { requestId: "exp-2", format: "pdf" });
    });
    const [payload] = dataOf(host);
    expect(payload?.bodyHtml).not.toContain("vscode-webview://");
    expect(payload?.bodyHtml).not.toContain("readora-code-editor");
    expect(payload?.bodyHtml).not.toContain("data-readora-code-editor-state");
    expect(payload?.bodyHtml).toContain("readora-code-pre");
    // 高亮器会把一行拆成好几个 span，比文本要先降标签；不这么写就是在测
    // 「highlight.js 今早把 const 染成哪个颜色」。
    expect((payload?.bodyHtml ?? "").replace(/<[^>]*>/g, "")).toContain("const answer = 42");
    expect(payload?.bodyHtml).toContain("data-readora-image=");
  });

  test("rootStyleText 是这一帧生效的偏好（缩放已折进字号）", () => {
    const host = setup();
    act(() => {
      host.emit("export.capture", { requestId: "exp-3", format: "png" });
    });
    const [payload] = dataOf(host);
    expect(payload?.rootStyleText).toContain("--readora-font-size: 17px");
    expect(payload?.rootStyleText).toContain("--readora-content-width: 720px");
  });

  test("同一个 requestId 重投只交一帧", () => {
    const host = setup();
    act(() => {
      host.emit("export.capture", { requestId: "exp-4", format: "html" });
      host.emit("export.capture", { requestId: "exp-4", format: "html" });
    });
    expect(dataOf(host)).toHaveLength(1);
    act(() => {
      host.emit("export.capture", { requestId: "exp-5", format: "html" });
    });
    expect(dataOf(host)).toHaveLength(2);
  });

  test("没有正文时报 EXPORT_FAILED，不交空载荷", () => {
    const host = setup(false);
    act(() => {
      host.emit("export.capture", { requestId: "exp-6", format: "html" });
    });
    expect(host.sent("export.data")).toHaveLength(0);
    const errors = host.sent("reader.error") as Array<{ code: string }>;
    expect(errors[0]?.code).toBe(READORA_ERROR_CODES.EXPORT_FAILED);
  });
});
