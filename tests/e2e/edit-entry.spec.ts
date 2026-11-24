/**
 * 双击入口的可达性（用户反馈「段落很难进入编辑模式，双击默认是全选文本」）。
 *
 * 那条反馈拆成两件可测的事，取证都在浏览器里，jsdom 给不出答案：
 * 1. **进不去**：`onDoubleClick` 原先取的是 `closest(EDITABLE_BLOCK_SELECTOR)`，
 *    那是「最近的一个匹配祖先」。引用里的段落与松散列表 `li` 里的段落既带
 *    `p.readora-paragraph`，又住在认领块**内部**，于是紧随的那一步
 *    `parentElement !== container` 直接 return —— 双击它们永远只留下一串浏览器
 *    自己的选区，看起来就是「双击=全选文本」。同一条块按 `Enter` 却进得去（键盘
 *    路径认的是 `[data-readora-editable]`，那个属性只落在顶层认领块上），这种
 *    不对称本身就是缺陷的形状。
 * 2. **进去了也不在点上**：光标一律跳到块末尾，用户双击的那个词与光标落点无关，
 *    一敲就把改动加在句子尾巴上 —— 与「没进去」看起来是同一种坏了。
 *
 * 断言的权威仍是 `window.__readora.model()`（夹具里的宿主模型）而不是屏上文本，
 * 与 `edit.spec.ts` 同一条口径（ARC-009 §15-3）。
 */
import { expect, test, type Page } from "@playwright/test";
import { openReader, viewMessages } from "../helpers/reader";

/**
 * 行号是用例的一部分：2 段落 / 4 引用 / 6-8 松散列表（中间那个空行把列表变松，
 * `li` 里就多出内层 `p.readora-paragraph` —— 那正是原先双击不中的那一种）。
 */
const DOC = [
  "# Entry", // 0
  "", // 1
  "Alpha needle paragraph one.", // 2
  "", // 3
  "> quote needle line.", // 4
  "", // 5
  "- first needle item", // 6
  "", // 7
  "- second needle item", // 8
  ""
].join("\n");

function model(page: Page): Promise<{ text: string }> {
  return page.evaluate(() => window.__readora.model());
}

/** 按行替换那一份期望：只该动到那一行，其余逐字节不变。 */
function withLine(index: number, line: string): string {
  const lines = DOC.split("\n");
  lines[index] = line;
  return lines.join("\n");
}

async function openEditor(page: Page): Promise<void> {
  await openReader(page, { text: DOC, documentUri: "file:///vault/e2e/edit-entry.md" });
  await page.getByRole("button", { name: "Edit mode" }).click();
  await expect(page.locator("[data-readora-editable]")).not.toHaveCount(0);
}

/** 当前选区的文本：「双击后还剩什么选区」只能这样问，屏上高亮不是证据。 */
function selectedText(page: Page): Promise<string> {
  return page.evaluate(() => window.getSelection()?.toString() ?? "");
}

/** 活动块里光标前面的字符数（DOM 文本坐标，与块内 `textContent` 同一把尺）。 */
function caretOffset(page: Page): Promise<number> {
  return page.evaluate(() => {
    const block = document.querySelector<HTMLElement>('[data-readora-edit-state="active"]');
    const selection = window.getSelection();
    const range = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
    if (!block || !range) {
      return -1;
    }
    const before = range.cloneRange();
    before.selectNodeContents(block);
    before.setEnd(range.startContainer, range.startOffset);
    return before.toString().length;
  });
}

/**
 * 块内那个词在视口里的真矩形，用来把双击精确落在词上。
 *
 * 不写像素常数：`caretRangeFromPoint` 读的是真实布局，字号、宽度、滚动都会动，
 * 拿数值推出来的坐标测的又是夹具自己（ARC-009 §15-3 那条老坑）。
 */
async function wordBox(page: Page, rangeKey: string, word: string): Promise<{ x: number; y: number }> {
  const box = await page.evaluate(
    ({ key, needle }) => {
      const block = document.querySelector<HTMLElement>(`[data-readora-source-range="${key}"]`);
      const text = block?.firstChild;
      if (!block || !text || text.nodeType !== Node.TEXT_NODE) {
        throw new Error(`no text node in ${key}`);
      }
      const index = (text.textContent ?? "").indexOf(needle);
      if (index < 0) {
        throw new Error(`word not found in ${key}`);
      }
      const range = document.createRange();
      range.setStart(text, index);
      range.setEnd(text, index + needle.length);
      const rect = range.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, index };
    },
    { key: rangeKey, needle: word }
  );
  return { x: box.x, y: box.y };
}

/** 词在块内文本里的起始下标（同一个 `evaluate` 里顺手取回，不再量一次坐标）。 */
function wordIndex(page: Page, rangeKey: string, word: string): Promise<number> {
  return page.evaluate(
    ({ key, needle }) => {
      const block = document.querySelector<HTMLElement>(`[data-readora-source-range="${key}"]`);
      const text = block?.firstChild;
      return (text?.textContent ?? "").indexOf(needle);
    },
    { key: rangeKey, needle: word }
  );
}

