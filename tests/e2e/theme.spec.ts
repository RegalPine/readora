/**
 * 主题与预设的就地切换（ARC-006 §11.1 / §8.1，PRD-003 §10.5，IMP-002 STORY-06-*）。
 *
 * 单测（`theme-runtime.spec.tsx`）能证明 `applyTheme` 只写属性，证不了两件事：
 * 1. 一次主题切换**不会重建正文 DOM**、不会把滚动位置甩回顶部 —— 这要有真实布局；
 * 2. `[data-readora-preset]` / `[data-readora-typography]` 的覆写在真实层叠里
 *    真的赢过 palette 与 scheme 两层 —— jsdom 不按 CSS 文件顺序算特异度层叠，
 *    这类「谁覆盖谁」只有在浏览器里算得出computed value。
 */
import { expect, test } from "@playwright/test";
import {
  hostMessage,
  longDoc,
  openReader,
  scrollTo,
  viewMessages
} from "../helpers/reader";

import {
  expectReaderAlive,
  loadDocument,
  openProductionReader,
  pageErrors,
  postToView,
  violations
} from "../helpers/production-page";

declare global {
  interface Window {
    __readoraStartup: {
      frames: Array<{ palette: string; scheme: string; background: string; target: string }>;
      regressions: string[];
      running: boolean;
    };
  }
}

const ROOT = "html";

