/**
 * 正文交互委托测试（IMP-001 §14 Component Test，ARC-005 §9.4）。
 *
 * 通过 MarkdownContent 走真实链路：渲染产物 → 容器委托 → 行为断言。
 * 产物里没有内联脚本，所有交互只能由 interactions.ts 承担。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { READORA_ERROR_CODES } from "@readora/contracts";
import { BLOCKED_REMOTE_REASON } from "../image-layer";
import { MarkdownContent } from "../MarkdownContent";
import {
  attachContentInteractions,
  RELATIVE_LINK_NOTE,
  WIKI_LINK_MISSING_NOTE,
  WIKI_LINK_SELECTOR,
  type ContentInteractionHandlers
} from "../interactions";

const DOCUMENT_URI = "file:///vault/notes/interactions.md";

interface Setup {
  container: HTMLElement;
  handlers: ContentInteractionHandlers;
}

interface SetupOptions {
  /** Host 是否接受跨文档跳转；false 走行内降级文案。 */
  navigateAccepted?: boolean;
}

function setup(text: string, options: SetupOptions = {}): Setup {
  const navigateAccepted = options.navigateAccepted ?? true;
  const handlers: ContentInteractionHandlers = {
    openExternal: vi.fn(),
    navigate: vi.fn(async () => navigateAccepted),
    openImage: vi.fn(),
    resolveResource: vi.fn(async () => ({
      ok: false as const,
      code: READORA_ERROR_CODES.RESOURCE_NOT_FOUND,
      message: "missing"
    }))
  };
  const view = render(
    <MarkdownContent
      documentId={DOCUMENT_URI}
      documentUri={DOCUMENT_URI}
      version={1}
      text={text}
      theme="light"
      handlers={handlers}
    />
  );
  const container = view.container.querySelector<HTMLDivElement>(".readora-document");
  if (!container) {
    throw new Error("readora-document container missing");
  }
  return { container, handlers };
}

const SOURCES = {
  anchor: "# 目标标题\n\n[跳转](#目标标题)\n",
  external: "[文档](https://example.com/page?a=1)\n",
  relative: "[相邻笔记](./other.md)\n",
  image: "![示意图](https://example.com/a.png)\n",
  code: "```javascript\nconst greeting = \"hi\";\n```\n"
};

beforeEach(() => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete (navigator as { clipboard?: unknown }).clipboard;
});

describe("文档内锚点", () => {
  it("点击锚点滚动到目标标题，URL 编码的 CJK 锚点被解码定位", () => {
    const { container } = setup(SOURCES.anchor);
    const link = container.querySelector<HTMLAnchorElement>("a[data-readora-anchor]");
    const heading = container.querySelector("h1");
    expect(link?.getAttribute("href")).toContain("%E7%9B%AE");
    expect(heading?.id).toBe("目标标题");

    // fireEvent 返回「未被取消」标志：false 表示 preventDefault 已生效
    expect(fireEvent.click(link as HTMLAnchorElement)).toBe(false);
    expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalledTimes(1);
    expect(heading?.getAttribute("tabindex")).toBe("-1");
  });

  it("锚点目标不存在时静默降级，不抛穿", () => {
    const { container } = setup("[失效锚点](#不存在)\n");
    const link = container.querySelector<HTMLAnchorElement>("a[data-readora-anchor]");
    expect(() => {
      fireEvent.click(link as HTMLAnchorElement);
    }).not.toThrow();
    expect(HTMLElement.prototype.scrollIntoView).not.toHaveBeenCalled();
  });

  // Sanitizer 的 DOMPurify DOM-clobbering 保护会剥离与 document 具名属性冲突的 id
  // （标题「Images」→ id="images" 被丢掉），委托必须靠 data-readora-heading 镜像兜底。
  it("id 被 DOMPurify 剥离时锚点仍能定位到镜像标题", () => {
    const { container } = setup("## Images\n\n[跳转](#images)\n");
    const heading = container.querySelector("[data-readora-heading=\"images\"]");
    expect(heading).not.toBeNull();
    expect(heading?.id).toBe("");
    expect(container.ownerDocument!.getElementById("images")).toBeNull();

    const link = container.querySelector<HTMLAnchorElement>("a[data-readora-anchor]");
    fireEvent.click(link as HTMLAnchorElement);
    expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalledTimes(1);
    expect(heading?.getAttribute("tabindex")).toBe("-1");
  });
});

