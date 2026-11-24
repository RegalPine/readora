/**
 * 段落级就地编辑（ARC-009 §12 E2 行 / STORY-13-03，E2）。
 *
 * 判据就一句：**双击改字 → 提交 → 宿主那份文件已按行更新 → 没编辑过的行逐字节不变**。
 * 这条判据只能在浏览器里成立 —— 它同时用到 contenteditable 的真实编辑行为
 * （选区、`<br>`、失焦时机）、`document.edit` 的一来一回与重写后的 DOM 保全，
 * jsdom 那一份（`content/edit/__tests__/edit-layer.spec.ts`）把前两件都 mock 掉了。
 *
 * 断言的权威是 `window.__readora.model()`（夹具里的宿主模型），**不是屏上文本**：
 * 屏上的 DOM 是渲染产物，拿它当文件内容等于用结论证明前提（§15-3）。
 */
import { expect, test, type Page } from "@playwright/test";
import { openReader, viewMessages, type DocInput } from "../helpers/reader";

/** 一份把四类认领区块 + 三类不认领区块都装进去的文档（行号是用例的一部分）。 */
const DOC = [
  "# Edit Guide", // 0
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
  "Gamma with **bold** marker.", // 15
  "", // 16
  "| Col | Val |", // 17
  "| --- | --- |", // 18
  "| a | b |", // 19
  "", // 20
  "---", // 21
  "", // 22
  "Tail paragraph." // 23
].join("\n");

interface Model {
  documentUri: string;
  text: string;
  version: number;
}

function model(page: Page): Promise<Model> {
  return page.evaluate(() => window.__readora.model());
}

/** 按行替换那一份期望：与 Host 的 `applyEdit` 同一条算法，用例自己也算一次。 */
function withLine(text: string, index: number, line: string): string {
  const lines = text.split("\n");
  lines[index] = line;
  return lines.join("\n");
}

/**
 * 开到「编辑模式已开启」：双击入口与把手都跟着 `editMode`（§7.2），
 * 所以本篇绝大多数用例得先按下那枚开关，不是在测一个不存在的快捷键入口。
 */
async function openEditor(page: Page, documentUri = "file:///vault/e2e/edit.md"): Promise<void> {
  await openReader(page, { text: DOC, documentUri });
  await editToggle(page).click();
  await expect(page.locator("[data-readora-editable]")).not.toHaveCount(0);
}

function editDoc(documentUri: string): DocInput {
  return { text: DOC, documentUri };
}

/** 顶栏那枚开关（UX-008）：E2 的入口只有它，`E` 键属 E6。 */
function editToggle(page: Page) {
  return page.getByRole("button", { name: "Edit mode" });
}

/**
 * 双击激活并等单元真的进入编辑态。
 *
 * 一定要等 `contenteditable`：把手在、属性还没上是两回事（阈值拒绝激活也长这样）。
 */
async function activate(locator: ReturnType<Page["locator"]>): Promise<void> {
  await locator.dblclick();
  await expect(locator).toHaveAttribute("contenteditable", "true");
}

/**
 * 在激活的单元末尾追加一段文字（末尾靠 {@link moveCaretToBlockEnd} 钉住）。
 *
 * 追加串**不以空格开头**：Chromium 会抹掉一个文本节点末尾那个多余空格（没有
 * 任何不可见字符留在 DOM 里，已实测），拿它做逐字节断言的夹具只会测到浏览器
 * 的空白处理。写回侧负责的是 DOM 里有的字符一个不丢、一个不多加。
 */
async function append(page: Page, text: string): Promise<void> {
  await page.keyboard.type(text);
}

/**
 * 把光标钉在活动块的末尾。
 *
 * 双击进入编辑时光标落在**点击处**（E8 修订，ARC-009 §7.1），而 `locator.dblclick()`
 * 点的是元素中心：单个段落那样也落在行尾之后的空白上，多段引用与两行列表的中心
 * 却可能落在中间那行。本篇的逐字节断言写的是「在末尾追加」，所以追加之前自己把
 * 坐标定死 —— 用的是产品同一个读法（`selectNodeContents` + `collapse(false)），
 * 不去猜那一下落在哪个像素。
 */
