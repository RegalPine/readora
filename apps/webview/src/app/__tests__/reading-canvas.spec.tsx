/**
 * ReadingCanvas 组件测试（IMP-001 §14 Component Test，计划 §「apps/webview 集成」）。
 *
 * 覆盖画布结构（DocumentHeader / 诊断提示条 / 偏好内联生效）与 M3 装配点：
 * 四个交互通道是否真的接到 bridge 的 notify 与 request 上，
 * 以及 Lightbox 覆盖层的开关与焦点归还。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { DocumentLoadPayload } from "@readora/contracts";
import type { MarkdownRenderResult, RenderRequest } from "@readora/markdown-core";
import { fakeBridge, okResult } from "../../content/__tests__/test-support";
import { ReadingCanvas, fileNameOf } from "../ReadingCanvas";

/** 供 vi.mock 工厂读取的可变开关（工厂会被提升到 import 之前，只能靠 hoisted 持有）。 */
const injection = vi.hoisted(() => ({ injectError: false }));

vi.mock("@readora/markdown-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@readora/markdown-core")>();
  return {
    ...actual,
    renderMarkdown: (request: RenderRequest): MarkdownRenderResult => {
      const result = actual.renderMarkdown(request);
      if (!injection.injectError) {
        return result;
      }
      return {
        ...result,
        diagnostics: [
          {
            code: "readora.render.parse-failed",
            severity: "error",
            message: "模拟整篇失败"
          },
          ...result.diagnostics
        ]
      };
    }
  };
});

const PREFERENCES = {
  theme: "auto" as const,
  fontSize: 17,
  lineHeight: 1.8,
  contentWidth: 720,
  showOutline: false,
  typography: "newsreader" as const,
  themePreset: "default" as const
};

function payloadFor(overrides: Partial<DocumentLoadPayload> = {}): DocumentLoadPayload {
  return {
    documentUri: "file:///vault/%E7%AC%94%E8%AE%B0/note-one.md",
    languageId: "markdown",
    version: 1,
    text: "# 一级\n\n正文\n",
    preferences: PREFERENCES,
    ...overrides
  };
}

/** 画布替身：默认能应答 resource.resolve，测试按需换掉响应。 */
type TestBridge = ReturnType<typeof fakeBridge>;

function defaultBridge(): TestBridge {
  return fakeBridge({ "resource.resolve": okResult("assets/logo.png") });
}

function setup(payload: DocumentLoadPayload, bridge: TestBridge = defaultBridge()) {
  const view = render(<ReadingCanvas payload={payload} theme="light" bridge={bridge} />);
  const main = view.container.querySelector("main");
  if (!main) {
    throw new Error("readora-canvas main missing");
  }
  return { ...view, main, bridge };
}

afterEach(() => {
  cleanup();
  injection.injectError = false;
  vi.restoreAllMocks();
});

describe("DocumentHeader", () => {
  it("frontmatter 标题优先于文件名", () => {
    const { main } = setup(payloadFor({ text: "---\ntitle: 阅读笔记\n---\n\n# 章节\n" }));
    expect(main.querySelector(".readora-document-title")?.textContent).toBe("阅读笔记");
    // 文件名行已移除，VS Code 原生面包屑已提供路径信息
    expect(main.querySelector(".readora-document-source")).toBeNull();
  });

  it("无 frontmatter 时标题回落为文件名，文件名做 URI 解码", () => {
    const { main } = setup(payloadFor({ text: "# 章节\n" }));
    expect(main.querySelector(".readora-document-title")?.textContent).toBe("note-one.md");
    expect(fileNameOf("file:///vault/笔记/第二章.md")).toBe("第二章.md");
    expect(fileNameOf("file:///vault/%E7%AC%94%E8%AE%B0/a.md")).toBe("a.md");
  });

  it("正文渲染进 .readora-document，不再输出原始 <pre>", () => {
    const { main } = setup(payloadFor({ text: "# 章节\n\n- 项目\n" }));
    expect(main.querySelector(".readora-document h1")?.textContent).toBe("章节");
    expect(main.querySelector(".readora-list-item")).not.toBeNull();
    expect(main.querySelector("pre.readora-raw")).toBeNull();
  });
});

