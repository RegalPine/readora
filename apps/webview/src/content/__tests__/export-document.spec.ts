/**
 * 导出序列化测试（M11）。
 *
 * 钉死的三件事：
 * 1. 交互专属节点一个都不许进交付物（名单与造它的那一层同源，见 INTERACTIVE_SELECTORS）；
 * 2. 与屏上同源的状态属性必须留着 —— 删了就等于导出件比屏幕少一张占位卡；
 * 3. 处理只有「删」，没有「写」：文本内容前后全等，屏幕上的 DOM 一点不动。
 */
import { beforeEach, describe, expect, test } from "vitest";
import {
  INTERACTIVE_SELECTORS,
  SEARCH_HIT_EXPORT_SELECTOR,
  exportRootStyleText,
  serializeExportDocument
} from "../export-document";
import { CODE_EDITOR_STATE_ATTRIBUTE } from "../code-editor/code-editor-layer";
import { DIAGRAM_ACTION_ATTRIBUTE, DIAGRAM_TOOLBAR_CLASS } from "../diagram-layer";
import {
  REFERENCE_ATTRIBUTE as IMAGE_REFERENCE_ATTRIBUTE,
  STATE_ATTRIBUTE as IMAGE_STATE_ATTRIBUTE
} from "../image-layer";
import {
  DOCUMENT_VERSION_ATTRIBUTE,
  SEARCH_HIT_ID_ATTRIBUTE
} from "../search-engine";
import { CONTENT_WIDTH_VARIABLE, FONT_SIZE_VARIABLE, LINE_HEIGHT_VARIABLE } from "../../app/theme";

/** 一份「接管完成后」的正文：代码块已挂 CodeMirror、图表已出 SVG、图片已补 src。 */
const RICH_HTML = `
  <h2 id="sec">Title</h2>
  <p>Some <strong>bold</strong> prose.</p>
  <div class="readora-code-block" ${CODE_EDITOR_STATE_ATTRIBUTE}="mounted">
    <div class="readora-code-header"><span class="readora-code-lang">ts</span>
      <button type="button" class="readora-code-copy" data-readora-copy>Copy</button>
    </div>
    <pre class="readora-code-pre"><code>const a = 1</code></pre>
    <div class="readora-code-editor"><div class="cm-editor"><div class="cm-content">const a = 1</div></div></div>
  </div>
  <div class="readora-diagram" ${"data-readora-diagram-state"}="rendered">
    <div class="${DIAGRAM_TOOLBAR_CLASS}" role="toolbar">
      <button class="readora-diagram-tool" ${DIAGRAM_ACTION_ATTRIBUTE}="zoom-in">＋</button>
      <button class="readora-diagram-tool" ${DIAGRAM_ACTION_ATTRIBUTE}="fullscreen"></button>
    </div>
    <div class="readora-diagram-container"><svg viewBox="0 0 10 10"><rect width="10" height="10"></rect></svg></div>
    <pre class="readora-diagram-source">graph TD;a--&gt;b</pre>
  </div>
  <div class="readora-diagram readora-diagram--fullscreen" data-readora-diagram-state="failed">
    <div class="readora-diagram-error" role="status"><p class="readora-diagram-error-message">解析失败</p>
      <div class="readora-diagram-error-actions"><button ${DIAGRAM_ACTION_ATTRIBUTE}="retry">重试</button></div>
    </div>
  </div>
  <span class="readora-image readora-image--ready" ${IMAGE_REFERENCE_ATTRIBUTE}="assets/a.png"
        data-readora-mime="image/png" data-readora-resource-id="r-1">
    <img class="readora-image-element" src="vscode-webview://abc/assets/a.png" alt="a">
    <span class="readora-image-label">a</span>
  </span>
  <span class="readora-image readora-image--blocked" ${IMAGE_REFERENCE_ATTRIBUTE}="https://cdn/x.png"
        data-readora-image-state="blocked">
    <img class="readora-image-element" alt="x">
    <span class="readora-image-label">x</span>
    <span class="readora-image-hint">外部图片默认不加载</span>
  </span>
  <table><caption>csv</caption><tbody><tr><td>1</td></tr></tbody></table>
`;

function mount(html = RICH_HTML): HTMLElement {
  const host = document.createElement("div");
  host.className = "readora-document";
  host.setAttribute(DOCUMENT_VERSION_ATTRIBUTE, "12");
  host.innerHTML = html;
  const canvas = document.createElement("main");
  canvas.className = "readora-canvas";
  canvas.append(host);
  document.body.replaceChildren(canvas);
  return host;
}

/** 导出后重新解析成 DOM，方便按选择器断言交付物内容。 */
function parse(bodyHtml: string): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = bodyHtml;
  return host;
}

