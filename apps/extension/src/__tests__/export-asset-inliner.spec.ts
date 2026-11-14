/**
 * 资产内联（M11 · 「单文件自包含」的落地点）。
 *
 * 两条通道的失败语义刻意不同，因此分成两组用例：
 * - 字体 fail-closed：少一个 `url()` 解析不出来就整体报错，绝不出「半内联」产物；
 * - 图片 best-effort：读不到就保持屏上那张占位卡，交付物不比屏幕更脆弱。
 */
import { beforeEach, describe, expect, test, vi } from "vitest";
import { READORA_ERROR_CODES } from "@readora/contracts";
import { ReaderError } from "../errors";
import {
  clearAssetCache,
  inlineCssAssets,
  inlineImages,
  type AssetBytes,
  type AssetReader,
  type InlinePayload
} from "../export/asset-inliner";

function asset(bytes: string, size = bytes.length, mtimeMs = 1): AssetBytes {
  return { bytes: new Uint8Array(Buffer.from(bytes, "utf8")), size, mtimeMs };
}

function dataUrl(mime: string, text: string): string {
  return `data:${mime};base64,${Buffer.from(text, "utf8").toString("base64")}`;
}

beforeEach(() => {
  clearAssetCache();
});

describe("inlineCssAssets", () => {
  test("./ 前缀的 woff2 引用换成 data:font/woff2", async () => {
    const read: AssetReader = vi.fn(async () => asset("AAA"));
    const css = "@font-face{src:url(./Inter.woff2) format(\"woff2\")}";
    expect(await inlineCssAssets(css, read)).toBe(
      `@font-face{src:url(${dataUrl("font/woff2", "AAA")}) format("woff2")}`
    );
  });

  test("裸写、单引号、双引号、内含空白四种写法都走同一出口", async () => {
    const read: AssetReader = vi.fn(async () => asset("X"));
    const css = [
      "a{src:url(a.woff2)}",
      "b{src:url(\"b.woff2\")}",
      "c{src:url('c.woff2')}",
      "d{src:url(  d.woff2  )}"
    ].join("");
    const out = await inlineCssAssets(css, read);
    for (const name of ["a", "b", "c", "d"]) {
      expect(out).toContain(`url(${dataUrl("font/woff2", "X")})`);
      expect(out).not.toContain(`${name}.woff2`);
    }
  });

  test("同一资产被多处引用只读一次；不同资产各读一次", async () => {
    const read = vi.fn(async (name: string) => asset(name));
    await inlineCssAssets("a:url(./x.woff2);b:url(./x.woff2);c:url(./y.woff2)", read);
    expect(read).toHaveBeenCalledTimes(2);
    expect(read.mock.calls.map((call) => call[0]).sort()).toEqual(["x.woff2", "y.woff2"]);
  });

  test("已经是 data: 的引用原样留着，不去归档里找同名文件", async () => {
    const read = vi.fn(async () => asset("nope"));
    const css = "@font-face{src:url(data:font/woff2;base64,QUlE)}";
    expect(await inlineCssAssets(css, read)).toBe(css);
    expect(read).not.toHaveBeenCalled();
  });

  test("不含 url() 的样式表原样返回，不触发任何读取", async () => {
    const read = vi.fn(async () => asset("x"));
    const css = ".readora-paragraph{margin:0}";
    expect(await inlineCssAssets(css, read)).toBe(css);
    expect(read).not.toHaveBeenCalled();
  });

  test("fail-closed：任一引用读不到就整体报错，不出半内联产物", async () => {
    const read: AssetReader = vi.fn(async (name) => (name === "b.woff2" ? null : asset("A")));
    const css = "a:url(./a.woff2);b:url(./b.woff2)";
    const error = await inlineCssAssets(css, read).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ReaderError);
    expect((error as ReaderError).code).toBe(READORA_ERROR_CODES.EXPORT_FAILED);
    expect((error as Error).message).toContain("b.woff2");
  });

  test("跨目录与远端引用一律拒收：它们不是「归档内同名同目录」", async () => {
    const read: AssetReader = vi.fn(async () => asset("A"));
    for (const ref of ["../a.woff2", "fonts/a.woff2", "/abs/a.woff2", "https://cdn/a.woff2"]) {
      const error = await inlineCssAssets(`x:url(./${ref})`, read).catch((cause: unknown) => cause);
      expect(error, ref).toBeInstanceOf(ReaderError);
      expect((error as Error).message, ref).toContain("same-directory");
    }
  });

  test("归档里没有的字体扩展名也拒收，不猜 MIME 写出坏 data:", async () => {
    const read: AssetReader = vi.fn(async () => asset("A"));
    const error = await inlineCssAssets("x:url(./a.eot)", read).catch((cause: unknown) => cause);
    expect((error as ReaderError).code).toBe(READORA_ERROR_CODES.EXPORT_FAILED);
    expect((error as Error).message).toContain("unsupported asset type");
  });

  test("真实产物口径：全部 url() 都换掉后不再残留 .woff2 引用", async () => {
    const names = Array.from({ length: 27 }, (_, index) => `font${index}.woff2`);
    const read: AssetReader = vi.fn(async () => asset("BINARY"));
    const css = names.map((name) => `@font-face{src:url(./${name})}`).join(";");
    const out = await inlineCssAssets(css, read);
    expect(out).not.toContain(".woff2)");
    expect(out.match(/url\(data:font\/woff2;base64,/gu)).toHaveLength(27);
  });

  test("缓存判据是 size + mtimeMs：二者不变就不重算 base64", async () => {
    const first = await inlineCssAssets("x:url(./c.woff2)", async () => asset("ABC"));
    const second = await inlineCssAssets("x:url(./c.woff2)", async () => asset("XYZ"));
    expect(second).toBe(first);
    const third = await inlineCssAssets("x:url(./c.woff2)", async () => asset("XYZ", 3, 2));
    expect(third).toBe(`x:url(${dataUrl("font/woff2", "XYZ")})`);
  });

  test("四种字体扩展名的 MIME 都对，svg 走 image/svg+xml", async () => {
    const read: AssetReader = vi.fn(async () => asset("S"));
    const out = await inlineCssAssets(
      "a:url(./f.woff);b:url(./f.woff2);c:url(./f.ttf);d:url(./f.otf);e:url(./f.svg)",
      read
    );
    for (const mime of [
      "font/woff",
      "font/woff2",
      "font/ttf",
      "font/otf",
      "image/svg+xml"
    ]) {
      expect(out).toContain(`data:${mime};base64,`);
    }
  });
});

