/**
 * 图片夹具端到端测试（STORY-08-01 / 08-02，IMP-001 §14 Fixture Test）。
 *
 * 这一层是唯一能同时看见「真实 Markdown 源 → 渲染产物 → 激活层」的位置：
 * 单测里的 HTML 是手写的字符串，夹具里的 HTML 是 markdown-core 真产出来的。
 * 两者对不上，浏览器里就会看到「测试全绿但图不出来」。
 *
 * Host 侧的解析语义（boundary / MIME / size）由 apps/extension 的真机夹具负责，
 * 本文件只断言到「Webview 该发什么请求、该显示什么状态」为止。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderMarkdown } from "@readora/markdown-core";
import { READORA_ERROR_CODES, type ResourceKind } from "@readora/contracts";
import {
  EMPTY_REFERENCE_REASON,
  IMAGE_ROOT_MARGIN,
  STATE_ATTRIBUTE,
  classifyReference,
  createImageLayer,
  type ImageLayer
} from "../image-layer";
import type { ResourceEntry } from "../resource-cache";
import { failedResource, okResource } from "./test-support";

const FIXTURE_PATH = resolve(process.cwd(), "../../tests/fixtures/images.md");
const SOURCE = readFileSync(FIXTURE_PATH, "utf8");

const RESULT = renderMarkdown({
  documentId: "file:///tests/fixtures/images.md",
  documentUri: "file:///tests/fixtures/images.md",
  version: 1,
  text: SOURCE
});

/** 夹具承诺的引用清单：改夹具必须同时改这里，否则测试就是装饰。 */
const WHITELIST = [
  "assets/logo.png",
  "assets/photo.jpg",
  "assets/diagram.gif",
  "assets/icon.webp",
  "assets/flow.svg"
];
/**
 * 中文与空格文件名在 CommonMark 的 normalizeLink 下被归一成百分号形式，
 * 尖括号写法与手写百分号写法到 Host 是同一个字符串（见夹具第 2 节）。
 */
const UNAMBIGUOUS_LOCAL = [
  "assets/%E4%B8%AD%E6%96%87%20%E6%A0%87%E5%BF%97.png",
  "assets/CAPITAL.PNG",
  "../fixtures/assets/logo.png"
];
const MISSING_LOCAL = [
  "assets/missing.png",
  "assets/",
  "assets/none.png",
  "assets/absent.gif",
  // 双重编码只解一次，落到「文档目录内一个不存在的文件名」：不是越权。
  "..%252e%252e%252fetc%252fpasswd.png"
];
const DENIED_LOCAL = [
  "../../etc/passwd.png",
  "..%2f..%2fetc%2fpasswd.png",
  "..%2F..%2Fetc%2Fpasswd.png",
  "..%5c..%5cetc%5cpasswd.png",
  "assets/escape-link.png"
];
const UNSUPPORTED_LOCAL = ["sample.md"];
const BLOCKED = [
  "https://example.com/assets/logo.png",
  "//cdn.example.com/logo.png",
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"
];

function parse(markup: string): Document {
  return new DOMParser().parseFromString(`<div>${markup}</div>`, "text/html");
}

function containerFrom(html: string): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = html;
  document.body.append(host);
  return host;
}

function references(host: Element): string[] {
  return Array.from(host.querySelectorAll("[data-readora-image]")).map((element) =>
    element.getAttribute("data-readora-image")?.trim() ?? ""
  );
}

function referencesOf(markup: string): string[] {
  return references(parse(markup).body);
}

interface Layered {
  host: HTMLElement;
  layer: ImageLayer;
  requested: Array<{ reference: string; kind: ResourceKind }>;
  activate: (element: HTMLElement) => void;
  stateOf: (reference: string) => string | null;
  hintOf: (reference: string) => string | null;
}

/**
 * 用「Host 会怎么答」的表驱动跑完整层：
 * 白名单与无歧义本地路径成功，缺失/越界/类型不符各回自己的错误码。
 * 表本身来自夹具的承诺，因此这条测试证的是承诺能否兑现。
 */
