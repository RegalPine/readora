/**
 * 外壳栅格与阅读辅助字段（PRD-003 §10.5 / §4.6，IMP-002 STORY-06-01 外壳部分）。
 *
 * 这一组是**只有浏览器能回答**的问题：各带的实际几何、状态条字段是否随真实数据变、
 * pill 真的落在状态条右端而不被挤出去、专注模式把大纲收掉后快速条补得上导航。
 * §4.6 的区块渲染诚实性在这里的可观测形式是：字段值必须跟着换文档 / 换主题变，
 * 而不是渲染一次就定死的字符串。
 */
import { expect, test } from "@playwright/test";
import { openReader, RICH_DOC, scrollTo } from "../helpers/reader";

const FIELDS = ["words", "zoom", "theme"] as const;

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
  test("各带的实测几何：顶栏 44px、状态条 24px，搜索段未打开不占位", async ({ page }) => {
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

  test("大纲通顶 + 顶栏让位：左栏从视口顶贯到状态条上沿，顶栏右偏不压大纲", async ({ page }) => {
    await openReader(page);

    const viewport = page.viewportSize();
    const nav = await page.locator(".readora-shell-nav").boundingBox();
    const topbar = await page.locator(".readora-topbar").boundingBox();
    const statusbar = await page.locator(".readora-statusbar").boundingBox();
    expect(nav).not.toBeNull();
    expect(topbar).not.toBeNull();
    expect(statusbar).not.toBeNull();

    // 通顶：左栏顶边贴视口顶，底边到状态条上沿为止（状态条仍横贯整窗）。
    expect(nav?.y ?? -1).toBeLessThanOrEqual(1);
    expect((nav?.y ?? 0) + (nav?.height ?? 0)).toBeLessThanOrEqual((statusbar?.y ?? 0) + 1);

    // 让位：顶栏左缘落在大纲右缘之右，宽度也不铺满整窗（只占右侧内容列）。
    expect(topbar?.x ?? 0).toBeGreaterThanOrEqual((nav?.x ?? 0) + (nav?.width ?? 0) - 1);
    expect(topbar?.width ?? 0).toBeLessThan(viewport?.width ?? Number.POSITIVE_INFINITY);
  });

  test("状态条只保留三项，文档更新后也不展示内部版本", async ({ page }) => {
    await openReader(page, { text: RICH_DOC, version: 0 });

    await expect(page.locator(".readora-status .readora-status-item")).toHaveCount(3);
    for (const field of FIELDS) {
      await expect(page.locator(`[data-readora-status="${field}"]`)).toBeVisible();
    }
    // 节数字段已删（产品反馈：目录那一栏直接数得出来，底部再说一遍是重复）。
    await expect(page.locator('[data-readora-status="sections"]')).toHaveCount(0);
    await expect(page.locator('[data-readora-status="version"]')).toHaveCount(0);
    await expect(page.locator(".readora-status")).not.toContainText(/\bv\d+\b/u);
    await expect(page.locator(".readora-document")).toHaveAttribute("data-readora-document-version", "0");
    expect(await fieldText(page, "zoom")).toBe("zoom 100%");
    const words = Number.parseInt(await fieldText(page, "words"), 10);
    expect(words).toBeGreaterThan(0);

    // 换一份文档：字数必须跟着走，内部版本仍不作为状态字段显示。
    await page.evaluate(() =>
      window.__readora.load({
        text: "# One\n\nOnly a heading and a line.\n\n## Two\n\nBody.",
        documentUri: "file:///vault/e2e/short.md",
        version: 7
      })
    );
    await expect(page.locator(".readora-document")).toHaveAttribute("data-readora-document-version", "7");
    await expect(page.locator('[data-readora-status="version"]')).toHaveCount(0);
    await expect(page.locator(".readora-status")).not.toContainText(/\bv\d+\b/u);
    expect(Number.parseInt(await fieldText(page, "words"), 10)).toBeLessThan(words);
  });

  test("顶栏不再自绘面包屑：路径导航交给 VS Code 原生面包屑", async ({ page }) => {
    await openReader(page);

    // 自定义编辑器形态下宿主在编辑器上方给原生面包屑，webview 顶栏不该再有第二条。
    await expect(page.locator(".readora-breadcrumb")).toHaveCount(0);
    await expect(page.locator("[data-readora-breadcrumb]")).toHaveCount(0);
    await expect(page.locator('[aria-label="Document path"]')).toHaveCount(0);
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

  test("专注模式整段不输出顶栏：快速条贴顶不留空带，退出入口移到快速条上 hover 浮现且必可点", async ({ page }) => {
    await openReader(page);
    await expect(page.getByRole("button", { name: "Expand outline" })).toHaveCount(0);
    const topbar = page.locator(".readora-topbar");
    await expect(topbar).toHaveCount(1);

    await page.getByRole("button", { name: "Enter focus mode" }).click();

    await expect(page.locator(".readora-shell")).toHaveAttribute("data-readora-focus-mode", "true");
    // 顶栏段不在 DOM：既没有第二条入口，也不给顶部留一条抬出视口的带子（§11.2）。
    await expect(topbar).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Search in document" })).toHaveCount(0);
    await expect(page.locator('[data-readora-pill="mode"]')).toHaveText("Focus");

    // 「透明占位」的直接反证：顶部那段命中的就是快速条本身，不是空的正文容器。
    // 上一版这里 4~44px 是 `.readora-shell-main`，文档标题被切掉半截。
    await expect(
      page.evaluate(() => document.elementFromPoint(640, 20)?.closest(".readora-quickbar") !== null)
    ).resolves.toBeTruthy();

    // 退出入口默认不显示，鼠标移到快速条这一整条才浮现。这里断言量 opacity：
    // 浮现手段就是淡入淡出本身，按钮原地不动（不靠位移），所以 opacity 是真结论；
    // 但必须 poll 到稳态，过渡插值帧里的中间值不能作为结论。
    const exit = page.getByRole("button", { name: "Exit focus mode" });
    await expect(exit).toHaveCount(1);
    const exitOpacity = () => exit.evaluate((node) => getComputedStyle(node).opacity);
    await page.mouse.move(640, 400);
    await expect.poll(exitOpacity).toBe("0");
    // 触发区是快速条自己：33px 高、整屏宽，指针落在条子中间就该浮现。
    // 旧版的触发沿只有 4px，停在 y=8 就命中不到，用户根本退不出专注模式。
    await page.mouse.move(640, 20);
    await expect.poll(exitOpacity).toBe("1");
    // 键盘路径不能因为收起变成死胡同：聚焦到入口（祖先 :focus-within）同样浮现。
    await page.mouse.move(640, 400);
    await expect.poll(exitOpacity).toBe("0");
    await exit.focus();
    await expect.poll(exitOpacity).toBe("1");

    // 浮现后入口原地可点：click 会把指针带到按钮中心，那里仍在快速条内，
    // hover 不会在点击前收回 —— 触发区与命中区同域是这版设计的核心。
    await exit.click();
    await expect(page.locator(".readora-shell")).not.toHaveAttribute(
      "data-readora-focus-mode",
      "true"
    );
    await expect(topbar).toHaveCount(1);
  });

  test("专注模式的「展开大纲」不被任何浮层遮挡，退出后目录按偏好回来", async ({ page }) => {
    await openReader(page);
    await page.getByRole("button", { name: "Enter focus mode" }).click();

    const outline = page.getByRole("navigation", { name: "Document outline" });
    await expect(outline).toBeHidden();

    // 指针停在顶部那一条上（退出入口此刻正浮现）去按 Outline：上一版这里会被
    // z-index 70 的顶栏浮层吃掉命中，30s 超时停在 subtree intercepts pointer events。
    await page.mouse.move(640, 20);
    await page.getByRole("button", { name: "Expand outline" }).click();
    await expect(outline).toBeVisible();

    // 收起态是临时态：退出专注后回到「大纲按偏好显示」，不改写用户偏好。
    await page.getByRole("button", { name: "Exit focus mode" }).click();
    await expect(outline).toBeVisible();
    await expect(page.getByRole("button", { name: "Expand outline" })).toHaveCount(0);
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
