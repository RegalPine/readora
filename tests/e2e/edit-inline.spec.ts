/**
 * 行内格式化（ARC-009 §6.3 / F12-003 / TASK-13-03-05，E3）。
 *
 * 本篇只负责 jsdom 给不了的那四件事：
 * 1. **真选区**：`window.getSelection()` + `Range` 端点换算成源下标。单测里选区是从
 *    `EditLayerOptions.selection` 注进去的（§16.6 记了为什么不赌 jsdom 的实现），
 *    于是「真实读取那一段」只有在这里才算被跑过；
 * 2. **真像素**：工具条是不是浮在被选中那个词的上方。`placeToolbar` 在 jsdom 里
 *    只拿得到全零矩形，边界逻辑能断言、落点不能；
 * 3. **真 contenteditable**：标记是 `Range#insertNode` 写进文本节点的，相邻文本节点
 *    怎么合、焦点转移到工具条按钮上选区丢不丢，都在 Chromium 的账上；
 * 4. **真键盘**：`E` 键走容器委托 + idle 护栏，与单元自己的监听抢同一个 keydown。
 *
 * 断言权威仍是 `window.__readora.model()`（宿主那份文件）而不是屏上文本（§15-3）：
 * 屏上的 DOM 是渲染产物，拿它当文件内容等于用结论证明前提。逐条都用
 * {@link expectSource} 收口 —— 它同时断言**行数不变**与**没编辑的行逐字节不变**。
 */
import { expect, test, type Page } from "@playwright/test";
import { openReader, viewMessages } from "../helpers/reader";
import {
  EDIT_FOOTNOTE_NOTE,
  EDIT_INSIDE_CODE_NOTE,
  EDIT_MULTILINE_WRAP_NOTE
} from "../../apps/webview/src/content/edit/limits";

/**
 * 一份把「六个动作 + 级别 + 降级」都要的夹具装进去的文档（行号是用例的一部分）：
 * 带 `**` 的段落、`>` 空行的多行引用、无序与有序列表、`##` 标题、行内代码段、
 * 已有 `[^1]` 的脚注（引用与定义各一处，`nextFootnoteLabel` 才会给出 2）。
 */
const DOC = [
  "# Inline Guide", // 0
  "", // 1
  "Alpha paragraph one.", // 2
  "", // 3
  "## Section two", // 4
  "", // 5
  "Beta paragraph two.", // 6
  "", // 7
  "> quote line one.", // 8
  ">", // 9
  "> quote line two.", // 10
  "", // 11
  "- first item", // 12
  "- second item", // 13
  "", // 14
  "1. one item", // 15
  "2. two item", // 16
  "", // 17
  "Gamma with **bold** marker.", // 18
  "", // 19
  "Use `code span` carefully.", // 20
  "", // 21
  "Delta cites[^1] a footnote.", // 22
  "", // 23
  "[^1]: The cited definition." // 24
].join("\n");

interface Model {
  documentUri: string;
  text: string;
  version: number;
}

function model(page: Page): Promise<Model> {
  return page.evaluate(() => window.__readora.model());
}

/**
 * 逐字节判据：`edits` 里那些行换成新串，**其余每一行连行数都还是原样**。
 *
 * 一条 `toEqual` 顶三件事：改到的行确实改了、没改的行一个字节没动、格式化没有
 * 顺手多写一行（脚注那条尤其靠这一条证明「只插引用不补定义」，决策 6）。
 */
async function expectSource(page: Page, edits: Record<number, string>): Promise<void> {
  const expected = DOC.split("\n").map((line, index) => edits[index] ?? line);
  const lines = (await model(page)).text.split("\n");
  expect(lines).toHaveLength(expected.length);
  expect(lines).toEqual(expected);
}

async function openEditor(page: Page): Promise<void> {
  await openReader(page, {
    text: DOC,
    documentUri: "file:///vault/e2e/edit-inline.md"
  });
  await page.getByRole("button", { name: "Edit mode" }).click();
  await expect(page.locator("[data-readora-editable]")).not.toHaveCount(0);
}