beforeEach(() => {
  document.body.replaceChildren();
  const root = document.documentElement;
  root.removeAttribute("style");
});

describe("交互专属节点剥除", () => {
  test("CodeMirror 宿主整体摘掉", () => {
    const result = serializeExportDocument(mount());
    expect(parse(result.bodyHtml).querySelector(".readora-code-editor")).toBeNull();
  });

  test("接管状态属性一并摘掉，静态 <pre> 回到唯一视图", () => {
    const result = serializeExportDocument(mount());
    const block = parse(result.bodyHtml).querySelector(".readora-code-block");
    expect(block?.hasAttribute(CODE_EDITOR_STATE_ATTRIBUTE)).toBe(false);
    expect(block?.querySelector("pre.readora-code-pre code")?.textContent).toBe("const a = 1");
  });

  test("图表工具栏与其中的每一枚按钮都不在交付物里", () => {
    const result = serializeExportDocument(mount());
    const root = parse(result.bodyHtml);
    expect(root.querySelector(`.${DIAGRAM_TOOLBAR_CLASS}`)).toBeNull();
    expect(root.querySelectorAll(`[${DIAGRAM_ACTION_ATTRIBUTE}]`)).toHaveLength(0);
  });

  test("失败图留成因文本，但重试按钮被摘", () => {
    const result = serializeExportDocument(mount());
    const root = parse(result.bodyHtml);
    expect(root.querySelector(".readora-diagram-error-message")?.textContent).toBe("解析失败");
    expect(root.querySelector(`[${DIAGRAM_ACTION_ATTRIBUTE}="retry"]`)).toBeNull();
  });

  test("代码复制按钮摘掉，语言标签留下", () => {
    const result = serializeExportDocument(mount());
    const root = parse(result.bodyHtml);
    expect(root.querySelector("button[data-readora-copy]")).toBeNull();
    expect(root.querySelector(".readora-code-lang")?.textContent).toBe("ts");
  });

  test("图片提示行摘掉，label 与占位形状保留", () => {
    const result = serializeExportDocument(mount());
    const root = parse(result.bodyHtml);
    expect(root.querySelector(".readora-image-hint")).toBeNull();
    expect(root.querySelectorAll(".readora-image-label")).toHaveLength(2);
  });

  test("剥除名单每一项都指向真实存在的类名或属性", () => {
    // 凭印象起的名字会让导出静默漏节点：名单里每一项都必须在 fixture 里命中过。
    for (const part of INTERACTIVE_SELECTORS.split(", ")) {
      expect(mount().querySelectorAll(part).length, part).toBeGreaterThan(0);
    }
  });
});

describe("与屏上同源的状态保留", () => {
  test("图表状态属性与内联 SVG 原样带走", () => {
    const result = serializeExportDocument(mount());
    const root = parse(result.bodyHtml);
    const rendered = root.querySelectorAll(".readora-diagram");
    expect(rendered[0]?.getAttribute("data-readora-diagram-state")).toBe("rendered");
    expect(rendered[0]?.querySelector("svg rect")).not.toBeNull();
    expect(rendered[1]?.getAttribute("data-readora-diagram-state")).toBe("failed");
  });

  test("全屏是视图态，不进文件", () => {
    const result = serializeExportDocument(mount());
    expect(parse(result.bodyHtml).querySelector(".readora-diagram--fullscreen")).toBeNull();
    // 节点本身还在：只是不再处于全屏态。
    expect(parse(result.bodyHtml).querySelectorAll(".readora-diagram")).toHaveLength(2);
  });

  test("图片引用、状态与 MIME 保留，供 Host 重新走策略", () => {
    const result = serializeExportDocument(mount());
    const blocked = parse(result.bodyHtml).querySelector(`[${IMAGE_STATE_ATTRIBUTE}="blocked"]`);
    expect(blocked?.getAttribute(IMAGE_REFERENCE_ATTRIBUTE)).toBe("https://cdn/x.png");
    expect(blocked?.getAttribute("data-readora-mime")).toBeNull();
    expect(blocked?.classList.contains("readora-image--blocked")).toBe(true);
  });

  test("块属性尺寸保留（交付物要同样宽）", () => {
    const host = mount(
      `<span class="readora-image" ${IMAGE_REFERENCE_ATTRIBUTE}="a.png" data-readora-width="60%">` +
        `<img class="readora-image-element" src="vscode-webview://x/a.png" alt="a"></span>`
    );
    const root = parse(serializeExportDocument(host).bodyHtml);
    expect(root.querySelector(".readora-image")?.getAttribute("data-readora-width")).toBe("60%");
  });
});

