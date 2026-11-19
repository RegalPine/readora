/**
 * CSP 基线（ARC-004 §10 / IMP-003 §7.2 安全准入第 1、2 条，EPIC-12 STORY-12-01）。
 *
 * 这一支测的只有浏览器能给的答案：
 * - `meta[http-equiv]` 里的策略是不是生产模板那份（单测里拼字符串，拼错了也照样是合法 TS）；
 * - 脚本到底有没有**被执行**（nonce 写错一位，页面就白屏，而 DOM 看起来一模一样）；
 * - 越界注入是不是被**浏览器**拦下 —— 净化漏网时 CSP 是最后一道，这道必须是活的。
 *
 * 「故意违规」的用例各自独占一条 test：violation 计数是页面级的，
 * 把红灯动作和「零违规」断言放同一条里，等于自己污染自己的证据。
 */
import { expect, test } from "@playwright/test";
import {
  expectReaderAlive,
  loadDocument,
  openProductionReader,
  pageErrors,
  productionCsp,
  violations
} from "../helpers/production-page";

/** 取浏览器实际生效的那条策略，而不是我们以为写进去的那条。 */
function livePolicy(page: import("@playwright/test").Page): Promise<string> {
  return page.evaluate(
    () =>
      document
        .querySelector('meta[http-equiv="Content-Security-Policy"]')
        ?.getAttribute("content") ?? ""
  );
}