describe("诊断提示条", () => {
  it("error 级诊断以页内提示条呈现，可折叠且不弹通知", async () => {
    injection.injectError = true;
    const { main, bridge } = setup(payloadFor({ text: "# 章节\n" }));
    const bar = main.querySelector(".readora-diagnostic-bar");
    expect(bar?.textContent).toContain("1 rendering problem");
    expect(bar?.textContent).toContain("模拟整篇失败");
    expect(bridge.notifications).toHaveLength(0);

    const toggle = bar?.querySelector<HTMLButtonElement>(".readora-diagnostic-toggle");
    expect(toggle?.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(toggle as HTMLButtonElement);
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    expect(main.querySelector(".readora-diagnostic-list")).toBeNull();
  });

  it("无 error 诊断时不显示提示条", () => {
    const { main } = setup(payloadFor({ text: "# 章节\n\n```unknownlang\nx\n```\n" }));
    expect(main.querySelector(".readora-diagnostic-bar")).toBeNull();
  });
});

describe("偏好与外链", () => {
  // M5 起偏好不再写内联样式（PRD-003 §11.4 单一变量驱动）：三项偏好由 App 落到
  // `<html>` 的变量上，本层只留类名。取值断言在 app-navigation.spec.tsx 那条变量用例里。
  it("画布不写内联偏好样式（改由 :root 变量驱动）", () => {
    const { main } = setup(payloadFor({ text: "# 章节\n" }));
    expect(main.getAttribute("style")).toBeNull();
  });

  it("外链点击经 bridge 发 document.open", () => {
    const bridge = fakeBridge();
    const { main } = setup(payloadFor({ text: "[文档](https://example.com/page)\n" }), bridge);
    const link = main.querySelector<HTMLAnchorElement>("a[data-readora-external]");
    fireEvent.click(link as HTMLAnchorElement);
    expect(bridge.notifications).toEqual([["document.open", { uri: "https://example.com/page" }]]);
    expect(bridge.requests).toHaveLength(0);
  });

  it("主题注入点只影响代码配色标记，不改正文结构", () => {
    const { main, rerender } = setup(payloadFor({ text: "# 章节\n" }));
    const article = main.querySelector(".readora-document");
    rerender(
      <ReadingCanvas
        payload={payloadFor({ text: "# 章节\n", version: 2 })}
        theme="dark"
        bridge={fakeBridge()}
      />
    );
    // 换明暗既不重跑管线也不重建 DOM（ARC-006 §11.1）：节点全等即证明。
    expect(main.querySelector(".readora-document")).toBe(article);
  });
});

describe("M3 资源与交互装配", () => {
  it("本地图片经 bridge 发 resource.resolve，成功后写入 webviewUri", async () => {
    const result = okResult("assets/logo.png", { webviewUri: "https://stub/assets/logo.png?v=1" });
    const bridge = fakeBridge({ "resource.resolve": result });
    const { main } = setup(payloadFor({ text: "![示意图](assets/logo.png)\n" }), bridge);

    await waitFor(() => {
      const img = main.querySelector<HTMLImageElement>(".readora-image-element");
      expect(img?.getAttribute("src")).toBe(result.webviewUri);
    });
    expect(main.querySelector(".readora-image")?.getAttribute("data-readora-image-state")).toBe("ready");
    expect(bridge.requests).toEqual([
      [
        "resource.resolve",
        {
          documentUri: payloadFor().documentUri,
          reference: "assets/logo.png",
          kind: "image"
        }
      ]
    ]);
  });

  it("Host 报错时降级为 missing 并给出行内原因，不影响正文其余部分", async () => {
    const bridge = fakeBridge({
      "resource.resolve": new Error("Readora: readora.resource.notFound: assets/gone.png")
    });
    const { main } = setup(
      payloadFor({ text: "![缺失](assets/gone.png)\n\n段落仍在。\n" }),
      bridge
    );

    await waitFor(() => {
      expect(main.querySelector(".readora-image")?.getAttribute("data-readora-image-state")).toBe(
        "missing"
      );
    });
    expect(main.querySelector(".readora-image-hint")?.textContent).toBe("本地图片不存在或不可读");
    expect(main.querySelector(".readora-image")?.classList.contains("readora-image--missing")).toBe(
      true
    );
    expect(main.textContent).toContain("段落仍在。");
  });

  it("相对链接点击经 bridge 发 document.navigate", async () => {
    const bridge = fakeBridge({ "document.navigate": {} });
    const { main } = setup(payloadFor({ text: "[其它文档](./other.md)\n" }), bridge);
    const link = main.querySelector<HTMLElement>("[data-readora-relative]");
    fireEvent.click(link as HTMLElement);

    await waitFor(() => {
      expect(bridge.requests).toEqual([["document.navigate", { uri: "./other.md" }]]);
    });
    expect(main.querySelector(".readora-inline-note")).toBeNull();
  });

  it("Host 拒绝跳转时回退行内提示，不静默失败", async () => {
    const bridge = fakeBridge({
      "document.navigate": new Error("Readora: readora.document.notFound: ./other.md")
    });
    const { main } = setup(payloadFor({ text: "[其它文档](./other.md)\n" }), bridge);
    fireEvent.click(main.querySelector<HTMLElement>("[data-readora-relative]") as HTMLElement);

    await waitFor(() => {
      expect(main.querySelector(".readora-inline-note")?.textContent).toBe(
        "跨文档跳转待资源解析（M3）"
      );
    });
  });

  it("就绪图片点击开 Lightbox，Esc 关闭并把焦点还给触发元素", async () => {
    const result = okResult("assets/logo.png");
    const { main, container } = setup(payloadFor({ text: "![示意图](assets/logo.png)\n" }));
    await waitFor(() => {
      expect(main.querySelector(".readora-image")?.getAttribute("data-readora-image-state")).toBe(
        "ready"
      );
    });

    const wrapper = main.querySelector<HTMLElement>(".readora-image") as HTMLElement;
    wrapper.setAttribute("tabindex", "0");
    wrapper.focus();
    fireEvent.click(wrapper);

    const dialog = document.querySelector<HTMLElement>(".readora-lightbox");
    expect(dialog?.getAttribute("role")).toBe("dialog");
    expect(dialog?.getAttribute("aria-modal")).toBe("true");
    expect(dialog?.querySelector<HTMLImageElement>(".readora-lightbox-image")?.getAttribute("src")).toBe(
      result.webviewUri
    );
    expect(dialog?.querySelector(".readora-lightbox-caption")?.textContent).toBe("assets/logo.png");

    fireEvent.keyDown(window, { key: "+" });
    expect(dialog?.querySelector(".readora-lightbox-scale")?.textContent).toBe("125%");

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => {
      expect(document.querySelector(".readora-lightbox")).toBeNull();
    });
    expect(container.ownerDocument.activeElement).toBe(wrapper);
  });

  it("未就绪图片点击只显示原因，不开覆盖层", async () => {
    const bridge = fakeBridge({
      "resource.resolve": new Error("Readora: readora.resource.denied: remote image")
    });
    const { main } = setup(payloadFor({ text: "![远程](https://example.com/a.png)\n" }), bridge);

    await waitFor(() => {
      expect(main.querySelector(".readora-image")?.getAttribute("data-readora-image-state")).toBe(
        "blocked"
      );
    });
    fireEvent.click(main.querySelector<HTMLElement>(".readora-image") as HTMLElement);
    expect(document.querySelector(".readora-lightbox")).toBeNull();
    expect(main.querySelector(".readora-inline-note")).not.toBeNull();
  });
});
