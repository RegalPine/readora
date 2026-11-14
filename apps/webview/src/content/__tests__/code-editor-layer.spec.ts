/**
 * 代码编辑器接管层测试（IMP-001 §14 Component Test，ARC-002 §8 的编辑器化改造）。
 *
 * 一律注入编辑器替身：CodeMirror 在 jsdom 里没有布局，真实例的行高测量、
 * 视口渲染都不可信 —— 真实挂载交给 Playwright（tests/e2e/code-editor.spec.ts）。
 * 本层要证的是接管纪律：接管时机、状态写回、降级只掉一块、销毁不留悬挂实例，
 * 以及那条最容易破坏的约束 —— **静态 `<pre>` 必须留在 DOM 里**（搜索唯一的文本源）。
 *
 * 输入产物取自真实 renderMarkdown：夹具与生产者同源，才不会各测各的
 * （这条口径是图表层踩过的坑，见 search-engine 的 DIAGRAM_EXCLUDED_SELECTOR 注）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderMarkdown } from "@readora/markdown-core";
import {
  CODE_EDITOR_HOST_CLASS,
  CODE_EDITOR_ROOT_MARGIN,
  CODE_EDITOR_STATE_ATTRIBUTE,
  createCodeEditorLayer,
  stripTrailingNewline,
  type CodeEditorInit,
  type CodeEditorLayer
} from "../code-editor/code-editor-layer";
import type { ObserverHandle } from "../viewport";

const DOCUMENT_URI = "file:///vault/notes/code.md";

const CODE_DOC = [
  "# Code",
  "",
  "```js",
  "export function greet(name) {",
  '  return "hi " + name;',
  "}",
  "```",
  "",
  "```python",
  'print("hello")',
  "```",
  "",
  "```brainfuck",
  "++++[---->++++++++]",
  "```",
  "",
  "```text",
  "散文式纯文本",
  "```",
  "",
  "```js",
  "```",
  ""
].join("\n");

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
  layer: CodeEditorLayer;
  /** 每次真起编辑器都记在这里：init 是要断言的核心契约。 */
  inits: CodeEditorInit[];
  hosts: HTMLElement[];
  observed: Element[];
  activate: (element: HTMLElement) => void;
  destroys: ReturnType<typeof vi.fn>[];
  measures: ReturnType<typeof vi.fn>[];
}

function mountDocument(text: string): HTMLElement {
  const container = document.createElement("div");
  container.innerHTML = htmlFor(text);
  document.body.append(container);
  return container;
}