describe("外链与降级链接", () => {
  it("外链交 Host（document.open），Webview 不自行打开窗口", () => {
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
    const { container, handlers } = setup(SOURCES.external);
    const link = container.querySelector<HTMLAnchorElement>("a[data-readora-external]");

    fireEvent.click(link as HTMLAnchorElement);
    expect(handlers.openExternal).toHaveBeenCalledWith("https://example.com/page?a=1");
    expect(openSpy).not.toHaveBeenCalled();
  });

  it("相对链接交 Host 解析后跳转，被接受时不留提示", async () => {
    const { container, handlers } = setup(SOURCES.relative);
    const inert = container.querySelector<HTMLElement>("[data-readora-relative]");
    expect(inert?.getAttribute("href")).toBeNull();

    expect(fireEvent.click(inert as HTMLElement)).toBe(false);
    expect(handlers.navigate).toHaveBeenCalledWith("./other.md");
    await vi.waitFor(() => {
      expect(container.querySelector(".readora-inline-note")).toBeNull();
    });
  });

  it("Host 拒绝相对链接时回退行内降级提示，且重复点击不叠加节点", async () => {
    const { container } = setup(SOURCES.relative, { navigateAccepted: false });
    const inert = container.querySelector<HTMLElement>("[data-readora-relative]");

    fireEvent.click(inert as HTMLElement);
    await vi.waitFor(() => {
      expect(container.querySelector(".readora-inline-note")?.textContent).toBe(RELATIVE_LINK_NOTE);
    });
    expect(container.querySelectorAll(".readora-inline-note")).toHaveLength(1);

    fireEvent.click(inert as HTMLElement);
    await vi.waitFor(() => {
      expect(container.querySelectorAll(".readora-inline-note")).toHaveLength(1);
    });
  });

  it("外部图片被策略拦截：点击给出拦截原因而不是打开空 Lightbox", async () => {
    const { container, handlers } = setup(SOURCES.image);
    const wrapper = container.querySelector<HTMLElement>("[data-readora-image]");
    await vi.waitFor(() => {
      expect(wrapper?.getAttribute("data-readora-image-state")).toBe("blocked");
    });

    fireEvent.click(wrapper as HTMLElement);
    expect(handlers.openImage).not.toHaveBeenCalled();
    expect(container.querySelector(".readora-inline-note")?.textContent).toBe(
      BLOCKED_REMOTE_REASON
    );
  });

  it("已就绪的图片点击交上层打开 Lightbox，地址取自已补上的 src", () => {
    const { container, handlers } = setup(SOURCES.image);
    const wrapper = container.querySelector<HTMLElement>("[data-readora-image]") as HTMLElement;
    // 直接摆出 ready 态：image-layer 是唯一的 src 作者，这里只验委托分流。
    wrapper.setAttribute("data-readora-image-state", "ready");
    const img = wrapper.querySelector("img") as HTMLImageElement;
    img.setAttribute("src", "https://stub.local/readora.png");

    fireEvent.click(wrapper);
    expect(handlers.openImage).toHaveBeenCalledWith(
      expect.objectContaining({
        reference: "https://example.com/a.png",
        state: "ready",
        src: "https://stub.local/readora.png"
      })
    );
    expect(container.querySelector(".readora-inline-note")).toBeNull();
  });
});

describe("SVG 内链接委托", () => {
  // Sanitizer 把图表 SVG 里 <a> 的 href 改写成 data-readora-external（ARC-008 §10.3 第 4 条）：
  // 委托必须在 SVG 命名空间元素上同样命中，且不能依赖 dataset（部分实现不提供）。
  function svgAnchorWith(uri: string): SVGAElement {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    const anchor = document.createElementNS("http://www.w3.org/2000/svg", "a");
    const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
    label.textContent = "节点";
    anchor.setAttribute("data-readora-external", uri);
    anchor.append(label);
    svg.append(anchor);
    return anchor;
  }

  it("SVG 锚点点击复用同一条外链通道，dataset 不参与读取", () => {
    const openExternal = vi.fn();
    const container = document.createElement("div");
    const anchor = svgAnchorWith("https://example.com/from-diagram");
    container.append(anchor.parentNode as Node);
    const detach = attachContentInteractions(container, {
      openExternal,
      navigate: async () => true,
      openImage: vi.fn(),
      resolveResource: async () => ({
        ok: false as const,
        code: READORA_ERROR_CODES.RESOURCE_NOT_FOUND,
        message: "missing"
      })
    });

    expect(fireEvent.click(anchor)).toBe(false);
    expect(openExternal).toHaveBeenCalledWith("https://example.com/from-diagram");
    expect(anchor.hasAttribute("href")).toBe(false);
    detach();
  });
});

