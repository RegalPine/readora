/**
 * 主题运行时与 React 集成（ARC-006 §8 / §10 / §11）。
 *
 * 分三层：`applyTheme` 的写入语义（含不可信输入不进 CSS 这条护栏）、
 * App 侧切换的六条约束（§11.1 逐条）、Context 只读（§10.1）。
 * 图表实例的「不重复创建」由 `content/__tests__/diagram-layer.spec.ts` 的
 * `syncTheme 只切 class` 与 markdown-content 的「主题切换不重解析」两条覆盖，
 * 这里不重复实现一遍引擎替身。
 */
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createEnvelope,
  ReaderPreferencesSchema,
  type DocumentLoadPayload,
  type MessageType,
  type ReaderPreferences
} from "@readora/contracts";
import { App } from "../App";
import { HostBridge, type MessageSource } from "../../bridge/host-bridge";
import type { VsCodeApi } from "../../bridge/vscode-api";
import {
  CONTENT_WIDTH_VARIABLE,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  FONT_SIZE_VARIABLE,
  LINE_HEIGHT_MAX,
  LINE_HEIGHT_MIN,
  LINE_HEIGHT_VARIABLE,
  applyTheme
} from "../theme";
import * as themeContext from "../theme-context";

const PREFERENCES: ReaderPreferences = {
  theme: "auto",
  fontSize: 17,
  lineHeight: 1.8,
  contentWidth: 720,
  showOutline: true,
  typography: "newsreader",
  themePreset: "default"
};

const TEXT = ["# Overview", "", "Body text stays put.", "", "## Architecture", "", "More.", ""].join("\n");

function root(): HTMLElement {
  return document.documentElement;
}

/** 每次取一个干净的元素：属性与变量都从零开始，用例之间不串味。 */
function freshRoot(): HTMLElement {
  const element = document.createElement("div");
  delete element.dataset.readoraTheme;
  delete element.dataset.readoraScheme;
  return element;
}