test.describe("暗色首帧交接（生产模板与 bundle）", () => {
  for (const palette of ["dark", "vscode"] as const) {
    test(`${palette}：主题消息迟到期间没有亮色帧`, async ({ page }) => {
      // 在生产脚本执行前开始记录；最终暗色正确不能证明中途没闪过白。
      await page.addInitScript((expectedPalette) => {
        const trace: Window["__readoraStartup"] = { frames: [], regressions: [], running: true };
        window.__readoraStartup = trace;
        const observer = new MutationObserver((records) => {
          for (const record of records) {
            if (!trace.running || record.target !== document.documentElement) continue;
            const expected = record.attributeName === "data-readora-theme" ? expectedPalette : "dark";
            const current = document.documentElement.getAttribute(record.attributeName ?? "");
            if (current !== expected || (record.oldValue !== null && record.oldValue !== expected)) {
              trace.regressions.push(`${record.attributeName}: ${record.oldValue} -> ${current}`);
            }
          }
        });
        observer.observe(document, {
          subtree: true,
          attributes: true,
          attributeOldValue: true,
          attributeFilter: ["data-readora-theme", "data-readora-scheme"]
        });
        const sample = () => {
          if (!trace.running) {
            observer.disconnect();
            return;
          }
          const root = document.documentElement;
          const target = root && getComputedStyle(root).getPropertyValue("--readora-color-canvas").trim();
          if (document.body && target) {
            const normalized = document.createElement("div");
            normalized.style.backgroundColor = target;
            trace.frames.push({
              palette: root.dataset.readoraTheme ?? "",
              scheme: root.dataset.readoraScheme ?? "",
              background: getComputedStyle(document.body).backgroundColor,
              target: normalized.style.backgroundColor
            });
          }
          requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      }, palette);

      await openProductionReader(page, { palette, scheme: "dark" });
      await expectReaderAlive(page);
      await page.waitForFunction(() => window.__readoraStartup.frames.length >= 3);
      await expect(page.locator(ROOT)).toHaveAttribute("data-readora-theme", palette);
      await expect(page.locator(ROOT)).toHaveAttribute("data-readora-scheme", "dark");

      // 故意让 document.load 先到、theme.update 晚到，中间实际经历多个绘制帧。
      await loadDocument(page, "# Dark startup\n\n主题消息尚未到达，正文也必须保持暗色。", { theme: palette });
      const before = await page.evaluate(() => window.__readoraStartup.frames.length);
      await page.waitForFunction((count) => window.__readoraStartup.frames.length >= count + 3, before);
      await expect(page.locator('[data-readora-status="theme"]')).toHaveText("theme dark");
      await postToView(page, hostMessage("theme.update", {
        theme: "dark", source: palette === "vscode" ? "vscode" : "product"
      }));
      const delivered = await page.evaluate(() => window.__readoraStartup.frames.length);
      await page.waitForFunction((count) => window.__readoraStartup.frames.length >= count + 3, delivered);
      const trace = await page.evaluate(() => {
        window.__readoraStartup.running = false;
        return window.__readoraStartup;
      });
      expect(trace.regressions).toEqual([]);
      expect(trace.frames.length).toBeGreaterThanOrEqual(9);
      for (const frame of trace.frames) {
        expect(frame.palette).toBe(palette);
        expect(frame.scheme).toBe("dark");
        expect(frame.background).toBe(frame.target);
      }
      expect(new Set(trace.frames.map((frame) => frame.background)).size).toBe(1);
      expect(await pageErrors(page)).toEqual([]);
      expect(await violations(page)).toEqual([]);
    });
  }
});

/** 根元素上某个 CSS 变量的实测取值（去空白，便于跨浏览器比较）。 */
async function cssVariable(page: import("@playwright/test").Page, name: string): Promise<string> {
  const value = await page.evaluate((token) => {
    return getComputedStyle(document.documentElement).getPropertyValue(token);
  }, name);
  return value.trim();
}

test.describe("主题就地切换", () => {
  test("theme.update 只改属性：正文节点与滚动位置原封不动", async ({ page }) => {
    await openReader(page);
    const scrolled = await scrollTo(page, 800);
    expect(scrolled).toBeGreaterThan(0);

    // 探针写在正文根节点上：一旦 React 重建这棵子树，它是第一个消失的东西。
    await page.evaluate(() => {
      const doc = document.querySelector<HTMLElement>(".readora-document");
      if (!doc) {
        throw new Error("fixture: .readora-document not mounted");
      }
      doc.dataset.readoraE2eProbe = "keep";
    });

    await page.evaluate(() => window.__readora.setTheme("dark"));

    await expect(page.locator(ROOT)).toHaveAttribute("data-readora-theme", "dark");
    await expect(page.locator(ROOT)).toHaveAttribute("data-readora-scheme", "dark");
    await expect(page.locator(".readora-document")).toHaveAttribute(
      "data-readora-e2e-probe",
      "keep"
    );
    // 状态条的 theme 字段与根属性同源：两处各读一份状态就迟早会漂。
    await expect(page.locator('[data-readora-status="theme"]')).toHaveText("theme dark");
    expect(await page.evaluate(() => window.scrollY)).toBe(scrolled);
  });

  /**
   * 弹层里的「主题模式」按下去要真的落色（PRD-003 §4.6 的区块渲染诚实性）。
   *
   * 这条是补上一轮浏览器取证的发现：夹具的 `config.patch` 原先只广播 `config.update`，
   * 而取色的唯一入口是 `theme.update`（`App.tsx` 头注），于是弹层改主题在这套 e2e 里
   * 什么都不会发生 —— 生产侧 `application.ts` 的 onDidChange 是 broadcastTheme +
   * broadcastConfig 两条，夹具少一条就是「绿灯与生产不同形」。
   * 断言全部走界面（点按钮、看属性），不碰夹具内部，所以夹具再漏一条广播也会被抓住。
   */
  test("弹层改主题模式：经 config.patch 落色，正文节点与滚动位置不动", async ({ page }) => {
    await openReader(page, { text: longDoc() });
    const scrolled = await scrollTo(page, 900);
    expect(scrolled).toBeGreaterThan(0);

    await page.evaluate(() => {
      const doc = document.querySelector<HTMLElement>(".readora-document");
      if (!doc) {
        throw new Error("fixture: .readora-document not mounted");
      }
      doc.dataset.readoraE2eProbe = "keep";
    });

    await page.getByRole("button", { name: "Reader settings" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Dark", exact: true }).click();

    // 弹层不乐观生效：DOM 上的主题属性只能由 Host 广播回来之后写上去。
    await expect(page.locator(ROOT)).toHaveAttribute("data-readora-theme", "dark");
    await expect(page.locator(ROOT)).toHaveAttribute("data-readora-scheme", "dark");
    await expect(page.locator('[data-readora-status="theme"]')).toHaveText("theme dark");

    const patches = await viewMessages<{ payload: { key: string; value: unknown } }>(
      page,
      "config.patch"
    );
    expect(patches.map((entry) => `${entry.payload.key}=${entry.payload.value}`)).toEqual([
      "theme=dark"
    ]);

    // 换的是取色属性，不是这棵子树：探针还在、滚动位置还在（§11.1 不重建 Reader Shell）。
    await expect(page.locator(".readora-document")).toHaveAttribute(
      "data-readora-e2e-probe",
      "keep"
    );
    expect(await page.evaluate(() => window.scrollY)).toBe(scrolled);
  });

  test("字族偏好换的是真实生效的 font-family，不只是 DOM 属性", async ({ page }) => {
    await openReader(page);
    await page.evaluate(() =>
      window.__readora.setPreferences({ typography: "newsreader" })
    );
    const newsreader = await page.evaluate(() => {
      const heading = document.querySelector(".readora-document h1");
      return heading ? getComputedStyle(heading).fontFamily : "";
    });
    expect(newsreader.length).toBeGreaterThan(0);

    await page.evaluate(() => window.__readora.setPreferences({ typography: "geist" }));
    await expect(page.locator(ROOT)).toHaveAttribute("data-readora-typography", "geist");
    const geist = await page.evaluate(() => {
      const heading = document.querySelector(".readora-document h1");
      return heading ? getComputedStyle(heading).fontFamily : "";
    });

    expect(geist).not.toBe(newsreader);
  });

  test("high-contrast 预设覆盖 muted / border-strong 两层之后的取值", async ({ page }) => {
    await openReader(page);
    await page.evaluate(() => window.__readora.setTheme("dark"));
    await expect(page.locator(ROOT)).toHaveAttribute("data-readora-scheme", "dark");

    const before = await cssVariable(page, "--readora-color-text-muted");
    expect(before.length).toBeGreaterThan(0);

    await page.evaluate(() =>
      window.__readora.setPreferences({ themePreset: "high-contrast" })
    );
    await expect(page.locator(ROOT)).toHaveAttribute("data-readora-preset", "high-contrast");
    const after = await cssVariable(page, "--readora-color-text-muted");

    // 断言「变了」而不是「变成了某个色值」：具体色值的权威在 tokens.css，
    // 对比度是否达标由 styles/__tests__/contrast.spec.ts 按 WCAG 实算，两边都不该写死。
    expect(after).not.toBe(before);
  });

  test("越界枚举的 config.update 进不了 DOM，视图照常可用", async ({ page }) => {
    await openReader(page);
    const before = await page.evaluate(() => ({
      typography: document.documentElement.dataset.readoraTypography ?? "",
      preset: document.documentElement.dataset.readoraPreset ?? ""
    }));

    // 字族与预设都放越界值：`themePreset` 里那句 `-moz-binding` 是旧浏览器的
    // 属性绑定注入写法，一旦漏进 DOM 属性就是可执行载荷，必须被 Schema 拦死。
    const badPrefs = hostMessage("config.update", {
      preferences: {
        theme: "light",
        fontSize: 16,
        lineHeight: 1.6,
        contentWidth: 720,
        showOutline: true,
        typography: "Comics Sans",
        themePreset: ";;-moz-binding"
      }
    });

    // 直接投一条**绕过夹具广播路径**的 config.update：真实 Host 也可能被用户
    // 往 `readora.*` 里写任意字符串，越界值必须留在 DOM 之外。信封形状合法，
    // 所以被拒的是入站 payload 校验（`ReaderPreferencesSchema`）这一道；
    // `applyTheme` 自己的枚举护栏是第二道，单测 theme-runtime.spec.tsx 已逐值锁过。
    await page.evaluate((message) => window.__readora.postRaw(message), badPrefs);

    const after = await page.evaluate(() => ({
      typography: document.documentElement.dataset.readoraTypography ?? "",
      preset: document.documentElement.dataset.readoraPreset ?? ""
    }));
    expect(after).toEqual(before);

    // 对拍照：同样的信封形状、只把越界值换成合法值，DOM 必须**跟着变**。
    // 少了这一条，上面的「没变」也可能只是通道压根没通（订阅没挂、类型不认识），
    // 那样断言的是个假护栏。
    await page.evaluate(
      (message) => window.__readora.postRaw(message),
      hostMessage("config.update", {
        preferences: {
          theme: "light",
          fontSize: 16,
          lineHeight: 1.6,
          contentWidth: 720,
          showOutline: true,
          typography: "geist",
          themePreset: "high-contrast"
        }
      })
    );
    await expect
      .poll(() =>
        page.evaluate(() => document.documentElement.dataset.readoraTypography ?? "")
      )
      .toBe("geist");

    // 拒收不等于崩：正文与状态条必须还在，用户看不出刚才那条消息存在过。
    await expect(page.locator(".readora-document")).toBeVisible();
    await expect(page.locator(".readora-statusbar")).toBeVisible();
  });

  /**
   * 代码块的底色就是它躺在上面的那张纸（用户口径：「不能是灰色的」）。
   *
   * 判据取计算后的 `backgroundColor` 而不是 Token 名：PRD-003 §4.2 把
   * `surface-sunken` 划给代码块，但那是「面板」思路下的分配，阅读面里代码块直接坐在
   * 画布上，套一层 sunken 就成了正文里嵌一块灰。外壳不画底（transparent）也算一致：
   * 它透出的一定是同一张画布。
   *
   * M8 之后代码块默认长出一个 CodeMirror 编辑器：静态 `<pre>` 被 CSS 收起，所以这里
   * 两个表面都要量 —— 只量 pre 就成了「在测一个看不见的面板」，编辑器要是自己带回来
   * 一层灰底就漏掉了（挂载与降级路径上的完整断言在 code-editor.spec.ts）。
   */
  test("代码块底色与其所在画布相同，明暗两套都不例外", async ({ page }) => {
    await openReader(page);

    const readBack = async (): Promise<{ pre: string; panel: string; editor: string; canvas: string }> =>
      page.evaluate(() => {
        const pre = document.querySelector(".readora-code-pre");
        if (!pre) {
          throw new Error("fixture: 正文里没有代码块");
        }
        const panel = pre.closest(".readora-code-block");
        const host = panel?.querySelector(".readora-code-editor");
        return {
          pre: getComputedStyle(pre).backgroundColor,
          panel: panel ? getComputedStyle(panel).backgroundColor : "",
          // 还没滚进视口时没有宿主：读空串，下面的断言跟着跳过这一项。
          editor: host ? getComputedStyle(host).backgroundColor : "",
          canvas: getComputedStyle(document.body).backgroundColor
        };
      });

    /**
     * 等到画布底色落定了再取。“落定”的判据就是两者相等：body 上挂着
     * `transition: background-color var(--readora-motion-slow)`（base.css），而代码块没有动效，
     * 于是换色途中会读到插值（实测 body = rgba(248,249,255,.89) 而 pre = rgb(248,249,255)）。
     * 轮询不会掩盖真缺陷：两边真不相等时它到点失败。
     */
    const settled = async (): Promise<{ pre: string; panel: string; editor: string; canvas: string }> => {
      await expect
        .poll(async () => {
          const now = await readBack();
          return now.pre === now.canvas;
        })
        .toBe(true);
      return readBack();
    };

    const light = await settled();
    expect(["transparent", "rgba(0, 0, 0, 0)"]).toContain(light.panel);
    // 编辑器宿主同样不许带底色：空串意味着这块还没滚进视口，没有宿主可读。
    if (light.editor !== "") {
      expect(["transparent", "rgba(0, 0, 0, 0)"]).toContain(light.editor);
    }

    await page.evaluate(() => window.__readora.setTheme("dark"));
    await expect(page.locator(ROOT)).toHaveAttribute("data-readora-theme", "dark");
    const dark = await settled();
    if (dark.editor !== "") {
      expect(["transparent", "rgba(0, 0, 0, 0)"]).toContain(dark.editor);
    }
    // 两套配色真的换了色，否则上面两条相等可能只是两套都读到了同一个默认值。
    expect(dark.canvas).not.toBe(light.canvas);
  });

  /**
   * 弹层的几何不跟阅读偏好即时抖（用户报：改 Line height 时窗口高度当场变）。
   *
   * 弹层里的控件尺寸是外壳的，不是正文的：它不该继承 body 上那个
   * `var(--readora-line-height)`（shell.css 里钉的 1.5）。实测钉之前在 1.4 / 2.4 两档
   * 下行高 19.6px / 33.6px、弹层 529.2px / 690px；钉住后两档等高，而正文行高仍在变
   * —— 后半句是前置条件，不然这条断言测的只是「偏好根本没生效」。
   */
  test("Reader Settings 弹层高度不随行高偏好即时变化", async ({ page }) => {
    await openReader(page);
    await page.getByRole("button", { name: "Reader settings" }).click();
    const dialog = page.locator(".readora-settings-dialog");
    await expect(dialog).toBeVisible();

    const measure = async (lineHeight: number): Promise<{ height: number; body: string }> => {
      await page.evaluate(
        (value) => window.__readora.setPreferences({ lineHeight: value }),
        lineHeight
      );
      await expect
        .poll(() => cssVariable(page, "--readora-line-height"))
        .toBe(String(lineHeight));
      // 等正文真的按新行高重排了再看弹层：变量写了但没重排，测到的是旧几何。
      const body = await page.evaluate(() => {
        const paragraph = document.querySelector(".readora-document p");
        return paragraph ? getComputedStyle(paragraph).lineHeight : "";
      });
      return { height: await dialog.evaluate((node) => node.getBoundingClientRect().height), body };
    };

    const loose = await measure(2.4);
    const tight = await measure(1.4);
    expect(loose.body).not.toBe(tight.body);
    expect(Math.abs(loose.height - tight.height)).toBeLessThan(1);
  });
});
