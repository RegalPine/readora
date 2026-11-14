/**
 * 文档内搜索（PRD-003 §10.3 / ARC-007 §9，IMP-002 STORY-05-*）。
 *
 * 浏览器里才成立的那部分事实：高亮是真插进 DOM 的 `<mark>`，滚动会跟着活动命中走，
 * 关闭后文本节点要合回去（`normalize`）。单测把这些都 mock 成了字符串比较。
 */
import { expect, test } from "@playwright/test";
import { openReader } from "../helpers/reader";

const INPUT = ".readora-search-input";
/**
 * 高亮节点的唯一标识是 `data-readora-search-id`（search-engine 的 SEARCH_HIT_SELECTOR）：
 * 一条跨节点的命中会拆成同 id 的多个 mark，所以这里数的是 mark 而不是「命中条数」。
 */
const HITS = ".readora-document mark[data-readora-search-id]";
const ACTIVE = `${HITS}[data-readora-search-active="true"]`;

async function openSearch(page: import("@playwright/test").Page): Promise<void> {
  await page.keyboard.press("Control+f");
  await expect(page.locator(INPUT)).toBeFocused();
}

async function countLabel(page: import("@playwright/test").Page): Promise<string> {
  return (await page.locator(".readora-search-count").textContent()) ?? "";
}

/**
 * 命中节点的文本清单。
 *
 * 搜索有 `SEARCH_DEBOUNCE_MS = 250` 的输入防抖，所以**任何 fill 之后都不能直接读
 * 一次就下结论** —— 那样读到的是上一次查询留下的高亮。这里只负责取数，
 * 等待交给调用处的 `expect.poll` / web-first 断言。
 */
async function hitTexts(page: import("@playwright/test").Page): Promise<string[]> {
  return page.locator(HITS).allInnerTexts();
}

test.describe("文档内搜索", () => {
  test.beforeEach(async ({ page }) => {
    await openReader(page);
  });

  test("Ctrl+F 打开搜索条并聚焦输入框，Escape 收回", async ({ page }) => {
    await expect(page.locator(".readora-searchbar")).toHaveCount(0);
    await openSearch(page);
    await page.keyboard.press("Escape");
    await expect(page.locator(".readora-searchbar")).toHaveCount(0);
  });

  test("输入即时出计数，上/下一条让活动高亮在命中之间巡回", async ({ page }) => {
    await openSearch(page);
    await page.locator(INPUT).fill("needle");
    await expect(page.locator(HITS)).not.toHaveCount(0);
    expect(await countLabel(page)).toMatch(/^1 \/ \d+$/);

    const activeId = () => page.locator(ACTIVE).getAttribute("data-readora-search-id");
    const first = await activeId();
    expect(first).not.toBeNull();

    await page.getByRole("button", { name: "Next match" }).click();
    await expect.poll(activeId).not.toBe(first);

    await page.getByRole("button", { name: "Previous match" }).click();
    await expect.poll(activeId).toBe(first);
  });

  test("查询串里的正则元字符按字面量处理", async ({ page }) => {
    await openSearch(page);
    // 正文同段里 `a.b` 与 `axb` 各一处：那个点要是被当成正则的「任意字符」，
    // 命中的文本里就会出现 axb —— 比只数个数更能证明走的是字面量匹配。
    await page.locator(INPUT).fill("a.b");
    await expect.poll(async () => {
      const texts = await hitTexts(page);
      return texts.length > 0 && texts.every((text) => text === "a.b");
    }).toBe(true);

    // 未闭合的括号不该让搜索整条链路抛异常（没有命中就是没有命中）。
    await page.locator(INPUT).fill("(unclosed");
    await expect(page.locator(".readora-search-count")).toHaveText("No matches");
    await expect(page.locator(HITS)).toHaveCount(0);
    await expect(page.locator(".readora-document")).toBeVisible();
  });

  test("换查询词会清掉上一次的高亮，关闭搜索后正文文本原样还原", async ({ page }) => {
    // 取一段**确实会被高亮命中**的正文：拿没被碰过的段落比还原，等于什么都没验。
    const target = page.locator(".readora-paragraph", { hasText: "needle" }).first();
    const before = await target.innerText();

    await openSearch(page);
    await page.locator(INPUT).fill("needle");
    await expect(page.locator(HITS)).not.toHaveCount(0);

    await page.locator(INPUT).fill("bullet");
    // 高亮节点会被复用，但命中的文本必须全部来自新查询词：留一个 needle 就是没清干净。
    await expect.poll(async () => {
      const texts = await hitTexts(page);
      return texts.length > 0 && texts.every((text) => text.includes("bullet"));
    }).toBe(true);

    await page.getByRole("button", { name: "Close search" }).click();
    await expect(page.locator(HITS)).toHaveCount(0);
    await expect(target).toHaveText(before);
  });
});
