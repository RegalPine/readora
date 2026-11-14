/**
 * 代码编辑器接管层在浏览器里的真实形态（ARC-002 §8 的编辑器化改造，M8）。
 *
 * 单测（`code-editor-layer.spec.ts`）把编辑器整个换成了替身，因此它证不了五类事实：
 * 1. **行号是真的**：CodeMirror 的 gutter 要有真实布局才数得出行，jsdom 里量不到；
 * 2. **只读是真的**：`editable: false` 在浏览器里表现为打字改不动正文，替身没这个语义；
 * 3. **底色==画布**：编辑器外壳必须 transparent，透出来的才是正文那张纸 ——
 *    用户对代码块定下的硬口径（0.7.0），换组件不能把它带回来；
 * 4. **搜索命中会回显静态视图**：`:has(.readora-code-pre .readora-search-hit)` 那条
 *    CSS 只在真实层叠里生效，jsdom 不算 CSS；
 * 5. **配色跟随主题**：色值全是 var()，换 `html[data-readora-theme]` 就重新取色，
 *    编辑器实例不必重建。
 *
 * 挂载一律由滚动触发：接管层是懒挂载的（400px 视口余量），不等它就数不到 `.cm-editor`。
 */
import { expect, test, type Page } from "@playwright/test";
import { openReader } from "../helpers/reader";

/**
 * 四行 typescript + 一行纯文本 + 一个未知语言块：
 * 行号、无语法降级、未知语言三件事各有独立样本，不用一块覆盖两条。
 *
 * `zebra` 在全篇只出现一次（在代码里）：搜索用例拿它当查询词，
 * 计数就同时证明了「宿主子树不进搜索范围」—— 数成两遍即编辑器里的副本被算进去了。
 */
const CODE_DOC = [
  "# Code Editor",
  "",
  "Intro paragraph sits above the block so the editor has to be scrolled into view.",
  "",
  "```typescript",
  "export function pick(items: string[]): number {",
  "  const index = items.indexOf('zebra');",
  "  return index;",
  "}",
  "```",
  "",
  "```text",
  "散文式纯文本",
  "```",
  "",
  "```brainfuck",
  "++++[---->++++++++]",
  "```",
  ""
].join("\n");

const BLOCK = ".readora-code-block";
const HOST = ".readora-code-editor";
const TRANSPARENT = ["transparent", "rgba(0, 0, 0, 0)"];

/** 把首个代码块滚进视口，等接管层把它挂成编辑器。 */
async function mountFirstBlock(page: Page): Promise<void> {
  await page.locator(BLOCK).first().scrollIntoViewIfNeeded();
  await expect
    .poll(() =>
      // 选择器写实字符串：`page.evaluate` 拿不到外层作变量。
      page.evaluate(
        () =>
          document
            .querySelector(".readora-code-block")
            ?.getAttribute("data-readora-code-editor-state") ?? ""
      )
    )
    .toBe("mounted");
}

interface Surface {
  host: string;
  editor: string;
  content: string;
  gutter: string;
  canvas: string;
  preDisplay: string;
  hostDisplay: string;
}

/** 编辑器各层的实测底色，以及两个视图各自的显隐。 */
async function readSurface(page: Page): Promise<Surface> {
  return page.evaluate(() => {
    const host = document.querySelector<HTMLElement>(".readora-code-block .readora-code-editor");
    const editor = document.querySelector<HTMLElement>(".readora-code-block .cm-editor");
    const content = document.querySelector<HTMLElement>(".readora-code-block .cm-content");
    const gutter = document.querySelector<HTMLElement>(".readora-code-block .cm-gutters");
    const pre = document.querySelector<HTMLElement>(".readora-code-block .readora-code-pre");
    if (!host || !editor || !content || !gutter || !pre) {
      throw new Error("fixture: 代码编辑器没挂上");
    }
    return {
      host: getComputedStyle(host).backgroundColor,
      editor: getComputedStyle(editor).backgroundColor,
      content: getComputedStyle(content).backgroundColor,
      gutter: getComputedStyle(gutter).backgroundColor,
      canvas: getComputedStyle(document.body).backgroundColor,
      preDisplay: getComputedStyle(pre).display,
      hostDisplay: getComputedStyle(host).display
    };
  });
}