/** 序列化层交出的图片形态：外层包裹带原始引用与状态，内层 img 已无 src。 */
function image(reference: string, state: string, img = '<img class="readora-image-element" alt="">'): string {
  return (
    `<span class="readora-image readora-image--${state}" ` +
    `data-readora-image="${reference}" data-readora-image-state="${state}">${img}</span>`
  );
}

describe("inlineImages", () => {
  test("ready 状态的图补上 data:，与屏上同一张图", async () => {
    const read = vi.fn(async () => ({ mimeType: "image/png", base64: "QUlE" }) as InlinePayload | null);
    const result = await inlineImages(image("./a.png", "ready"), read);
    expect(result.inlined).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.html).toContain(`<img class="readora-image-element" alt="" src="data:image/png;base64,QUlE">`);
    expect(result.html).toContain('data-readora-image-state="ready"');
  });

  test("blocked / missing 两态不补 src：交付物里就是屏上那张占位卡", async () => {
    const read = vi.fn(async () => ({ mimeType: "image/png", base64: "QUlE" }) as InlinePayload | null);
    for (const state of ["blocked", "missing"]) {
      const result = await inlineImages(image("./a.png", state), read);
      expect(result.skipped).toBe(1);
      expect(result.inlined).toBe(0);
      expect(result.html).not.toContain("src=");
      expect(read).not.toHaveBeenCalled();
    }
  });

  test("策略拒绝或读不到时保持原样，不算失败", async () => {
    const html = image("./a.png", "ready");
    const result = await inlineImages(html, async () => null);
    expect(result.html).toBe(html);
    expect(result.skipped).toBe(1);
  });

  test("已经是 data: 的引用不重复读", async () => {
    const read = vi.fn(async () => ({ mimeType: "image/png", base64: "QUlE" }));
    const result = await inlineImages(image("data:image/png;base64,QUlE", "ready"), read);
    expect(result.skipped).toBe(1);
    expect(read).not.toHaveBeenCalled();
  });

  test("引用里的 HTML 实体先还原再交给资源策略", async () => {
    const read = vi.fn(async () => null);
    await inlineImages(image("a&amp;b.png", "ready"), read);
    expect(read).toHaveBeenCalledWith("a&b.png");
    await inlineImages(image("a&#39;b.png", "ready"), read);
    expect(read).toHaveBeenLastCalledWith("a'b.png");
    await inlineImages(image("./x&lt;y.png", "ready"), read);
    expect(read).toHaveBeenLastCalledWith("./x<y.png");
  });

  test("多张图各自配对：读得到的补，读不到的不动，顺序与文本都不变", async () => {
    const read = vi.fn(async (reference: string) =>
      reference === "./ok.png" ? { mimeType: "image/png", base64: "T0s=" } : null
    );
    const body = `前${image("./ok.png", "ready")}中${image("./no.png", "ready")}后`;
    const result = await inlineImages(body, read);
    expect(result.inlined).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.html.startsWith("前")).toBe(true);
    expect(result.html.endsWith("后")).toBe(true);
    expect(result.html).toContain("src=\"data:image/png;base64,T0s=\"");
    expect(result.html).toContain('data-readora-image="./no.png"');
    // 跨包裹乱补是这类扫描最容易犯的错：no.png 那一格必须仍然没有 src。
    const second = result.html.slice(result.html.indexOf("./no.png"));
    expect(second).not.toContain("src=");
  });

  test("自闭合写法补完仍是合法标签", async () => {
    const read = vi.fn(async () => ({ mimeType: "image/png", base64: "QUlE" }));
    const result = await inlineImages(image("./a.png", "ready", '<img class="x"/>'), read);
    expect(result.html).toContain('<img class="x" src="data:image/png;base64,QUlE" />');
  });

  test("包裹里没有 img 就不动，也不猜下一个包裹的图属于它", async () => {
    const read = vi.fn(async () => ({ mimeType: "image/png", base64: "QUlE" }));
    const body = '<span data-readora-image="./a.png" data-readora-image-state="ready"></span>';
    const result = await inlineImages(body, read);
    expect(result.html).toBe(body);
    expect(result.skipped).toBe(1);
  });

  test("读回来的 MIME 串不在安全字符集内时落回 octet-stream", async () => {
    const read = vi.fn(async () => ({ mimeType: 'image/png;base64,x" onload="alert(1)', base64: "QUlE" }));
    const result = await inlineImages(image("./a.png", "ready"), read);
    expect(result.html).toContain("src=\"data:application/octet-stream;base64,QUlE\"");
    expect(result.html).not.toContain("onload");
  });

  test("没有 state 属性的包裹按可导出处理（屏上 ready 是默认形态）", async () => {
    const read = vi.fn(async () => ({ mimeType: "image/png", base64: "QUlE" }));
    const body = '<span class="readora-image" data-readora-image="./a.png"><img alt=""></span>';
    const result = await inlineImages(body, read);
    expect(result.inlined).toBe(1);
  });

  test("正文里一张图都没有时原样返回，不做任何读取", async () => {
    const read = vi.fn(async () => ({ mimeType: "image/png", base64: "QUlE" }));
    const body = "<p>纯文本</p>";
    const result = await inlineImages(body, read);
    expect(result).toEqual({ html: body, inlined: 0, skipped: 0 });
    expect(read).not.toHaveBeenCalled();
  });
});