function setup(
  text: string,
  options: { failFirst?: boolean; observer?: boolean } = {}
): Harness {
  const container = mountDocument(text);
  const inits: CodeEditorInit[] = [];
  const hosts: HTMLElement[] = [];
  const observed: Element[] = [];
  const destroys: ReturnType<typeof vi.fn>[] = [];
  const measures: ReturnType<typeof vi.fn>[] = [];
  let activate: (element: HTMLElement) => void = () => {};
  // 「只让第一块撞抛错」要按尝试次数判：拿 inits.length 判会连着第二块一起失败，
  // 因为抛错那块根本不会进 inits。
  let alreadyFailed = false;

  const layer: CodeEditorLayer = createCodeEditorLayer({
    createObserver:
      options.observer === false
        ? () => null
        : (callback) => {
            activate = callback;
            const handle: ObserverHandle = {
              observe: (element) => {
                observed.push(element);
              },
              unobserve: (element) => {
                const at = observed.indexOf(element);
                if (at >= 0) {
                  observed.splice(at, 1);
                }
              },
              disconnect: () => {
                observed.length = 0;
              }
            };
            return handle;
          },
    createEditor: (host, init) => {
      if (options.failFirst && !alreadyFailed) {
        alreadyFailed = true;
        throw new Error("stub: 布局不可用");
      }
      inits.push(init);
      hosts.push(host);
      const destroy = vi.fn();
      const requestMeasure = vi.fn();
      destroys.push(destroy);
      measures.push(requestMeasure);
      return { destroy, requestMeasure };
    }
  });

  return { container, layer, inits, hosts, observed, activate, destroys, measures };
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("接管纪律", () => {
  it("scan 给每个代码块标 pending、在 pre 之后插宿主，但不立即起实例", () => {
    const { container, layer, observed } = setup(CODE_DOC);
    const blocks = [...container.querySelectorAll(".readora-code-block")];

    expect(layer.scan(container)).toBe(blocks.length);
    expect(blocks).toHaveLength(5);
    for (const block of blocks) {
      expect(block.getAttribute(CODE_EDITOR_STATE_ATTRIBUTE)).toBe("pending");
      const host = block.querySelector(`.${CODE_EDITOR_HOST_CLASS}`);
      expect(host).not.toBeNull();
      // 宿主必须紧跟在 pre 之后：两个视图是兄弟，谁显谁隐由 CSS 判。
      expect(host?.previousElementSibling?.className).toContain("readora-code-pre");
    }
    // 观察器路径下实例数还是 0 —— 首屏不该铺 N 个编辑器。
    expect(layer.instanceCount).toBe(0);
    expect(observed).toHaveLength(blocks.length);
  });

  it("进入视口才起实例，源码与语言一起交出，状态转 mounted", () => {
    const { container, layer, inits, activate } = setup(CODE_DOC);
    layer.scan(container);
    const first = container.querySelector(".readora-code-block") as HTMLElement;

    activate(first);

    expect(layer.stateOf(first)).toBe("mounted");
    expect(inits).toHaveLength(1);
    expect(inits[0]?.language).toBe("js");
    expect(inits[0]?.source).toBe('export function greet(name) {\n  return "hi " + name;\n}');
    expect(layer.instanceCount).toBe(1);
  });

  it("静态 pre 在挂载后仍然留在 DOM 里（搜索唯一的可搜文本源）", () => {
    const { container, layer, activate } = setup(CODE_DOC);
    layer.scan(container);
    const first = container.querySelector(".readora-code-block") as HTMLElement;

    activate(first);

    const pre = first.querySelector(".readora-code-pre");
    expect(pre).not.toBeNull();
    expect(pre?.textContent).toContain("export function greet");
    // 已挂载的块从观察目标里摘掉：滚动来回不该重复起实例。
    expect(layer.stateOf(first)).toBe("mounted");
  });

  it("没有 IntersectionObserver 的环境立即挂载，行为与图表层退化一致", () => {
    const { container, layer, inits } = setup(CODE_DOC, { observer: false });

    expect(layer.scan(container)).toBe(5);
    // 最后一个块是空代码：不起实例（见下面那条用例），所以 4 个。
    expect(inits).toHaveLength(4);
    expect(layer.instanceCount).toBe(4);
  });

  it("重复 scan 幂等：一块只有一个编辑器、一个宿主", () => {
    const { container, layer } = setup(CODE_DOC);

    expect(layer.scan(container)).toBe(5);
    expect(layer.scan(container)).toBe(0);
    for (const block of container.querySelectorAll(".readora-code-block")) {
      expect(block.querySelectorAll(`.${CODE_EDITOR_HOST_CLASS}`)).toHaveLength(1);
    }
  });

  it("空代码块不值得起编辑器：标 failed，pre 原样留着", () => {
    const { container, layer, inits } = setup(CODE_DOC, { observer: false });
    layer.scan(container);
    const empty = [...container.querySelectorAll(".readora-code-block")].at(-1) as HTMLElement;

    expect(layer.stateOf(empty)).toBe("failed");
    expect(empty.querySelector(`.${CODE_EDITOR_HOST_CLASS}`)).toBeNull();
    expect(empty.querySelector(".readora-code-pre")).not.toBeNull();
    // 空块不进 inits：其它四块照常。
    expect(inits).toHaveLength(4);
  });

  it("挂载失败只降级这一块：宿主撤掉、pre 可见，其它块不受影响", () => {
    const { container, layer, inits } = setup(CODE_DOC, { failFirst: true, observer: false });
    layer.scan(container);
    const blocks = [...container.querySelectorAll(".readora-code-block")];

    // 第一块（js）撞抛错，第二块（python）成功。
    expect(layer.stateOf(blocks[0] as HTMLElement)).toBe("failed");
    expect(blocks[0]?.querySelector(`.${CODE_EDITOR_HOST_CLASS}`)).toBeNull();
    expect(blocks[0]?.querySelector(".readora-code-pre")).not.toBeNull();
    expect(layer.stateOf(blocks[1] as HTMLElement)).toBe("mounted");
    expect(inits).toHaveLength(3);
    expect(layer.instanceCount).toBe(3);
  });

  it("未知语言照样挂成编辑器，语言位原样交出（判定交给语法表）", () => {
    const { container, layer, inits, activate } = setup(CODE_DOC);
    layer.scan(container);
    const weird = [...container.querySelectorAll(".readora-code-block")][2] as HTMLElement;

    activate(weird);

    expect(inits.some((init) => init.language === "brainfuck")).toBe(true);
    expect(layer.stateOf(weird)).toBe("mounted");
  });

  it("无语言位的块交出渲染器归一后的 text，语法表把它判成无语法", () => {
    // 渲染器对没有语言位的围栏写 `data-readora-code-lang="text"`（code.ts 里的
    // languageLabel 归一），接管层不自己再造一套「缺语言」的判定，原样交出。
    const container = mountDocument(["# No lang", "", "```", "raw text", "```", ""].join("\n"));
    const layer = createCodeEditorLayer({
      createObserver: () => null,
      createEditor: (_host, init) => {
        expect(init.language).toBe("text");
        expect(init.source).toBe("raw text");
        return { destroy: vi.fn(), requestMeasure: vi.fn() };
      }
    });

    expect(layer.scan(container)).toBe(1);
    layer.destroy();
  });
});

describe("生命周期", () => {
  it("destroy 关掉观察器、销毁每个实例、撤掉所有宿主", () => {
    const { container, layer, destroys, observed } = setup(CODE_DOC, { observer: false });
    layer.scan(container);
    const hosts = [...container.querySelectorAll(`.${CODE_EDITOR_HOST_CLASS}`)];
    expect(hosts.length).toBe(4);

    layer.destroy();

    expect(destroys).toHaveLength(4);
    for (const destroy of destroys) {
      expect(destroy).toHaveBeenCalledTimes(1);
    }
    expect(observed).toHaveLength(0);
    expect(container.querySelectorAll(`.${CODE_EDITOR_HOST_CLASS}`)).toHaveLength(0);
    expect(layer.instanceCount).toBe(0);
  });

  it("destroy 后再 scan 同一容器可以重新接管（正文重写不留陈旧实例）", () => {
    const { container, layer, inits } = setup(CODE_DOC, { observer: false });
    layer.scan(container);
    layer.destroy();
    layer.scan(container);

    expect(inits).toHaveLength(8);
    expect(layer.instanceCount).toBe(4);
  });

  it("refreshAll 请每个实例重测度量（字号偏好走这条）", () => {
    const { container, layer, measures } = setup(CODE_DOC, { observer: false });
    layer.scan(container);

    layer.refreshAll();

    expect(measures).toHaveLength(4);
    for (const measure of measures) {
      expect(measure).toHaveBeenCalledTimes(1);
    }
  });

  it("stateOf 只认代码块，别的元素返回 null", () => {
    const { container, layer } = setup(CODE_DOC);
    layer.scan(container);

    expect(layer.stateOf(container.querySelector("h1") as Element)).toBeNull();
  });

  it("视口余量比图片层给得宽松，且与实现里的常量一致", () => {
    // 400px：编辑器建实例比图表便宜，但仍不该在首屏一次性铺满长文档。
    expect(CODE_EDITOR_ROOT_MARGIN).toBe("400px");
  });
});

describe("尾部换行裁剪", () => {
  it("只削最后一个换行，块内空行保留", () => {
    expect(stripTrailingNewline("a\nb\n")).toBe("a\nb");
    expect(stripTrailingNewline("a\n\n")).toBe("a\n");
    expect(stripTrailingNewline("a")).toBe("a");
    expect(stripTrailingNewline("")).toBe("");
  });

  it("真实产物里 pre 的文本以换行结尾，行号才不会比静态视图多一行", () => {
    const container = mountDocument(CODE_DOC);
    const code = container.querySelector(".readora-code-pre code");
    expect(code?.textContent?.endsWith("\n")).toBe(true);
    // 静态视图里这块是三行；削掉尾部换行后编辑器的文档模型同样三行。
    expect(stripTrailingNewline(code?.textContent ?? "").split("\n")).toHaveLength(3);
  });
});