describe("applyTheme 写入语义", () => {
  afterEach(() => {
    root().removeAttribute("style");
    delete root().dataset.readoraTheme;
    delete root().dataset.readoraScheme;
  });

  it("两轴各写一个属性：palette 只走 themePalette 这一处映射", () => {
    const element = freshRoot();
    applyTheme(element, { mode: "dark", source: "product" });
    expect(element.dataset.readoraTheme).toBe("dark");
    expect(element.dataset.readoraScheme).toBe("dark");

    // vscode 取色来源下 palette 属性必须落到 vscode，明暗轴仍按解析结果走：
    // 代码配色与图表系列色要看的是后者（ARC-006 §6.2）。
    applyTheme(element, { mode: "dark", source: "vscode" });
    expect(element.dataset.readoraTheme).toBe("vscode");
    expect(element.dataset.readoraScheme).toBe("dark");

    applyTheme(element, { mode: "light", source: "system" });
    expect(element.dataset.readoraTheme).toBe("light");
    expect(element.dataset.readoraScheme).toBe("light");
  });

  it("三项偏好写成 :root 变量（PRD-003 §11.4 单一变量驱动）", () => {
    const element = freshRoot();
    applyTheme(element, { mode: "light", source: "product" }, PREFERENCES);
    expect(element.style.getPropertyValue(FONT_SIZE_VARIABLE)).toBe("17px");
    expect(element.style.getPropertyValue(LINE_HEIGHT_VARIABLE)).toBe("1.8");
    expect(element.style.getPropertyValue(CONTENT_WIDTH_VARIABLE)).toBe("720px");
    // 行高是无单位倍数：写成 1.8px 会把行间关系变成固定高度。
    expect(element.style.getPropertyValue(LINE_HEIGHT_VARIABLE)).not.toContain("px");
  });

  it("偏好缺省时只写属性，不动变量（缺省值归 tokens.css）", () => {
    const element = freshRoot();
    element.style.setProperty(FONT_SIZE_VARIABLE, "20px");
    applyTheme(element, { mode: "dark", source: "product" });
    expect(element.dataset.readoraTheme).toBe("dark");
    expect(element.style.getPropertyValue(FONT_SIZE_VARIABLE)).toBe("20px");
  });

  it("非有限值不拼进 CSS，越界值夹回区间（ARC-006 §8.1）", () => {
    const element = freshRoot();
    applyTheme(element, { mode: "light", source: "product" }, {
      fontSize: Number("1px; background: url(http://evil)"),
      lineHeight: Number.POSITIVE_INFINITY,
      contentWidth: Number.NaN
    });
    expect(element.style.getPropertyValue(FONT_SIZE_VARIABLE)).toBe("");
    expect(element.style.getPropertyValue(LINE_HEIGHT_VARIABLE)).toBe("");
    expect(element.style.getPropertyValue(CONTENT_WIDTH_VARIABLE)).toBe("");

    applyTheme(element, { mode: "light", source: "product" }, {
      fontSize: 1,
      lineHeight: 99,
      contentWidth: 10
    });
    expect(element.style.getPropertyValue(FONT_SIZE_VARIABLE)).toBe(`${FONT_SIZE_MIN}px`);
    expect(element.style.getPropertyValue(LINE_HEIGHT_VARIABLE)).toBe(`${LINE_HEIGHT_MAX}`);
    expect(element.style.getPropertyValue(CONTENT_WIDTH_VARIABLE)).toBe("480px");
  });

  it("缩放只改字号变量，且仍夹在 8–32px（PRD-003 §10.5 × §11.4）", () => {
    const element = freshRoot();
    applyTheme(element, { mode: "light", source: "product" }, PREFERENCES, 1.5);
    expect(element.style.getPropertyValue(FONT_SIZE_VARIABLE)).toBe("26px");
    // 行高是倍数、内容宽度是版面约束：都不跟着缩放走。跟着走的话缩放的就成了
    // 「字相对行」的关系，那是字号偏好的职责，不是视图动作。
    expect(element.style.getPropertyValue(LINE_HEIGHT_VARIABLE)).toBe("1.8");
    expect(element.style.getPropertyValue(CONTENT_WIDTH_VARIABLE)).toBe("720px");

    // 端点之外仍夹回区间：缩放不该把正文推出可读范围。
    applyTheme(element, { mode: "light", source: "product" }, PREFERENCES, 5);
    expect(element.style.getPropertyValue(FONT_SIZE_VARIABLE)).toBe(`${FONT_SIZE_MAX}px`);
    applyTheme(element, { mode: "light", source: "product" }, PREFERENCES, 0.01);
    expect(element.style.getPropertyValue(FONT_SIZE_VARIABLE)).toBe(`${FONT_SIZE_MIN}px`);

    // 缩放本身非法（编程错误）按 1 处理，不连带抹掉用户的字号偏好。
    applyTheme(element, { mode: "light", source: "product" }, PREFERENCES, Number.NaN);
    expect(element.style.getPropertyValue(FONT_SIZE_VARIABLE)).toBe("17px");
    // 但基准非法就一律不写：缺省值的权威是 tokens.css，不是 JS 里的第二个 16。
    applyTheme(element, { mode: "light", source: "product" }, { ...PREFERENCES, fontSize: Number.NaN });
    expect(element.style.getPropertyValue(FONT_SIZE_VARIABLE)).toBe("17px");
  });

  it("边界与 ReaderPreferencesSchema 一致：配置能过的值必须原样生效", () => {
    for (const fontSize of [FONT_SIZE_MIN, FONT_SIZE_MAX]) {
      for (const lineHeight of [LINE_HEIGHT_MIN, LINE_HEIGHT_MAX]) {
        const parsed = ReaderPreferencesSchema.safeParse({
          theme: "auto",
          fontSize,
          lineHeight,
          contentWidth: 820,
          showOutline: true,
          typography: "newsreader",
          themePreset: "default"
        });
        expect(parsed.success, `schema 应放行 ${fontSize}/${lineHeight}`).toBe(true);
        const element = freshRoot();
        applyTheme(element, { mode: "light", source: "product" }, {
          fontSize,
          lineHeight,
          contentWidth: 820
        });
        expect(element.style.getPropertyValue(FONT_SIZE_VARIABLE)).toBe(`${fontSize}px`);
        expect(element.style.getPropertyValue(LINE_HEIGHT_VARIABLE)).toBe(`${lineHeight}`);
      }
    }
  });

  it("幂等：同一状态重复应用不改任何其他状态", () => {
    const element = freshRoot();
    applyTheme(element, { mode: "dark", source: "vscode" }, PREFERENCES);
    const cssText = element.getAttribute("style");
    applyTheme(element, { mode: "dark", source: "vscode" }, PREFERENCES);
    expect(element.getAttribute("style")).toBe(cssText);
  });
});

