/**
 * 语义三件套在真实浏览器里的形态（M10：脚注 / 块属性 / CSV 围栏）。
 *
 * 单测能证 token 流、AST 判定与产物字符串，证不到三件事：
 * 1. 脚注的 `href` 能不能真把目标滚进视口（跳转走的是既有锚点委托，本轮 0 行新代码）；
 * 2. `{width=…}` 经接管层落到 `img.style` 之后，浏览器认不认这条声明；
 * 3. `{code_block=true}` 的图在真 mermaid 出图之后源码是否仍然可见（CSS 权重之争）。
 * 这一组只断言这些只有真实布局与真实引擎能回答的事（IMP-003 §7.1）。
 *
 * 文档串一律自带：不新增 fixture 文件、不动 `dev/visual.tsx`，
 * 所以 `visual:check` 的十档基线不必重采。
 */
import { expect, test, type Page } from "@playwright/test";
import { longDoc, openReader } from "../helpers/reader";

/** 1200×60 的 SVG：宽到必须被收缩，`width=…` 的效果才量得出来。 */
const WIDE_SVG =
  "data:image/svg+xml;base64," +
  Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="60"><rect width="1200" height="60" fill="#2563eb"/></svg>'
  ).toString("base64");

const RESOLVE_WIDE = {
  resourceScript: {
    mode: "ok" as const,
    result: { webviewUri: WIDE_SVG, mimeType: "image/svg+xml", kind: "image" as const }
  }
};

/** 目标元素是否真的进了视口：跳转类断言只看这个，不看「点了没报错」。 */
function inViewport(page: Page, selector: string): Promise<boolean> {
  return page.evaluate((css) => {
    const node = document.querySelector(css);
    if (!node) {
      return false;
    }
    const rect = node.getBoundingClientRect();
    return rect.top >= -1 && rect.top <= window.innerHeight;
  }, selector);
}

test.describe("脚注", () => {
  // 正文足够长才谈得上「滚过去」：短文档上滚动会被浏览器夹回 0，用例就假绿了。
  const FOOTNOTE_DOC = [
    longDoc(3),
    "这里有一条引用[^1]，那里有一条引用[^long]。",
    "",
    "[^1]: 第一条说明。",
    "",
    "[^long]: 第二条说明，带**强调**。",
    ""
  ].join("\n");

  test("引用、条目与双向锚点在 DOM 里齐备", async ({ page }) => {
    await openReader(page, { text: FOOTNOTE_DOC });

    const refs = page.locator("a.readora-footnote-ref");
    await expect(refs).toHaveCount(2);
    const items = page.locator(".readora-footnote-item");
    await expect(items).toHaveCount(2);

    expect(await refs.first().getAttribute("href")).toBe("#readora-fn-1");
    expect(await refs.first().getAttribute("id")).toBe("readora-fnref-1");
    expect(await items.nth(0).getAttribute("id")).toBe("readora-fn-1");
    expect(await items.nth(1).getAttribute("id")).toBe("readora-fn-2");
    await expect(page.locator(".readora-footnotes-title")).toHaveText("脚注");
    // 标记文本是 `[1]`，上标观感由 CSS 承担：产物里没有 <sup>（白名单没扩）。
    await expect(refs.first().locator(".readora-footnote-marker")).toHaveText("[1]");
    await expect(page.locator("sup")).toHaveCount(0);
    // 强调在脚注正文里照常生效：脚注区不是纯文本转储。
    expect(await items.nth(1).locator("strong").textContent()).toBe("强调");
  });

  test("点引用滚到条目、点回跳滚回正文：两端都真进了视口", async ({ page }) => {
    await openReader(page, { text: FOOTNOTE_DOC });

    await page.locator("a.readora-footnote-ref").first().click();
    await expect
      .poll(() => inViewport(page, "#readora-fn-1"), { timeout: 5_000 })
      .toBe(true);

    await page.locator(".readora-footnote-item").first().locator("a.readora-footnote-backref").click();
    await expect
      .poll(() => inViewport(page, "#readora-fnref-1"), { timeout: 5_000 })
      .toBe(true);
  });

  test("编号按首次引用顺序，不是定义书写顺序；未被引用的定义排在最后", async ({ page }) => {
    await openReader(
      page,
      {
        text: [
          "# 顺序",
          "",
          "先引 [^b]，再引 [^a]，[^c] 这条没有定义。",
          "",
          "[^a]: A 的定义。",
          "",
          "[^b]: B 的定义。",
          "",
          "[^d]: 写了但没人引用。",
          ""
        ].join("\n")
      }
    );

    const items = page.locator(".readora-footnote-item");
    await expect(items).toHaveCount(3);
    await expect(items.nth(0)).toContainText("B 的定义");
    await expect(items.nth(1)).toContainText("A 的定义");
    // 未被引用的定义仍进脚注区，编号排在已引用条目之后（GFM 口径）。
    await expect(items.nth(2)).toContainText("写了但没人引用");
    expect(await items.nth(2).getAttribute("id")).toBe("readora-fn-3");

    // 没有定义的引用不摆跳转：原样显示 [^c]，页面上没有第三个锚点。
    await expect(page.locator("a.readora-footnote-ref")).toHaveCount(2);
    await expect(page.locator(".readora-document")).toContainText("[^c]");
  });

  test("脚注标题不是标题：目录与大纲里不多出一条「脚注」", async ({ page }) => {
    await openReader(page, { text: "# 唯一标题\n\n文字[^a]。\n\n[^a]: 定义。\n" });

    await expect(page.locator(".readora-document h1, .readora-document h2")).toHaveCount(1);
    expect(await page.locator(".readora-document .readora-footnotes-title").evaluate((node) => node.tagName)).toBe(
      "P"
    );
    // 目录条目来自 outline（标题节点），脚注区不在里面。
    await expect(page.locator(".readora-outline-item")).toHaveCount(1);
  });
});

