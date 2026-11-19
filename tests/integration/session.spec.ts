/**
 * 文档更新与会话状态的端到端往返（ARC-004 §8.5~§8.7、ARC-007 §8，M2 旧快照缺陷的回归位）。
 *
 * 版本作用域是这里唯一值得在浏览器里再验一遍的事：单测把 `applySnapshot` 当纯函数测，
 * 但「旧快照到底有没有覆盖新内容」的**可见后果**（正文停在旧版、大纲与状态条各说一套）
 * 只有真实渲染管线才会暴露。滚动恢复同理 —— §8.2 六步依赖真实布局与真实锚点。
 */
import { expect, test } from "@playwright/test";
import { FIXTURE_URL, longDoc, openReader, scrollTo, viewMessages } from "../helpers/reader";

interface SaveMessage {
  payload: { documentUri: string; state: { scrollTop: number; activeHeadingId: string | null } };
}

test.describe("document.update 版本作用域", () => {
  test("同文档旧版本被丢弃，跨文档不继承上一条版本线", async ({ page }) => {
    await openReader(page, {
      text: "# Alpha\n\nFirst body.",
      documentUri: "file:///vault/a.md",
      version: 5
    });
    await expect(page.locator(".readora-document h1")).toHaveText("Alpha");

    // 同文档 v3 晚到（乱序的在途快照）：必须整体作废，正文与状态条都不许动。
    await page.evaluate(() =>
      window.__readora.update({
        text: "# Stale\n\nShould never show.",
        documentUri: "file:///vault/a.md",
        version: 3
      })
    );
    await page.waitForTimeout(200);
    await expect(page.locator(".readora-document h1")).toHaveText("Alpha");
    await expect(page.locator(".readora-document")).toHaveAttribute("data-readora-document-version", "5");
    await expect(page.locator('[data-readora-status="words"]')).toHaveText("3 words");

    await page.evaluate(() =>
      window.__readora.update({
        text: "# Alpha edited\n\nNewer body.",
        documentUri: "file:///vault/a.md",
        version: 6
      })
    );
    await expect(page.locator(".readora-document h1")).toHaveText("Alpha edited");
    await expect(page.locator(".readora-document")).toHaveAttribute("data-readora-document-version", "6");
    await expect(page.locator('[data-readora-status="words"]')).toHaveText("4 words");

    // 换文档：版本号是另一条计数线。拿上一版的 6 去拦新文档的 v1，跨文档跳转就会停在旧内容上。
    await page.evaluate(() =>
      window.__readora.load({
        text: "# Beta\n\nAnother file.",
        documentUri: "file:///vault/b.md",
        version: 1
      })
    );
    await expect(page.locator(".readora-document h1")).toHaveText("Beta");
    await expect(page.locator(".readora-document")).toHaveAttribute("data-readora-document-version", "1");
    await expect(page.locator('[data-readora-status="words"]')).toHaveText("3 words");
    // 大纲也跟着换文档：正文换了、目录留旧版就是两源。
    await expect(page.locator(".readora-outline-link")).toHaveCount(1);
  });
});

test.describe("state.save / state.restore", () => {
  test("滚动后防抖上报真实位置与真实活动标题", async ({ page }) => {
    await openReader(page, { text: longDoc() });
    const scrolled = await scrollTo(page, 900);
    expect(scrolled).toBeGreaterThan(0);

    // 800ms 防抖（ARC-007 §8.3）：等一条到达，而不是等固定时间后盲读。
    await expect
      .poll(async () => (await viewMessages<SaveMessage>(page, "state.save")).length)
      .toBeGreaterThan(0);

    const saves = await viewMessages<SaveMessage>(page, "state.save");
    const last = saves[saves.length - 1];
    expect(last?.payload.documentUri).toBe("file:///vault/e2e/reader.md");
    expect(last?.payload.state.scrollTop).toBe(scrolled);
    // 活动标题为 null 只允许发生在顶部：滚到中段还报 null 就是没接真实判定。
    expect(last?.payload.state.activeHeadingId).toMatch(/^section-\d+$/u);
  });

  test("渲染完成之后到达的 restore 立即落地（六步里的定位步）", async ({ page }) => {
    await openReader(page, { text: longDoc() });
    expect(await page.evaluate(() => window.scrollY)).toBe(0);

    await page.evaluate(() => window.__readora.restoreState({ scrollTop: 1_400, activeHeadingId: null }));

    await expect
      .poll(() => page.evaluate(() => window.scrollY))
      .toBeGreaterThanOrEqual(1_300);
  });

  test("restore 早于首帧时挂到渲染回调，不丢也不空滚", async ({ page }) => {
    await page.goto(FIXTURE_URL);
    await page.waitForFunction(() => typeof window.__readora === "object");
    // 先让 View 完成订阅并上报 ready，再把快照压在门控后面：
    // 这样 restore 到达时 `renderedVersionRef` 仍是 -1，走的是「挂起等渲染」那条分支。
    await page.evaluate(() => window.__readora.setGate("hold"));
    await page.evaluate(async () => {
      await window.__readora.ready();
      window.__readora.restoreState({ scrollTop: 1_000, activeHeadingId: null });
    });
    await page.evaluate((text) => {
      window.__readora.load({ text });
      window.__readora.setGate("open");
    }, longDoc());

    await expect(page.locator(".readora-document h1")).toHaveText("Long Guide");
    await expect
      .poll(() => page.evaluate(() => window.scrollY))
      .toBeGreaterThanOrEqual(900);
  });

  test("换文档之后，state.save 挂的是新文档的 URI", async ({ page }) => {
    await page.goto(FIXTURE_URL);
    await page.waitForFunction(() => typeof window.__readora === "object");
    // state.save 必须挂在新文档的 URI 上：会话表按 URI 存，带着旧 URI 就是
    // 把 B 的位置写进 A 的槽位（M2 的旧快照缺陷正是这个形状）。
    await page.evaluate((text) => {
      window.__readora.load({ text, documentUri: "file:///vault/second.md", version: 1 });
    }, longDoc(14));
    await expect(page.locator(".readora-document h1")).toHaveText("Long Guide");

    await scrollTo(page, 700);
    await expect
      .poll(async () => {
        const saves = await viewMessages<SaveMessage>(page, "state.save");
        return saves[saves.length - 1]?.payload.documentUri;
      })
      .toBe("file:///vault/second.md");
  });
});
