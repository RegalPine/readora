/**
 * 会话视图状态测试（ARC-004 §4.1 focusMode / toggleOutline、§4.5 宽度键位、
 * §6.2 ReaderSessionState；投递门控沿用 §8.7）。
 *
 * 断言的是「命令 → 会话状态 → reader.viewState」这条链的三件事：
 * 1. 初值来自偏好，命令只改会话、不回写用户设置；
 * 2. 宽度收口在契约区间 [480, 1600]，越界只到边界；
 * 3. 面板未 ready 时只更新状态不投递，ready 后随首帧补投。
 *
 * 末尾再加一条弹层回路：`config.patch` 写回的配置键必须能被同一进程读回并广播，
 * 那是用户在真实宿主里报过的缺陷形状（写进了 settings.json、界面无反应）。
 */
import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("vscode", async () => await import("../__stubs__/vscode"));

import type * as vscode from "vscode";
import {
  CONTENT_WIDTH_MAX,
  CONTENT_WIDTH_MIN,
  createEnvelope,
  type ReaderPreferences,
  type ViewStatePayload
} from "@readora/contracts";
import { createReaderApplication } from "../application";
import { CONTENT_WIDTH_STEP, clampContentWidth } from "../session/session-manager";
import {
  commandHandlers,
  configValues,
  contextValues,
  createdPanels,
  errorMessages,
  fileStates,
  FileType,
  fireDidChangeConfiguration,
  resetVscodeStub,
  Uri,
  warningMessages,
  type FakePanel
} from "../__stubs__/vscode";

const DOC = "file:///docs/read.md";

const flush = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

function seedDocument(): void {
  fileStates.set("/docs/read.md", { type: FileType.File, size: 32, mtime: 5 });
}

/** 面板 + 已投递消息里的 reader.viewState（没有返回 null）。 */
function postedViewState(panel: FakePanel): ViewStatePayload | null {
  for (const message of [...panel.webview.postedMessages].reverse()) {
    if (
      typeof message === "object" &&
      message !== null &&
      "type" in message &&
      message.type === "reader.viewState"
    ) {
      return (message as unknown as { payload: ViewStatePayload }).payload;
    }
  }
  return null;
}

function viewStateCount(panel: FakePanel): number {
  return panel.webview.postedMessages.filter(
    (message) =>
      typeof message === "object" &&
      message !== null &&
      "type" in message &&
      message.type === "reader.viewState"
  ).length;
}

/** 最后一条已投递的 config.update 里的偏好（没有返回 null）。 */
function postedPreferences(panel: FakePanel): ReaderPreferences | null {
  for (const message of [...panel.webview.postedMessages].reverse()) {
    if (
      typeof message === "object" &&
      message !== null &&
      "type" in message &&
      message.type === "config.update"
    ) {
      return (message as unknown as { payload: { preferences: ReaderPreferences } }).payload
        .preferences;
    }
  }
  return null;
}

function command(id: string): (...args: unknown[]) => Promise<unknown> {
  const handler = commandHandlers.get(id);
  if (!handler) {
    throw new Error(`${id} was not registered`);
  }
  return (args: unknown) => Promise.resolve(handler(args));
}

/**
 * 打开阅读器；`ready: false` 用于验证首帧门控之前的行为。
 */
async function open(
  options: { ready?: boolean; preferences?: Record<string, unknown> } = {}
): Promise<FakePanel> {
  seedDocument();
  for (const [key, value] of Object.entries(options.preferences ?? {})) {
    configValues.set(`readora.${key}`, value);
  }
  const app = createReaderApplication({
    extensionUri: Uri.file("/ext") as unknown as vscode.Uri
  } as unknown as vscode.ExtensionContext);
  app.activate();
  await command("readora.openReader")(Uri.parse(DOC));
  await flush();
  const panel = createdPanels[0];
  if (!panel) {
    throw new Error("reader panel was not created");
  }
  if (options.ready !== false) {
    panel.webview.receive(createEnvelope("reader.ready", {}));
    await flush();
  }
  return panel;
}

beforeEach(() => {
  resetVscodeStub();
});

describe("reader.viewState 初值", () => {
  test("outlineVisible / contentWidth 取偏好，focusMode 恒为 false", async () => {
    const panel = await open({
      preferences: { showOutline: false, contentWidth: 1000 }
    });
    expect(postedViewState(panel)).toEqual({
      focusMode: false,
      outlineVisible: false,
      contentWidth: 1000
    });
  });

  test("偏好缺省时按配置默认值起步（showOutline true / contentWidth 820）", async () => {
    const panel = await open();
    expect(postedViewState(panel)).toEqual({
      focusMode: false,
      outlineVisible: true,
      contentWidth: 820
    });
  });

  test("偏好越界不投非法载荷，宽度钳到上界", async () => {
    const panel = await open({ preferences: { contentWidth: 9999 } });
    const viewState = postedViewState(panel);
    expect(viewState?.contentWidth).toBe(CONTENT_WIDTH_MAX);
    // 载荷本身仍过 Schema：能取到就说明 parsePayload 没拒绝。
    expect(viewState).not.toBeNull();
  });
});

