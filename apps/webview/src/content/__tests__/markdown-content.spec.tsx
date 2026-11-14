/**
 * MarkdownContent 组件测试（IMP-001 §14 Component Test，ARC-005 §9.5 / §17.1 第 5 项）。
 *
 * 关注三件事：
 * - 容器只接收 Sanitizer 之后的 HTML（无任何可执行结构）；
 * - 旧 version 的结果不得覆盖较新的内容；
 * - 同内容重复 update 不重新写入 DOM（全量渲染但跳过重复渲染）。
 *
 * 注意：正文一律通过 props 对象传入，不写在 JSX 属性里，
 * 否则 `\n` 在 JSX 字符串属性中不是换行转义。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { DiagramEngine } from "@readora/diagram-core";
import type { MarkdownRenderResult, RenderRequest, ResolvedRenderTheme } from "@readora/markdown-core";
import { MarkdownContent, type MarkdownContentProps } from "../MarkdownContent";
import { CODE_EDITOR_HOST_CLASS } from "../code-editor/code-editor-layer";
import type { ContentInteractionHandlers } from "../interactions";
import { fakeDiagramEngine, fakeHandlers } from "./test-support";

/** 统计管线真实被调用的次数（用于证明「内容 hash 跳过重复渲染」真的生效）。 */
const renderCalls = vi.hoisted(() => ({ count: 0 }));

vi.mock("@readora/markdown-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@readora/markdown-core")>();
  return {
    ...actual,
    renderMarkdown: (request: RenderRequest): MarkdownRenderResult => {
      renderCalls.count += 1;
      return actual.renderMarkdown(request);
    }
  };
});

const DOCUMENT_URI = "file:///vault/notes/doc.md";

interface Input {
  version: number;
  text: string;
  /** 文档标识：留空即沿用 DOCUMENT_URI，跨文档用例显式传另一个。 */
  documentId?: string;
  theme?: ResolvedRenderTheme;
  handlers?: ContentInteractionHandlers;
  diagramEngine?: DiagramEngine;
  fontSize?: number;
  onRendered?: (result: MarkdownRenderResult) => void;
}

function propsFor(input: Input): MarkdownContentProps {
  const id = input.documentId ?? DOCUMENT_URI;
  return {
    documentId: id,
    documentUri: id,
    version: input.version,
    text: input.text,
    theme: input.theme ?? "light",
    handlers: input.handlers ?? fakeHandlers(),
    ...(input.diagramEngine ? { diagramEngine: input.diagramEngine } : {}),
    ...(input.fontSize === undefined ? {} : { fontSize: input.fontSize }),
    ...(input.onRendered ? { onRendered: input.onRendered } : {})
  };
}

function setup(input: Input) {
  const handlers: ContentInteractionHandlers = input.handlers ?? fakeHandlers();
  const view = render(<MarkdownContent {...propsFor({ ...input, handlers })} />);
  const container = view.container.querySelector<HTMLDivElement>(".readora-document");
  if (!container) {
    throw new Error("readora-document container missing");
  }
  return { ...view, container, handlers };
}

