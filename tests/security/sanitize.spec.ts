/**
 * 文档自带 HTML 与危险 scheme 的浏览器内净化断言（ARC-002 §11 / IMP-001 §8.4，
 * IMP-003 §7.2 安全准入第 3、4 条）。
 *
 * 单测（`packages/markdown-core/src/__tests__/security.spec.ts`）在 jsdom 里比对
 * 字符串，能证明白名单算法本身；这里补两件事：
 * 1. **真的进了 DOM** 之后仍然没有可执行入口 —— 净化产物是直接写进正文容器的 HTML，
 *    中间任何一环改回去（少调一次 sanitize、换成未净化的那份），单测都看不出来；
 * 2. 净化 + CSP 是两层，不是替代关系（ARC-002 §11.5）：敌意文档渲染完必须
 *    一次 CSP 违规都不产生，这才叫两层都在工作。若净化漏了而 CSP 兜住，
 *    violation 计数会亮；若两层都漏，页面里会直接出现可执行节点。
 */
import { expect, test } from "@playwright/test";
import {
  expectReaderAlive,
  loadDocument,
  openProductionReader,
  pageErrors,
  violations
} from "../helpers/production-page";

/** 一页足够狠的样本：每种写法对应一类真实攻击面，各不自说自话。 */
const HOSTILE_DOC = [
  "# Hostile Document",
  "",
  "<script>window.__pwned_script = 1</script>",
  "",
  '<img src="x" onerror="window.__pwned_img = 1" />',
  "",
  '<iframe src="https://example.invalid/"></iframe>',
  "",
  '<a href="javascript:window.__pwned_js_url=1">click</a>',
  "",
  '<a href="data:text/html,<script>window.__pwned_data_url=1</script>">data</a>',
  "",
  '<div style="behavior:url(#default#time2);background:url(http://example.invalid/px)">inline style</div>',
  "",
  "<svg><animate attributeName=href values=javascript:window.__pwned_svg=1 /></svg>",
  "",
  "<style>body{display:none}</style>",
  "",
  "普通段落：这里的 [链接](https://example.com/) 与 **强调** 必须照常可用。",
  ""
].join("\n");