function layered(options: { lazy?: boolean } = {}): Layered {
  const host = containerFrom(RESULT.html);
  const requested: Array<{ reference: string; kind: ResourceKind }> = [];
  const pending = new Set<string>([...MISSING_LOCAL, ...DENIED_LOCAL, ...UNSUPPORTED_LOCAL]);
  let activate: (element: HTMLElement) => void = () => {};

  const resolveEntry = (reference: string): ResourceEntry => {
    if (pending.has(reference)) {
      const code = MISSING_LOCAL.includes(reference)
        ? READORA_ERROR_CODES.RESOURCE_NOT_FOUND
        : DENIED_LOCAL.includes(reference)
          ? READORA_ERROR_CODES.RESOURCE_DENIED
          : READORA_ERROR_CODES.RESOURCE_UNSUPPORTED;
      return failedResource(code);
    }
    return okResource(reference, { mimeType: mimeTypeOf(reference) });
  };

  const layer = createImageLayer({
    resolve: async (reference, kind = "image") => {
      requested.push({ reference, kind });
      return resolveEntry(reference);
    },
    createObserver: (callback) => {
      activate = callback;
      if (options.lazy === false) {
        // 无观察器环境等价于「立即可见」：懒加载分支留在下一条用例里专测。
        return null;
      }
      return {
        observe: (element) => {
          // 夹具按「全部已进入视口」处理：逐元素立即触发，懒加载分支另有专测。
          activate(element as HTMLElement);
        },
        unobserve: vi.fn(),
        disconnect: vi.fn()
      };
    }
  });

  const wrapperFor = (reference: string): HTMLElement | null =>
    Array.from(host.querySelectorAll<HTMLElement>("[data-readora-image]")).find(
      (element) => element.getAttribute("data-readora-image")?.trim() === reference
    ) ?? null;

  return {
    host,
    layer,
    requested,
    activate,
    stateOf: (reference) => wrapperFor(reference)?.getAttribute(STATE_ATTRIBUTE) ?? null,
    hintOf: (reference) => wrapperFor(reference)?.querySelector(".readora-image-hint")?.textContent ?? null
  };
}