/** 第一个代码块里某个语法 token 的实测前景色。 */
function tokenColor(page: Page): Promise<string> {
  return page.evaluate(() => {
    const span = document.querySelector<HTMLElement>(".readora-code-block .cm-content span");
    return span ? getComputedStyle(span).color : "";
  });
}

test.describe("代码编辑器接管", () => {
  test("进入视口挂成编辑器：行号与静态视图行数一致", async ({ page }) => {
    await openReader(page, { text: CODE_DOC });
    await mountFirstBlock(page);

    const rows = await page.evaluate(() => {
      const block = document.querySelector(".readora-code-block");
      const source = block?.querySelector(".readora-code-pre code")?.textContent ?? "";
      // CM 会在行号列末尾多追一枚隐藏占位（写的是 maxLineNumber，四行代码就是「9」），
      // 它只用来撑列宽，不是行号：不剔除就会数出一行不存在的编号。
      const visible = [...(block?.querySelectorAll(".cm-lineNumbers .cm-gutterElement") ?? [])].filter(
        (node) => (node as HTMLElement).style.visibility !== "hidden"
      );
      return {
        // 静态视图按 CSS 口径数行：围栏尾部那个换行不成一行的。
        staticLines: source.replace(/\n$/, "").split("\n").length,
        gutter: visible.length,
        lines: block?.querySelectorAll(".cm-content .cm-line").length ?? 0,
        // 隐藏占位确实在场，而且它写的是 9：不剃它的话上一条断言会变成假绿灯。
        spacer: (block?.querySelectorAll(".cm-lineNumbers .cm-gutterElement").length ?? 0) - visible.length
      };
    });
    expect(rows.staticLines).toBe(4);
    expect(rows.gutter).toBe(rows.staticLines);
    expect(rows.lines).toBe(rows.staticLines);
    expect(rows.spacer).toBe(1);

    // 静态 pre 留在 DOM 里（只是被 CSS 收起）：它是文档内搜索唯一的可搜文本源。
    await expect(page.locator(`${BLOCK} .readora-code-pre`).first()).toBeAttached();
  });

  test("只读：打字改不动正文，鼠标仍然能选中", async ({ page }) => {
    await openReader(page, { text: CODE_DOC });
    await mountFirstBlock(page);

    const content = page.locator(`${BLOCK} .cm-content`).first();
    const text = () => content.evaluate((node) => node.textContent ?? "");
    const before = await text();

    await content.click();
    await page.keyboard.type("OOPS");
    expect(await text()).toBe(before);
    // 只读的落点：contenteditable 关掉，所以键盘与 IME 都进不去正文。
    expect(await content.evaluate((node) => (node as HTMLElement).isContentEditable)).toBe(false);

    // 但鼠标选择必须还在：读者选中文本的第一动作是复制，不是编辑。
    expect(
      await content.evaluate((node) => {
        const range = document.createRange();
        range.selectNodeContents(node);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        return (selection?.toString() ?? "").length;
      })
    ).toBeGreaterThan(0);
  });

  test("编辑器底色就是它躺在上面的那张纸，明暗两套都不例外", async ({ page }) => {
    await openReader(page, { text: CODE_DOC });
    await mountFirstBlock(page);

    const light = await readSurface(page);
    // 外壳、.cm-editor、.cm-content、.cm-gutters 四层都不许铺面：透出来的必须是画布。
    for (const value of [light.host, light.editor, light.content, light.gutter]) {
      expect(TRANSPARENT).toContain(value);
    }
    // 挂载态下静态视图收起、编辑器是主视图（命中回显见下面那条搜索用例）。
    expect(light.preDisplay).toBe("none");
    expect(light.hostDisplay).not.toBe("none");

    const lightColor = await tokenColor(page);
    await page.evaluate(() => window.__readora.setTheme("dark"));
    await expect(page.locator("html")).toHaveAttribute("data-readora-theme", "dark");
    // body 上挂着 background-color 过渡（base.css），换色途中读到的是插值：
    // 等画布真的离开 light 那一档再取（theme.spec 那条底色门禁踩过的同一个坑）。
    await expect.poll(async () => (await readSurface(page)).canvas !== light.canvas).toBe(true);

    const dark = await readSurface(page);
    for (const value of [dark.host, dark.editor, dark.content, dark.gutter]) {
      expect(TRANSPARENT).toContain(value);
    }
    // 画布与语法色都真的换了色：否则上面那些相等可能只是两套都读到同一个默认值。
    expect(dark.canvas).not.toBe(light.canvas);
    expect(lightColor).not.toBe("");
    expect(await tokenColor(page)).not.toBe(lightColor);
  });

  test("搜索命中落进代码块时回显静态视图，清掉查询再换回编辑器", async ({ page }) => {
    await openReader(page, { text: CODE_DOC });
    await mountFirstBlock(page);

    await page.keyboard.press("Control+f");
    await page.locator(".readora-search-input").fill("zebra");
    const hits = page.locator(".readora-document mark[data-readora-search-id]");
    await expect(hits).toHaveCount(1);

    // 命中的那块：静态 pre 显形（命中点看得见），编辑器暂时收起。
    const during = await readSurface(page);
    expect(during.preDisplay).not.toBe("none");
    expect(during.hostDisplay).toBe("none");
    // 高亮节点确实在 pre 里，不在编辑器子树里。
    await expect(page.locator(".readora-code-pre mark")).toHaveCount(1);

    // 计数只算 pre 里那一份源码：编辑器里的同内容若被计入，这里就是 2 了。
    await expect(page.locator(".readora-search-count")).toHaveText("1 / 1");

    await page.locator(".readora-search-input").fill("");
    await expect(hits).toHaveCount(0);
    const after = await readSurface(page);
    expect(after.preDisplay).toBe("none");
    expect(after.hostDisplay).not.toBe("none");
  });

  test("没有语法也照样挂成编辑器：纯文本与未知语言都有行号，只是不着色", async ({ page }) => {
    await openReader(page, { text: CODE_DOC });

    const blocks = page.locator(BLOCK);
    await expect(blocks).toHaveCount(3);
    const states: Array<{ lines: number; spans: number }> = [];
    for (let index = 0; index < 3; index += 1) {
      const block = blocks.nth(index);
      await block.scrollIntoViewIfNeeded();
      await expect
        .poll(() => block.getAttribute("data-readora-code-editor-state"))
        .toBe("mounted");
      states.push({
        lines: await block.locator(".cm-content .cm-line").count(),
        spans: await block.locator(".cm-content span").count()
      });
    }

    // 三块全起了编辑器、都有行号：不能出现「有些块有行号、有些没有」的分裂。
    expect(states.map((entry) => entry.lines)).toEqual([4, 1, 1]);
    // text 与 brainfuck 没有语法：零着色 span；typescript 那块必须有。
    expect(states[0]?.spans).toBeGreaterThan(0);
    expect(states[1]?.spans).toBe(0);
    expect(states[2]?.spans).toBe(0);
  });

  test("切主题不重建编辑器实例，正文重写才销毁", async ({ page }) => {
    await openReader(page, { text: CODE_DOC });
    await mountFirstBlock(page);

    // 探针钉在编辑器宿主上：接管层或 React 重建这棵子树，它是第一个消失的东西。
    await page.evaluate(() => {
      const host = document.querySelector(".readora-code-block .readora-code-editor");
      if (!host) {
        throw new Error("fixture: 编辑器宿主不在");
      }
      host.setAttribute("data-readora-e2e-probe", "keep");
    });

    await page.evaluate(() => window.__readora.setTheme("dark"));
    await expect(page.locator(HOST).first()).toHaveAttribute("data-readora-e2e-probe", "keep");

    // 换一篇文档（正文 innerHTML 重写）：旧实例必须随宿主一起消失，不留悬挂编辑器。
    await page.evaluate(() =>
      window.__readora.load({
        documentUri: "file:///vault/e2e/other.md",
        version: 2,
        text: "# Other\n\n```ts\nconst a = 1;\n```\n"
      })
    );
    // 拿探针而不只拿宿主数：新文档自己也会有一个宿主（pending 态就插入），
    // 数不等于 0 才证明「旧实例真的随 DOM 一起销毁了」。
    await expect
      .poll(() =>
        page.evaluate(() => document.querySelectorAll("[data-readora-e2e-probe]").length)
      )
      .toBe(0);

    await page.locator(BLOCK).first().scrollIntoViewIfNeeded();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            document
              .querySelector(".readora-code-block")
              ?.getAttribute("data-readora-code-editor-state") ?? ""
        )
      )
      .toBe("mounted");
    // 新文档只有一块代码：宿主数回到 1，而不是旧的三件加起来。
    await expect(page.locator(HOST)).toHaveCount(1);
  });
});
