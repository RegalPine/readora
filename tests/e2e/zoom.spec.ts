/**
 * 缩放组与缩放快捷键（PRD-003 §10.5 缩放组、§11.4 单一变量驱动）。
 *
 * 单测锁的是 `clampZoom` / `scaledFontSize` 的算术，浏览器里才有的事实是：
 * 三枚按钮真的改变了 `--readora-font-size`（也就是真的把正文画大），
 * 到端点时按钮真的 disabled 而不是按下去静默失败，
 * 以及 `Ctrl/Cmd + = / - / 0` 只在画面有文档时被接管。
 */
import { expect, test } from "@playwright/test";
import { openReader } from "../helpers/reader";

const VALUE = '.readora-zoom-button[aria-label="Reset zoom"]';
const IN = '.readora-zoom-button[aria-label="Zoom in"]';
const OUT = '.readora-zoom-button[aria-label="Zoom out"]';

/** 正文字号变量的实测值 —— 缩放最终必须落到这里才算真生效。 */
function fontSizeVariable(page: import("@playwright/test").Page): Promise<string> {
  return page.evaluate(
    () =>
      getComputedStyle(document.documentElement)
        .getPropertyValue("--readora-font-size")
        .trim()
  );
}

/** 正文 h1 的实际渲染字号（px 字符串），证明变量真的被消费了。 */
function headingPx(page: import("@playwright/test").Page): Promise<string> {
  return page.evaluate(() => {
    const heading = document.querySelector(".readora-document h1");
    return heading ? getComputedStyle(heading).fontSize : "";
  });
}

test.describe("缩放", () => {
  test.beforeEach(async ({ page }) => {
    await openReader(page);
  });

  test("按钮组按 10% 步长走，并同步写进 --readora-font-size 与状态条", async ({ page }) => {
    expect(await fontSizeVariable(page)).toBe("16px");
    const base = await headingPx(page);

    await page.locator(IN).click();
    await page.locator(IN).click();
    await expect(page.locator(VALUE)).toHaveText("120%");
    // round(16 × 1.2) = 19：缩放是整像素量化，半像素会让行距抖。
    expect(await fontSizeVariable(page)).toBe("19px");
    expect(await headingPx(page)).not.toBe(base);
    await expect(page.locator('[data-readora-status="zoom"]')).toHaveText("zoom 120%");

    await page.locator(OUT).click();
    await expect(page.locator(VALUE)).toHaveText("110%");
  });

  test("区间端点停在 50% / 200%，越界的按钮被禁用", async ({ page }) => {
    // 1.0 → 2.0 正好 10 步：第 11 次点击会落在已禁用的按钮上，那本身就是断言。
    for (let step = 0; step < 10; step += 1) {
      await page.locator(IN).click();
    }
    await expect(page.locator(VALUE)).toHaveText("200%");
    await expect(page.locator(IN)).toBeDisabled();
    await expect(page.locator(OUT)).toBeEnabled();

    // 从 200% 减 15 步正好到 50%：再多一次就是点已禁用的按钮，那本身另有断言。
    for (let step = 0; step < 15; step += 1) {
      await page.locator(OUT).click();
    }
    await expect(page.locator(VALUE)).toHaveText("50%");
    await expect(page.locator(OUT)).toBeDisabled();
    // 端点上字号仍在可读区间内（8–32px 的夹取归 applyTheme，两处口径不能互相打架）。
    expect(await fontSizeVariable(page)).toBe("8px");
  });

  test("点百分号复位到 100%", async ({ page }) => {
    await page.locator(IN).click();
    await page.locator(IN).click();
    await page.locator(IN).click();
    await expect(page.locator(VALUE)).toHaveText("130%");

    await page.locator(VALUE).click();
    await expect(page.locator(VALUE)).toHaveText("100%");
    expect(await fontSizeVariable(page)).toBe("16px");
  });

  test("Ctrl/Cmd + = / - / 0 接管按键，且不吞掉带 Alt 的组合", async ({ page }) => {
    await page.keyboard.press("Control+=");
    await expect(page.locator(VALUE)).toHaveText("110%");
    await page.keyboard.press("Control+-");
    await expect(page.locator(VALUE)).toHaveText("100%");
    await page.keyboard.press("Control+=");
    await page.keyboard.press("Control+0");
    await expect(page.locator(VALUE)).toHaveText("100%");

    // Alt 组合留给宿主：Readora 不认为自己有权接管 Ctrl+Alt+= 这类按键。
    await page.keyboard.press("Control+Alt+=");
    await expect(page.locator(VALUE)).toHaveText("100%");
  });

  test("缩放是会话内状态：不写配置，也不动字号偏好", async ({ page }) => {
    await page.keyboard.press("Control+=");
    await page.keyboard.press("Control+=");
    await expect(page.locator(VALUE)).toHaveText("120%");

    // 真通道只有 config.patch：缩放了 N 次也不该冒出一条写 readora.fontSize 的消息。
    const patches = await page.evaluate(() =>
      window.__readora.messages("config.patch").map((entry) => entry.payload)
    );
    expect(patches).toEqual([]);
    expect(await page.evaluate(() => window.__readora.preferences().fontSize)).toBe(16);
  });
});
