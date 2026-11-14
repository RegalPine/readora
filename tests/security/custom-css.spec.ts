/**
 * 不可信自定义 CSS 的注入拦截（F08-011，IMP-003 §7.2 安全准入第 3 条）。
 *
 * 这条链路上有**两道**独立的防线，得分开测，否则一道挡住了会让人误以为够了：
 * 1. Host 的 `sanitizeCustomCss()`（AST 重生成 + 任一违规整段拒绝）—— 规则本体由
 *    `packages/design-tokens/src/__tests__/custom-css.spec.ts` 与
 *    `apps/extension/src/__tests__/custom-css-injection.spec.ts` 锁；
 * 2. 模板的 `sanitizeInjectedCss()` —— 万一调用方忘了净化，`<style>` 里也不能出现
 *    能提前收尾的字节。
 *
 * 本文件测的是这两道防线**在真浏览器里留下的痕迹**：产物 HTML 字符串里有没有那段
 * 样式，以及浏览器解析完之后页面上到底多出了几个可执行入口。只有第二问才排掉
 * 「字符串看着干净、解析器却另有解释」这类分歧。
 */
import { expect, test } from "@playwright/test";
import { DEFAULT_CUSTOM_CSS_MAX_CHARS } from "../../packages/design-tokens/src/custom-css.ts";
import {
  ASSET_PREFIX,
  expectReaderAlive,
  hostSanitizedCss,
  loadDocument,
  openProductionReader,
  pageErrors,
  productionHtml,
  violations
} from "../helpers/production-page";

/**
 * 六类不可信写法 + 三种越权选择器。每条带一个只在它自己里出现的标记串，
 * 断言「整段不落进 HTML」时按标记查，不会被别的用例的相似文本蒙对。
 */
const HOSTILE: [string, string][] = [
  ["@import 拉外部样式表", '@import url("https://evil.example/__css_import__.css");'],
  ["expression() 表达式求值", ".readora-document { width: expression(__css_expr__) }"],
  [
    "</style> 提前收尾塞脚本",
    ".readora-document{color:red}</style><script>window.__css_pwn__=1</script>"
  ],
  ["HTML 注释里藏结构", "<!-- */ .readora-document{color:__css_comment__} -->"],
  [
    "反斜杠 + 换行拆标签",
    // CSS 允许 `\` 续行，`</sty\` + `le>` 在某些解析路径下会被拼回一个结束标签。
    ".readora-document{color:red}\\</sty\\\nle><script>window.__css_slash__=1</script>"
  ],
  ["越权选择器 :root", ":root { --readora-color-background: __css_root__ }"],
  ["越权选择器 body", "body { display: none; content: '__css_body__' }"],
  ["越权选择器 *（全局覆盖）", "* { visibility: hidden; voice-family: '__css_star__' }"],
  ["behavior（IE 的 CSS 执行入口）", ".readora-document { behavior: url(#__css_behavior__) }"],
  ["javascript: scheme", ".readora-document { background: url(javascript:__css_js__) }"]
];