function mimeTypeOf(reference: string): string {
  const clean = reference.split("?")[0]?.toLowerCase() ?? "";
  if (clean.endsWith(".svg")) {
    return "image/svg+xml";
  }
  if (clean.endsWith(".jpg")) {
    return "image/jpeg";
  }
  if (clean.endsWith(".gif")) {
    return "image/gif";
  }
  if (clean.endsWith(".webp")) {
    return "image/webp";
  }
  if (clean.endsWith(".md")) {
    return "text/markdown";
  }
  return "image/png";
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("夹具渲染：Markdown 源必须落成预期结构", () => {
  it("每种承诺的写法都产出了待解析的图片容器", () => {
    const found = referencesOf(RESULT.html);
    for (const reference of [
      ...WHITELIST,
      ...UNAMBIGUOUS_LOCAL,
      ...MISSING_LOCAL,
      ...DENIED_LOCAL,
      ...UNSUPPORTED_LOCAL,
      ...BLOCKED
    ]) {
      expect(found, reference).toContain(reference);
    }
  });

  it("中文与空格文件名归一成百分号形式，字面反斜杠进不了引用字符串", () => {
    const found = referencesOf(RESULT.html);
    // 尖括号目标 `<assets/中文 标志.png>` 与手写百分号写法到 Host 是同一个字符串：
    // 归一发生在渲染层，Host 只需处理一种形式（夹具第 2 节）。
    expect(found).toContain("assets/%E4%B8%AD%E6%96%87%20%E6%A0%87%E5%BF%97.png");
    expect(found.filter((reference) => reference.includes("标志"))).toEqual([]);
    // 字面反斜杠被 CommonMark 百分号化，所以只剩 `%5c` 这一种穿越写法能到达 Host。
    expect(found.filter((reference) => reference.includes("\\")).length).toBe(0);
    expect(found).toContain("..%5c..%5cetc%5cpasswd.png");
  });

  it("空引用保留属性但值为空", () => {
    expect(referencesOf(RESULT.html)).toContain("");
  });

  it("结构内图片不因所在结构而被漏掉", () => {
    const host = containerFrom(RESULT.html);
    expect(host.querySelector("table [data-readora-image]")).not.toBeNull();
    expect(host.querySelector("blockquote [data-readora-image]")).not.toBeNull();
    expect(host.querySelector("li [data-readora-image]")).not.toBeNull();
    // 被链接包裹：外层 <a> 带 data-readora-external，内层仍是完整图片容器。
    const wrapped = host.querySelector("[data-readora-external] [data-readora-image]");
    expect(wrapped).not.toBeNull();
    expect(wrapped?.querySelector("img")).not.toBeNull();
  });

  it("渲染层不产出 src，也不把本地 SVG 内联（ARC-008 §9.4）", () => {
    const host = containerFrom(RESULT.html);
    const images = Array.from(host.querySelectorAll("img"));
    expect(images.length).toBeGreaterThanOrEqual(referencesOf(RESULT.html).length);
    for (const image of images) {
      expect(image.getAttribute("src")).toBeNull();
    }
    expect(host.querySelectorAll("svg").length).toBe(0);
  });
});

describe("夹具驱动的状态机", () => {
  it("白名单 MIME 与无歧义本地路径全部 ready，且不残留 M3 提示", async () => {
    const view = layered();
    view.layer.scan(view.host);
    await vi.waitFor(() => {
      for (const reference of [...WHITELIST, ...UNAMBIGUOUS_LOCAL]) {
        expect(view.stateOf(reference), reference).toBe("ready");
      }
    });
    expect(view.hintOf(WHITELIST[0] ?? "")).toBeNull();
    view.layer.destroy();
  });

  it("缺失 / 越界 / 类型不符各给出自己的原因（F06-006）", async () => {
    const view = layered();
    view.layer.scan(view.host);
    await vi.waitFor(() => {
      for (const reference of [...MISSING_LOCAL, ...DENIED_LOCAL, ...UNSUPPORTED_LOCAL]) {
        expect(view.stateOf(reference), reference).toBe("missing");
      }
    });
    expect(view.hintOf("assets/missing.png")).toBe("本地图片不存在或不可读");
    expect(view.hintOf("../../etc/passwd.png")).toBe("超出允许范围，或策略不允许该资源");
    expect(view.hintOf("assets/escape-link.png")).toBe("超出允许范围，或策略不允许该资源");
    expect(view.hintOf("sample.md")).toBe("该资源类型暂不支持");
    view.layer.destroy();
  });

  it("blocked 与空引用不发起任何 Host 请求", async () => {
    const view = layered();
    const queued = view.layer.scan(view.host);
    await vi.waitFor(() => {
      expect(view.stateOf(BLOCKED[0] ?? "")).toBe("blocked");
    });
    for (const reference of BLOCKED.slice(1)) {
      expect(view.stateOf(reference), reference).toBe("blocked");
    }
    expect(view.stateOf("")).toBe("missing");
    expect(view.hintOf("")).toBe(EMPTY_REFERENCE_REASON);
    // 排队数 = 本地且非空的引用数：blocked / 空引用一条都不许落到 bridge 上。
    const localCount = referencesOf(RESULT.html).filter(
      (reference) => reference.length > 0 && classifyReference(reference) === "local"
    ).length;
    expect(queued).toBe(localCount);
    expect(view.requested.length).toBe(localCount);
    expect(view.requested.some((item) => classifyReference(item.reference) !== "local")).toBe(false);
    view.layer.destroy();
  });

  it("懒加载：没有观察器时立即激活，rootMargin 为 200px", async () => {
    expect(IMAGE_ROOT_MARGIN).toBe("200px");
    const view = layered({ lazy: false });
    view.layer.scan(view.host);
    await vi.waitFor(() => {
      expect(view.stateOf("assets/logo.png")).toBe("ready");
    });
    expect(view.requested.length).toBeGreaterThan(0);
    view.layer.destroy();
  });

  it("每个容器只问一次，重复 scan 幂等", async () => {
    const view = layered();
    view.layer.scan(view.host);
    await vi.waitFor(() => {
      expect(view.stateOf("assets/logo.png")).toBe("ready");
    });
    const first = view.requested.length;
    expect(view.layer.scan(view.host)).toBe(0);
    expect(view.requested.length).toBe(first);
    view.layer.destroy();
  });
});
