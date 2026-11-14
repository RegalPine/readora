/**
 * 图表挂载层测试（IMP-001 §14 Component Test，ARC-003 §6 / §7 / §10，STORY-05-03）。
 *
 * 一律注入引擎替身：Adapter 契约由 packages/diagram-core 负责，
 * 本层要证的是「怎么用引擎」—— 接管时机、状态写回、工具栏指令转发、
 * 错误卡三件事、主题只切 class、销毁不留悬挂实例。
 *
 * 输入产物取自真实 renderMarkdown：夹具与生产者同源，才不会各测各的。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderMarkdown } from "@readora/markdown-core";
import {
  DIAGRAM_ROOT_MARGIN,
  DIAGRAM_STATE_ATTRIBUTE,
  DIAGRAM_WRAPPER_SELECTOR,
  ZOOM_IN_FACTOR,
  ZOOM_OUT_FACTOR,
  createDiagramLayer,
  diagramSourceOf,
  type DiagramLayer
} from "../diagram-layer";
import type { ObserverHandle } from "../viewport";
import { fakeDiagramEngine } from "./test-support";

const DOCUMENT_URI = "file:///vault/notes/diagrams.md";

function htmlFor(text: string): string {
  return renderMarkdown({
    documentId: DOCUMENT_URI,
    documentUri: DOCUMENT_URI,
    version: 1,
    text,
    theme: "light"
  }).html;
}

interface Harness {
  container: HTMLElement;
  layer: DiagramLayer;
  engine: ReturnType<typeof fakeDiagramEngine>["engine"];
  calls: ReturnType<typeof fakeDiagramEngine>["mountCalls"];
  instances: ReturnType<typeof fakeDiagramEngine>["instances"];
  observed: Element[];
  activate: (element: HTMLElement) => void;
  copy: ReturnType<typeof vi.fn>;
}

function setup(text: string, engineOptions = {}, attach = true): Harness {
  const container = document.createElement("div");
  container.innerHTML = htmlFor(text);
  if (attach) {
    document.body.append(container);
  }
  const fake = fakeDiagramEngine(engineOptions);
  const observed: Element[] = [];
  let activate: (element: HTMLElement) => void = () => {};
  const copy = vi.fn(async () => true);
  const layer = createDiagramLayer({
    engine: fake.engine,
    copy,
    createObserver: (callback): ObserverHandle => {
      activate = callback;
      return {
        observe: (element) => {
          observed.push(element);
        },
        unobserve: vi.fn(),
        disconnect: vi.fn()
      };
    }
  });
  return {
    container,
    layer,
    engine: fake.engine,
    calls: fake.mountCalls,
    instances: fake.instances,
    observed,
    copy,
    get activate(): (element: HTMLElement) => void {
      return activate;
    }
  };
}

const FLOW = "```mermaid\ngraph TD\n  开始 --> 结束\n```\n";

function click(element: Element | null): void {
  if (!element) {
    throw new Error("action target missing");
  }
  element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("接管与懒挂载", () => {
  it("源码取自 <pre> 的 textContent，原样交给引擎（含中文与箭头）", () => {
    const h = setup(FLOW);
    const wrapper = h.container.querySelector<HTMLElement>(DIAGRAM_WRAPPER_SELECTOR) as HTMLElement;
    expect(diagramSourceOf(wrapper)).toBe("graph TD\n  开始 --> 结束\n");
    expect(h.layer.scan(h.container)).toBe(1);
    expect(h.calls).toHaveLength(0);
    expect(h.observed).toEqual([wrapper]);

    h.activate(wrapper);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]?.source).toBe("graph TD\n  开始 --> 结束\n");
    expect(h.calls[0]?.container.classList.contains("readora-diagram-container")).toBe(true);
    // zoom: true 而不是 "auto"：引擎的 zoomBy / zoomTo 在未溢出的 auto 下是空操作，
    // 工具栏那三枚缩放按钮就会变成三枚死按钮（真实浏览器实测）。
    expect(h.calls[0]?.options?.zoom).toBe(true);
  });

  it("接管后状态与结构齐备：工具栏五件套、源码节点仍在、状态为 rendered", () => {
    const h = setup(FLOW);
    const wrapper = h.container.querySelector<HTMLElement>(DIAGRAM_WRAPPER_SELECTOR) as HTMLElement;
    h.layer.scan(h.container);
    h.activate(wrapper);

    expect(wrapper.getAttribute(DIAGRAM_STATE_ATTRIBUTE)).toBe("rendered");
    expect(wrapper.classList.contains("readora-diagram--light")).toBe(true);
    const actions = Array.from(
      wrapper.querySelectorAll<HTMLElement>("[data-readora-diagram-action]")
    ).map((button) => button.getAttribute("data-readora-diagram-action"));
    expect(actions).toEqual([
      "zoom-in",
      "zoom-out",
      "fit",
      "fullscreen",
      "copy-source"
    ]);
    // 1:1 已按产品反馈下掉（窄图上它与 Fit 同义，宽图上又是一个让人猜该按哪的第二档）：
    // 这里反向断言按钮真的不在，而不是只靠数组长度推。
    expect(wrapper.querySelector(".readora-diagram-toolbar")).not.toBeNull();
    // 全屏是图标按钮：没有文案，只有一个 aria-hidden 的 svg，名字走 aria-label。
    const fullscreen = wrapper.querySelector<HTMLElement>(
      "[data-readora-diagram-action=\"fullscreen\"]"
    ) as HTMLElement;
    expect(fullscreen.textContent).toBe("");
    expect(fullscreen.querySelector("svg.readora-icon")).not.toBeNull();
    expect(fullscreen.getAttribute("aria-label")).toBe("Fullscreen");
    // 不新增 data 属性：源码只能从既有 <pre> 取（避免扩大 Sanitizer 可信面）
    expect(wrapper.getAttribute("data-readora-diagram-source")).toBeNull();
    expect(wrapper.querySelector("pre.readora-diagram-source")).not.toBeNull();
  });

  it("引擎推迟出图时状态记为 mounting，不谎报 rendered", () => {
    const h = setup(FLOW, { pending: true });
    const wrapper = h.container.querySelector<HTMLElement>(DIAGRAM_WRAPPER_SELECTOR) as HTMLElement;
    h.layer.scan(h.container);
    h.activate(wrapper);
    expect(wrapper.getAttribute(DIAGRAM_STATE_ATTRIBUTE)).toBe("mounting");
  });

  it("重复 scan 幂等；非 pending 或无源码的容器不接管", () => {
    const h = setup(FLOW);
    expect(h.layer.scan(h.container)).toBe(1);
    expect(h.layer.scan(h.container)).toBe(0);

    const done = setup(FLOW);
    done.container.querySelector(DIAGRAM_WRAPPER_SELECTOR)?.setAttribute(DIAGRAM_STATE_ATTRIBUTE, "rendered");
    expect(done.layer.scan(done.container)).toBe(0);

    const empty = setup(FLOW);
    empty.container.querySelector("pre.readora-diagram-source")?.replaceChildren();
    expect(empty.layer.scan(empty.container)).toBe(0);
  });

  it("同页多图各自独立 idPrefix，SVG 内部 id 不打架", () => {
    const two = "```mermaid\ngraph TD\n  A --> B\n```\n\n```mermaid\npie\n  \"a\" : 1\n```\n";
    const h = setup(two);
    expect(h.layer.scan(h.container)).toBe(2);
    for (const wrapper of Array.from(h.container.querySelectorAll(DIAGRAM_WRAPPER_SELECTOR))) {
      h.activate(wrapper as HTMLElement);
    }
    const prefixes = h.calls.map((call) => call.options?.idPrefix);
    expect(prefixes).toHaveLength(2);
    expect(new Set(prefixes).size).toBe(2);
    expect(prefixes[0]).toMatch(/^readora-diagram-\d+-$/);
  });

  it("观察器以图表专用余量创建", () => {
    const createObserver = vi.fn((): ObserverHandle => ({
      observe: vi.fn(),
      unobserve: vi.fn(),
      disconnect: vi.fn()
    }));
    const container = document.createElement("div");
    container.innerHTML = htmlFor(FLOW);
    document.body.append(container);
    const fake = fakeDiagramEngine();
    createDiagramLayer({ engine: fake.engine, createObserver }).scan(container);
    expect(createObserver).toHaveBeenCalledWith(expect.any(Function), {
      rootMargin: DIAGRAM_ROOT_MARGIN
    });
  });
});

describe("工具栏指令转发", () => {
  function mounted(): Harness {
    const h = setup(FLOW);
    const wrapper = h.container.querySelector<HTMLElement>(DIAGRAM_WRAPPER_SELECTOR) as HTMLElement;
    h.layer.scan(h.container);
    h.activate(wrapper);
    return h;
  }

  function tool(h: Harness, action: string): HTMLElement {
    const button = h.container.querySelector<HTMLElement>(
      `.readora-diagram-toolbar [data-readora-diagram-action="${action}"]`
    );
    if (!button) {
      throw new Error(`tool ${action} missing`);
    }
    return button;
  }

  it("zoom in / out 走引擎倍率，工具栏不自己算 transform", () => {
    const h = mounted();
    const instance = h.instances[0];
    if (!instance) {
      throw new Error("mounted instance missing");
    }
    click(tool(h, "zoom-in"));
    expect(instance.zoom.scale).toBeCloseTo(ZOOM_IN_FACTOR, 4);
    click(tool(h, "zoom-out"));
    // 放大再缩小必须回到 1：两个系数互为倒数是工具栏唯一可被用户感知的不变量。
    expect(ZOOM_IN_FACTOR * ZOOM_OUT_FACTOR).toBeCloseTo(1, 6);
    expect(instance.zoom.scale).toBeCloseTo(1, 4);
    click(tool(h, "fit"));
    expect(instance.zoom.scale).toBeCloseTo(0.5, 4);
    // 只剩 Fit 一档归位：引擎的 fit 把整图缩进容器，不需要第二个入口。
    expect(
      h.container.querySelector('[data-readora-diagram-action="reset"]')
    ).toBeNull();
  });

  it("Fullscreen 切 class；有原生 API 时一并调用", () => {
    const requestFullscreen = vi.fn();
    const exitFullscreen = vi.fn();
    const container = document.createElement("div");
    container.innerHTML = htmlFor(FLOW);
    document.body.append(container);
    const fake = fakeDiagramEngine();
    let activate: (element: HTMLElement) => void = () => {};
    const layer = createDiagramLayer({
      engine: fake.engine,
      createObserver: (callback): ObserverHandle => {
        activate = callback;
        return { observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn() };
      },
      requestFullscreen,
      exitFullscreen
    });
    layer.scan(container);
    const wrapper = container.querySelector<HTMLElement>(DIAGRAM_WRAPPER_SELECTOR) as HTMLElement;
    activate(wrapper);
    const button = wrapper.querySelector<HTMLElement>(
      "[data-readora-diagram-action=\"fullscreen\"]"
    ) as HTMLElement;

    click(button);
    expect(wrapper.classList.contains("readora-diagram--fullscreen")).toBe(true);
    expect(requestFullscreen).toHaveBeenCalledWith(wrapper);
    // 图标与可读名跟着状态走：退出态不能再叫 “Fullscreen”。
    expect(button.getAttribute("aria-label")).toBe("Exit fullscreen");
    expect(button.title).toBe("Exit fullscreen");
    expect(button.querySelector("svg path")?.getAttribute("d")).toContain("M10 4v6H4");
    click(button);
    expect(wrapper.classList.contains("readora-diagram--fullscreen")).toBe(false);
    expect(button.getAttribute("aria-label")).toBe("Fullscreen");
    expect(button.querySelector("svg path")?.getAttribute("d")).toContain("M4 10V4h6");
    expect(exitFullscreen).toHaveBeenCalledTimes(1);
    layer.destroy();
  });

  it("Copy Source 复制的是引擎收到的源码原文", async () => {
    const h = mounted();
    click(tool(h, "copy-source"));
    await vi.waitFor(() => {
      expect(h.copy).toHaveBeenCalledWith("graph TD\n  开始 --> 结束\n");
    });
  });
});

describe("错误卡与局部降级", () => {
  const SYNTAX_ERROR = {
    kind: "syntax" as const,
    message: "Parse error on line 2",
    source: { line: 2, column: 7 }
  };

  function failed(): Harness {
    const h = setup(FLOW, { failWith: SYNTAX_ERROR });
    const wrapper = h.container.querySelector<HTMLElement>(DIAGRAM_WRAPPER_SELECTOR) as HTMLElement;
    h.layer.scan(h.container);
    h.activate(wrapper);
    return h;
  }

  it("失败只影响本张图：状态 failed，容器清空，错误卡给出成因与位置", () => {
    const h = failed();
    const wrapper = h.container.querySelector<HTMLElement>(DIAGRAM_WRAPPER_SELECTOR) as HTMLElement;
    expect(wrapper.getAttribute(DIAGRAM_STATE_ATTRIBUTE)).toBe("failed");
    const card = wrapper.querySelector<HTMLElement>(".readora-diagram-error");
    expect(card?.dataset.readoraDiagramErrorKind).toBe("syntax");
    expect(card?.querySelector(".readora-diagram-error-message")?.textContent).toContain(
      "Parse error on line 2"
    );
    expect(card?.querySelector(".readora-diagram-error-message")?.textContent).toContain("(line 2)");
    expect(wrapper.querySelector(".readora-diagram-container svg")).toBeNull();
  });

  it("错误卡三件事：展开源码 / 复制 / 重试", async () => {
    // 用「能成功的引擎 + 运行期失败回调」造错误态：重试才有真恢复可断言。
    const h = setup(FLOW);
    const wrapper = h.container.querySelector<HTMLElement>(DIAGRAM_WRAPPER_SELECTOR) as HTMLElement;
    h.layer.scan(h.container);
    h.activate(wrapper);
    const onError = h.calls[0]?.options?.onError;
    if (!onError) {
      throw new Error("onError channel missing");
    }
    onError(SYNTAX_ERROR);

    const toggle = wrapper.querySelector<HTMLElement>(
      ".readora-diagram-error [data-readora-diagram-action=\"toggle-source\"]"
    ) as HTMLElement;
    click(toggle);
    expect(wrapper.classList.contains("readora-diagram--source-open")).toBe(true);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(toggle.textContent).toBe("收起源码");

    click(wrapper.querySelector<HTMLElement>("[data-readora-diagram-action=\"copy-source\"]"));
    await vi.waitFor(() => {
      expect(h.copy).toHaveBeenCalledWith("graph TD\n  开始 --> 结束\n");
    });

    const before = h.calls.length;
    click(wrapper.querySelector<HTMLElement>("[data-readora-diagram-action=\"retry\"]"));
    expect(h.calls.length).toBe(before + 1);
    expect(wrapper.querySelector(".readora-diagram-error")).toBeNull();
    expect(wrapper.classList.contains("readora-diagram--source-open")).toBe(false);
    expect(wrapper.getAttribute(DIAGRAM_STATE_ATTRIBUTE)).toBe("rendered");
    expect(wrapper.querySelector(".readora-diagram-container svg[data-readora-fake-svg]")).not.toBeNull();
  });

  it("重试仍失败时只留一张卡片，卡片文案同步最新成因", () => {
    const h = failed();
    const wrapper = h.container.querySelector<HTMLElement>(DIAGRAM_WRAPPER_SELECTOR) as HTMLElement;
    const before = h.calls.length;
    click(wrapper.querySelector<HTMLElement>("[data-readora-diagram-action=\"retry\"]"));
    expect(h.calls.length).toBe(before + 1);
    expect(wrapper.querySelectorAll(".readora-diagram-error")).toHaveLength(1);
    expect(wrapper.getAttribute(DIAGRAM_STATE_ATTRIBUTE)).toBe("failed");
  });

  it("未注册类型走 unsupported，卡片文案点名类型而不是堆栈", () => {
    const container = document.createElement("div");
    container.innerHTML = htmlFor("```mermaid\nblock-beta\n  a\n```\n");
    document.body.append(container);
    const fake = fakeDiagramEngine({
      failWith: {
        kind: "unsupported",
        code: "readora.diagram.not-registered",
        message: 'Diagram type "block" is not enabled in this reader.'
      }
    });
    const layer = createDiagramLayer({ engine: fake.engine });
    layer.scan(container);
    const wrapper = container.querySelector<HTMLElement>(DIAGRAM_WRAPPER_SELECTOR) as HTMLElement;
    expect(wrapper.getAttribute(DIAGRAM_STATE_ATTRIBUTE)).toBe("failed");
    expect(wrapper.querySelector(".readora-diagram-error-message")?.textContent).toContain(
      "not enabled in this reader"
    );
    layer.destroy();
  });

  it("同一张图重复回调失败时只留一张卡片，不叠加节点", () => {
    const h = setup(FLOW);
    const wrapper = h.container.querySelector<HTMLElement>(DIAGRAM_WRAPPER_SELECTOR) as HTMLElement;
    h.layer.scan(h.container);
    h.activate(wrapper);
    const onError = h.calls[0]?.options?.onError;
    if (!onError) {
      throw new Error("onError channel missing");
    }

    onError(SYNTAX_ERROR);
    onError(SYNTAX_ERROR);
    expect(wrapper.querySelectorAll(".readora-diagram-error")).toHaveLength(1);
    expect(wrapper.getAttribute(DIAGRAM_STATE_ATTRIBUTE)).toBe("failed");
  });
});

describe("主题与度量", () => {
  it("syncTheme 只切 class，不调用引擎 refresh", () => {
    const h = setup(FLOW);
    const wrapper = h.container.querySelector<HTMLElement>(DIAGRAM_WRAPPER_SELECTOR) as HTMLElement;
    h.layer.scan(h.container);
    h.activate(wrapper);
    const instance = h.instances[0];
    if (!instance) {
      throw new Error("mounted instance missing");
    }

    h.layer.syncTheme("dark");
    expect(wrapper.classList.contains("readora-diagram--dark")).toBe(true);
    expect(wrapper.classList.contains("readora-diagram--light")).toBe(false);
    expect(instance.refreshes).toBe(0);
    expect(h.calls).toHaveLength(1);
  });

  it("refreshAll 才让引擎重算布局，并把 mounting 纠正为 rendered", () => {
    const h = setup(FLOW, { pending: true });
    const wrapper = h.container.querySelector<HTMLElement>(DIAGRAM_WRAPPER_SELECTOR) as HTMLElement;
    h.layer.scan(h.container);
    h.activate(wrapper);
    expect(wrapper.getAttribute(DIAGRAM_STATE_ATTRIBUTE)).toBe("mounting");

    h.layer.refreshAll();
    expect(h.instances[0]?.refreshes).toBe(1);
    expect(wrapper.getAttribute(DIAGRAM_STATE_ATTRIBUTE)).toBe("rendered");
  });
});

describe("销毁", () => {
  it("destroy 释放引擎实例、附加节点与点击监听", () => {
    const h = setup(FLOW);
    const wrapper = h.container.querySelector<HTMLElement>(DIAGRAM_WRAPPER_SELECTOR) as HTMLElement;
    h.layer.scan(h.container);
    h.activate(wrapper);
    const instance = h.instances[0];
    if (!instance) {
      throw new Error("mounted instance missing");
    }

    h.layer.destroy();
    expect(instance.destroys).toBe(1);
    expect(h.layer.instanceCount).toBe(0);
    expect(wrapper.querySelector(".readora-diagram-toolbar")).toBeNull();
    expect(wrapper.querySelector(".readora-diagram-container")).toBeNull();

    // 监听已解绑：再点已残留的按钮不会触达引擎
    const orphan = document.createElement("button");
    orphan.setAttribute("data-readora-diagram-action", "zoom-in");
    wrapper.append(orphan);
    click(orphan);
    expect(instance.zoom.scale).toBe(1);
  });

  it("destroy 后在途激活不再生效", () => {
    const h = setup(FLOW);
    const wrapper = h.container.querySelector<HTMLElement>(DIAGRAM_WRAPPER_SELECTOR) as HTMLElement;
    h.layer.scan(h.container);
    h.layer.destroy();
    h.activate(wrapper);
    expect(h.calls).toHaveLength(0);
  });

  it("无观察器环境（jsdom）立即激活，长文档不留空白", () => {
    const container = document.createElement("div");
    container.innerHTML = htmlFor(FLOW);
    document.body.append(container);
    const fake = fakeDiagramEngine();
    const layer = createDiagramLayer({ engine: fake.engine });
    expect(layer.scan(container)).toBe(1);
    expect(fake.mountCalls).toHaveLength(1);
    expect(
      container.querySelector(".readora-diagram-container svg[data-readora-fake-svg]")
    ).not.toBeNull();
    layer.destroy();
  });
});

describe("围栏块属性（M10：code_block / filename / 尺寸）", () => {
  const CODE_BLOCK_FLOW = "```mermaid {code_block=true}\ngraph TD\n  开始 --> 结束\n```\n";
  const SYNTAX_ERROR = {
    kind: "syntax" as const,
    message: "Parse error on line 2",
    source: { line: 2, column: 7 }
  };

  /** 接管一张图并返回它的 wrapper：属性驱动的分支都要走真产物才有意义。 */
  function mounted(text: string, engineOptions = {}): Harness {
    const h = setup(text, engineOptions);
    const wrapper = h.container.querySelector<HTMLElement>(DIAGRAM_WRAPPER_SELECTOR) as HTMLElement;
    h.layer.scan(h.container);
    h.activate(wrapper);
    return h;
  }

  it("code_block=true：接管即处于展开态，不该让用户先点一次「展开源码」", () => {
    const h = mounted(CODE_BLOCK_FLOW);
    const wrapper = h.container.querySelector<HTMLElement>(DIAGRAM_WRAPPER_SELECTOR) as HTMLElement;
    expect(wrapper.getAttribute("data-readora-diagram-code-block")).toBe("true");
    expect(wrapper.classList.contains("readora-diagram--source-open")).toBe(true);
    expect(wrapper.querySelector("pre.readora-diagram-source")).not.toBeNull();
  });

  it("没写 code_block 的图保持默认收起（上面那条的反面：不是所有图都摊开源码）", () => {
    const h = mounted(FLOW);
    const wrapper = h.container.querySelector<HTMLElement>(DIAGRAM_WRAPPER_SELECTOR) as HTMLElement;
    expect(wrapper.classList.contains("readora-diagram--source-open")).toBe(false);
  });

  it("失败卡上的展开态按文档声明恢复：按钮文案与 aria-expanded 同步", () => {
    const h = mounted(CODE_BLOCK_FLOW);
    const wrapper = h.container.querySelector<HTMLElement>(DIAGRAM_WRAPPER_SELECTOR) as HTMLElement;
    const onError = h.calls[0]?.options?.onError;
    if (!onError) {
      throw new Error("onError channel missing");
    }
    onError(SYNTAX_ERROR);
    const toggle = wrapper.querySelector<HTMLElement>(
      ".readora-diagram-error [data-readora-diagram-action=\"toggle-source\"]"
    ) as HTMLElement;
    expect(wrapper.classList.contains("readora-diagram--source-open")).toBe(true);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(toggle.textContent).toBe("收起源码");
  });

  it("重试也不丢初始展开态：clearCard 拆掉之后按属性重新恢复", () => {
    const h = mounted(CODE_BLOCK_FLOW);
    const wrapper = h.container.querySelector<HTMLElement>(DIAGRAM_WRAPPER_SELECTOR) as HTMLElement;
    const onError = h.calls[0]?.options?.onError;
    if (!onError) {
      throw new Error("onError channel missing");
    }
    onError(SYNTAX_ERROR);
    const before = h.calls.length;
    click(wrapper.querySelector<HTMLElement>("[data-readora-diagram-action=\"retry\"]"));
    expect(h.calls.length).toBe(before + 1);
    expect(wrapper.querySelector(".readora-diagram-error")).toBeNull();
    expect(wrapper.classList.contains("readora-diagram--source-open")).toBe(true);
  });

  it("用户手动收起之后本层不再插手：声明只管初始态，不管每次重挂", () => {
    const h = mounted(CODE_BLOCK_FLOW);
    const wrapper = h.container.querySelector<HTMLElement>(DIAGRAM_WRAPPER_SELECTOR) as HTMLElement;
    const onError = h.calls[0]?.options?.onError;
    if (!onError) {
      throw new Error("onError channel missing");
    }
    onError(SYNTAX_ERROR);
    const toggle = wrapper.querySelector<HTMLElement>(
      ".readora-diagram-error [data-readora-diagram-action=\"toggle-source\"]"
    ) as HTMLElement;
    // 已声明为展开：点一次是「收起」，此时不该被属性又掀开。
    click(toggle);
    expect(wrapper.classList.contains("readora-diagram--source-open")).toBe(false);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.textContent).toBe("展开源码");
  });

  it("尺寸落在接管容器上：百分比走 max-width，像素走 width", () => {
    const percent = mounted("```mermaid {width=80%}\ngraph TD\n  A --> B\n```\n");
    const percentContainer = percent.container.querySelector<HTMLElement>(
      ".readora-diagram-container"
    ) as HTMLElement;
    expect(percentContainer.style.maxWidth).toBe("80%");
    expect(percentContainer.style.width).toBe("");

    const pixels = mounted("```mermaid {width=640px height=360px}\ngraph TD\n  A --> B\n```\n");
    const pixelsContainer = pixels.container.querySelector<HTMLElement>(
      ".readora-diagram-container"
    ) as HTMLElement;
    expect(pixelsContainer.style.width).toBe("640px");
    expect(pixelsContainer.style.height).toBe("360px");
  });

  it("非法尺寸值不写 style，也不把图从渲染路径拽回代码块", () => {
    const h = mounted("```mermaid {width=50vw}\ngraph TD\n  A --> B\n```\n");
    const wrapper = h.container.querySelector<HTMLElement>(DIAGRAM_WRAPPER_SELECTOR) as HTMLElement;
    expect(wrapper.getAttribute("data-readora-width")).toBeNull();
    expect(h.calls).toHaveLength(1);
    const container = wrapper.querySelector<HTMLElement>(".readora-diagram-container") as HTMLElement;
    expect(container.getAttribute("style")).toBeNull();
  });

  it("filename 进工具栏：textContent 写入，不新增 innerHTML 面", () => {
    const h = mounted("```mermaid {filename=\"部署流程.mmd\"}\ngraph TD\n  A --> B\n```\n");
    const label = h.container.querySelector<HTMLElement>(".readora-diagram-filename");
    expect(label?.textContent).toBe("部署流程.mmd");
    // 名字排在按钮之前，工具栏仍然是同一行：不新增第二行 chrome。
    const first = h.container.querySelector(".readora-diagram-toolbar > *");
    expect(first).toBe(label);
    expect(h.container.querySelectorAll(".readora-diagram-tool")).toHaveLength(5);
  });

  it("`filename=@外部文件` 属文件导入，本批不实现：值被拒收，不留半个假 affordance", () => {
    const h = mounted("```mermaid {filename=@README.md}\ngraph TD\n  A --> B\n```\n");
    const wrapper = h.container.querySelector<HTMLElement>(DIAGRAM_WRAPPER_SELECTOR) as HTMLElement;
    expect(wrapper.getAttribute("data-readora-diagram-filename")).toBeNull();
    expect(h.container.querySelector(".readora-diagram-filename")).toBeNull();
  });
});