/** Host 侧消息源替身：只记录投递，不模拟应答。 */
function harness() {
  const posted: Array<{ type: MessageType; payload: unknown }> = [];
  const listeners: Array<(event: { data: unknown }) => void> = [];
  const api: VsCodeApi = {
    postMessage: (message: unknown) => {
      posted.push(message as { type: MessageType; payload: unknown });
    },
    getState: () => undefined,
    setState: () => undefined
  };
  const source: MessageSource = {
    addEventListener: (_type, listener) => {
      listeners.push(listener as (event: { data: unknown }) => void);
    },
    removeEventListener: () => undefined
  };
  const bridge = new HostBridge(api, source);
  return {
    bridge,
    posted,
    emit(type: MessageType, payload: unknown): void {
      const envelope = createEnvelope(type, payload);
      for (const listener of [...listeners]) {
        listener({ data: envelope });
      }
    }
  };
}

function payloadFor(overrides: Partial<DocumentLoadPayload> = {}): DocumentLoadPayload {
  return {
    documentUri: "file:///vault/notes/theme.md",
    languageId: "markdown",
    version: 1,
    text: TEXT,
    preferences: PREFERENCES,
    ...overrides
  };
}

describe("切换主题的六条约束（ARC-006 §11.1）", () => {
  let scrollY = 0;

  beforeEach(() => {
    scrollY = 0;
    Object.defineProperty(window, "scrollY", { configurable: true, writable: true, value: 0 });
  });

  afterEach(() => {
    cleanup();
    root().removeAttribute("style");
    delete root().dataset.readoraTheme;
    delete root().dataset.readoraScheme;
  });

  function setup() {
    const host = harness();
    render(<App bridge={host.bridge} />);
    act(() => {
      host.emit("document.load", payloadFor());
      host.emit("theme.update", { theme: "light", source: "product" });
      host.emit("reader.viewState", { focusMode: false, outlineVisible: true, contentWidth: 820 });
    });
    return host;
  }

  it("只改属性：文档不重载、Reader Shell 不重建、正文 DOM 不动", () => {
    const host = setup();
    const shell = document.querySelector(".readora-shell");
    const article = document.querySelector(".readora-document");
    const title = document.querySelector(".readora-document-title");
    const postsBefore = host.posted.length;

    act(() => {
      host.emit("theme.update", { theme: "dark", source: "vscode" });
    });

    expect(root().dataset.readoraTheme).toBe("vscode");
    expect(root().dataset.readoraScheme).toBe("dark");
    // 1 不重新加载文档：正文节点全等，且没有新的对 Host 投递。
    expect(document.querySelector(".readora-document")).toBe(article);
    expect(document.querySelector(".readora-document-title")).toBe(title);
    expect(host.posted).toHaveLength(postsBefore);
    // 2 不重建 Reader Shell：外壳与工具栏同一批节点。
    expect(document.querySelector(".readora-shell")).toBe(shell);
    expect(document.querySelector(".readora-toolbar")).not.toBeNull();
  });

  it("不重置滚动位置，也不影响当前导航状态", () => {
    const host = setup();
    const scrollTo = vi.fn();
    window.scrollTo = scrollTo;
    Object.defineProperty(window, "scrollY", { configurable: true, writable: true, value: 1_200 });
    scrollY = 1_200;
    // 目录点选把导航态推进到「已定位」，切换主题不该把它抹平。
    const link = document.querySelector<HTMLElement>(".readora-outline-link");
    expect(link).not.toBeNull();
    act(() => {
      link?.click();
    });
    scrollTo.mockClear();
    const pinnedActive = document.querySelectorAll(".readora-outline-link[aria-current]").length;

    act(() => {
      host.emit("theme.update", { theme: "dark", source: "system" });
    });

    // 3 不重置滚动：没有任何 scrollTo 调用，窗口位置保持。
    expect(scrollTo).not.toHaveBeenCalled();
    expect(window.scrollY).toBe(scrollY);
    // 4 不影响导航状态：高亮条目数量与切换前一致。
    expect(document.querySelectorAll(".readora-outline-link[aria-current]").length).toBe(pinnedActive);
  });

  it("偏好变化只改变量：字号与行高跟随 config.update", () => {
    const host = setup();
    expect(root().style.getPropertyValue(FONT_SIZE_VARIABLE)).toBe("17px");
    act(() => {
      host.emit("config.update", { preferences: { ...PREFERENCES, fontSize: 21, lineHeight: 2 } });
    });
    expect(root().style.getPropertyValue(FONT_SIZE_VARIABLE)).toBe("21px");
    expect(root().style.getPropertyValue(LINE_HEIGHT_VARIABLE)).toBe("2");
    // 宽度仍以会话视图状态为准（M4 的优先级不变，只是换了载体）。
    expect(root().style.getPropertyValue(CONTENT_WIDTH_VARIABLE)).toBe("820px");
  });
});