describe("代码块复制", () => {
  function buttonOf(container: HTMLElement): HTMLButtonElement {
    const button = container.querySelector<HTMLButtonElement>("button[data-readora-copy]");
    if (!button) {
      throw new Error("copy button missing");
    }
    return button;
  }

  it("clipboard 可用时写入代码原文并给出状态反馈", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true
    });
    const { container } = setup(SOURCES.code);

    fireEvent.click(buttonOf(container));
    await vi.waitFor(() => {
      expect(buttonOf(container).textContent).toBe("Copied");
    });
    expect(writeText).toHaveBeenCalledWith('const greeting = "hi";\n');
    expect(buttonOf(container).dataset.readoraCopyState).toBe("copied");
  });

  it("clipboard 抛错时回退 document.execCommand", async () => {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
      configurable: true
    });
    const execCommand = vi.fn(() => true);
    document.execCommand = execCommand;
    const { container } = setup(SOURCES.code);

    fireEvent.click(buttonOf(container));
    await vi.waitFor(() => {
      expect(buttonOf(container).textContent).toBe("Copied");
    });
    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(container.querySelectorAll("textarea.readora-copy-helper")).toHaveLength(0);
  });

  it("两条路径都失败时提示失败而不是静默", async () => {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
      configurable: true
    });
    document.execCommand = vi.fn(() => false);
    const { container } = setup(SOURCES.code);

    fireEvent.click(buttonOf(container));
    await vi.waitFor(() => {
      expect(buttonOf(container).textContent).toBe("Copy failed");
    });
    expect(buttonOf(container).dataset.readoraCopyState).toBe("failed");
  });

  it("execCommand 自身抛错也被吞掉并报告失败", async () => {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
      configurable: true
    });
    document.execCommand = vi.fn(() => {
      throw new Error("not supported");
    });
    const { container } = setup(SOURCES.code);

    fireEvent.click(buttonOf(container));
    await vi.waitFor(() => {
      expect(buttonOf(container).textContent).toBe("Copy failed");
    });
  });
});

/**
 * Wiki 引用激活（STORY-06-03）。
 *
 * 渲染层已经保证产物只有 `data-readora-wikilink`、没有 href（wiki-link.spec.ts），
 * 这里只锁 webview 侧的两条激活通道与「未命中就地提示」：
 * - 点击：交 Host document.navigate，落空才 showInlineNote；
 * - 键盘：无 href 的 `<a>` 浏览器不为 Enter 合成 click，必须显式接住。
 */