describe("视图命令", () => {
  test("focusMode 与 toggleOutline 各切两次回到初值（幂等）", async () => {
    const panel = await open();
    const toggleFocus = command("readora.focusMode");
    const toggleOutline = command("readora.toggleOutline");

    await toggleFocus(undefined);
    expect(postedViewState(panel)?.focusMode).toBe(true);
    await toggleFocus(undefined);
    expect(postedViewState(panel)?.focusMode).toBe(false);

    await toggleOutline(undefined);
    expect(postedViewState(panel)?.outlineVisible).toBe(false);
    await toggleOutline(undefined);
    expect(postedViewState(panel)?.outlineVisible).toBe(true);
  });

  test("切换 focusMode 不动 outlineVisible 与宽度", async () => {
    const panel = await open({ preferences: { showOutline: true, contentWidth: 900 } });
    await command("readora.focusMode")(undefined);
    expect(postedViewState(panel)).toEqual({
      focusMode: true,
      outlineVisible: true,
      contentWidth: 900
    });
  });

  test("宽度命令按 80px 步进，方向由参数给出", async () => {
    const panel = await open({ preferences: { contentWidth: 820 } });
    const adjust = command("readora.adjustContentWidth");
    await adjust(1);
    expect(postedViewState(panel)?.contentWidth).toBe(820 + CONTENT_WIDTH_STEP);
    await adjust(-1);
    await adjust(-1);
    expect(postedViewState(panel)?.contentWidth).toBe(820 - CONTENT_WIDTH_STEP);
  });

  test("宽度连续增减钳在 [480, 1600]，不越契约界", async () => {
    const panel = await open({ preferences: { contentWidth: 520 } });
    const adjust = command("readora.adjustContentWidth");
    for (let i = 0; i < 10; i += 1) {
      await adjust(-1);
    }
    expect(postedViewState(panel)?.contentWidth).toBe(CONTENT_WIDTH_MIN);
    for (let i = 0; i < 40; i += 1) {
      await adjust(1);
    }
    expect(postedViewState(panel)?.contentWidth).toBe(CONTENT_WIDTH_MAX);
  });

  test("空参数与非法参数按减档处理，不放大小", async () => {
    const panel = await open({ preferences: { contentWidth: 820 } });
    const adjust = command("readora.adjustContentWidth");
    await adjust(undefined);
    expect(postedViewState(panel)?.contentWidth).toBe(820 - CONTENT_WIDTH_STEP);
    await adjust("wider");
    expect(postedViewState(panel)?.contentWidth).toBe(820 - 2 * CONTENT_WIDTH_STEP);
  });

  test("命令只改会话状态，不写用户设置", async () => {
    const panel = await open({ preferences: { showOutline: true, contentWidth: 820 } });
    await command("readora.toggleOutline")(undefined);
    await command("readora.adjustContentWidth")(1);
    expect(configValues.get("readora.showOutline")).toBe(true);
    expect(configValues.get("readora.contentWidth")).toBe(820);
    expect(postedViewState(panel)?.outlineVisible).toBe(false);
  });
});

describe("配置变更与视图状态", () => {
  test("showOutline 以配置为准覆盖，focusMode 与命令宽度保留会话值", async () => {
    const panel = await open({ preferences: { showOutline: true, contentWidth: 820 } });
    await command("readora.focusMode")(undefined);
    await command("readora.adjustContentWidth")(1);
    expect(postedViewState(panel)).toEqual({
      focusMode: true,
      outlineVisible: true,
      contentWidth: 820 + CONTENT_WIDTH_STEP
    });

    configValues.set("readora.showOutline", false);
    fireDidChangeConfiguration();
    await flush();
    expect(postedViewState(panel)).toEqual({
      focusMode: true,
      outlineVisible: false,
      contentWidth: 820 + CONTENT_WIDTH_STEP
    });

    // 再改回 true：证明覆盖是「跟着配置走」而不是一次性置假。
    configValues.set("readora.showOutline", true);
    fireDidChangeConfiguration();
    await flush();
    expect(postedViewState(panel)).toEqual({
      focusMode: true,
      outlineVisible: true,
      contentWidth: 820 + CONTENT_WIDTH_STEP
    });
  });
});