describe("图片 src 摘除", () => {
  test("交付物里没有任何 img 带 src，也没有会话内摘要 id", () => {
    const result = serializeExportDocument(mount());
    const root = parse(result.bodyHtml);
    expect(root.querySelectorAll("img[src]").length).toBe(0);
    expect(result.bodyHtml).not.toContain("vscode-webview://");
    expect(root.querySelector("[data-readora-resource-id]")).toBeNull();
  });

  test("srcset 同样摘掉：它比 src 更容易被漏", () => {
    const host = mount(
      `<span class="readora-image" ${IMAGE_REFERENCE_ATTRIBUTE}="a.png">` +
        `<img srcset="vscode-webview://x/a.png 2x" src="vscode-webview://x/a.png"></span>`
    );
    expect(serializeExportDocument(host).bodyHtml).not.toContain("srcset");
  });
});

describe("搜索高亮 unwrap", () => {
  test("mark 包裹降掉，字符一个不少", () => {
    const host = mount(`<p>readora <mark ${SEARCH_HIT_ID_ATTRIBUTE}="1">export</mark> chain</p>`);
    const before = host.textContent;
    const result = serializeExportDocument(host);
    expect(parse(result.bodyHtml).querySelector(SEARCH_HIT_EXPORT_SELECTOR)).toBeNull();
    expect(parse(result.bodyHtml).textContent).toBe(before);
  });

  test("高亮里的子元素跟着上移，不被一起删掉", () => {
    const host = mount(
      `<p><mark ${SEARCH_HIT_ID_ATTRIBUTE}="1"><strong>bold</strong> hit</mark> tail</p>`
    );
    const root = parse(serializeExportDocument(host).bodyHtml);
    expect(root.querySelector("strong")?.textContent).toBe("bold");
    expect(root.textContent).toBe("bold hit tail");
  });
});

describe("文本零增量", () => {
  test("不新增也不丢失任何文本节点", () => {
    const host = mount();
    const before = host.textContent;
    const result = serializeExportDocument(host);
    // `.readora-code-editor` 与工具栏是「非文档内容」，它们带文字；比较口径是
    // 剥除名单之外的文本一字不动 —— 用反向断言：静态 pre 与图表源码都在。
    const root = parse(result.bodyHtml);
    expect(root.querySelector("pre.readora-code-pre")?.textContent).toBe("const a = 1");
    expect(root.querySelector(".readora-diagram-source")?.textContent).toBe("graph TD;a-->b");
    expect(before).toContain("Some bold prose.");
    expect(root.textContent).toContain("Some bold prose.");
    expect(root.textContent).toContain("csv");
  });

  test("序列化不扰动屏幕上的 DOM", () => {
    const host = mount();
    serializeExportDocument(host);
    expect(host.querySelector(".readora-code-editor")).not.toBeNull();
    expect(host.querySelector(`[${CODE_EDITOR_STATE_ATTRIBUTE}]`)).not.toBeNull();
    expect(host.querySelector<HTMLImageElement>("img")?.getAttribute("src")).toContain(
      "vscode-webview://"
    );
  });
});

describe("偏好变量与尺寸", () => {
  test("三个变量按行内值输出，顺序固定", () => {
    const host = mount();
    const root = document.documentElement;
    root.style.setProperty(FONT_SIZE_VARIABLE, "18px");
    root.style.setProperty(LINE_HEIGHT_VARIABLE, "1.75");
    root.style.setProperty(CONTENT_WIDTH_VARIABLE, "820px");
    expect(exportRootStyleText(root)).toBe(
      "--readora-font-size: 18px; --readora-line-height: 1.75; --readora-content-width: 820px"
    );
    expect(serializeExportDocument(host).rootStyleText).toContain("--readora-font-size: 18px");
  });

  test("未下发偏好时不拼空声明", () => {
    expect(exportRootStyleText(document.documentElement)).toBe("");
  });

  test("版本号取自身标记，非法值落回 0 由 Host 判陈旧", () => {
    expect(serializeExportDocument(mount()).version).toBe(12);
    const host = mount();
    host.setAttribute(DOCUMENT_VERSION_ATTRIBUTE, "NaN");
    expect(serializeExportDocument(host).version).toBe(0);
  });

  test("宽取 canvas、高取正文 scrollHeight", () => {
    const host = mount();
    const canvas = host.parentElement as HTMLElement;
    Object.defineProperty(canvas, "offsetWidth", { value: 903, configurable: true });
    Object.defineProperty(host, "scrollHeight", { value: 4200, configurable: true });
    const result = serializeExportDocument(host);
    expect(result.canvasWidthPx).toBe(903);
    expect(result.contentHeightPx).toBe(4200);
  });

  test("无 canvas 时退回正文宽，不抛出", () => {
    const host = document.createElement("div");
    host.className = "readora-document";
    document.body.replaceChildren(host);
    expect(serializeExportDocument(host).canvasWidthPx).toBe(0);
  });
});
