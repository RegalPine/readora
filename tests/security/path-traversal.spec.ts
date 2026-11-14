/**
 * 路径越界与「Webview 不自拼本地路径」（ARC-008 §12.5 / IMP-001 §12.2，
 * IMP-003 §7.2 安全准入第 5 条）。
 *
 * 边界要说清：判定「这个引用能不能读」的权威在 Host（`resource-service.ts`，
 * 由 `apps/extension/src/__tests__/resource-path.spec.ts` 等逐条锁过）。
 * Webview 侧的威胁模型只有一条 —— **它不许自己把引用变成地址**。只要它自己动手
 * 拼过 `new URL(reference, base)` 之类的东西，越界判定就被绕开了，而这件事
 * 只有在真浏览器里数得出来：页面发出的每一条 `resource.resolve`、页面上每一个
 * `img[src]`、网络层每一次真实请求。
 */
import { expect, test } from "@playwright/test";
import {
  loadDocument,
  openProductionReader,
  posted,
  setResourceEntries,
  violations
} from "../helpers/production-page";

/** 六种越界写法：相对上跳、绝对路径、file: 协议、编码绕过，各是一种真实尝试。 */
const ESCAPE_DOC = [
  "# Path Escapes",
  "",
  "![up](../../../../etc/passwd)",
  "",
  "![outside](../outside/secret.png)",
  "",
  "![absolute](/outside/secret.png)",
  "",
  "![scheme](file:///etc/passwd)",
  "",
  "![encoded](%2e%2e%2foutside%2fsecret.png)",
  "",
  "![ok](./assets/shot.png)",
  ""
].join("\n");

/** 图片是懒激活的（IntersectionObserver）：不滚到底，计数只会数到半截。 */
async function activateAllImages(page: import("@playwright/test").Page): Promise<void> {
  await page.evaluate(async () => {
    const step = window.innerHeight;
    for (let top = 0; top < document.body.scrollHeight; top += step) {
      window.scrollTo({ top, behavior: "auto" });
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    }
    window.scrollTo({ top: 0, behavior: "auto" });
  });
}