async function moveCaretToBlockEnd(page: Page): Promise<void> {
  await page.evaluate(() => {
    const block = document.querySelector<HTMLElement>('[data-readora-edit-state="active"]');
    if (!block) {
      throw new Error("no active edit unit");
    }
    const range = document.createRange();
    range.selectNodeContents(block);
    range.collapse(false);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
}

async function submit(page: Page): Promise<void> {
  await page.keyboard.press("Control+Enter");
}

/**
 * 全选活动单元里的那一段。
 *
 * 平台和 chord 得对上：macOS 那一份 Chromium 把 Select All 绑在 `Cmd+A`，
 * `Ctrl+A` 在 contenteditable 里不是一个全选（实测只按光标位置动了那一个字符）；
 * Linux / Windows（CI）保持 `Ctrl+A`。本仓在这台机器上跑这条用例一直是红的，
 * 退回未改动的代码复跑同样红 —— 它与光标落点无关，只是没人在这台机器上跑绿过。
 */
async function selectAll(page: Page): Promise<void> {
  await page.keyboard.press(process.platform === "darwin" ? "Meta+a" : "Control+a");
}

test.describe("段落级就地编辑", () => {
  test("双击段落改字 → 提交 → 文件按行更新，其余行逐字节不变（§15-3）", async ({ page }) => {
    await openEditor(page);
    const block = page.locator(".readora-paragraph", { hasText: "Alpha paragraph one." }).first();
    await activate(block);
    await append(page, "[edited]");
    await submit(page);

    await expect.poll(() => model(page)).toEqual({
      documentUri: "file:///vault/e2e/edit.md",
      text: withLine(DOC, 2, "Alpha paragraph one.[edited]"),
      version: 2
    });
    // 逐字节证据：只有第 2 行动过，其余每一行都还是原值
    const lines = (await model(page)).text.split("\n");
    const original = DOC.split("\n");
    expect(lines.filter((_line, index) => index !== 2)).toEqual(
      original.filter((_line, index) => index !== 2)
    );
    // 一次提交只发一条 `document.edit`，字段是行区间而不是字符偏移
    // （`viewMessages` 交出的是整条信封，载荷在这一格里）
    const requests = await viewMessages<{
      payload: { range: { startLine: number; endLine: number }; baseVersion: number };
    }>(page, "document.edit");
    expect(requests.map((entry) => entry.payload.range)).toEqual([{ startLine: 2, endLine: 2 }]);
    expect(requests[0]?.payload.baseVersion).toBe(1);
    // 回声到达后区块回到静态形态：编辑属性摘净，新文本已在正文里
    await expect(block).toHaveText("Alpha paragraph one.[edited]");
    await expect(block).not.toHaveAttribute("contenteditable");
  });

  test("heading 改字保住 `##` 前缀与锚点（形态 A 补前缀）", async ({ page }) => {
    await openEditor(page);
    const heading = page.locator("h2.readora-heading").first();
    expect(await heading.getAttribute("data-readora-heading")).toBe("section-two");
    await activate(heading);
    await append(page, "[补充]");
    await submit(page);

    await expect
      .poll(() => model(page))
      .toHaveProperty("text", withLine(DOC, 4, "## Section two[补充]"));
    const after = page.locator("h2.readora-heading").first();
    await expect(after).toHaveText("Section two[补充]");
    // 前缀没被抹平（改的是字，不是结构），锚点也没丢：重渲染后仍然带源位置锁定
    expect(await after.getAttribute("data-readora-heading")).toContain("section-two");
    expect(await after.getAttribute("data-readora-source-range")).toBe("4:4");
  });

  test("blockquote 与 list 走形态 A；含 `**` 的段落回落形态 B（§6.2 的条件式）", async ({ page }) => {
    await openEditor(page);
    // 1) 引用：两段落中间那份空行是 `>` 撑出来的，补前缀要按原 marker 逐行还原
    const quote = page.locator("blockquote.readora-blockquote").first();
    await activate(quote);
    await moveCaretToBlockEnd(page);
    await append(page, "[q]");
    await submit(page);
    await expect
      .poll(() => model(page))
      .toHaveProperty("text", withLine(DOC, 10, "> quote line two.[q]"));

    // 2) 列表：一行一个 `li`，标记复用原串（`-` 不会被换成 `*`）
    const list = page.locator("ul.readora-list").first();
    await activate(list);
    await moveCaretToBlockEnd(page);
    await append(page, "[x]");
    await submit(page);
    await expect
      .poll(() => model(page))
      .toHaveProperty("text", withLine((await model(page)).text, 13, "- second item[x]"));

    // 3) 行内标记：渲染把 `**` 吃掉了，判据不成立 → 单元改挂在源文本上
    const bold = page.locator(".readora-paragraph", { hasText: "Gamma with" }).first();
    await activate(bold);
    expect(await bold.getAttribute("data-readora-edit")).toBe("source");
    await expect(bold).toHaveText("Gamma with **bold** marker.");
    // 形态 B 提交原样写回，不做任何 Markdown 反解析（§9.4）
    const beforeBold = (await model(page)).text;
    await append(page, "[tail]");
    await submit(page);
    await expect
      .poll(() => model(page))
      .toHaveProperty("text", withLine(beforeBold, 15, "Gamma with **bold** marker.[tail]"));
  });

  test("把手落在认领的区块上：表格进、分隔线不进（§15-5）", async ({ page }) => {
    // 本条自己开：要验的就是「开关前 0 枚 / 开关后 9 枚」这一段跳变
    await openReader(page, editDoc("file:///vault/e2e/edit.md"));
    await expect(page.locator("[data-readora-editable]")).toHaveCount(0);
    await editToggle(page).click();

    // 9 块认领：2 个标题 + 4 个段落 + 1 个引用 + 1 个列表 + 1 个表格
    // （E4/E5 起表格进源码编辑，把手落在包裹它的 `div.readora-table-scroll` 上）
    await expect(page.locator("[data-readora-editable]")).toHaveCount(9);
    expect(await page.locator("[data-readora-editable]").evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute("data-readora-editable"))
    )).toEqual([
      "heading",
      "paragraph",
      "heading",
      "paragraph",
      "blockquote",
      "list",
      "paragraph",
      "table",
      "paragraph"
    ]);
    // 分隔线不认领：连属性都不该出现（有把手没入口 = 骗一次 hover）。
    // 表格的把手在包裹它的滚动 `div` 上，`<table>` 元素本体不带该属性，故这条仍为 0。
    await expect(page.locator("table[data-readora-editable], hr[data-readora-editable]")).toHaveCount(0);
    await expect(page.locator("table")).toBeVisible();
    // 键盘可达：把手块带 `tabindex`，不用每块多一枚按钮
    expect(
      await page.locator('[data-readora-editable="paragraph"]').first().getAttribute("tabindex")
    ).toBe("0");
  });

  test("被拒 stale：卡片两枚动作都在，「强制替换」落进文件（§5.3）", async ({ page }) => {
    await openEditor(page);
    const block = page.locator(".readora-paragraph", { hasText: "Beta paragraph two." }).first();
    await activate(block);
    await append(page, "[draft]");
    // 剧本在提交之前装好：`stale` 是恒拒，用来造「真的陈旧」之外的强制分支
    await page.evaluate(() => window.__readora.setEditScript({ mode: "stale" }));
    await submit(page);

    const card = page.locator(".readora-edit-conflict");
    await expect(card).toBeVisible();
    await expect(card).toHaveAttribute("data-readora-edit-reason", "stale");
    // 三枚错误码的文案不合成一句：这一条只允许出现 stale 那一份
    await expect(
      card.locator(".readora-edit-conflict-reason")
    ).toContainText("The file changed while you were editing");
    await expect(card.getByRole("button", { name: "Replace anyway" })).toBeVisible();
    await expect(
      card.getByRole("button", { name: "Re-edit from the latest source" })
    ).toBeVisible();
    // DOM 一律不动：输入还在块里，没被静默扫掉
    await expect(block).toHaveText("Beta paragraph two.[draft]");

    await page.evaluate(() => window.__readora.setEditScript({ mode: "ok" }));
    await card.getByRole("button", { name: "Replace anyway" }).click();
    await expect
      .poll(() => model(page))
      .toHaveProperty("text", withLine(DOC, 6, "Beta paragraph two.[draft]"));
    await expect(card).toHaveCount(0);
  });

  test("编辑期间外部快照到达：输入不丢，卡片接手（§5.4）", async ({ page }) => {
    await openEditor(page);
    const block = page.locator(".readora-paragraph", { hasText: "Alpha paragraph one." }).first();
    await activate(block);
    await append(page, "[typing]");

    // 动的是**另一段**正文（并且得是同一篇文档：换 URI 的快照就是另一篇，
    // 接管层会丢掉上一篇的输入）：rangeKey 不变，被持有的那块要能插回原位
    await page.evaluate((text) => {
      const current = window.__readora.model();
      window.__readora.update({ text, documentUri: current.documentUri, version: 9 });
    }, withLine(DOC, 23, "Tail paragraph. 外部改的"));

    const card = page.locator(".readora-edit-conflict");
    await expect(card).toBeVisible();
    await expect(card).toHaveAttribute("data-readora-edit-reason", "stale");
    // 证据是「输入还在屏上」而不是「没抛异常」：块里与卡片里都还看得见那份草稿
    await expect(block).toHaveText("Alpha paragraph one.[typing]");
    await expect(card.locator(".readora-edit-conflict-text")).toHaveText("Alpha paragraph one.[typing]");
    // 文件里那一份是外部改动，没有被我们半路覆盖
    expect((await model(page)).text).toContain("Tail paragraph. 外部改的");
    expect((await model(page)).text).toContain("Alpha paragraph one.");
  });

  test("Escape 放弃：正文回到静态产物，一条消息都不发（§7.4）", async ({ page }) => {
    await openEditor(page);
    const block = page.locator(".readora-paragraph", { hasText: "Alpha paragraph one." }).first();
    const before = await block.evaluate((node) => node.innerHTML);
    await activate(block);
    await append(page, "[gone]");
    await page.keyboard.press("Escape");

    await expect(block).toHaveText("Alpha paragraph one.");
    expect(await block.evaluate((node) => node.innerHTML)).toBe(before);
    await expect(block).not.toHaveAttribute("contenteditable");
    await expect(block).not.toHaveAttribute("data-readora-edit");
    expect(await viewMessages(page, "document.edit")).toEqual([]);
    expect((await model(page)).text).toBe(DOC);
  });

  test("清空区块提交：留一个空行，其余字节不变（已知形态）", async ({ page }) => {
    await openEditor(page);
    const block = page.locator(".readora-paragraph", { hasText: "Alpha paragraph one." }).first();
    await activate(block);
    await selectAll(page);
    await page.keyboard.press("Delete");
    await submit(page);

    // 不做删行：那会连带吃掉用来分隔区块的空行，改动面从一块膨胀到两块
    await expect.poll(() => model(page)).toHaveProperty("text", withLine(DOC, 2, ""));
    const lines = (await model(page)).text.split("\n");
    expect(lines[2]).toBe("");
    expect(lines[1]).toBe("");
    expect(lines[3]).toBe("");
    expect(lines[4]).toBe("## Section two");
    // 空区块仍然被渲染成文档的一部分，后面的正文一个不少
    await expect(
      page.locator(".readora-paragraph", { hasText: "Beta paragraph two." }).first()
    ).toBeVisible();
  });

  test("untitled 文档：开关禁用而非隐藏，双击也不激活（§7.2）", async ({ page }) => {
    await openReader(page, editDoc("untitled:Untitled-1"));
    const button = editToggle(page);
    await expect(button).toBeVisible();
    await expect(button).toBeDisabled();
    await expect(button).toHaveAttribute("title", /local files/i);
    await button.click({ force: true });
    await expect(page.locator("[data-readora-editable]")).toHaveCount(0);
    // 没有把手也没有双击入口：改不了的东西不给可点的样子
    const block = page.locator(".readora-paragraph", { hasText: "Alpha paragraph one." }).first();
    await block.dblclick();
    await expect(block).not.toHaveAttribute("contenteditable");
    expect(await viewMessages(page, "document.edit")).toEqual([]);
  });
});