describe("Theme Context（ARC-006 §10.1）", () => {
  it("只读：不导出任何写入通道", () => {
    // Webview 没有 View→Host 的主题写入通道，给了 setMode 就是按不动的假开关。
    expect(Object.keys(themeContext).sort()).toStrictEqual([
      "DEFAULT_THEME_CONTEXT",
      "ThemeProvider",
      "useTheme"
    ]);
    expect(themeContext.DEFAULT_THEME_CONTEXT).not.toHaveProperty("setMode");
  });

  it("缺省值是产品亮色 + 偏好缺省，与首帧预置之前的状态一致", () => {
    expect(themeContext.DEFAULT_THEME_CONTEXT).toStrictEqual({
      theme: "light",
      source: "product",
      preferences: null
    });
  });

  it("消费者拿到 App 持有的那份状态（单一来源，不做二次状态）", () => {
    const host = harness();
    const view = render(<App bridge={host.bridge} />);
    act(() => {
      host.emit("document.load", payloadFor());
      host.emit("theme.update", { theme: "dark", source: "vscode" });
    });
    view.rerender(<App bridge={host.bridge} />);
    // Provider 的值与 `<html>` 上的属性同源：两处不一致就等于双份主题态。
    expect(root().dataset.readoraTheme).toBe("vscode");
    expect(root().dataset.readoraScheme).toBe("dark");
  });

  it("Provider 之外的消费者退回缺省值（孤立单测不必套一层 Provider）", () => {
    const Probe = () => {
      const value = themeContext.useTheme();
      return <span data-testid="probe">{`${value.theme}/${value.source}/${value.preferences === null}`}</span>;
    };
    const { getByTestId } = render(<Probe />);
    expect(getByTestId("probe").textContent).toBe("light/product/true");
    cleanup();

    const wrapped = render(
      <themeContext.ThemeProvider
        value={{ theme: "dark", source: "system", preferences: PREFERENCES }}
      >
        <Probe />
      </themeContext.ThemeProvider>
    );
    expect(wrapped.getByTestId("probe").textContent).toBe("dark/system/false");
  });
});