/** 按源行范围认块：`rangeKey` 是接管层自己的身份口径，比 class + hasText 更硬。 */
function block(page: Page, rangeKey: string) {
  return page.locator(`[data-readora-source-range="${rangeKey}"]`);
}

/** 工具条挂在 `body` 上（决策 4），所以不从正文容器里找。 */
function toolbar(page: Page) {
  return page.locator(".readora-edit-toolbar");
}

function tool(page: Page, name: string) {
  return toolbar(page).getByRole("button", { name });
}

/** 选区端点：块内第 `node` 个文本节点里的第 `offset` 个字符（文档顺序）。 */
interface NodePoint {
  node: number;
  offset: number;
}

/**
 * 把选区精确放到「第几个文本节点的哪个偏移」上。
 *
 * 为什么不用鼠标拖：拖出来的端点会偏半个字符（Chromium 命中测试落在哪个字格上
 * 取决于字体度量），本篇要的是 `[6,15)` 就是 `[6,15)`。仍然走真的
 * `selection.addRange`，所以被测的那条链路（`readUnitSelection` →
 * `selectionFromRange` → `charOffsetOf`）与用户拖出来的完全同一条。
 */
async function selectText(
  page: Page,
  rangeKey: string,
  start: NodePoint,
  end: NodePoint
): Promise<void> {
  await page.evaluate(
    ({ key, from, to }) => {
      const node = document.querySelector<HTMLElement>(
        `[data-readora-source-range="${key}"]`
      );
      if (!node) {
        throw new Error(`no block for ${key}`);
      }
      const texts: Text[] = [];
      const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
      let current = walker.nextNode();
      while (current) {
        texts.push(current as Text);
        current = walker.nextNode();
      }
      const startNode = texts[from?.node ?? -1];
      const endNode = texts[to?.node ?? -1];
      if (!startNode || !endNode) {
        throw new Error(`text node missing in ${key}`);
      }
      const range = document.createRange();
      range.setStart(startNode, from.offset);
      range.setEnd(endNode, to.offset);
      const selection = window.getSelection();
      if (!selection) {
        throw new Error("no selection object");
      }
      selection.removeAllRanges();
      selection.addRange(range);
    },
    { key: rangeKey, from: start, to: end }
  );
  await expect.poll(() => selectionText(page)).not.toBe("");
}

/** 当前选区的文本：验「点了工具条按钮之后选区还在不在」。 */
function selectionText(page: Page): Promise<string> {
  return page.evaluate(() => window.getSelection()?.toString() ?? "");
}

/** 选区那个词的真矩形（视口坐标）。 */
function selectionBox(page: Page): Promise<{ top: number; bottom: number; left: number; right: number }> {
  return page.evaluate(() => {
    const selection = window.getSelection();
    const range = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
    const rect = range?.getBoundingClientRect();
    return {
      top: rect?.top ?? -1,
      bottom: rect?.bottom ?? -1,
      left: rect?.left ?? -1,
      right: rect?.right ?? -1
    };
  });
}

/** 双击激活并等单元真的进入编辑态。 */
async function activate(page: Page, rangeKey: string) {
  const target = block(page, rangeKey);
  await target.dblclick();
  await expect(target).toHaveAttribute("contenteditable", "true");
  return target;
}

async function submit(page: Page): Promise<void> {
  await page.keyboard.press("Control+Enter");
}