test.describe("块属性与 CSV 围栏", () => {
  test("CSV 围栏画成真表格：thead/tbody、scope 与滚动容器齐备", async ({ page }) => {
    await openReader(
      page,
      {
        text: [
          "# CSV",
          "",
          "```csv",
          "name,qty,note",
          "苹果,3,\"带逗号,与引号\"",
          "香蕉,7,\"说法\"",
          "```",
          ""
        ].join("\n")
      }
    );

    const table = page.locator(".readora-table");
    await expect(table).toHaveCount(1);
    await expect(table.locator("thead th")).toHaveCount(3);
    await expect(table.locator("tbody td")).toHaveCount(6);
    expect(await table.locator("thead th").first().getAttribute("scope")).toBe("col");
    await expect(page.locator(".readora-table-scroll")).toBeVisible();
    // 引号包住的是内容而不是分隔符：那一格必须整块成立
    expect(await table.locator("tbody td").nth(2).innerText()).toBe("带逗号,与引号");
    // 成了表就不留代码块外壳
    await expect(page.locator(".readora-code-block")).toHaveCount(0);
  });

  test("`header=false` 整表都是 td；不成表的数据退回代码块并原样可读", async ({ page }) => {
    await openReader(
      page,
      {
        text: [
          "# 反例",
          "",
          "```csv {header=false}",
          "a,b",
          "1,2",
          "```",
          "",
          "```csv",
          "a,b",
          "只有三个字段的一行,再加,一个",
          "```",
          ""
        ].join("\n")
      }
    );

    await expect(page.locator(".readora-table thead")).toHaveCount(0);
    await expect(page.locator(".readora-table tbody td")).toHaveCount(4);
    // 行列不规则 ⇒ 一个字都不改地留作代码块：残缺数据摆成整表比不摆更糟
    await expect(page.locator(".readora-code-block")).toHaveCount(1);
    await expect(page.locator(".readora-document")).toContainText("只有三个字段的一行,再加,一个");
  });

  test("尺寸属性经接管层落到 img.style，浏览器按声明排版", async ({ page }) => {
    await openReader(
      page,
      {
        text: [
          "# 尺寸",
          "",
          "![固定宽](./assets/wide.png){width=320px}",
          "",
          "![半栏宽](./assets/wide.png){width=50%}",
          ""
        ].join("\n")
      },
      RESOLVE_WIDE
    );

    const figures = page.locator("[data-readora-image]");
    await expect(figures.nth(0)).toHaveAttribute("data-readora-image-state", "ready");

    const fixed = figures.nth(0).locator("img");
    // 声明与生效一起看：只有 style 里没有真宽度，是本层写了个不被认的值。
    expect(await fixed.evaluate((node) => (node as HTMLImageElement).style.width)).toBe("320px");
    expect(Math.round(await fixed.evaluate((node) => node.getBoundingClientRect().width))).toBe(320);
    expect(await figures.nth(0).getAttribute("data-readora-width")).toBe("320px");

    const percent = figures.nth(1).locator("img");
    expect(await percent.evaluate((node) => (node as HTMLImageElement).style.maxWidth)).toBe("50%");
    // 百分比是「相对栏宽的一半」，不是相对图片自己：量给邻近段落宽度看
    const ratio = await percent.evaluate((node) => {
      const column = node.closest("p")?.getBoundingClientRect().width ?? 0;
      return column > 0 ? node.getBoundingClientRect().width / column : 0;
    });
    expect(ratio).toBeGreaterThan(0.44);
    expect(ratio).toBeLessThan(0.56);
  });

  test("非法尺寸与未实现的形态整串留在正文：不给一半生效，也不给假 affordance", async ({ page }) => {
    await openReader(
      page,
      {
        text: [
          "# 拒收",
          "",
          "尾巴上是一个不认的键 {json=1}",
          "",
          "尾巴上是一个非法尺寸 {width=50vw}",
          "",
          "![图](./assets/wide.png){width=50vw}",
          ""
        ].join("\n")
      }
    );

    // 拒收的代价由用户承担还是由作者承担：花括号留在纸上，作者一眼看见自己写错了；
    // 吃掉它而什么都不做，就只能靠猜。
    const body = page.locator(".readora-document");
    await expect(body).toContainText("{json=1}");
    await expect(body).toContainText("{width=50vw}");
    await expect(page.locator("[data-readora-width]")).toHaveCount(0);
    await expect(page.locator("[data-align]")).toHaveCount(0);
  });

  test("围栏属性落到代码块与图表：filename 徽章、code_block 的初始展开态", async ({ page }) => {
    await openReader(
      page,
      {
        text: [
          "# 围栏",
          "",
          '```js {filename="app.js"}',
          "const answer = 42;",
          "```",
          "",
          "```mermaid {code_block=true filename=\"flow.mmd\"}",
          "graph TD",
          "  A[Start] --> B{Done?}",
          "```",
          ""
        ].join("\n")
      }
    );

    await expect(page.locator(".readora-code-filename")).toHaveText("app.js");
    await expect(page.locator(".readora-code-filename")).toHaveAttribute("title", "app.js");

    const block = page.locator(".readora-diagram");
    // 真引擎出图要动态载 mermaid：以状态位为准给足时间
    await expect(block).toHaveAttribute("data-readora-diagram-state", "rendered", { timeout: 30_000 });
    await expect(block).toHaveClass(/readora-diagram--source-open/);
    // 可见性是关键：接管后源码默认 display:none，属性要真把它掀回来
    await expect(block.locator("pre.readora-diagram-source")).toBeVisible();
    await expect(block.locator(".readora-diagram-filename")).toHaveText("flow.mmd");
    await expect(block.locator(".readora-diagram-container svg")).toBeVisible();
  });

  // 本轮顺带修掉的存量缺陷：接管后源码被 `[data-readora-diagram-state=…]` 以 0-3-0
  // 收起，而展开态那条只有 0-2-0 —— 单测验 class 全绿，浏览器里按钮按下去什么都没发生。
  // jsdom 没有布局，这条只能在这里钉；写坏图的源码走真实引擎的失败路径，不假造状态。
  test("出错卡的「展开源码」在真实浏览器里真把源码摊开（CSS 权重回归防线）", async ({ page }) => {
    await openReader(
      page,
      { text: ["# 坏图", "", "```mermaid", "graph TD", "  A[ -->", "```", ""].join("\n") }
    );

    const block = page.locator(".readora-diagram");
    await expect(block).toHaveAttribute("data-readora-diagram-state", "failed", { timeout: 30_000 });
    const source = block.locator("pre.readora-diagram-source");
    await expect(source).toBeHidden();

    const toggle = block.locator('.readora-diagram-error [data-readora-diagram-action="toggle-source"]');
    await toggle.click();
    await expect(source).toBeVisible();
    await expect(toggle).toHaveText("收起源码");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");

    await toggle.click();
    await expect(source).toBeHidden();
    await expect(toggle).toHaveText("展开源码");
  });

  test("块级 align 落到 data-align 并由 CSS 生效（不是内联 style）", async ({ page }) => {
    await openReader(
      page,
      {
        text: ["# 对齐", "", "居中段落 {align=center}", "", "```js {align=right}", "x", "```", ""].join("\n")
      }
    );

    const paragraph = page.locator(".readora-paragraph");
    expect(await paragraph.getAttribute("data-align")).toBe("center");
    expect(await paragraph.evaluate((node) => getComputedStyle(node).textAlign)).toBe("center");
    // 渲染层不写 style：Sanitizer 把 style 限域在公式子树内，写了也是被剥掉。
    // 只量块属性输出过 data-align 的元素：CodeMirror 接管后的代码块自己带 style，
    // 那不是「渲染器写了内联样式」，拿它当反证会测到一个不属于本批的作者。
    const styled = await page
      .locator(".readora-document [data-align]")
      .evaluateAll((nodes) => nodes.filter((node) => node.hasAttribute("style")).length);
    expect(styled).toBe(0);
  });
});
