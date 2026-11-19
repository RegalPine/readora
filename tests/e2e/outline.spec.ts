/**
 * 大纲导航（PRD-003 §10.7 / ARC-007 §6~§7，IMP-002 STORY-04-*）。
 *
 * 只验「浏览器里真的会滚」这一类单测给不了结论的事：jsdom 里 `scrollIntoView`
 * 是个被替换掉的 mock，点击目录到底有没有把目标标题送进视口、长目录的活动项
 * 有没有被列表自己滚进可见区，只有真实布局知道。
 */
import { expect, test } from "@playwright/test";
import { longDoc, openReader, scrollTo } from "../helpers/reader";

test.describe("大纲导航", () => {
  test("头部图标靠右，3px 滚动条仍能独立滚动长目录", async ({ page }) => {
    await openReader(page, { text: longDoc(60) });
    const header = page.locator(".readora-outline-header");
    const actions = header.locator("button");
    await expect(actions).toHaveCount(2);
    await expect(header).toHaveCSS("justify-content", "flex-end");
    const headerBox = await header.boundingBox();
    const lastBox = await actions.last().boundingBox();
    expect(headerBox).not.toBeNull();
    expect(lastBox).not.toBeNull();
    expect(Math.abs(lastBox!.x + lastBox!.width - headerBox!.x - headerBox!.width)).toBeLessThan(1);
    for (const action of await actions.all()) {
      await expect(action).toHaveText("");
      await expect(action.locator("svg")).toHaveCount(1);
    }

    const list = page.locator(".readora-outline-list");
    const size = await list.evaluate((node) => ({
      width: getComputedStyle(node, "::-webkit-scrollbar").width,
      gutter: node.getBoundingClientRect().width - node.clientWidth,
      overflow: node.scrollHeight > node.clientHeight
    }));
    expect(size.width).toBe("3px");
    expect(size.gutter).toBeLessThanOrEqual(3);
    expect(size.overflow).toBe(true);
    const before = await page.evaluate(() => window.scrollY);
    await list.hover();
    await page.mouse.wheel(0, 300);
    await expect.poll(() => list.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
    expect(await page.evaluate(() => window.scrollY)).toBe(before);
    await expect(header).toBeInViewport();
  });

  for (const theme of ["light", "dark"] as const) {
    test(`${theme}：Outline 开合换图标、不留灰底，搜索按下态不受影响`, async ({ page }) => {
      await openReader(page);
      await page.evaluate((value) => window.__readora.setTheme(value), theme);
      await expect(page.locator("html")).toHaveAttribute("data-readora-theme", theme);
      const toggle = page.getByRole("button", { name: "Toggle outline" });
      const outline = page.getByRole("navigation", { name: "Document outline" });
      await page.mouse.move(0, 0);
      await expect(toggle).toHaveAttribute("aria-pressed", "true");
      await expect(toggle).toHaveAttribute("title", "Hide outline");
      await expect(toggle).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      const shownShape = await toggle.locator("svg").innerHTML();
      await toggle.click();
      await page.mouse.move(0, 0);
      await expect(outline).toBeHidden();
      await expect(toggle).toHaveAttribute("aria-pressed", "false");
      await expect(toggle).toHaveAttribute("title", "Show outline");
      expect(await toggle.locator("svg").innerHTML()).not.toBe(shownShape);
      await expect(toggle).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");

      // 键盘也能恢复大纲；焦点反馈独立于按钮的显示状态底色。
      await toggle.focus();
      await toggle.press("Enter");
      await expect(outline).toBeVisible();
      await expect(toggle).toHaveAttribute("aria-pressed", "true");
      expect(await toggle.locator("svg").innerHTML()).toBe(shownShape);
      await expect(toggle).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      await expect(toggle).not.toHaveCSS("outline-style", "none");
      const search = page.getByRole("button", { name: "Search in document" });
      await search.click();
      await page.mouse.move(0, 0);
      await expect(search).toHaveAttribute("aria-pressed", "true");
      await expect(search).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      await expect(toggle).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    });
  }

  test("点击目录项把对应标题送进视口，并把高亮钉在它身上", async ({ page }) => {
    await openReader(page);
    const target = page.locator("#search-scope");
    // 点击前目标在视口外（文档足够长才谈得上「跳转」）。
    await expect(target).not.toBeInViewport();

    const entry = page.locator(".readora-outline-link", { hasText: "Search scope" });
    await entry.click();

    await expect(target).toBeInViewport();
    await expect(entry).toHaveAttribute("aria-current", "location");
  });

  test("滚动位置决定活动标题：目录高亮跟着正文走", async ({ page }) => {
    await openReader(page);
    await expect(page.locator(".readora-outline-link").first()).toHaveAttribute(
      "aria-current",
      "location"
    );

    await scrollTo(page, 1_200);

    const active = page.locator('.readora-outline-link[aria-current="location"]');
    await expect(active).toHaveCount(1);
    await expect(active).not.toContainText("Reader Guide");
  });

  test("标题过滤按子串收窄，命中项自动展开；清空后恢复全量", async ({ page }) => {
    await openReader(page);
    const all = await page.locator(".readora-outline-link").count();
    expect(all).toBeGreaterThan(2);

    await page.locator('[data-readora-outline-action="filter"]').click();
    const filter = page.locator("#readora-outline-filter-input");
    await filter.fill("Search");

    const filtered = page.locator(".readora-outline-link");
    await expect(filtered).toHaveCount(1);
    await expect(filtered).toContainText("Search scope");

    // Escape 清空而不是删除整条过滤态：键盘用户按 Esc 期望回到「没过滤」的形态。
    await filter.press("Escape");
    await expect(page.locator(".readora-outline-link")).toHaveCount(all);
    await expect(filter).toHaveValue("");
  });

  // 底部不再输出 `N Sections` / `Depth`（产品要求）：层级跨度读者用不上；
  // 节数连状态条那一份也下掉了（产品反馈：目录直接数得出来，不必另设字段）。
  test("底部不摆统计：没有 footer，节数不在任何地方重复报", async ({ page }) => {
    await openReader(page);
    await expect(page.locator(".readora-outline-footer")).toHaveCount(0);
    await expect(page.locator('[data-readora-outline="sections"]')).toHaveCount(0);
    await expect(page.locator('[data-readora-outline="depth"]')).toHaveCount(0);
    await expect(page.locator('[data-readora-status="sections"]')).toHaveCount(0);
  });

  /**
   * 焦点跟随（用户报「高亮会跟着走，但活动项在窗口外时目录不跟着滚」）。
   *
   * 单测只能验算术（jsdom 无布局），这里验的是真实几何：六十节把列表撑到溢出，
   * 滚到文档末尾时活动行必须落在列表可见区内，并且只动列表自己的 scrollTop。
   */
  test("长目录滚到末尾：活动项被列表带进可见区，不带跑正文那一屏", async ({ page }) => {
    await openReader(page, {
      text: longDoc(60),
      documentUri: "file:///vault/e2e/long-outline.md"
    });

    const list = page.locator(".readora-outline-list");
    const box = await list.evaluate((node) => ({
      scrollHeight: node.scrollHeight,
      clientHeight: node.clientHeight
    }));
    // 前置条件：目录真的溢出。不溢出的话「超出窗口」这件事无从谈起，用例假绿。
    expect(box.scrollHeight).toBeGreaterThan(box.clientHeight + 100);

    const settled = await scrollTo(page, await page.evaluate(() => document.documentElement.scrollHeight));

    const active = page.locator('.readora-outline-item[data-readora-outline="active"]');
    await expect(active).toHaveCount(1);
    // 活动项是靠末尾那一节（不在列表开头），否则下一条断言只是在验「本来就在里面」。
    expect(await active.innerText()).toContain("Section 60");
    await expect
      .poll(() =>
        active.evaluate((node) => {
          const row = node.getBoundingClientRect();
          const container = node.closest(".readora-outline-list") as HTMLElement;
          const visible = container.getBoundingClientRect();
          // 夹 1px：子像素舍入不该让用例红。
          return row.top >= visible.top - 1 && row.bottom <= visible.bottom + 1;
        })
      )
      .toBe(true);
    expect(await list.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
    // 跟随只滚列表：窗口位置还是 `scrollTo` 落定后的那个读数。
    expect(await page.evaluate(() => window.scrollY)).toBe(settled);
  });

  test("滚回开头：活动项回到第一条，列表也跟着回到顶部", async ({ page }) => {
    await openReader(page, {
      text: longDoc(60),
      documentUri: "file:///vault/e2e/long-outline.md"
    });
    await scrollTo(page, await page.evaluate(() => document.documentElement.scrollHeight));

    await scrollTo(page, 0);
    const active = page.locator('.readora-outline-item[data-readora-outline="active"]');
    await expect(active).toHaveCount(1);
    expect(await active.innerText()).toContain("Long Guide");
    await expect
      .poll(() => page.locator(".readora-outline-list").evaluate((node) => node.scrollTop))
      .toBeLessThanOrEqual(1);
  });

  // 就用 RICH_DOC：它的 H1 正好落在源文件首行，而 markdown-core 的 `startLine` 是
  // 0 基 —— 按 1 基解释时这一条区间切不出来，字数标签会静默不显示。拿最常见的
  // 文档形状取证，才能同时验住「只剩字数」与「首行标题也有字数」。
  test("大纲不报进度也不排行号：行内标签只剩字数这一种形态", async ({ page }) => {
    await openReader(page);
    // 进度只属于快速条（PRD-003 §10.5）；面板里再放一条就是两个数各说各话。
    await expect(page.locator('[data-readora-outline="progress"]')).toHaveCount(0);
    await expect(page.locator(".readora-outline-progress")).toHaveCount(0);

    const meta = page.locator(".readora-outline-meta");
    await expect(meta).toHaveCount(1);
    await expect(meta.first()).toHaveText(/^\d+w$/u);
    // 行号形态（`L12`）一律不再出现：它是编辑器坐标，不是阅读信息。
    const texts = await meta.allTextContents();
    expect(texts.filter((value) => /^L\d+$/u.test(value))).toEqual([]);
  });
});