test.describe("CSP 基线", () => {
  test("生效策略与生产模板逐字一致，且不含 unsafe-eval / unsafe-inline 脚本许可", async ({
    page
  }) => {
    await openProductionReader(page);
    const policy = await livePolicy(page);

    // 与 `buildContentSecurityPolicy()` 同源比对：模板改了这行就红，
    // 而不是等报告里那句「无 unsafe-eval」变成一句空话。
    expect(policy).toBe(await productionCsp());

    const directives = policy.split(";").map((entry) => entry.trim());
    expect(directives).toContain("default-src 'none'");
    expect(directives).toContain("frame-src 'none'");
    expect(directives).toContain("connect-src 'none'");
    expect(policy).not.toContain("unsafe-eval");
    // 'unsafe-inline' 只允许出现在 style-src：样式必须能内联（弹层与 KaTeX 都靠它），
    // 脚本一次都不许。
    const scriptSource = directives.find((entry) => entry.startsWith("script-src")) ?? "";
    expect(scriptSource).toMatch(/^script-src 'nonce-[A-Za-z0-9-]+'$/);
    expect(scriptSource).not.toContain("unsafe-inline");

    // 策略不是摆设：脚本确实带 nonce 且确实跑了（白屏同样「零违规」）。
    const nonce = await page.evaluate(
      () => document.querySelector("script")?.getAttribute("nonce") ?? ""
    );
    expect(scriptSource).toBe(`script-src 'nonce-${nonce}'`);
    await expectReaderAlive(page);
  });

  test("正常加载与交互期间零违规、零脚本异常", async ({ page }) => {
    await openProductionReader(page);
    await loadDocument(
      page,
      [
        "# Security Baseline",
        "",
        "Inline `code`, a [link](https://example.com/) and $$E = mc^2$$ math.",
        "",
        "```ts",
        "const answer = 42;",
        "```",
        "",
        "| a | b |",
        "| --- | --- |",
        "| 1 | 2 |",
        "",
        "![local](./assets/shot.png)",
        ""
      ].join("\n")
    );

    // 交互覆盖会牵动样式与资源的两条路径：主题就地切换 + 滚动 + 大纲点击。
    await page.evaluate(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: {
            id: "theme-dark",
            type: "theme.update",
            version: 1,
            payload: { theme: "dark", source: "system" }
          }
        })
      );
    });
    await page.locator(".readora-document").scrollIntoViewIfNeeded();
    await page.mouse.wheel(0, 400);

    expect(await violations(page)).toEqual([]);
    expect(await pageErrors(page)).toEqual([]);
  });

  test("违规收集器保留标准事件的内容样本与来源", async ({ page }) => {
    await openProductionReader(page);
    await expectReaderAlive(page);
    expect(await violations(page)).toEqual([]);

    // 合成事件只验证采集字段映射；真实 CSP 拦截由后续用例覆盖。
    await page.evaluate(() => {
      window.dispatchEvent(
        new SecurityPolicyViolationEvent("securitypolicyviolation", {
          blockedURI: "inline",
          violatedDirective: "script-src-elem",
          sample: "window.__pwned = 1",
          sourceFile: `${location.origin}/sample.js`,
          lineNumber: 12,
          columnNumber: 3
        })
      );
      window.dispatchEvent(new SecurityPolicyViolationEvent("securitypolicyviolation"));
    });

    expect(await violations(page)).toEqual([
      {
        blockedURI: "inline",
        directive: "script-src-elem",
        html: "window.__pwned = 1",
        source: new URL("/sample.js", page.url()).href,
        at: "12:3"
      },
      { blockedURI: "", directive: "", html: "", source: "", at: "0:0" }
    ]);
  });

  test("无 nonce 的三种注入入口全被浏览器拦下，且没有一种真的执行", async ({ page }) => {
    await openProductionReader(page);
    await loadDocument(page, "# Baseline\n\nSafe paragraph.\n");

    // 三种写法对应三种真实威胁：文档自带 `<script>`（inline）、外链脚本、
    // 可加载任意页面的 iframe。它们绕过了净化层（这里是直接从 DOM 塞进去的，
    // 相当于假设净化漏了一个），CSP 必须兜住。
    await page.evaluate(() => {
      const inlineScript = document.createElement("script");
      inlineScript.textContent = "window.__pwned = 1";
      document.body.append(inlineScript);

      const externalScript = document.createElement("script");
      externalScript.src = "/readora-assets/main.js?evil=1";
      document.body.append(externalScript);

      const frame = document.createElement("iframe");
      frame.src = "/readora-assets/main.css";
      document.body.append(frame);
    });

    await expect
      .poll(() => violations(page).then((entries) => entries.length), {
        timeout: 5_000
      })
      .toBe(3);
    const entries = await violations(page);
    const scriptEntries = entries.filter((entry) => entry.directive.startsWith("script-src"));
    expect(scriptEntries).toHaveLength(2);
    expect(entries.filter((entry) => entry.directive.startsWith("frame-src"))).toHaveLength(1);
    // 两条 script-src 各自对应一种入口：`inline` 是文档自带脚本，另一条带着外链的 URL。
    // 当前策略未启用 'report-sample'，不能依赖内容样本区分注入入口。
    expect(scriptEntries.some((entry) => entry.blockedURI === "inline")).toBe(true);
    expect(scriptEntries.some((entry) => entry.blockedURI.includes("main.js?evil=1"))).toBe(true);

    // 拦下 ≠ 只举报：载荷真的没有执行，页面也没替我们挨一次异常。
    expect(
      await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)
    ).toBeUndefined();
    await expect(page.locator(".readora-document")).toBeVisible();
  });

  test("connect-src 'none'：页面自己发不起任何网络请求", async ({ page }) => {
    const requested: string[] = [];
    page.on("request", (request) => {
      requested.push(request.url());
    });
    await openProductionReader(page);
    await loadDocument(page, "# Baseline\n\nSafe paragraph.\n");
    requested.length = 0;

    const outcome = await page.evaluate(async () => {
      try {
        await fetch("/readora-assets/main.css");
        return "resolved";
      } catch (error) {
        return `rejected: ${(error as Error).name}`;
      }
    });

    expect(outcome).toContain("rejected");
    await expect
      .poll(() => violations(page).then((entries) => entries.length))
      .toBe(1);
    expect((await violations(page))[0]?.directive).toContain("connect-src");
    // 请求根本没出页面：这是「越界路径不可达」之外的另一层保障 —— 即便 Host
    // 交错了地址，Webview 也没有第二条通道可以自己去要。
    expect(requested).toEqual([]);
  });

  test("img-src 不放开外部源：漏网的远端图片也只是坏图，不会被取回", async ({ page }) => {
    await openProductionReader(page);
    await loadDocument(page, "# Baseline\n\nSafe paragraph.\n");

    await page.evaluate(() => {
      const remote = document.createElement("img");
      remote.src = "https://example.invalid/pixel.png";
      document.body.append(remote);
      // 同源的 data: 是允许的一格（Host 对小图会走 data: URI），不能一并误伤。
      const inline = document.createElement("img");
      inline.src =
        "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
      document.body.append(inline);
    });

    await expect
      .poll(() => violations(page).then((entries) => entries.length))
      .toBe(1);
    const entry = (await violations(page))[0];
    expect(entry?.directive).toContain("img-src");
    expect(entry?.blockedURI).toContain("example.invalid");
    // 与 fetch 不同：图片这一层 Chromium 先建请求再拦，`page.on("request")` 照样看得见，
    // 所以这里能拿出来说的只有「字节没落地」—— 解码宽度为 0、`complete` 也未成立。
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            [...document.querySelectorAll<HTMLImageElement>("img")].filter(
              (node) => node.src.includes("example.invalid") && node.naturalWidth === 0
            ).length
        )
      )
      .toBe(1);
    // 只放开了外部源，data: 那条照常解码成功。
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            [...document.querySelectorAll("img")].filter((node) => node.naturalWidth === 1).length
        )
      )
      .toBe(1);
  });
});
