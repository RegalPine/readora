/**
 * Wiki Link 的激活（IMP-002 STORY-06-03，IMP-001 §12.2「Webview 不拼本地路径」）。
 *
 * 浏览器里要钉死的是两件事：
 * 1. 渲染产物里的 `[[目标]]` 是 `<a data-readora-wikilink>`，**没有 href** ——
 *    有 href 就等于 View 自己拼了路径，那是 §12.2 明令禁止的；
 * 2. 未命中时只就地提示，不弹模态：「点了个不存在的链接」不该打断阅读。
 */
import { expect, test } from "@playwright/test";
import { openReader, viewMessages } from "../helpers/reader";

const WIKI_DOC = ["# Index", "", "详见 [[Note Two]] 与 [[缺失的笔记|点这里]]。", ""].join("\n");

test.describe("Wiki Link", () => {
  test("产物是无 href 的锚点，别名与目标各归各位", async ({ page }) => {
    await openReader(page, { text: WIKI_DOC });

    const links = page.locator("a[data-readora-wikilink]");
    await expect(links).toHaveCount(2);
    await expect(links.first()).toHaveAttribute("data-readora-wikilink", "Note Two");
    // 有 href 的话浏览器会自己导航，那就绕过了 Host 的解析与存在性检查。
    expect(await links.first().getAttribute("href")).toBeNull();
    await expect(links.nth(1)).toHaveText("点这里");
    await expect(links.nth(1)).toHaveAttribute("data-readora-wikilink", "缺失的笔记");
  });

  test("Host 报未命中：就地提示文案出现，不弹对话框，页面继续可读", async ({ page }) => {
    await openReader(
      page,
      { text: WIKI_DOC },
      {
        navigateScript: {
          mode: "error",
          code: "readora.wikilink.missing",
          message: "e2e: not found"
        }
      }
    );

    await page.locator("a[data-readora-wikilink]").first().click();

    await expect(page.locator(".readora-inline-note")).toHaveText("未找到目标文档");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.locator(".readora-document")).toBeVisible();

    const requests = await viewMessages<{ payload: { uri: string } }>(page, "document.navigate");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.payload.uri).toBe("Note Two");
  });

  test("Host 命中：目标文档经 document.load 换进阅读器，面包屑与状态条跟着走", async ({ page }) => {
    await openReader(
      page,
      { text: WIKI_DOC },
      {
        navigateScript: {
          mode: "ok",
          documentUri: "file:///vault/e2e/Note%20Two.md",
          text: "# Note Two\n\nLanded."
        }
      }
    );

    await page.locator("a[data-readora-wikilink]").first().click();

    await expect(page.locator(".readora-document h1")).toHaveText("Note Two");
    // 分隔符 `/` 是段内的 aria-hidden 节点，所以用后缀匹配而不是整串相等。
    await expect(page.locator(".readora-breadcrumb [data-readora-breadcrumb='filename']")).toHaveText(
      /Note Two\.md$/
    );
    // 行内提示不该出现在成功路径上。
    await expect(page.locator(".readora-inline-note")).toHaveCount(0);

    const requests = await viewMessages<{ payload: { uri: string } }>(page, "document.navigate");
    expect(requests).toHaveLength(1);
  });

  test("换文档后 Wiki Link 的在途结果不会落到新正文上", async ({ page }) => {
    await openReader(
      page,
      { text: WIKI_DOC },
      { navigateScript: { mode: "error", code: "readora.wikilink.missing", message: "e2e" } }
    );
    // 点完立刻换文档：提示节点挂在旧锚点上，旧子树一撤就不该再往新正文里插东西。
    await page.locator("a[data-readora-wikilink]").first().click();
    await page.evaluate(() =>
      window.__readora.load({ text: "# Fresh\n\nBrand new body.", version: 2 })
    );

    await expect(page.locator(".readora-document h1")).toHaveText("Fresh");
    await expect(page.locator(".readora-inline-note")).toHaveCount(0);
  });
});