describe("投递门控（ARC-004 §8.7）", () => {
  test("未 ready 时命令只更新会话状态，不投递 reader.viewState", async () => {
    const panel = await open({ ready: false });
    expect(panel.webview.postedMessages).toHaveLength(0);
    await command("readora.focusMode")(undefined);
    await flush();
    expect(viewStateCount(panel)).toBe(0);
  });

  test("ready 后随首帧补投，且带的是命令改过的最新状态", async () => {
    const panel = await open({ ready: false, preferences: { contentWidth: 820 } });
    await command("readora.focusMode")(undefined);
    await command("readora.adjustContentWidth")(1);
    panel.webview.receive(createEnvelope("reader.ready", {}));
    await flush();
    expect(viewStateCount(panel)).toBe(1);
    expect(postedViewState(panel)).toEqual({
      focusMode: true,
      outlineVisible: true,
      contentWidth: 820 + CONTENT_WIDTH_STEP
    });
    const types = panel.webview.postedMessages
      .filter((message) => "type" in (message as object))
      .map((message) => (message as { type: string }).type);
    // 视图状态排在 document.load 之后、state.restore 之前。
    expect(types.indexOf("reader.viewState")).toBeGreaterThan(
      types.indexOf("document.load")
    );
  });

  test("重复 ready 不重复补投视图状态", async () => {
    const panel = await open({ ready: false });
    panel.webview.receive(createEnvelope("reader.ready", {}));
    await flush();
    panel.webview.receive(createEnvelope("reader.ready", {}));
    await flush();
    expect(viewStateCount(panel)).toBe(1);
  });

  test("ready 之后的命令即时投递一条新的 reader.viewState", async () => {
    const panel = await open();
    const before = viewStateCount(panel);
    await command("readora.toggleOutline")(undefined);
    await flush();
    expect(viewStateCount(panel)).toBe(before + 1);
  });
});

describe("readora.readerActive 上下文键", () => {
  test("建面板置真，面板隐藏与释放置假", async () => {
    const panel = await open();
    expect(contextValues.get("readora.readerActive")).toBe(true);
    panel.setVisible(false);
    expect(contextValues.get("readora.readerActive")).toBe(false);
    panel.setVisible(true);
    expect(contextValues.get("readora.readerActive")).toBe(true);
    panel.dispose();
    expect(contextValues.get("readora.readerActive")).toBe(false);
  });
});

describe("无会话时的命令行为", () => {
  test("三条视图命令空转，不弹通知", async () => {
    const app = createReaderApplication({
      extensionUri: Uri.file("/ext") as unknown as vscode.Uri
    } as unknown as vscode.ExtensionContext);
    app.activate();
    await command("readora.focusMode")(undefined);
    await command("readora.toggleOutline")(undefined);
    await command("readora.adjustContentWidth")(1);
    await flush();
    expect(errorMessages).toHaveLength(0);
    expect(warningMessages).toHaveLength(0);
    expect(createdPanels).toHaveLength(0);
  });
});

describe("clampContentWidth", () => {
  test("非整数向下取整，NaN 回落下界，±Infinity 顶到对应边界", () => {
    expect(clampContentWidth(820.9)).toBe(820);
    expect(clampContentWidth(479.5)).toBe(CONTENT_WIDTH_MIN);
    expect(clampContentWidth(Number.NaN)).toBe(CONTENT_WIDTH_MIN);
    expect(clampContentWidth(Number.POSITIVE_INFINITY)).toBe(CONTENT_WIDTH_MAX);
    expect(clampContentWidth(Number.NEGATIVE_INFINITY)).toBe(CONTENT_WIDTH_MIN);
    expect(clampContentWidth(CONTENT_WIDTH_MAX + 1)).toBe(CONTENT_WIDTH_MAX);
  });
});

/**
 * 弹层改预设的完整回路（用户在宿主里报出的「点 High contrast 没反应」）。
 *
 * 只断言 patchPreference 的返回值是不够的：Webview 不认那份响应，它等的是
 * Host 广播的 config.update。于是「写盘成功但读不回」在上一代护栏里全绿。
 * 本用例把写→读→广播跑成真实回路，配置键形状一变就当场红。
 */
describe("Reader Settings 的写回回路", () => {
  test("config.patch themePreset → 落盘、读回、广播同一值", async () => {
    const panel = await open({ preferences: { themePreset: "default" } });
    expect(postedPreferences(panel)).toBeNull();

    panel.webview.receive(
      createEnvelope("config.patch", { key: "themePreset", value: "high-contrast" })
    );
    await flush();

    expect(configValues.get("readora.themePreset")).toBe("high-contrast");
    expect(postedPreferences(panel)?.themePreset).toBe("high-contrast");
  });
});