test.describe("行内格式化", () => {
  test("选中一个词 → 工具条贴在那词上方（真像素）→ 加粗 → 只改那一个词", async ({ page }) => {
    await openEditor(page);
    const paragraph = await activate(page, "2:2");
    await selectText(page, "2:2", { node: 0, offset: 6 }, { node: 0, offset: 15 });
    await expect(toolbar(page)).toBeVisible();
    await expect(tool(page, "Bold")).toBeEnabled();

    // 真像素判据：工具条与被选中的那个词**横向相交**且贴在它上方。
    // 全零矩形落在这里过不了第一行（词的 right 会是 -1）。
    const bar = await toolbar(page).boundingBox();
    const word = await selectionBox(page);
    expect(bar).not.toBeNull();
    const box = bar as NonNullable<typeof bar>;
    expect(Math.min(box.x + box.width, word.right) - Math.max(box.x, word.left)).toBeGreaterThan(0);
    expect(box.y).toBeLessThan(word.top);
    // 间距 = `placeToolbar` 那 8px + 估算高度与实际高度的差；超过 24px 就是飘到别处了
    expect(word.top - (box.y + box.height)).toBeLessThan(24);

    await tool(page, "Bold").click();
    // 选区跟着标记一起扩到新串上：再点一次就是解包的入口（决策 3 的幂等）
    await expect(paragraph).toHaveText("Alpha **paragraph** one.");
    expect(await selectionText(page)).toBe("**paragraph**");
    await submit(page);

    await expectSource(page, { 2: "Alpha **paragraph** one." });
    // 单元销毁 → 工具条随它一起从 body 上摘掉（生命周期断言的浏览器版）
    await expect(toolbar(page)).toHaveCount(0);
    expect((await model(page)).documentUri).toBe("file:///vault/e2e/edit-inline.md");
  });

  test("同一段再选 `**paragraph**` 整段 → 点加粗 → 回到原串（端到端幂等）", async ({ page }) => {
    await openEditor(page);
    // 先包一次，拿到带标记的那一版
    await activate(page, "2:2");
    await selectText(page, "2:2", { node: 0, offset: 6 }, { node: 0, offset: 15 });
    await tool(page, "Bold").click();
    await submit(page);
    await expectSource(page, { 2: "Alpha **paragraph** one." });

    // 渲染把 `**` 吃掉了 → 判据不成立 → 这一次单元挂在源文本上（形态 B），
    // 于是屏幕上就看得见标记，解包点的是标记本身而不是渲染后的词
    const paragraph = await activate(page, "2:2");
    expect(await paragraph.getAttribute("data-readora-edit")).toBe("source");
    await expect(paragraph).toHaveText("Alpha **paragraph** one.");
    await selectText(page, "2:2", { node: 0, offset: 6 }, { node: 0, offset: 19 });
    expect(await selectionText(page)).toBe("**paragraph**");
    await tool(page, "Bold").click();
    await expect(paragraph).toHaveText("Alpha paragraph one.");
    await submit(page);
    // 幂等的端到端版：整篇文档回到一个字节都不差的原文
    expect((await model(page)).text).toBe(DOC);
  });

  test("跨两个列表项的选区 → 逐行包裹，标记插在 `- ` / `1. ` 之后", async ({ page }) => {
    await openEditor(page);
    const note = page.locator(".readora-inline-note");
    const list = await activate(page, "12:13");
    // 端点分别落在两个 `<li>` 上：这是跨行选区在 DOM 里的真实形状
    await selectText(
      page,
      "12:13",
      { node: 0, offset: 0 },
      { node: 1, offset: "second item".length }
    );
    await tool(page, "Bold").click();
    // 逐行包裹不拆结构：还是两个 `<li>`，只是各自披上了一对标记
    await expect(list.locator("li")).toHaveCount(2);
    await expect(list.locator("li")).toHaveText(["**first item**", "**second item**"]);
    // 决策 2 第 4 条：跨行包裹不是失败，但必须说明「按行分别加粗」
    await expect(note).toContainText(EDIT_MULTILINE_WRAP_NOTE);
    await submit(page);
    await expectSource(page, { 12: "- **first item**", 13: "- **second item**" });

    // 有序列表同理：marker 是 `1. ` / `2. `，编号不被重排、`-` 不会取代 `.`
    await activate(page, "15:16");
    await selectText(page, "15:16", { node: 0, offset: 0 }, { node: 1, offset: "two item".length });
    await tool(page, "Bold").click();
    await submit(page);
    await expectSource(page, {
      12: "- **first item**",
      13: "- **second item**",
      15: "1. **one item**",
      16: "2. **two item**"
    });
    // 逐行包裹的意义就在这一条上：源里不会留下任何孤立的 `**`
    const pairs = (await model(page)).text.split("\n").filter((line) => {
      const stars = line.split("**").length - 1;
      return stars > 0 && stars % 2 === 1;
    });
    expect(pairs).toEqual([]);
  });

  test("引用两行之间那条 `>` 空行不被包成 `**`", async ({ page }) => {
    await openEditor(page);
    await activate(page, "8:10");
    // 文本空间是「quote line one.\n\nquote line two.」，中间那个空段就是 `>` 撑的
    await selectText(
      page,
      "8:10",
      { node: 0, offset: 0 },
      { node: 1, offset: "quote line two.".length }
    );
    await tool(page, "Italic").click();
    await submit(page);
    await expectSource(page, {
      8: "> *quote line one.*",
      9: ">",
      10: "> *quote line two.*"
    });
  });

  test("链接：URL 输入框展开时单元不销毁、包裹对象不丢（选区被输入框拿走）→ 回车写出 `[词](url)`", async ({ page }) => {
    await openEditor(page);
    const paragraph = await activate(page, "6:6");
    await selectText(page, "6:6", { node: 0, offset: 0 }, { node: 0, offset: 4 });
    await tool(page, "Link").click();

    // 「单元不被销毁」是硬要求；选区则必须如实写：**焦点一进 `<input>` 文档选区就清了**
    // （Chromium 把选区归给当前焦点控件，实测 `toString()` 返回空串）。丢掉的是选区，
    // 不丢的是包裹对象 —— `onUrlOpen` 在失焦之前已经把它换成下标记下了，
    // 所以下面那一次回车仍然包得住 `Beta`（那一手记忆坏掉时这里会退化成只写出 `()`）。
    await expect(toolbar(page).locator(".readora-edit-toolbar__url")).toBeVisible();
    await expect(paragraph).toHaveAttribute("contenteditable", "true");
    await expect(paragraph).toHaveAttribute("data-readora-edit-state", "active");
    expect(await selectionText(page)).toBe("");
    expect(await viewMessages(page, "document.edit")).toEqual([]);

    await toolbar(page).locator(".readora-edit-toolbar__url-input").fill("https://example.com");
    await page.keyboard.press("Enter");
    await expect(paragraph).toHaveText("[Beta](https://example.com) paragraph two.");
    // 输入框交回焦点 → `restoreSelection` 把光标送回单元 → `Ctrl+Enter` 才接得住
    expect(
      await page.evaluate(() =>
        (document.activeElement as HTMLElement | null)?.getAttribute(
          "data-readora-source-range"
        )
      )
    ).toBe("6:6");
    await submit(page);
    await expectSource(page, { 6: "[Beta](https://example.com) paragraph two." });
  });

  test("heading 改级别：只动 `##` 那三个字节，DOM 与锚点都不改", async ({ page }) => {
    await openEditor(page);
    const heading = await activate(page, "4:4");
    await expect(toolbar(page).locator(".readora-edit-toolbar__levels")).toBeVisible();
    await expect(tool(page, "Heading level 2")).toHaveAttribute("aria-pressed", "true");
    await expect(tool(page, "Heading level 2")).toBeDisabled();
    await expect(tool(page, "Heading level 3")).toBeEnabled();
    // 非选区动作不需要选区：级别改的是 marker，光标落在哪都一样
    await tool(page, "Heading level 3").click();
    // 形态 A 的级别改动**不动 DOM 一个字符**（决策 5）—— 脏位靠 marker 签名，
    // 于是下面那次提交能不能发出去就是 `dirty()` 有没有算上 marker 的证据
    await expect(heading).toHaveText("Section two");
    await submit(page);

    await expectSource(page, { 4: "### Section two" });
    const after = page.locator("h3.readora-heading");
    await expect(after).toHaveText("Section two");
    expect(await after.getAttribute("data-readora-heading")).toBe("section-two");
    expect(await after.getAttribute("data-readora-source-range")).toBe("4:4");
  });

  test("`E` 键：把手块上按 e 激活；活动单元里按 E 只是一个字，不重挂", async ({ page }) => {
    await openEditor(page);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    // 顶栏之后有多少可聚焦件不是本篇的断言，所以「按到出现把手块为止」
    let focused = "";
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await page.keyboard.press("Tab");
      focused = await page.evaluate(() => {
        const node = document.activeElement as HTMLElement | null;
        return node?.getAttribute("data-readora-source-range") ?? "";
      });
      if (focused !== "") {
        break;
      }
    }
    expect(focused).not.toBe("");
    await page.keyboard.press("e");
    await expect(block(page, focused)).toHaveAttribute("contenteditable", "true");
    await expect(block(page, focused)).toHaveAttribute("data-readora-edit-state", "active");
    // `E` 与 Enter / Space 同一条委托，`preventDefault` 只在真的激活时吞键
    expect(await viewMessages(page, "document.edit")).toEqual([]);

    // 活动单元里的大写 E：是一个字，不是快捷键（idle 护栏的浏览器版）
    await activate(page, "2:2");
    const before = await block(page, "2:2").evaluate((node) => node.innerHTML);
    await page.keyboard.press("E");
    const after = await block(page, "2:2").evaluate((node) => node.innerHTML);
    expect(after).toBe(`${before}E`);
    await expect(block(page, "2:2")).toHaveAttribute("contenteditable", "true");
    await submit(page);
    await expectSource(page, { 2: "Alpha paragraph one.E" });
    const requests = await viewMessages(page, "document.edit");
    expect(requests).toHaveLength(1);
  });

  test("脚注：光标处插 `[^2]`，模型里不多出行，并给一行提示", async ({ page }) => {
    await openEditor(page);
    const paragraph = await activate(page, "6:6");
    // 光标态（collapsed）就能插：脚注引用是纯插入，不需要选区（决策 6）
    await expect(tool(page, "Footnote reference")).toBeEnabled();
    await expect(tool(page, "Bold")).toBeDisabled();
    await tool(page, "Footnote reference").click();
    await expect(page.locator(".readora-inline-note")).toContainText(EDIT_FOOTNOTE_NOTE);
    await expect(paragraph).toHaveText("Beta paragraph two.[^2]");
    await submit(page);

    // 「没有多出行」＝ 只插了引用、没有偷偷补定义行（一次写回只有一个行范围）
    await expectSource(page, { 6: "Beta paragraph two.[^2]" });
    expect(await viewMessages<{ payload: { range: unknown } }[]>(page, "document.edit")).toHaveLength(1);
  });

  test("行内代码段内加粗：按钮 disabled、合成 click 也无变化，源里不出现 `` `** ``", async ({ page }) => {
    await openEditor(page);
    const paragraph = await activate(page, "20:20");
    // 带 code span 的那一段渲染会吃掉反引号 → 判据不成立 → 形态 B，标记现形
    expect(await paragraph.getAttribute("data-readora-edit")).toBe("source");
    await selectText(page, "20:20", { node: 0, offset: 5 }, { node: 0, offset: 9 });
    expect(await selectionText(page)).toBe("code");

    // 「为什么是灰的」要说在置灰那一次：disabled 的按钮收不到 click
    await expect(page.locator(".readora-inline-note")).toContainText(EDIT_INSIDE_CODE_NOTE);
    for (const name of ["Bold", "Italic", "Strikethrough", "Link"]) {
      await expect(tool(page, name)).toBeDisabled();
    }
    // `code` 自己走解包，不受 insideCode 约束（§6.3）
    await expect(tool(page, "Inline code")).toBeEnabled();

    // 键盘/脚本路径仍可能把 click 递到 disabled 按钮上，`runAction` 里那一支是防御：
    // 无论浏览器这关怎么判，结果都必须是什么也没写
    await tool(page, "Bold").dispatchEvent("click");
    await expect(paragraph).toHaveText("Use `code span` carefully.");
    await submit(page);
    expect((await model(page)).text).toBe(DOC);
    expect(await viewMessages(page, "document.edit")).toEqual([]);
  });
});
