/**
 * 导出链路的威胁模型（M11 · ARC-008「导出与写盘」，IMP-003 §7.2 安全准入）。
 *
 * 本轮新增的攻击面只有一句话：**Webview 触发 Host 写文件**。四条防线各有其主，
 * 这一支逐条问「浏览器/真实字节给的答案」，而不是复述实现注释：
 *
 * 1. 交付物自身：单文件自包含 → 里面既不该有脚本入口，也不该有能解引用的本机地址
 *    （`vscode-webview://` 是会话内地址，`file://` 是本机结构泄露）；
 * 2. 交付物的 CSP：净化漏网时它是最后一道，而且必须是**活的** —— 只有把恶意样本
 *    真的装进浏览器，才证得了 `script-src 'none'` 不是纸面承诺；
 * 3. 内联层：字体 fail-closed（绝不出「半内联」交付物）、引用不参与路径拼接；
 * 4. 授权边界：`showSaveDialog` 是唯一授权者 —— 那条由 extension 单测与
 *    `host-activation-smoke` 钉住，不在浏览器可达的范围内，这里不重复造。
 *
 * 被测代码全部来自生产源文件（`tests/helpers/export-artifact.ts` 用 esbuild 装载），
 * 测试不落第二份组装规则：否则「交付物没有脚本」可能只是测试自己没写脚本。
 */
import { expect, test, type Page } from "@playwright/test";
import {
  CLEAN_BODY,
  artifactInput,
  exportAssetInliner,
  exportHtmlBuilder
} from "../helpers/export-artifact";

const ARTIFACT_URL = "/readora-export-artifact.html";

interface Audit {
  violations: { directive: string; blockedURI: string }[];
  errors: string[];
}

/**
 * 把一份交付物真的装进浏览器，并带上两副眼睛：
 * CSP 违规举报与脚本异常。晚装一帧就会漏掉第一条违规，所以走 `addInitScript`。
 */
async function openArtifact(page: Page, html: string): Promise<void> {
  await page.addInitScript(() => {
    const state: Audit = { violations: [], errors: [] };
    Object.defineProperty(window, "__exportAudit", { value: state, writable: false });
    window.addEventListener("securitypolicyviolation", (event) => {
      state.violations.push({
        directive: event.violatedDirective,
        blockedURI: event.blockedURI
      });
    });
    window.addEventListener("error", (event) => {
      state.errors.push(String(event.message));
    });
  });
  await page.route("**" + ARTIFACT_URL, (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: html })
  );
  await page.goto(ARTIFACT_URL);
}

function auditOf(page: Page): Promise<Audit> {
  return page.evaluate(
    () =>
      (window as unknown as { __exportAudit: Audit }).__exportAudit
  );
}

/** 交付物字符串：由生产组装层现场拼出，测试只给入参。 */
async function artifact(patch: Parameters<typeof artifactInput>[0] = {}): Promise<string> {
  const { composeExportHtml } = await exportHtmlBuilder();
  return composeExportHtml(artifactInput(patch));
}

/**
 * 从产物字符串里取出 CSP 原文。
 *
 * 拿的是 meta 而不是模块里那个常量：属性值经 `escapeAttribute` 转过实体，
 * 浏览器看到的与字符串里写的不是同一份 —— 正好是要验的那一层。
 */