test.describe("不可信自定义 CSS", () => {
  test("Host 逐条整段拒绝，一个字节都不进产物 HTML", async () => {
    for (const [label, css] of HOSTILE) {
      const result = await hostSanitizedCss(css);
      expect(result.ok, label).toBe(false);
      if (result.ok) {
        continue;
      }
      // 「整段拒绝」的含义是**不做部分采纳**：那条文档里合法的 `.readora-document`
      // 也必须一起消失，否则就成了「过滤」而不是「拒绝」。
      expect(result.reason.length, label).toBeGreaterThan(0);
      const html = await productionHtml({ customCss: result.ok ? result.css : "" });
      expect(html, label).not.toContain("data-readora-custom-css");
    }
    // 标记串逐条回查：宿主写进设置里的原文没有以任何形态出现在 HTML 里。
    const html = await productionHtml({ customCss: "" });
    for (const [label, css] of HOSTILE) {
      const marker = css.match(/__css_[a-z]+__/)?.[0];
      expect(marker, label).toBeTruthy();
      expect(html).not.toContain(marker ?? "");
    }
  });

  test("超长输入按上限拒绝，不截断后放行", async () => {
    // 用重复的合法声明把长度顶过上限：截断会留下一条**完整且合法**的规则，
    // 那等于告诉用户「写了就生效一部分」，与「整段拒绝」的口径不符。
    const unit = ".readora-document{letter-spacing:3px}";
    const css = unit.repeat(Math.ceil(DEFAULT_CUSTOM_CSS_MAX_CHARS / unit.length) + 1);
    const result = await hostSanitizedCss(css);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.reason).toContain(String(DEFAULT_CUSTOM_CSS_MAX_CHARS));
    const html = await productionHtml({ customCss: "" });
    expect(html).not.toContain("letter-spacing");
  });

  test("跳过 Host 直投模板时，breakout 形态也没能多出可执行入口", async ({ page }) => {
    // 这一条刻意**不**走 `sanitizeCustomCss`：它测的是第二道防线，也就是
    // 「调用方忘了净化」时模板还拦不拦得住。三种形态各开一次页面。
    const breakouts = [
      "</style><script>window.__css_pwn__=1</script><style>",
      '</style ><img src=x onerror="window.__css_pwn__=1">',
      "\\</style><script>window.__css_pwn__=1</script>"
    ];
    for (const raw of breakouts) {
      // 先看字符串：样式块整个不出现，载荷里的标记串一个字节都没漏。
      const html = await productionHtml({ rawCustomCss: raw });
      expect(html).not.toContain("data-readora-custom-css");
      expect(html).not.toContain("__css_pwn__");

      await openProductionReader(page, { rawCustomCss: raw });
      await loadDocument(page, "# CSS Guard\n\nStill rendered.\n");

      // 页面里只有一个脚本，就是模板那条带 nonce 的 `<script src>`。
      const scripts = await page.evaluate(() =>
        [...document.querySelectorAll("script")].map((node) => ({
          src: node.getAttribute("src") ?? "",
          body: node.textContent ?? ""
        }))
      );
      expect(scripts).toHaveLength(1);
      expect(scripts[0].src).toBe(`${ASSET_PREFIX}main.js`);
      expect(scripts[0].body).toBe("");
      // 被拦下的 inline 脚本会留下一条违规；漏网执行则会留下全局变量。
      // 两种都要为零：前者证明策略生效，后者证明结构没被提前收尾。
      expect(await violations(page)).toEqual([]);
      expect(
        await page.evaluate(
          () => (window as unknown as { __css_pwn__?: number }).__css_pwn__
        )
      ).toBeUndefined();
      expect(await page.title()).toBe("Readora");
      await expect(page.locator(".readora-document h1")).toHaveText("CSS Guard");
      expect(await pageErrors(page)).toEqual([]);
    }
  });

  test("合法自定义 CSS 照常生效：护栏不是一律清空", async ({ page }) => {
    const css = ".readora-document { letter-spacing: 3px }";
    const result = await hostSanitizedCss(css);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    // 净化产物是 AST 重生成的紧凑文本，进模板后应原样出现在 `<style>` 里。
    const html = await productionHtml({ customCss: result.css });
    expect(html).toContain('<style data-readora-custom-css>');
    expect(html).toContain("letter-spacing:3px");

    await openProductionReader(page, { customCss: result.css });
    await loadDocument(page, "# Styled\n\nA legal rule must still apply.\n");
    await expectReaderAlive(page);
    // 只断言这一条声明真的算到了元素上 —— 位置在 main.css 之后（首帧生效）。
    await expect
      .poll(() =>
        page.evaluate(
          () => getComputedStyle(document.querySelector(".readora-document")!).letterSpacing
        )
      )
      .toBe("3px");
    expect(await violations(page)).toEqual([]);
    expect(await pageErrors(page)).toEqual([]);
  });
});
