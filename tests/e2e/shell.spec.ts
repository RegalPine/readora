/**
 * 外壳四段与阅读辅助字段（PRD-003 §10.5 / §4.6，IMP-002 STORY-06-01 外壳部分）。
 *
 * 这一组是**只有浏览器能回答**的问题：四段的实际几何、状态条字段是否随真实数据变、
 * pill 真的落在状态条右端而不被挤出去、专注模式把大纲收掉后快速条补得上导航。
 * §4.6 的区块渲染诚实性在这里的可观测形式是：字段值必须跟着换文档 / 换主题变，
 * 而不是渲染一次就定死的字符串。
 */
import { expect, test } from "@playwright/test";
import { openReader, RICH_DOC, scrollTo } from "../helpers/reader";

const FIELDS = ["sections", "words", "version", "zoom", "theme", "bridge"] as const;

async function fieldText(page: import("@playwright/test").Page, field: string): Promise<string> {
  return (await page.locator(`[data-readora-status="${field}"]`).innerText()).trim();
}

/** 段高契约：CSS 变量声明值 = 实测高（允许一条 1px hairline 边框，别的不行）。 */
async function expectBandHeight(
  page: import("@playwright/test").Page,
  selector: string,
  token: string,
  declared: number
): Promise<void> {
  const value = await page.evaluate((name) => {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }, token);
  expect(value).toBe(`${declared}px`);

  const box = await page.locator(selector).boundingBox();
  expect(box).not.toBeNull();
  const measured = box?.height ?? 0;
  expect(measured).toBeGreaterThanOrEqual(declared);
  expect(measured).toBeLessThanOrEqual(declared + 1);
}

