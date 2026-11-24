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
  test("头部图标靠右且只给图标，3px 滚动条仍能独立滚动长目录", async ({ page }) => {
    await openReader(page, { text: longDoc(60) });
    const header = page.locator(".readora-outline-header");
    const actions = header.locator("button");
    // 展开与折叠拆成两枚常驻图标，加过滤一共三枚。
    await expect(actions).toHaveCount(3);
    await expect(header).toHaveCSS("justify-content", "flex-end");
    const headerBox = await header.boundingBox();
    const lastBox = await actions.last().boundingBox();
    expect(headerBox).not.toBeNull();
    expect(lastBox).not.toBeNull();
    expect(Math.abs(lastBox!.x + lastBox!.width - headerBox!.x - headerBox!.width)).toBeLessThan(1);
    for (const action of await actions.all()) {
      await expect(action).toHaveText("");
      await expect(action.locator("svg")).toHaveCount(1);
      // 图标调大（产品反馈）：从 12px 撑到 16px，与顶栏基准图标同尺寸。
      await expect(action.locator("svg")).toHaveCSS("width", "16px");
    }
    // 两枚展开/折叠的形状必须不同，否则“看不出点的是哪一枚”又回来了。
    const expandShape = await page
      .locator('[data-readora-outline-action="expand-all"] path')
      .getAttribute("d");
    const collapseShape = await page
      .locator('[data-readora-outline-action="collapse-all"] path')
      .getAttribute("d");
    expect(expandShape).not.toBeNull();
    expect(collapseShape).not.toBeNull();
    expect(expandShape).not.toBe(collapseShape);

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

  for (const theme of ["light", "dark"] as const) {
    test(`${theme}：活动条目文字走中性正文色，不再吃强调色`, async ({ page }) => {
      await openReader(page);
      await page.evaluate((value) => window.__readora.setTheme(value), theme);
      await scrollTo(page, 1_200);

      const active = page.locator('.readora-outline-link[aria-current="location"]');
      await expect(active).toHaveCount(1);
      // 色值不写死在这里：两边都从运行时取，比的是「活动条目等于哪一档」。
      // 旧实现吃 `--readora-outline-active-color`（= accent-text），用户实测
      // 「白里透紫、不够清爽」；现在走 text-primary，层级靠更亮的一档 + 600 + 淡底。
      const read = await active.evaluate((node) => {
        const toRgb = (value: string): readonly [number, number, number] | null => {
          const text = value.trim();
          const hex = /^#([\da-f]{6})$/iu.exec(text);
          if (hex?.[1]) {
            const digits = hex[1];
            return [
              Number.parseInt(digits.slice(0, 2), 16),
              Number.parseInt(digits.slice(2, 4), 16),
              Number.parseInt(digits.slice(4, 6), 16)
            ];
          }
          const rgb = /rgba?\((\d+), (\d+), (\d+)/u.exec(text);
          if (!rgb) {
            return null;
          }
          return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
        };
        const root = getComputedStyle(document.documentElement);
        const style = getComputedStyle(node);
        const plain = document.querySelector<HTMLElement>(
          '.readora-outline-link:not([aria-current])'
        );
        const [red, green, blue] = toRgb(style.color) ?? [0, 0, 0];
        return {
          active: toRgb(style.color),
          textPrimary: toRgb(root.getPropertyValue("--readora-color-text-primary")),
          accentText: toRgb(root.getPropertyValue("--readora-outline-active-color")),
          plain: plain ? toRgb(getComputedStyle(plain).color) : null,
          // 通道差是「有没有透色相」的量尺：旧值 #d2ccf0 为 36，新值 #dfe2eb 为 12。
          spread: Math.max(red, green, blue) - Math.min(red, green, blue),
          weight: style.fontWeight,
          raw: style.color
        };
      });

      expect(read.active, `${theme} 活动条目文字读不出色值：${read.raw}`).not.toBeNull();
      expect(read.textPrimary).not.toBeNull();
      expect(read.plain).not.toBeNull();
      expect(read.active).toEqual(read.textPrimary);
      // 与强调色那档必须拉开：否则「去紫」只是改了个名字。
      expect(read.accentText).not.toBeNull();
      expect(read.active).not.toEqual(read.accentText);
      // 层级线索仍在：活动项与常规行是两档文字。
      expect(read.active).not.toEqual(read.plain);
      expect(read.weight).toBe("600");
      if (theme === "dark") {
        // 暗色那档的正文色本身就是中性灰白，紫味能直接被量出来；亮色的
        // text-primary 是正文同相深藏青（PRD-003 §4.2），不适用这一把尺。
        expect(read.spread, `暗色活动条目文字仍带色相：${read.raw}`).toBeLessThanOrEqual(16);
      }
    });
  }

  test("高对比预设把文字压成两档：活动条目与常规行同色时，区分靠字重与淡底", async ({ page }) => {
    await openReader(page);
    await page.evaluate(() =>
      window.__readora.setPreferences({ theme: "dark", themePreset: "high-contrast" })
    );
    await scrollTo(page, 1_200);
    const read = await page
      .locator('.readora-outline-link[aria-current="location"]')
      .evaluate((node) => {
        const style = getComputedStyle(node);
        const plain = document.querySelector<HTMLElement>(
          '.readora-outline-link:not([aria-current])'
        );
        return {
          activeColor: style.color,
          plainColor: plain ? getComputedStyle(plain).color : null,
          weight: style.fontWeight,
          background: style.backgroundColor
        };
      });
    // 预设刻意把 text-secondary 压成 text-primary（tokens.css 高对比注释第 3 条：
    // 「高对比要的是可读性而不是层级感」），常规行因此与活动条目读到同一档文字色。
    // 区分没有丢，只是不再靠颜色 —— 字重 600 + 一层淡底，正是 1.4.1 要的线索。
    expect(read.plainColor).not.toBeNull();
    expect(read.activeColor).toBe(read.plainColor);
    expect(read.weight).toBe("600");
    expect(read.background).not.toBe("rgba(0, 0, 0, 0)");
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
  // 0 基 —— 按 1 基解释时这一条区间切不出来，字数标签会静默不显示。
  test("大纲不报进度也不排行内标签：字数与行号都不上 UI", async ({ page }) => {
    await openReader(page);
    // 进度只属于快速条（PRD-003 §10.5）；面板里再放一条就是两个数各说各话。
    await expect(page.locator('[data-readora-outline="progress"]')).toHaveCount(0);
    await expect(page.locator(".readora-outline-progress")).toHaveCount(0);

    // 行内标签整条链路已按产品要求下掉：`93w` 这类分节字数与 `L12` 那类源行号都不出现。
    await expect(page.locator(".readora-outline-meta")).toHaveCount(0);
    await expect(page.locator(".readora-outline-item").first()).not.toContainText(/\d+w/u);
  });

  test("折叠全部只换那一枚的按下态，列表真的收起来；展开全部再恢复", async ({ page }) => {
    await openReader(page, { text: longDoc(12) });
    const items = page.locator(".readora-outline-item");
    const total = await items.count();
    expect(total).toBeGreaterThan(2);

    const expand = page.locator('[data-readora-outline-action="expand-all"]');
    const collapse = page.locator('[data-readora-outline-action="collapse-all"]');
    // 全展开时展开那枚禁用（没东西可展开），淡底挂在折叠那枚上。
    await expect(expand).toBeDisabled();
    await expect(expand).toHaveAttribute("aria-pressed", "false");
    await expect(collapse).toBeEnabled();
    await expect(collapse).toHaveAttribute("aria-pressed", "true");
    const expandColor = await expand.evaluate((node) => getComputedStyle(node).color);
    const collapseColor = await collapse.evaluate((node) => getComputedStyle(node).color);

    await collapse.click();
    await expect(page.locator(".readora-outline-item")).toHaveCount(1);
    await expect(expand).toHaveAttribute("aria-pressed", "true");
    await expect(collapse).toHaveAttribute("aria-pressed", "false");
    await expect(expand).toBeEnabled();
    await expect(collapse).toBeDisabled();
    // 样式真的变了：高亮从折叠那枚移到展开那枚（用户报的“点了没变化”就是这一条）。
    // 读的是 `color` 而不是 `backgroundColor`：`shell.css` 里那段注释定了“按下态用
    // 透明度 / 强度表达而不用底色”（亮色下 surface-raised 与 canvas 差极小，灰底
    // 会让用户分不清那是普通按钮还是高亮），两枚的底色以设计而言本来就不变。
    await expect
      .poll(() => expand.evaluate((node) => getComputedStyle(node).color))
      .not.toBe(expandColor);
    await expect
      .poll(() => collapse.evaluate((node) => getComputedStyle(node).color))
      .not.toBe(collapseColor);

    await expand.click();
    await expect(page.locator(".readora-outline-item")).toHaveCount(total);
    await expect(expand).toHaveAttribute("aria-pressed", "false");
  });
});