beforeEach(() => {
  renderCalls.count = 0;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("渲染产物注入", () => {
  it("Sanitizer 之后的 HTML 进入容器，可执行结构一律不存在", () => {
    const { container } = setup({
      version: 1,
      text: "# 标题\n\n<script>alert(1)</script>\n\n[外链](https://example.com)\n"
    });
    expect(container.querySelector("h1")?.id).toBe("标题");
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector('[data-readora-external="https://example.com/"]')).not.toBeNull();
    expect(container.textContent).toContain("alert(1)");
    expect(container.innerHTML).not.toContain("<script");
  });

  it("管线只产出白名单结构，不产出内联事件与 style 属性", () => {
    const { container } = setup({
      version: 1,
      text: "| a | b |\n| - | - |\n| **粗** | `码` |\n\n- [x] 任务\n\n```js\nlet a=1\n```\n"
    });
    const offenders: string[] = [];
    for (const element of Array.from(container.querySelectorAll("*"))) {
      // 代码编辑器接管层是运行时 DOM（CodeMirror 用自己的 style 属性写行高与宽度度量），
      // 不属于「文档内容 → 渲染管线」的产物；它的契约由 code-editor-layer 单测与 e2e 守。
      if (element.closest(`.${CODE_EDITOR_HOST_CLASS}`)) {
        continue;
      }
      for (const attribute of Array.from(element.attributes)) {
        if (attribute.name === "style" || /^on[a-z]+$/i.test(attribute.name)) {
          offenders.push(`${element.tagName}/${attribute.name}`);
        }
      }
    }
    expect(offenders).toEqual([]);
    expect(container.querySelector("th")?.getAttribute("scope")).toBe("col");
    expect(container.querySelector("button[data-readora-copy]")).not.toBeNull();
    expect(container.querySelector(".readora-task-marker")).not.toBeNull();
  });

  it("onRendered 上报 metadata / outline / diagnostics 供上层使用", () => {
    const onRendered = vi.fn();
    setup({ version: 4, text: "---\ntitle: 契约\n---\n\n# 章节\n\n```unknownlang\nx\n```\n", onRendered });
    const result = onRendered.mock.calls[0]?.[0] as MarkdownRenderResult | undefined;
    expect(result?.metadata.title).toBe("契约");
    expect(result?.outline.map((item) => item.anchor)).toEqual(["章节"]);
    expect(result?.version).toBe(4);
    expect(result?.diagnostics.some((item) => item.severity === "warning")).toBe(true);
  });
});

describe("投递门控与重复渲染", () => {
  it("旧 version 的结果不覆盖较新内容（ARC-005 §9.5）", () => {
    const { container, rerender } = setup({ version: 2, text: "# 新版\n" });
    expect(container.querySelector("h1")?.textContent).toBe("新版");

    rerender(<MarkdownContent {...propsFor({ version: 1, text: "# 迟到的旧版\n" })} />);
    expect(container.querySelector("h1")?.textContent).toBe("新版");
    expect(container.innerHTML).not.toContain("迟到的旧版");
  });

  it("换到版本号更小的另一篇文档仍然渲染（版本只在同篇内可比）", () => {
    const { container, rerender } = setup({ version: 5, text: "# 甲篇\n" });
    expect(container.querySelector("h1")?.textContent).toBe("甲篇");

    // 跨文档跳转：另一篇文件的 version 是独立计数线，不能当成「迟到的旧快照」丢掉
    rerender(
      <MarkdownContent
        {...propsFor({ version: 2, text: "# 乙篇\n", documentId: "file:///vault/notes/other.md" })}
      />
    );
    expect(container.querySelector("h1")?.textContent).toBe("乙篇");
    expect(container.getAttribute("data-readora-document-version")).toBe("2");
  });

  it("换文档即使产物一致也重写 DOM，并重新上报 onRendered", () => {
    const onRendered = vi.fn();
    const { container, rerender } = setup({ version: 3, text: "# 同一份文本\n", onRendered });
    const heading = container.querySelector("h1");
    expect(heading).not.toBeNull();
    heading?.setAttribute("data-mark", "stale");
    expect(onRendered).toHaveBeenCalledTimes(1);

    rerender(
      <MarkdownContent
        {...propsFor({
          version: 1,
          text: "# 同一份文本\n",
          documentId: "file:///vault/notes/second.md",
          onRendered
        })}
      />
    );
    // 图片层/图表层的实例与在途请求绑在旧文档上：产物一致也必须重挂
    expect(container.querySelector("h1")).not.toBe(heading);
    expect(container.querySelector("h1")?.getAttribute("data-mark")).toBeNull();
    expect(onRendered).toHaveBeenCalledTimes(2);
    expect((onRendered.mock.calls[1]?.[0] as MarkdownRenderResult | undefined)?.documentId).toBe(
      "file:///vault/notes/second.md"
    );
  });

  it("内容 hash 命中时连解析都跳过（ARC-002 §13.1 全量渲染 + 内容 hash）", () => {
    const { container, rerender } = setup({ version: 1, text: "# 稳定\n\n正文\n" });
    expect(renderCalls.count).toBe(1);
    const heading = container.querySelector("h1");

    // 文本未变、只有版本变：不得重跑管线，也不得重排 DOM
    rerender(<MarkdownContent {...propsFor({ version: 2, text: "# 稳定\n\n正文\n" })} />);
    expect(renderCalls.count).toBe(1);
    expect(container.querySelector("h1")).toBe(heading);

    // 主题不进渲染输入（ARC-006 §11.1）：切明暗既不重跑管线也不重建 DOM，
    // 否则已挂载的图表实例连同在途请求会被一起丢掉重造。
    rerender(
      <MarkdownContent {...propsFor({ version: 3, text: "# 稳定\n\n正文\n", theme: "dark" })} />
    );
    expect(renderCalls.count).toBe(1);
    expect(container.querySelector("h1")).toBe(heading);

    // 文本变化必须重解析并更新 DOM
    rerender(<MarkdownContent {...propsFor({ version: 4, text: "# 变更\n" })} />);
    expect(renderCalls.count).toBe(2);
    expect(container.querySelector("h1")?.textContent).toBe("变更");
  });

  it("同内容重复 update 不重新写入 DOM（产物一致即跳过）", () => {
    const { container, rerender } = setup({ version: 1, text: "# 稳定\n\n正文\n" });
    const heading = container.querySelector("h1");
    expect(heading).not.toBeNull();
    heading?.setAttribute("data-mark", "kept");

    rerender(<MarkdownContent {...propsFor({ version: 2, text: "# 稳定\n\n正文\n" })} />);
    // 重写 innerHTML 会替换节点，自定义标记随之消失；标记仍在即证明未重排
    expect(container.querySelector("h1")).toBe(heading);
    expect(container.querySelector("h1")?.getAttribute("data-mark")).toBe("kept");
  });

  it("文本变化时同 version 也会更新 DOM", () => {
    const { container, rerender } = setup({ version: 3, text: "# 甲\n" });
    rerender(<MarkdownContent {...propsFor({ version: 3, text: "# 乙\n" })} />);
    expect(container.querySelector("h1")?.textContent).toBe("乙");
  });

  it("主题切换不改变产物结构（样式归 CSS）", () => {
    const { container, rerender } = setup({ version: 1, text: "# 标题\n\n正文\n" });
    const html = container.innerHTML;
    rerender(<MarkdownContent {...propsFor({ version: 1, text: "# 标题\n\n正文\n", theme: "dark" })} />);
    expect(container.innerHTML).toBe(html);
  });
});

/**
 * 附加层编排（STORY-05-03 / STORY-08-02，ARC-003 §6.3）。
 *
 * 层与 DOM 同生命周期才是这里的不变量：正文重写即销毁，
 * 产物未变即不重挂，卸载即清理，不留悬挂的引擎实例与在途请求。
 */
describe("附加层编排", () => {
  const DIAGRAM = '```mermaid\ngraph TD\n  开始 --> 结束\n```\n\n![示意图](assets/a.png)\n';

  function layerSetup(input: { version?: number; text?: string } = {}) {
    const fake = fakeDiagramEngine();
    const handlers = fakeHandlers();
    const view = setup({
      version: input.version ?? 1,
      text: input.text ?? DIAGRAM,
      handlers,
      diagramEngine: fake.engine
    });
    return { ...view, ...fake, handlers };
  }

  it("写入产物后图片层与图表层各自接管", async () => {
    const { container, mountCalls, handlers } = layerSetup();

    await vi.waitFor(() => {
      expect(mountCalls).toHaveLength(1);
    });
    expect(container.querySelector(".readora-diagram-container")).not.toBeNull();
    expect(container.querySelector(".readora-diagram-toolbar")).not.toBeNull();
    expect(container.querySelector(".readora-diagram")?.getAttribute("data-readora-diagram-state")).toBe(
      "rendered"
    );
    expect(handlers.resolveResource).toHaveBeenCalledWith("assets/a.png", "image");
  });

  it("同 html 的重复 update 既不重排 DOM，也不重新挂载", async () => {
    const { container, rerender, instances, mountCalls, handlers, engine } = layerSetup();
    await vi.waitFor(() => {
      expect(mountCalls).toHaveLength(1);
    });
    const toolbar = container.querySelector(".readora-diagram-toolbar");
    expect(handlers.resolveResource).toHaveBeenCalledTimes(1);

    rerender(
      <MarkdownContent {...propsFor({ version: 2, text: DIAGRAM, handlers, diagramEngine: engine })} />
    );
    await Promise.resolve();
    expect(mountCalls).toHaveLength(1);
    expect(instances[0]?.destroys).toBe(0);
    expect(handlers.resolveResource).toHaveBeenCalledTimes(1);
    expect(container.querySelector(".readora-diagram-toolbar")).toBe(toolbar);
  });

  it("正文重写即销毁旧实例，新内容用新的引擎实例", async () => {
    const { container, rerender, instances, mountCalls, handlers, engine } = layerSetup();
    await vi.waitFor(() => {
      expect(mountCalls).toHaveLength(1);
    });

    rerender(
      <MarkdownContent
        {...propsFor({
          version: 2,
          text: '```mermaid\npie\n  "甲" : 1\n```\n',
          handlers,
          diagramEngine: engine
        })}
      />
    );
    await vi.waitFor(() => {
      expect(mountCalls).toHaveLength(2);
    });
    expect(instances[0]?.destroys).toBe(1);
    // 旧图的工具栏随 innerHTML 重写一起离开，不留下无主节点
    expect(container.querySelectorAll(".readora-diagram-toolbar")).toHaveLength(1);
    expect(container.querySelector(".readora-image")).toBeNull();
  });

  it("卸载销毁全部引擎实例", async () => {
    const { instances, mountCalls } = layerSetup();
    await vi.waitFor(() => {
      expect(mountCalls).toHaveLength(1);
    });

    cleanup();
    expect(instances[0]?.destroys).toBe(1);
  });

  it("字号变化才让引擎重算布局，主题切换只切 class", async () => {
    const fake = fakeDiagramEngine();
    const { container, rerender } = setup({
      version: 1,
      text: DIAGRAM,
      diagramEngine: fake.engine,
      fontSize: 17
    });
    await vi.waitFor(() => {
      expect(fake.mountCalls).toHaveLength(1);
    });
    const instance = fake.instances[0];
    if (!instance) {
      throw new Error("mounted instance missing");
    }
    // 挂载即带一次 refresh（首帧字号偏好生效），此后按增量断言
    const baseline = instance.refreshes;
    const wrapper = container.querySelector<HTMLElement>(".readora-diagram");
    expect(wrapper?.classList.contains("readora-diagram--light")).toBe(true);

    rerender(
      <MarkdownContent {...propsFor({ version: 2, text: DIAGRAM, diagramEngine: fake.engine, fontSize: 21 })} />
    );
    expect(instance.refreshes).toBe(baseline + 1);

    rerender(
      <MarkdownContent
        {...propsFor({ version: 2, text: DIAGRAM, theme: "dark", diagramEngine: fake.engine, fontSize: 21 })}
      />
    );
    expect(instance.refreshes).toBe(baseline + 1);
    expect(wrapper?.classList.contains("readora-diagram--dark")).toBe(true);
    expect(wrapper?.classList.contains("readora-diagram--light")).toBe(false);
    expect(fake.mountCalls).toHaveLength(1);
  });
});