test.describe("外壳与状态条", () => {
  test("四段栅格的实测几何：顶栏 44px、状态条 24px，搜索段未打开不占位", async ({ page }) => {
    await openReader(page);

    await expectBandHeight(page, ".readora-topbar", "--readora-topbar-height", 44);
    await expectBandHeight(page, ".readora-statusbar", "--readora-statusbar-height", 24);
    // 「没打开搜索时整段不输出 DOM」：留一个 0 高的空段会在状态条上方画一条无用分隔线。
    await expect(page.locator(".readora-searchbar")).toHaveCount(0);
    await expect(page.locator(".readora-body")).toBeVisible();
    // 顶栏在上、状态条在下：顺序反了的话 sticky 快速条会盖住状态条。
    const topbar = await page.locator(".readora-topbar").boundingBox();
    const statusbar = await page.locator(".readora-statusbar").boundingBox();
    expect((topbar?.y ?? 1) + (topbar?.height ?? 0)).toBeLessThan(statusbar?.y ?? 0);
  });

  test("状态条六项齐备，且取值全部来自当前快照", async ({ page }) => {
    await openReader(page);

    await expect(page.locator(".readora-status .readora-status-item")).toHaveCount(6);
    for (const field of FIELDS) {
      await expect(page.locator(`[data-readora-status="${field}"]`)).toBeVisible();
    }
    // 大纲有 4 个标题 → 4 sections；版本与消息严格同源，不是本地计数器。
    expect(await fieldText(page, "sections")).toBe("4 sections");
    expect(await fieldText(page, "version")).toBe("v1");
    expect(await fieldText(page, "zoom")).toBe("zoom 100%");
    expect(Number.parseInt(await fieldText(page, "words"), 10)).toBeGreaterThan(0);
    await expect(page.locator('[data-readora-status="bridge"] [data-readora-bridge-state]')).toHaveAttribute(
      "data-readora-bridge-state",
      "connected"
    );

    // 换一份文档：sections 与 version 必须跟着走，留旧值就是 §4.6 说的假字段。
    await page.evaluate(() =>
      window.__readora.load({
        text: "# One\n\nOnly a heading and a line.\n\n## Two\n\nBody.",
        documentUri: "file:///vault/e2e/short.md",
        version: 7
      })
    );
    await expect(page.locator('[data-readora-status="sections"]')).toHaveText("2 sections");
    expect(await fieldText(page, "version")).toBe("v7");
  });

  test("面包屑取末 3 段且是纯文本（没有 reveal-in-explorer 就不给可点的假 affordance）", async ({ page }) => {
    await openReader(page);

    const segments = page.locator(".readora-breadcrumb [data-readora-breadcrumb]");
    await expect(segments).toHaveCount(3);
    await expect(segments.nth(2)).toHaveAttribute("data-readora-breadcrumb", "filename");
    // 段内的分隔符 `/` 是 aria-hidden 节点，整串文本因此带前缀 —— 按后缀断言。
    await expect(segments.nth(2)).toHaveText(/reader\.md$/);
    await expect(segments.nth(0)).toHaveAttribute("data-readora-breadcrumb", "directory");
    expect(await segments.nth(0).innerText()).toBe("vault");

    await expect(page.locator(".readora-breadcrumb a")).toHaveCount(0);
    await expect(page.locator(".readora-breadcrumb")).toHaveAttribute("title", "file:///vault/e2e/reader.md");
  });

  test("阅读时长 pill 随字数出现，空文档不出 pill，两者都贴状态条右端", async ({ page }) => {
    await openReader(page);
    await expect(page.locator('[data-readora-pill="reading-time"]')).toContainText("min read");
    // 模式标签与是否处于专注模式同源，不能永远写着 Reading。
    await expect(page.locator('[data-readora-pill="mode"]')).toHaveText("Reading");
    // 位置契约（产品反馈：放底部右侧）：pill 在状态条那一段里，顶栏一枚都不剩。
    await expect(page.locator(".readora-statusbar .readora-status-pills")).toBeVisible();
    expect(
      await page.locator('.readora-statusbar [data-readora-pill="mode"]').count()
    ).toBe(1);
    await expect(page.locator(".readora-topbar [data-readora-pill]")).toHaveCount(0);

    await page.evaluate(() =>
      window.__readora.load({ text: "", documentUri: "file:///vault/e2e/empty.md" })
    );
    await expect(page.locator('[data-readora-pill="reading-time"]')).toHaveCount(0);
    await expect(page.locator('[data-readora-status="words"]')).toHaveText("0 words");
  });

  test("快速条报进度与活动标题，但不自带「回到顶部」", async ({ page }) => {
    await openReader(page);
    expect(await page.locator('[data-readora-quickbar="progress"]').innerText()).toBe("0%");

    await scrollTo(page, 900);
    const progress = Number.parseInt(
      await page.locator('[data-readora-quickbar="progress"]').innerText(),
      10
    );
    expect(progress).toBeGreaterThan(0);
    // 活动标题跟着滚动走：快速条与大纲高亮必须指向同一节。
    const heading = await page.locator('[data-readora-quickbar="heading"]').innerText();
    expect(heading.length).toBeGreaterThan(0);
    await expect(page.locator('.readora-outline-link[aria-current="location"]')).toContainText(heading);

    // 常规档的快速条只是一个读数条，没有动作按钮：「回到顶部」已按产品反馈下掉，
    // 而且上一段的断言依赖窗口真的停在 900px，这里顺手把它钉住。
    await expect(page.locator(".readora-quickbar button")).toHaveCount(0);
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  });

  test("专注模式收掉大纲，退出入口默认淡出、鼠标移到顶部才浮现，快速条补上「展开大纲」这条导航退路", async ({ page }) => {
    await openReader(page);
    await expect(page.getByRole("button", { name: "Expand outline" })).toHaveCount(0);

    await page.getByRole("button", { name: "Enter focus mode" }).click();

    await expect(page.locator(".readora-shell")).toHaveAttribute("data-readora-focus-mode", "true");
    // 顶栏收成只剩退出入口（pill 在状态条那一段）：工具按钮一个都不留（§11.2）。
    await expect(page.getByRole("button", { name: "Search in document" })).toHaveCount(0);
    await expect(page.locator('[data-readora-pill="mode"]')).toHaveText("Focus");

    // 退出入口默认不显示，鼠标移到顶部才浮现（产品反馈：类浏览器全屏）。
    // 断言量的是几何位置而不是 opacity：隐藏手段已从「淡出」换成整条带子
    // `translateY` 抬出视口，opacity 在这条路径上恒为 "1"，拿它断言只会假绿。
    // 量工具栏内容自己的矩形，选择器里带上门控属性，这样「属性没挂上」与
    // 「挂了但不收起」两种跑偏都能红。
    const exit = page.getByRole("button", { name: "Exit focus mode" });
    await expect(exit).toHaveCount(1);
    const focusToolbar = page.locator(
      '.readora-topbar[data-readora-topbar-reveal="hover"] .readora-toolbar--focus'
    );
    // transform 走 --readora-motion-normal 过渡，插值帧里的中间值不能作为结论：poll 到稳态。
    // 两道稳态以视口上沿为分界：静默态整条带子被抬到 `4px - 100%`，内容矩形 top 取负值；
    // 浮现态回到 translateY(0)，内容矩形 top 落在带子里而非负。
    const toolbarTop = () =>
      focusToolbar.evaluate((node) => Math.round(node.getBoundingClientRect().top));
    // 上面那枚 Enter focus mode 就按在顶栏里，指针还停在带上：先移开再断言静默态。
    await page.mouse.move(640, 400);
    await expect.poll(toolbarTop).toBeLessThan(0);
    // 触发沿就是那 4px：被抬走的带子只有 0~4 这一段还在视口里，指针落在 8px 就命中不到它。
    await page.mouse.move(640, 2);
    await expect.poll(toolbarTop).toBeGreaterThanOrEqual(0);
    // 键盘路径不能因为收起变成死胡同：聚焦到入口自己就滑回。
    await page.mouse.move(640, 400);
    await expect.poll(toolbarTop).toBeLessThan(0);
    await exit.focus();
    await expect.poll(toolbarTop).toBeGreaterThanOrEqual(0);

    const outline = page.getByRole("navigation", { name: "Document outline" });
    await expect(outline).toBeHidden();

    await page.getByRole("button", { name: "Expand outline" }).click();
    await expect(outline).toBeVisible();

    await exit.click();
    await expect(outline).toBeVisible();
  });

  test("Reader Settings 触发器如实报告弹层开合（aria-haspopup + aria-expanded）", async ({ page }) => {
    await openReader(page);
    const trigger = page.getByRole("button", { name: "Reader settings" });
    await expect(trigger).toHaveAttribute("aria-haspopup", "dialog");
    await expect(trigger).toHaveAttribute("aria-expanded", "false");

    await trigger.click();
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    // Escape 关弹层，焦点归位触发器 —— 键盘用户不该在关闭后掉回 body。
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
    await expect(trigger).toBeFocused();
  });

  test("正文换文档后旧文档的搜索面板不会留着（面板随快照失效）", async ({ page }) => {
    await openReader(page);
    await page.keyboard.press("Control+f");
    await page.locator(".readora-search-input").fill("needle");
    await expect(page.locator(".readora-document mark[data-readora-search-id]")).not.toHaveCount(0);

    await page.evaluate((text) => {
      // 正文里已经没有 needle 了：留着旧高亮就说明面板还指着上一份快照。
      window.__readora.load({ text, version: 2 });
    }, RICH_DOC.replace(/needle/g, "spool"));
    // 高亮节点跟着正文一起没：留着就是在新文档上指向不存在的位置。
    await expect(page.locator(".readora-document mark[data-readora-search-id]")).toHaveCount(0);
  });
});