function cspOf(html: string): string {
  const raw = html.match(/Content-Security-Policy" content="([^"]*)"/u)?.[1] ?? "";
  return raw
    .replaceAll("&#39;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

test.describe("交付物字符串", () => {
  test("没有任何脚本入口，也没有能解引用的本机地址", async () => {
    const html = await artifact();
    const directives = cspOf(html).split(";").map((entry) => entry.trim());

    expect(html).toContain("<!DOCTYPE html>");
    expect(directives).toEqual(
      expect.arrayContaining([
        "default-src 'none'",
        "script-src 'none'",
        "img-src data:",
        "font-src data:",
        "connect-src 'none'",
        "frame-src 'none'"
      ])
    );
    // `'unsafe-inline'` 只许出现在 style-src：样式必须能内联，脚本一次都不许。
    expect(directives.some((entry) => entry.includes("unsafe-eval"))).toBe(false);
    expect(directives.filter((entry) => entry.includes("unsafe-inline"))).toEqual([
      "style-src 'unsafe-inline'"
    ]);
    expect(directives.filter((entry) => entry.startsWith("script-src"))).toEqual([
      "script-src 'none'"
    ]);

    expect(html).not.toContain("<script");
    expect(html.toLowerCase()).not.toContain("javascript:");
    // 会话内地址与本机绝对路径都不该出现在交付物里。
    expect(html).not.toContain("vscode-webview://");
    expect(html).not.toContain("file://");
    // 可寻址属性一个都不能带协议：`http(s)://` 只许出现在 SVG 命名空间声明里
    // （那是 XML 常量，不会发出任何请求）。
    const addressable = html.match(/(?:^|\s)(?:src|href|xlink:href)="[^"]*"/gu) ?? [];
    expect(addressable.filter((entry) => /="(?:https?:|file:|vscode-webview:|data:)/u.test(entry))).toEqual([]);
    for (const hit of html.split(/https?:\/\//u).slice(1)) {
      expect(hit.startsWith("www.w3.org")).toBe(true);
    }
  });

  test("`</style>` breakout 与自定义 CSS 里的标签整段作废", async () => {
    const hostile = "body{color:red}</style><script>window.__pwned=1</script><style>";
    const html = await artifact({ customCss: hostile });
    expect(html).not.toContain("<script");
    // 判据是「整段丢弃」而不是「转义后留下」：与面板同一出口 `sanitizeInjectedCss`。
    expect(html).not.toContain("data-readora-custom-css");

    const escaped = await artifact({ title: 'x" onmouseover="alert(1)', rootStyleText: 'a"-->' });
    expect(escaped).not.toContain('onmouseover="alert');
    expect(escaped).toContain("&quot;");
  });

  test("正文里混进脚本时，交付物的 CSP 真的拦得住（最后一道是活的）", async ({ page }) => {
    // 这一条刻意给「净化漏网」的形态：论证「源是已净化 DOM」不能成为不验 CSP 的理由。
    const html = await artifact({
      bodyHtml:
        `${CLEAN_BODY}<script>window.__pwned = 1;</script>` +
        '<img src="https://example.invalid/remote.png" ' +
        'onerror="window.__pwned = 2" alt="">'
    });
    expect(html).toContain("<script>");

    const requests: string[] = [];
    await page.route("**/example.invalid/**", (route) => {
      requests.push(route.request().url());
      return route.abort();
    });
    await openArtifact(page, html);

    const pwned = await page.evaluate(
      () => (window as unknown as { __pwned?: number }).__pwned
    );
    expect(pwned).toBeUndefined();

    const audit = await auditOf(page);
    const blocked = audit.violations.map((entry) => entry.directive).join(" ");
    expect(blocked).toContain("script-src");
    // 远程图连请求都发不出去：不是「请求失败」，而是浏览器根本没让它出门。
    expect(blocked).toContain("img-src");
    expect(requests).toHaveLength(0);
    // 文档本身照常可读：拦下脚本不等于把交付物打成白屏。
    await expect(page.locator(".readora-paragraph")).toHaveText("Body");
  });

  test("没有 nonce、没有外链样式：自包含意味着不请求任何东西", async ({ page }) => {
    const html = await artifact();
    const requested: string[] = [];
    page.on("request", (request) => requested.push(request.url()));
    await openArtifact(page, html);

    expect(await page.evaluate(() => document.querySelectorAll("script,link,iframe").length)).toBe(0);
    // 样式来自内联 `<style>`：面板那套 `<link rel=stylesheet>` 外链在这里不允许存在。
    expect(html).not.toContain("<link");
    expect(html).not.toMatch(/nonce/iu);
    // 除了这一页本身，浏览器一个请求都没发出去 —— 自包含不是承诺，是读数。
    expect(requested.filter((url) => !url.endsWith(ARTIFACT_URL))).toEqual([]);
    const audit = await auditOf(page);
    expect(audit.violations).toHaveLength(0);
    expect(audit.errors).toHaveLength(0);
  });
});

test.describe("内联层的失败语义", () => {
  test("字体读不到就整体失败：不出半内联交付物", async () => {
    const { inlineCssAssets } = await exportAssetInliner();
    const css = "@font-face{src:url(./Inter.woff2)}@font-face{src:url(./Miss.woff2)}";
    const error = await inlineCssAssets(css, async (name) =>
      name === "Miss.woff2" ? null : { bytes: new Uint8Array([1]), size: 1, mtimeMs: 1 }
    ).catch((cause: unknown) => cause);
    expect(String(error)).toContain("Miss.woff2");
    // 失败语义是「报错」而不是「返回半内联字符串」：产物一个字节都不该落盘。
    expect(String(error)).toContain("not readable");
  });

  test("越界的字体引用拒收：跨目录、子目录、远端都不是「同名同目录」", async () => {
    const { inlineCssAssets } = await exportAssetInliner();
    for (const ref of ["../Secret.woff2", "fonts/Inter.woff2", "https://cdn/Inter.woff2"]) {
      const error = await inlineCssAssets(`x:url(./${ref})`, async () => ({
        bytes: new Uint8Array([1]),
        size: 1,
        mtimeMs: 1
      })).catch((cause: unknown) => cause);
      expect(String(error), ref).toContain("same-directory");
    }
  });

  test("图片引用原样交给资源策略，导出层不拼任何路径", async () => {
    const { inlineImages } = await exportAssetInliner();
    const asked: string[] = [];
    const body =
      '<span data-readora-image="../../etc/passwd" data-readora-image-state="ready"><img alt=""></span>';
    const result = await inlineImages(body, async (reference) => {
      asked.push(reference);
      return null;
    });
    // 只转发，不翻译：路径归一与授权判断全在 ResourceService 那一侧。
    expect(asked).toEqual(["../../etc/passwd"]);
    expect(result.html).toBe(body);
    expect(result.skipped).toBe(1);
  });

  test("策略拒绝与 blocked/missing 都不补 src，占位卡形状照旧", async () => {
    const { inlineImages } = await exportAssetInliner();
    for (const state of ["blocked", "missing"]) {
      const body = `<span data-readora-image="./a.png" data-readora-image-state="${state}"><img alt=""></span>`;
      const result = await inlineImages(body, async () => ({
        mimeType: "image/png",
        base64: "QUlE"
      }));
      expect(result.html, state).toBe(body);
      expect(result.inlined, state).toBe(0);
    }
  });

  test("MIME 串不是安全字符集时落回 octet-stream，不带出属性注入", async () => {
    const { inlineImages } = await exportAssetInliner();
    const body = '<span data-readora-image="./a.png" data-readora-image-state="ready"><img alt=""></span>';
    const result = await inlineImages(body, async () => ({
      mimeType: 'image/png;base64,x" onload="alert(1)',
      base64: "QUlE"
    }));
    expect(result.html).toContain("data:application/octet-stream;base64,QUlE");
    expect(result.html).not.toContain("onload");
    // 补进去的 src 必须是完整闭合的一个属性：断掉引号就等于注入。
    const source = / src="([^"]*)"/u.exec(result.html)?.[1] ?? "";
    expect(source.startsWith("data:")).toBe(true);
  });
});