test.describe("路径越界", () => {
  test("视图只把原始引用交给 Host，一次都没有自己拼地址", async ({ page }) => {
    const requested: string[] = [];
    page.on("request", (request) => {
      requested.push(request.url());
    });
    await openProductionReader(page);
    await loadDocument(page, ESCAPE_DOC);
    await activateAllImages(page);

    const resolves = await posted(page, "resource.resolve");
    // 六条写法里只有五条成了图片节点：`file:///etc/passwd` 的 scheme 不被 Markdown
    // 链接规范化接受，压根没变成可寻址的 `<img>`（`imageRenderer` 那一步就出局了）。
    // 这条差异本身就是结论 —— 少问一次 Host，是因为页面上没有那个入口。
    expect(resolves).toHaveLength(5);
    await expect(page.locator(".readora-document img")).toHaveCount(5);

    // 逐字比对最狠：页面若把 `/outside/secret.png` 变成绝对 URL、把 `..` 折叠掉，
    // 这里都会红。
    const references = resolves.map(
      (message) => (message as { payload: { reference: string } }).payload.reference
    );
    expect(references).toEqual([
      "../../../../etc/passwd",
      "../outside/secret.png",
      "/outside/secret.png",
      "%2e%2e%2foutside%2fsecret.png",
      "./assets/shot.png"
    ]);
    // 而 `file:` 那一串只以散文形式留在正文里，从未进过任何解析请求。
    expect(references.some((reference) => reference.startsWith("file:"))).toBe(false);
    await expect(page.locator(".readora-document")).toContainText("![scheme](file:///etc/passwd)");
    for (const message of resolves) {
      const payload = (message as { payload: { documentUri: string } }).payload;
      expect(payload.documentUri).toBe("file:///vault/security/target.md");
    }

    // 网络层：`outside/secret.png` 没有以任何形态被取过（Host 没答，页面就没地址）。
    expect(requested.filter((url) => url.includes("secret.png"))).toEqual([]);
    expect(requested.filter((url) => url.includes("passwd"))).toEqual([]);
  });

  test("Host 全部拒绝时，正文里不留下任何指向越界路径的 src", async ({ page }) => {
    await openProductionReader(page);
    await loadDocument(page, ESCAPE_DOC);
    await activateAllImages(page);

    // 替身 Host 默认回 `readora.resource.denied`（见 helper），这里只核对页面的表现。
    await expect(page.locator('[data-readora-image-state="missing"]')).toHaveCount(5);
    const sources = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLImageElement>(".readora-document img")].map(
        (node) => node.getAttribute("src") ?? ""
      )
    );
    // 被拒的图片不配拥有地址：宁可是一条都没设 src，也不能是原始引用或任何拼出来的路径。
    expect(sources.every((value) => value === "")).toBe(true);
    expect(await violations(page)).toEqual([]);
  });

  test("Host 交出地址后，页面用的就是那一串，不多不少", async ({ page }) => {
    await openProductionReader(page);
    // 只放行 `./assets/shot.png`，其余五条仍走默认拒答：Host 给的是一个 data: URI，
    // 页面必须原样使用它。
    await setResourceEntries(page, {
      "./assets/shot.png": {
        ok: true,
        payload: {
          resourceId: "shot",
          webviewUri:
            "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
          mimeType: "image/gif",
          kind: "image",
          byteSize: 43,
          version: "v1"
        }
      }
    });
    await loadDocument(page, ESCAPE_DOC);
    await activateAllImages(page);

    const sources = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLImageElement>(".readora-document img")].map(
        (node) => node.getAttribute("src") ?? ""
      )
    );
    const hosted = sources.filter((value) => value.startsWith("data:image/gif"));
    expect(hosted).toHaveLength(1);
    // 关键断言：地址与 Host 给的那串**逐字相同**。页面加过 query、换过 scheme
    // 或者自己补过路径，都会在这里红 —— 那正是「Webview 不拼本地路径」的反例。
    expect(hosted[0]).toBe(
      "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"
    );
    expect(sources.filter((value) => value !== "" && !value.startsWith("data:image/gif"))).toEqual(
      []
    );
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            [...document.querySelectorAll<HTMLImageElement>("img")].filter(
              (node) => node.naturalWidth === 1
            ).length
        )
      )
      .toBe(1);
  });

  test("链接与 Wiki Link 也不带出本地地址：href 只剩锚点与 Host 批准过的 scheme", async ({
    page
  }) => {
    await openProductionReader(page);
    await loadDocument(
      page,
      [
        "# Link Escapes",
        "",
        "[绝对路径](/etc/passwd)",
        "",
        "[上跳](../../../outside/secret.png)",
        "",
        "[协议](file:///etc/passwd)",
        "",
        "[外部](https://example.com/doc.md)",
        "",
        "[[../../Note]]",
        ""
      ].join("\n")
    );

    const hrefs = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLAnchorElement>(".readora-document a[href]")].map(
        (node) => node.getAttribute("href") ?? ""
      )
    );
    expect(hrefs.filter((href) => href.includes("etc/passwd"))).toEqual([]);
    expect(hrefs.filter((href) => href.includes("secret.png"))).toEqual([]);
    expect(hrefs.filter((href) => href.startsWith("file:"))).toEqual([]);

    // Wiki Link 的出口是 `document.navigate`，载荷里只有文档给的原始目标 ——
    // 解析与存在性检查是 Host 的事，页面一个字都不加工。
    await page.locator('a[data-readora-wikilink]').click();
    await expect
      .poll(() => posted(page, "document.navigate").then((entries) => entries.length))
      .toBe(1);
    const navigates = await posted(page, "document.navigate");
    const payload = (navigates[0] as { payload: { uri: string } }).payload;
    expect(payload.uri).toBe("../../Note");
  });
});