describe("Wiki 引用激活", () => {
  function wikiAnchor(container: HTMLElement): HTMLAnchorElement {
    const anchor = container.querySelector<HTMLAnchorElement>(WIKI_LINK_SELECTOR);
    if (!anchor) {
      throw new Error("wikilink anchor missing");
    }
    return anchor;
  }

  it("点击把目标原文交 Host，命中后不显示提示", async () => {
    const { container, handlers } = setup("[[我的笔记]]\n");
    const anchor = wikiAnchor(container);
    // §12.2：目标名从属性读，不由 Webview 拼路径 —— 这里确认属性值就是目标原文。
    expect(anchor.getAttribute("data-readora-wikilink")).toBe("我的笔记");

    expect(fireEvent.click(anchor)).toBe(false);
    expect(handlers.navigate).toHaveBeenCalledWith("我的笔记");
    await vi.waitFor(() => {
      expect(container.querySelector(".readora-inline-note")).toBeNull();
    });
  });

  it("Host 未命中时行内提示，且重复点击不叠加节点", async () => {
    const { container } = setup("[[缺失笔记]]\n", { navigateAccepted: false });
    const anchor = wikiAnchor(container);

    fireEvent.click(anchor);
    await vi.waitFor(() => {
      expect(container.querySelector(".readora-inline-note")?.textContent).toBe(
        WIKI_LINK_MISSING_NOTE
      );
    });
    fireEvent.click(anchor);
    await vi.waitFor(() => {
      expect(container.querySelectorAll(".readora-inline-note")).toHaveLength(1);
    });
  });

  it("Enter 键激活：无 href 的链接靠委托接住，不当作普通文本", () => {
    const { container, handlers } = setup("[[键盘笔记]]\n");
    const anchor = wikiAnchor(container);

    // fireEvent.keyDown 返回「未被取消」：false 表示 preventDefault 生效。
    expect(fireEvent.keyDown(anchor, { key: "Enter" })).toBe(false);
    expect(handlers.navigate).toHaveBeenCalledWith("键盘笔记");
  });

  it("空格键同样激活（链接不应让页面滚动）", () => {
    const { container, handlers } = setup("[[空格笔记]]\n");
    const anchor = wikiAnchor(container);

    expect(fireEvent.keyDown(anchor, { key: " " })).toBe(false);
    expect(handlers.navigate).toHaveBeenCalledWith("空格笔记");
  });

  it("长按自动重复（event.repeat）不重复发请求", () => {
    const { container, handlers } = setup("[[重复笔记]]\n");
    const anchor = wikiAnchor(container);

    fireEvent.keyDown(anchor, { key: "Enter", repeat: true });
    expect(handlers.navigate).not.toHaveBeenCalled();
  });
});


describe("脚注跳转（M10）", () => {
  const FOOTNOTE = "正文带一个引用[^note]。\n\n[^note]: 脚注正文。\n";

  it("点击引用滚到脚注条目：非标题 id 同样走 getElementById 这条路径", () => {
    const { container } = setup(FOOTNOTE);
    const reference = container.querySelector<HTMLAnchorElement>("a.readora-footnote-ref");
    const item = container.querySelector<HTMLElement>("li.readora-footnote-item");
    expect(reference?.getAttribute("href")).toBe("#readora-fn-1");
    expect(item?.id).toBe("readora-fn-1");
    // 交互层为脚注新写的代码是 0 行：能不能跳，全押在 findHeading 的第一条查找路径上。
    expect(container.ownerDocument!.getElementById("readora-fn-1")).toBe(item);

    // fireEvent 返回「未被取消」标志：false 表示 preventDefault 已生效
    expect(fireEvent.click(reference as HTMLAnchorElement)).toBe(false);
    expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalledTimes(1);
    expect(item?.getAttribute("tabindex")).toBe("-1");
  });

  it("点击回跳滚回正文里的引用，而不是停在脚注区", () => {
    const { container } = setup(FOOTNOTE);
    const backref = container.querySelector<HTMLAnchorElement>("a.readora-footnote-backref");
    const reference = container.querySelector<HTMLElement>("a.readora-footnote-ref");
    expect(backref?.getAttribute("href")).toBe("#readora-fnref-1");
    expect(backref?.getAttribute("data-readora-anchor")).toBe("readora-fnref-1");
    // 回跳自己不需要 id：写了 id="" 反而会被下游选择器当成一个具名元素。
    expect(backref?.hasAttribute("id")).toBe(false);

    fireEvent.click(backref as HTMLAnchorElement);
    expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalledTimes(1);
    expect(reference?.getAttribute("tabindex")).toBe("-1");
  });

  it("脚注标题不是 heading：目录与 outline 里不多出一条「脚注」", () => {
    const { container } = setup("# 唯一标题\n\n文字[^a]。\n\n[^a]: 定义。\n");
    expect(container.querySelectorAll("h1, h2, h3, h4, h5, h6")).toHaveLength(1);
    expect(container.querySelector(".readora-footnotes-title")?.tagName).toBe("P");
    expect(container.querySelectorAll("[data-readora-heading]")).toHaveLength(1);
  });

  it("未命中的引用不摆跳转：原样显示 [^missing]，没有注定跳不到的 affordance", () => {
    const { container } = setup("文字[^missing]。\n");
    expect(container.querySelector("a.readora-footnote-ref")).toBeNull();
    expect(container.textContent).toContain("[^missing]");
  });
});