/** 活动块当前的文本：打过字之后 `hasText` 那个定位器已经不认这一块了。 */
function activeBlockText(page: Page): Promise<string> {
  return page.evaluate(
    () => document.querySelector<HTMLElement>('[data-readora-edit-state="active"]')?.textContent ?? ""
  );
}

async function submit(page: Page): Promise<void> {
  await page.keyboard.press("Control+Enter");
}

test.describe("双击入口的可达性", () => {
  test("双击引用里那段文字：引用进入编辑，且不留选区", async ({ page }) => {
    await openEditor(page);
    const quote = page.locator("blockquote.readora-blockquote").first();
    const inner = quote.locator("p.readora-paragraph").first();
    // 内层段落自己不是认领块：把手只落在顶层那一个上
    await expect(inner).not.toHaveAttribute("data-readora-editable");

    await inner.dblclick();
    await expect(quote).toHaveAttribute("data-readora-edit-state", "active");
    await expect(quote).toHaveAttribute("contenteditable", "true");
    // 「只剩一串选区」就是这条反馈的原话：进入编辑必须把选区换成一个光标
    expect(await selectedText(page)).toBe("");

    await page.keyboard.press("End");
    await page.keyboard.type("[q]");
    await submit(page);
    await expect
      .poll(() => model(page))
      .toHaveProperty("text", withLine(4, "> quote needle line.[q]"));
  });

  test("双击松散列表 `li` 里那段文字：列表进入编辑并提交到那一行", async ({ page }) => {
    await openEditor(page);
    const list = page.locator("ul.readora-list").first();
    const secondItem = list.locator("p.readora-paragraph").last();
    // 夹具形状自己也要钉住：`li` 里没有内层段落的话，这条用例就是在空转
    expect(await secondItem.count()).toBe(1);

    await secondItem.dblclick();
    await expect(list).toHaveAttribute("data-readora-edit-state", "active");
    await expect(list).toHaveAttribute("contenteditable", "true");
    expect(await selectedText(page)).toBe("");

    await page.keyboard.press("End");
    await page.keyboard.type("[x]");
    await submit(page);
    await expect
      .poll(() => model(page))
      .toHaveProperty("text", withLine(8, "- second needle item[x]"));
  });

  test("双击某个词：光标落在这一个词里，不在块末尾", async ({ page }) => {
    await openEditor(page);
    const block = page.locator("p.readora-paragraph", { hasText: "Alpha needle paragraph" }).first();
    const box = await wordBox(page, "2:2", "needle");
    const wordStart = await wordIndex(page, "2:2", "needle");
    const before = (await block.textContent()) ?? "";

    await page.mouse.dblclick(box.x, box.y);
    await expect(block).toHaveAttribute("contenteditable", "true");
    expect(await selectedText(page)).toBe("");

    // 落在双击那个像素上，不是词首也不是块末尾：旧形态一律跳到末尾，
    // 用户点的词与光标落点毫无关系。断言只钉「在这一个词里」与「不在末尾」两件事，
    // 具体第几个字符交给布局（字号、字宽、抗锯齿都会动它）。
    const offset = await caretOffset(page);
    expect(offset).toBeGreaterThanOrEqual(wordStart);
    expect(offset).toBeLessThanOrEqual(wordStart + "needle".length);
    expect(offset).toBeLessThan(before.length);

    await page.keyboard.type("X");
    // 真正要钉住的是「这一个字符落在刚才那个光标上」：从末尾开始打就跳不出旧形态。
    expect(await activeBlockText(page)).toBe(`${before.slice(0, offset)}X${before.slice(offset)}`);
  });

  test("已经在编辑的那一块上再双击：浏览器选词照旧，不重挂也不发消息", async ({ page }) => {
    await openEditor(page);
    const block = page.locator("p.readora-paragraph", { hasText: "Alpha needle paragraph" }).first();
    await block.dblclick();
    await expect(block).toHaveAttribute("contenteditable", "true");
    const requests = await viewMessages(page, "document.edit");
    expect(requests).toHaveLength(0);

    const box = await wordBox(page, "2:2", "needle");
    await page.mouse.dblclick(box.x, box.y);
    // 同块重双击不走进入路径：`preventDefault` 不施放，选词习惯留给浏览器
    expect(await selectedText(page)).toBe("needle");
    await expect(block).toHaveAttribute("data-readora-edit-state", "active");
    expect(await viewMessages(page, "document.edit")).toHaveLength(0);
  });

  test("编辑模式关着：双击不激活任何东西（把手与入口同生同灭，§7.1）", async ({ page }) => {
    await openReader(page, { text: DOC, documentUri: "file:///vault/e2e/edit-entry.md" });
    const inner = page.locator("blockquote.readora-blockquote p.readora-paragraph").first();
    await inner.dblclick();
    await expect(inner).not.toHaveAttribute("contenteditable");
    await expect(page.locator("[data-readora-editable]")).toHaveCount(0);
    expect(await viewMessages(page, "document.edit")).toEqual([]);
  });
});