test.describe("文档自带 HTML 的净化", () => {
  test("敌意文档渲染后，页面里没有一个可执行入口活下来", async ({ page }) => {
    await openProductionReader(page);
    await loadDocument(page, HOSTILE_DOC);
    await expectReaderAlive(page);

    // 节点级：脚本、框架、SVG 都不该从文档里出来。
    // 范围收在 `.readora-document`：外壳与顶栏本来就带内联 SVG 图标（Icon.tsx），
    // 把它们算进来是噪音，不是漏洞；净化层的责任边界只有「正文」这一格。
    await expect(page.locator("script")).toHaveCount(1); // 只有模板那一条带 nonce 的入口
    expect(await page.locator("script").getAttribute("nonce")).toBeTruthy();
    const body = page.locator(".readora-document");
    await expect(body.locator("iframe, object, embed, svg, style")).toHaveCount(0);

    // 属性级：事件处理器与危险 scheme 一个都不留。
    const attributes = await body.evaluate((root) => {
      const names = [
        "onerror",
        "onload",
        "onclick",
        "onmouseover",
        "srcdoc",
        "formaction",
        "style"
      ];
      const hits: string[] = [];
      for (const name of names) {
        for (const node of root.querySelectorAll(`[${name}]`)) {
          hits.push(`${name}=${node.getAttribute(name)?.slice(0, 60)}`);
        }
      }
      return hits;
    });
    expect(attributes).toEqual([]);

    const hrefs = await body.evaluate((root) =>
      [...root.querySelectorAll("a[href]")].map((node) => node.getAttribute("href") ?? "")
    );
    expect(hrefs.filter((href) => /^(javascript|data|vbscript):/i.test(href))).toEqual([]);

    // 结果级：载荷没执行，而且不是靠「整页白屏」达成的 —— 正文与合法行内元素都在。
    const pwned = await page.evaluate(() =>
      Object.keys(window).filter((key) => key.startsWith("__pwned_"))
    );
    expect(pwned).toEqual([]);
    await expect(page.locator(".readora-document h1")).toHaveText("Hostile Document");
    await expect(page.getByRole("link", { name: "链接" })).toBeVisible();
    // 文档里那段 `body{display:none}` 要是漏进样式表，正文立刻不可见；
    // 上面两条可见性断言就是它的反证。
  });

  test("敌意内容不产生一次 CSP 违规，也不抛一个脚本异常", async ({ page }) => {
    await openProductionReader(page);
    await loadDocument(page, HOSTILE_DOC);

    // 净化层是主责：漏了才轮得到 CSP。两层同时在线时，这一条必须都是 0 ——
    // 有了它才不能说「反正 CSP 兜着」来为净化减配。
    expect(await violations(page)).toEqual([]);
    expect(await pageErrors(page)).toEqual([]);
  });

  test("敌意 HTML 以转义文本现身，不静默消失（用户看得见文档里写了什么）", async ({ page }) => {
    await openProductionReader(page);
    await loadDocument(page, HOSTILE_DOC);

    const body = await page.locator(".readora-document").innerText();
    // `allowHtml: false` 的口径是「当字面量渲染」，不是「删掉」：
    // 静默吞掉会让用户以为笔记软件在改他的稿子。
    expect(body).toContain("<script>");
    expect(body).toContain("onerror=");
    expect(body).toContain("javascript:window.__pwned_js_url=1");
  });

  test("frontmatter 与代码块里的同样的载荷也只是数据", async ({ page }) => {
    await openProductionReader(page);
    await loadDocument(
      page,
      [
        "---",
        'title: "<script>window.__pwned_fm = 1</script>"',
        "tags: [\"<img src=x onerror=window.__pwned_tag=1>\"]",
        "---",
        "",
        "# Fenced is data",
        "",
        "```html",
        "<script>window.__pwned_fence = 1</script>",
        "```",
        ""
      ].join("\n")
    );

    await expect(page.locator("script")).toHaveCount(1);
    const pwned = await page.evaluate(() =>
      Object.keys(window).filter((key) => key.startsWith("__pwned_"))
    );
    expect(pwned).toEqual([]);
    // Frontmatter 属性卡片把值当纯文本排版：卡片可见但载荷不可执行。
    await expect(page.locator(".readora-document")).toBeVisible();
    expect(await violations(page)).toEqual([]);
  });

  // M10 语义三件套是本轮新开的可达面：脚注写 id/href、块属性写 data-*、CSV 造表格。
  // 白名单一行没改，那就必须在浏览器里拿证据：产物里既没有 style 也没有事件属性。
  test("脚注 / 块属性 / CSV 的载荷只到 data-* 为止", async ({ page }) => {
    await openProductionReader(page);
    await loadDocument(
      page,
      [
        "# Semantics",
        "",
        "一条有定义的引用[^a]，和一条没定义的引用[^b]。",
        "",
        '[^a]: 定义里夹带 <script>window.__pwned_fn = 1</script> 与 <span style="color:red">样式</span>。',
        "",
        '段落尾巴做属性注入 {width=1px" onload="window.__pwned_attr = 1}',
        "",
        "```csv",
        "name,note",
        '"<script>window.__pwned_csv = 1</script>",ok',
        "```",
        ""
      ].join("\n")
    );
    await expectReaderAlive(page);

    const body = page.locator(".readora-document");
    // 脚注区照常产出：白名单内的 span / a / div / p / ol / li 与 id / class / href / aria-label 都活着。
    await expect(body.locator(".readora-footnote-item")).toHaveCount(1);
    const reference = body.locator("a.readora-footnote-ref");
    await expect(reference).toHaveCount(1);
    expect(await reference.getAttribute("href")).toBe("#readora-fn-1");
    expect(await reference.getAttribute("id")).toBe("readora-fnref-1");
    expect(await body.locator("li.readora-footnote-item").getAttribute("id")).toBe("readora-fn-1");

    // 属性级：注入尝试没变成真属性，而是以转义文本留着。
    const hostile = await body.evaluate((root) => {
      const hits: string[] = [];
      for (const name of ["style", "onload", "onerror", "onclick"]) {
        for (const node of root.querySelectorAll(`[${name}]`)) {
          hits.push(`${name}=${node.getAttribute(name)?.slice(0, 40)}`);
        }
      }
      return hits;
    });
    expect(hostile).toEqual([]);
    await expect(body.locator("script")).toHaveCount(0);

    const pwned = await page.evaluate(() =>
      Object.keys(window).filter((key) => key.startsWith("__pwned_"))
    );
    expect(pwned).toEqual([]);
    expect(await violations(page)).toEqual([]);

    // CSV 不成表就退回代码块，成了表也只有文本：载荷不会从单元格钻进属性。
    await expect(body.locator(".readora-table-cell")).toHaveCount(4);
    const text = await body.innerText();
    expect(text).toContain("<script>");
    expect(text).toContain("onload=");
    // 未命中的脚注引用不摆一个注定跳不到的锚点，而是原样显示 [^b]。
    expect(text).toContain("[^b]");
    await expect(body.locator("a.readora-footnote-ref")).toHaveCount(1);
  });
});
