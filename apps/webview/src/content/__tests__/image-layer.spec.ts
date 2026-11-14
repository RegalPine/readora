/**
 * 图片激活层测试（IMP-001 §14 Component Test，ARC-008 §9 / STORY-08-02）。
 *
 * 断言的是状态机与请求口径，而不是浏览器解码结果：
 * 四态（pending / ready / missing / blocked）各自的写入、懒加载触发次数、
 * 契约不合时的降级、以及 destroy 之后在途结果不得再改 DOM。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { READORA_ERROR_CODES } from "@readora/contracts";
import {
  BLOCKED_DATA_REASON,
  BLOCKED_REMOTE_REASON,
  LOAD_FAILED_REASON,
  IMAGE_ROOT_MARGIN,
  STATE_ATTRIBUTE,
  classifyReference,
  createImageLayer,
  reasonForFailure,
  setState,
  type ImageLayer
} from "../image-layer";
import type { ResourceEntry } from "../resource-cache";
import { failedResource, okResource } from "./test-support";

const MARKUP = (reference: string, state = "pending", extra = ""): string =>
  `<p><span class="readora-image readora-image--local" data-readora-image="${reference}" data-readora-image-state="${state}"${extra}>` +
  `<img class="readora-image-element" alt="示意图">` +
  `<span class="readora-image-label">示意图</span>` +
  `<span class="readora-image-hint">图片加载待资源解析（M3）</span>` +
  `</span></p>`;

function mount(reference = "assets/logo.png", state = "pending", extra = ""): HTMLElement {
  const container = document.createElement("div");
  container.innerHTML = MARKUP(reference, state, extra);
  document.body.append(container);
  return container;
}

interface Harness {
  container: HTMLElement;
  wrapper: HTMLElement;
  resolve: ReturnType<typeof vi.fn>;
  layer: ImageLayer;
  observed: Element[];
  activate: (element: HTMLElement) => void;
  calls: number;
}

/** 假观察器：把「进入视口」变成可手动触发的回调，懒加载断言才有确定性。 */
function harness(
  reference = "assets/logo.png",
  entry?: ResourceEntry,
  state = "pending",
  extra = ""
): Harness {
  const container = mount(reference, state, extra);
  const wrapper = container.querySelector<HTMLElement>("[data-readora-image]") as HTMLElement;
  const observed: Element[] = [];
  let activate: (element: HTMLElement) => void = () => {};
  const resolve = vi.fn(async () => entry ?? okResource(reference));
  const layer = createImageLayer({
    resolve,
    createObserver: (callback) => {
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
    wrapper,
    resolve,
    layer,
    observed,
    activate,
    get calls(): number {
      return resolve.mock.calls.length;
    }
  };
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("引用分类", () => {
  it("data: 独立成类，远端与协议相对地址归 remote", () => {
    expect(classifyReference("assets/a.png")).toBe("local");
    expect(classifyReference("./assets/a.png")).toBe("local");
    expect(classifyReference("https://cdn.example.com/a.png")).toBe("remote");
    expect(classifyReference("//cdn.example.com/a.png")).toBe("remote");
    // markdown-core 的 classifyImageSrc 只分 remote/local，data: 会落到 local：
    // 本层必须自己识别，否则 data: 图片会被当成引用交给 Host 解析。
    expect(classifyReference("data:image/png;base64,AAAA")).toBe("data");
    expect(classifyReference("  DATA:image/png;base64,AAAA ")).toBe("data");
  });

  it("错误码到原因的映射覆盖全部资源错误码", () => {
    for (const code of [
      READORA_ERROR_CODES.RESOURCE_NOT_FOUND,
      READORA_ERROR_CODES.RESOURCE_DENIED,
      READORA_ERROR_CODES.RESOURCE_TOO_LARGE,
      READORA_ERROR_CODES.RESOURCE_UNSUPPORTED,
      READORA_ERROR_CODES.RESOURCE_UNREADABLE
    ]) {
      expect(reasonForFailure(code)).not.toHaveLength(0);
      expect(reasonForFailure(code)).not.toBe(reasonForFailure("readora.resource.unknown-code"));
    }
    expect(reasonForFailure("readora.resource.unknown-code")).toBe("解析失败");
  });
});

describe("ready 态", () => {
  it("解析成功后补 src、写状态并移除 M3 提示", async () => {
    const entry = okResource("assets/logo.png", { webviewUri: "https://stub.local/a.png" });
    const h = harness("assets/logo.png", entry);
    h.layer.scan(h.container);
    h.activate(h.wrapper);

    await vi.waitFor(() => {
      expect(h.wrapper.getAttribute(STATE_ATTRIBUTE)).toBe("ready");
    });
    const img = h.wrapper.querySelector("img") as HTMLImageElement;
    expect(img.getAttribute("src")).toBe("https://stub.local/a.png");
    if (entry.ok) {
      expect(h.wrapper.getAttribute("data-readora-resource-id")).toBe(entry.result.resourceId);
      expect(h.wrapper.getAttribute("data-readora-mime")).toBe(entry.result.mimeType);
    }
    expect(h.wrapper.querySelector(".readora-image-hint")).toBeNull();
    expect(h.wrapper.classList.contains("readora-image--ready")).toBe(true);
  });

  it("同一元素重复 scan 不重复问 Host", async () => {
    const h = harness("assets/logo.png");
    h.layer.scan(h.container);
    h.activate(h.wrapper);
    await vi.waitFor(() => {
      expect(h.calls).toBe(1);
    });
    expect(h.layer.scan(h.container)).toBe(0);
    h.activate(h.wrapper);
    await Promise.resolve();
    expect(h.calls).toBe(1);
  });

  it("解码失败（naturalWidth 为 0）降级为 missing", async () => {
    const h = harness("assets/broken.png");
    h.layer.scan(h.container);
    h.activate(h.wrapper);
    await vi.waitFor(() => {
      expect(h.wrapper.getAttribute(STATE_ATTRIBUTE)).toBe("ready");
    });
    const img = h.wrapper.querySelector("img") as HTMLImageElement;
    // jsdom 永不真正解码：naturalWidth 恒为 0，load 事件即「解码失败」判据
    img.dispatchEvent(new Event("load"));
    expect(h.wrapper.getAttribute(STATE_ATTRIBUTE)).toBe("missing");
    expect(h.wrapper.querySelector(".readora-image-hint")?.textContent).toBe(LOAD_FAILED_REASON);
  });

  it("img error 事件同样落到 missing", async () => {
    const h = harness("assets/broken.png");
    h.layer.scan(h.container);
    h.activate(h.wrapper);
    await vi.waitFor(() => {
      expect(h.wrapper.getAttribute(STATE_ATTRIBUTE)).toBe("ready");
    });
    (h.wrapper.querySelector("img") as HTMLImageElement).dispatchEvent(new Event("error"));
    expect(h.wrapper.getAttribute(STATE_ATTRIBUTE)).toBe("missing");
    expect(h.wrapper.querySelector(".readora-image-hint")?.textContent).toBe(LOAD_FAILED_REASON);
  });
});

describe("missing 态", () => {
  it("Host 报 notFound 时给出原因并保留文案", async () => {
    const h = harness("assets/gone.png", failedResource(READORA_ERROR_CODES.RESOURCE_NOT_FOUND));
    h.layer.scan(h.container);
    h.activate(h.wrapper);
    await vi.waitFor(() => {
      expect(h.wrapper.getAttribute(STATE_ATTRIBUTE)).toBe("missing");
    });
    expect(h.wrapper.querySelector("img")?.getAttribute("src")).toBeNull();
    expect(h.wrapper.querySelector(".readora-image-hint")?.textContent).toBe(
      reasonForFailure(READORA_ERROR_CODES.RESOURCE_NOT_FOUND)
    );
    expect(h.wrapper.classList.contains("readora-image--missing")).toBe(true);
  });

  it("载荷说是文档或地址为空时按 unreadable 降级，绝不写可疑 src", async () => {
    const asDocument = harness("assets/note.md", okResource("assets/note.md", { kind: "document" }));
    asDocument.layer.scan(asDocument.container);
    asDocument.activate(asDocument.wrapper);
    await vi.waitFor(() => {
      expect(asDocument.wrapper.getAttribute(STATE_ATTRIBUTE)).toBe("missing");
    });
    expect(asDocument.wrapper.querySelector("img")?.getAttribute("src")).toBeNull();
    expect(asDocument.wrapper.querySelector(".readora-image-hint")?.textContent).toBe(
      reasonForFailure(READORA_ERROR_CODES.RESOURCE_UNREADABLE)
    );

    const emptyUri = harness("assets/empty.png", okResource("assets/empty.png", { webviewUri: "" }));
    emptyUri.layer.scan(emptyUri.container);
    emptyUri.activate(emptyUri.wrapper);
    await vi.waitFor(() => {
      expect(emptyUri.wrapper.getAttribute(STATE_ATTRIBUTE)).toBe("missing");
    });
    expect(emptyUri.wrapper.querySelector("img")?.getAttribute("src")).toBeNull();
  });
});

describe("blocked 态与懒加载", () => {
  it("远端与 data: 图片不发请求，直接给策略说明", () => {
    const remote = harness("https://cdn.example.com/a.png");
    expect(remote.layer.scan(remote.container)).toBe(0);
    expect(remote.calls).toBe(0);
    expect(remote.wrapper.getAttribute(STATE_ATTRIBUTE)).toBe("blocked");
    expect(remote.wrapper.querySelector(".readora-image-hint")?.textContent).toBe(
      BLOCKED_REMOTE_REASON
    );

    const data = harness("data:image/png;base64,AAAA");
    expect(data.layer.scan(data.container)).toBe(0);
    expect(data.calls).toBe(0);
    expect(data.wrapper.querySelector(".readora-image-hint")?.textContent).toBe(
      BLOCKED_DATA_REASON
    );
  });

  it("懒加载：scan 只登记观察，进入视口才发请求", () => {
    const h = harness("assets/late.png");
    expect(h.layer.scan(h.container)).toBe(1);
    expect(h.observed).toEqual([h.wrapper]);
    expect(h.calls).toBe(0);

    h.activate(h.wrapper);
    expect(h.calls).toBe(1);
    // 重复触发（观察器回调可能被再次调用）不再发第二次请求
    h.activate(h.wrapper);
    expect(h.calls).toBe(1);
  });

  it("观察器以 200px 余量创建", () => {
    const createObserver = vi.fn(() => ({
      observe: vi.fn(),
      unobserve: vi.fn(),
      disconnect: vi.fn()
    }));
    createImageLayer({ resolve: async () => okResource("a.png"), createObserver }).scan(
      mount("assets/a.png")
    );
    expect(createObserver).toHaveBeenCalledWith(expect.any(Function), {
      rootMargin: IMAGE_ROOT_MARGIN
    });
  });

  it("已就绪的元素不被重复接管", () => {
    const h = harness("assets/logo.png", undefined, "ready");
    expect(h.layer.scan(h.container)).toBe(0);
    expect(h.calls).toBe(0);
  });
});

describe("destroy", () => {
  it("在途结果在 destroy 后不再改写 DOM", async () => {
    // Promise executor 同步执行，release 在 scan 前一定就绪（用 ! 声明避免 TS 把闭包赋值当作未发生）
    let release!: (value: ResourceEntry) => void;
    const container = mount("assets/inflight.png");
    const wrapper = container.querySelector<HTMLElement>("[data-readora-image]") as HTMLElement;
    const layer = createImageLayer({
      resolve: () =>
        new Promise<ResourceEntry>((resolve) => {
          release = resolve;
        })
    });
    layer.scan(container);
    wrapper.setAttribute(STATE_ATTRIBUTE, "pending");
    // scan 无观察器时立即激活：请求已在途
    layer.destroy();
    release(okResource("assets/inflight.png"));
    await Promise.resolve();
    await Promise.resolve();
    expect(wrapper.getAttribute(STATE_ATTRIBUTE)).toBe("pending");
    expect(wrapper.querySelector("img")?.getAttribute("src")).toBeNull();
  });
});

describe("setState 口径", () => {
  it("属性与同名 class 同源写入", () => {
    const container = mount("assets/logo.png");
    const wrapper = container.querySelector<HTMLElement>("[data-readora-image]") as HTMLElement;
    setState(wrapper, "blocked", "因为某种原因");
    expect(wrapper.getAttribute(STATE_ATTRIBUTE)).toBe("blocked");
    expect(wrapper.classList.contains("readora-image--blocked")).toBe(true);
    expect(wrapper.querySelector(".readora-image-hint")?.textContent).toBe("因为某种原因");
    setState(wrapper, "ready");
    expect(wrapper.classList.contains("readora-image--blocked")).toBe(false);
    expect(wrapper.querySelector(".readora-image-hint")).toBeNull();
  });
});

describe("块属性尺寸落地（M10）", () => {
  /** 走完「解析成功」这条唯一通道，再读 style：断言的是生效点，不是纯函数。 */
  async function readyWith(extra: string, entry?: ResourceEntry): Promise<HTMLImageElement> {
    const h = harness("assets/logo.png", entry, "pending", extra);
    h.layer.scan(h.container);
    h.activate(h.wrapper);
    await vi.waitFor(() => {
      expect(h.wrapper.getAttribute(STATE_ATTRIBUTE)).toBe("ready");
    });
    return h.wrapper.querySelector("img") as HTMLImageElement;
  }

  it("像素值写进 img.style.width —— 与 src 同一个作者、同一条通道", async () => {
    const img = await readyWith(' data-readora-width="300px"');
    expect(img.getAttribute("src")).not.toBeNull();
    expect(img.style.width).toBe("300px");
    // 像素是「就要这么宽」，不是上限：写成 max-width 会让图在原图更窄时不生效。
    expect(img.style.maxWidth).toBe("");
  });

  it("百分比走 max-width：只收缩，不把本来就小的图放大", async () => {
    const img = await readyWith(' data-readora-width="60%"');
    expect(img.style.maxWidth).toBe("60%");
    expect(img.style.width).toBe("");
  });

  it("width 与 height 各自落地，互不牵连", async () => {
    const img = await readyWith(' data-readora-width="40%" data-readora-height="200px"');
    expect(img.style.maxWidth).toBe("40%");
    expect(img.style.height).toBe("200px");
    expect(img.style.maxHeight).toBe("");
  });

  it("形状不合白名单的值一个字都不写：宁可留原始尺寸", async () => {
    // 这类值正常到不了 DOM（attrs.ts 整串拒收），这里是接管层的第二道：
    // 写进 style 的字符串必须是自己复查过的，不依赖上游一定守规矩。
    const img = await readyWith(' data-readora-width="50vw" data-readora-height="calc(100%)"');
    expect(img.style.width).toBe("");
    expect(img.style.maxWidth).toBe("");
    expect(img.style.height).toBe("");
    expect(img.style.maxHeight).toBe("");
    // 尺寸失败不影响图片本身：src 照旧补上。
    expect(img.getAttribute("src")).not.toBeNull();
  });

  it("没写属性就不碰 style：不给所有图片凭空加一条内联声明", async () => {
    const img = await readyWith("");
    expect(img.getAttribute("style")).toBeNull();
  });

  it("尺寸只在成功通道里出现：解析失败的图不留半个宽度", async () => {
    const h = harness("assets/gone.png", failedResource(), "pending", ' data-readora-width="300px"');
    h.layer.scan(h.container);
    h.activate(h.wrapper);
    await vi.waitFor(() => {
      expect(h.wrapper.getAttribute(STATE_ATTRIBUTE)).toBe("missing");
    });
    const img = h.wrapper.querySelector("img") as HTMLImageElement;
    expect(img.style.width).toBe("");
  });
});
