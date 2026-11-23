/**
 * 编辑手册（ARC-009 §7.5）的浏览器取证。
 *
 * 单测那一份（`app-edit-mode.spec.tsx` + `edit-help-dialog.spec.tsx`）能钉住接线
 * 与契约，但有四件事只在真实浏览器里成立，本篇就测这四件：
 * 1. **真实焦点转移**：`page.click()` 会让焦点从 contenteditable 走进顶栏按钮，
 *    于是 `focusout` 真的发生 —— 这正是「点 Help 把草稿误提交」那条缺陷的现场，
 *    jsdom 的合成 click 根本不移动焦点，测不到；
 * 2. **真实 contenteditable 输入**：在单元里按 `?` 到底打不打得出字符，取决于
 *    监听有没有让路（jsdom 不实现 `isContentEditable`，那一条只能靠落点判据）；
 * 3. **真实键盘焦点**：Tab 环与 Escape 归位用的是浏览器的焦点顺序；
 * 4. **弹层真的可见**：`toBeVisible` 过的是 CSS，类名写错时单测仍是绿的。
 *
 * 判据权威同样是 `window.__readora.model()`：手册讲的是怎么改文件，
 * 那就得证明「看手册」这件事一个字都没写进文件。
 */
import { expect, test, type Page } from "@playwright/test";
import { openReader, viewMessages } from "../helpers/reader";

const DOC = [
  "# Editing Guide", // 0
  "", // 1
  "Alpha paragraph one.", // 2
  "", // 3
  "Beta paragraph two.", // 4
  "", // 5
  "Gamma paragraph three." // 6
].join("\n");

/** 顶栏那枚开关（编辑模式入口）。 */
function editToggle(page: Page) {
  return page.getByRole("button", { name: "Edit mode" });
}

/**
 * 手册入口：只在编辑模式开着时存在。
 *
 * `exact: true` 不是风格问题。大纲每枚 `⋯` 的 accessible name 是
 * `Section actions for <标题>`（ARC-007），本篇夹具的 H1 又叫 `Editing Guide`，
 * 于是不加 exact 时它会被算成第二个「Editing guide」。夹具标题就以这名字保留：
 * 它真能证伪一个靠子串匹配的定位器（单测里靠 CSS 类名所以不会碰到）。
 */
function helpToggle(page: Page) {
  return page.getByRole("button", { name: "Editing guide", exact: true });
}

function helpPanel(page: Page) {
  return page.locator(".readora-edit-help-dialog");
}

async function openHelp(page: Page): Promise<void> {
  await helpToggle(page).click();
  await expect(helpPanel(page)).toBeVisible();
}

function model(page: Page): Promise<{ text: string; version: number }> {
  return page.evaluate(() => window.__readora.model());
}

/**
 * 浏览器此刻的焦点落在哪一枚控件上 —— 焦点归位是浏览器的行为，
 * 只能问浏览器自己。返回值取 `aria-label`，没有则取标签名。
 */
function activeName(page: Page): Promise<string> {
  return page.evaluate(() => {
    const node = document.activeElement;
    if (!(node instanceof HTMLElement)) {
      return "none";
    }
    return node.getAttribute("aria-label") ?? node.tagName.toLowerCase();
  });
}

/** 开到「编辑模式已开启」：手册入口跟着 `editMode`，只读态根本没有这一枚。 */
async function openEditor(page: Page): Promise<void> {
  await openReader(page, { text: DOC, documentUri: "file:///vault/e2e/edit-help.md" });
  await editToggle(page).click();
  await expect(page.locator("[data-readora-editable]")).not.toHaveCount(0);
}

test.describe("编辑手册", () => {
  test("入口只在编辑模式在场；看手册一个字节都不写进文件", async ({ page }) => {
    await openReader(page, { text: DOC, documentUri: "file:///vault/e2e/edit-help.md" });
    await expect(helpToggle(page)).toHaveCount(0);
    await expect(helpPanel(page)).toHaveCount(0);

    await editToggle(page).click();
    await expect(helpToggle(page)).toHaveCount(1);
    await expect(helpToggle(page)).toHaveAttribute("aria-expanded", "false");
    await openHelp(page);
    await expect(helpToggle(page)).toHaveAttribute("aria-expanded", "true");

    // 手册是纯本地界面：不开格式化的工具条通道，也不发写回请求。
    expect(await viewMessages(page, "document.edit")).toHaveLength(0);
    const before = await model(page);
    expect(before.text).toBe(DOC);
    expect(before.version).toBe(1);
  });

  test("面板真的画出来：标题、六段小标题、键帽列都在", async ({ page }) => {
    await openEditor(page);
    await openHelp(page);
    // 限定在面板里找：正文 H1 自己就叫 `Editing Guide`，全页扫会命中两个。
    await expect(
      helpPanel(page).getByRole("heading", { level: 2, name: "Editing guide" })
    ).toBeVisible();
    await expect(page.locator(".readora-edit-help-section-title")).toHaveText([
      "Start editing",
      "Submit or cancel",
      "Two shapes",
      "Formatting bar",
      "Sections",
      "When the file changed first"
    ]);
    // 「点外部是提交」这句是手册里最要紧的一条警告，缺了它就会有人丢草稿。
    await expect(
      page.locator(".readora-edit-help-row", { hasText: "Click outside" })
    ).toBeVisible();
  });

  test("Escape 只收手册：编辑模式与把手原地不动，焦点还给入口", async ({ page }) => {
    await openEditor(page);
    await openHelp(page);
    // 打开时焦点被收进面板（模态契约），否则 Escape 落不到面板的监听上。
    expect(await activeName(page)).toBe("div");

    await page.keyboard.press("Escape");
    await expect(helpPanel(page)).toHaveCount(0);
    await expect(helpToggle(page)).toHaveAttribute("aria-expanded", "false");
    // 归位：Escape 之后用户该回到刚才按下的那枚按钮上，而不是掉回页面顶部。
    await expect
      .poll(() => activeName(page), { message: "focus returns to the ? button" })
      .toBe("Editing guide");
    // 同一次 Escape 没有连带退出编辑模式（容器委托已被面板 stopPropagation）。
    await expect(editToggle(page)).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("[data-readora-editable]")).not.toHaveCount(0);
  });

  test("正改着的块不会因为我点 Help 就提交（§7.4 focusout 是提交）", async ({ page }) => {
    await openEditor(page);
    const block = page.locator(".readora-paragraph", { hasText: "Alpha paragraph one." }).first();
    await block.dblclick();
    await expect(block).toHaveAttribute("contenteditable", "true");
    await page.keyboard.type("[draft]");
    // 草稿只在屏上：此时文件必须还是原样。
    expect((await model(page)).text).toBe(DOC);

    // 真实点击：焦点从 contenteditable 走进去顶栏按钮，`focusout` 一定会发生。
    // 入口自己声明了 `data-readora-keep-editing`，这一脚才不至于变成一次提交。
    await openHelp(page);
    expect(await viewMessages(page, "document.edit")).toHaveLength(0);
    expect((await model(page)).text).toBe(DOC);
    await expect(block).toHaveAttribute("contenteditable", "true");
    await expect(block).toHaveText("Alpha paragraph one.[draft]");

    // 关掉手册后草稿还在原地，用户可以接着改，而不是被静默提交半句话。
    await page.keyboard.press("Escape");
    await expect(helpPanel(page)).toHaveCount(0);
    await block.dblclick();
    await expect(block).toHaveAttribute("contenteditable", "true");
    await expect(block).toHaveText("Alpha paragraph one.[draft]");
    expect(await viewMessages(page, "document.edit")).toHaveLength(0);
  });

  test("在单元里按 `?` 是打一个字符；在正文里按才叫出手册", async ({ page }) => {
    await openEditor(page);
    const block = page.locator(".readora-paragraph", { hasText: "Beta paragraph two." }).first();
    await block.dblclick();
    await expect(block).toHaveAttribute("contenteditable", "true");

    await page.keyboard.press("?");
    await expect(helpPanel(page)).toHaveCount(0);
    // 让路判据真的让了路：字符进了正文，也没有因此提交。
    await expect(block).toHaveText("Beta paragraph two.?");
    expect(await viewMessages(page, "document.edit")).toHaveLength(0);

    // 先按 Esc 取消这块（回到原文），再把焦点交给正文里非输入区的一处。
    await page.keyboard.press("Escape");
    await expect(block).toHaveText("Beta paragraph two.");
    await page.locator(".readora-document").click();
    await page.keyboard.press("?");
    await expect(helpPanel(page)).toBeVisible();
    expect(await viewMessages(page, "document.edit")).toHaveLength(0);
  });

  test("面板里的文字点不动它，点背景才关", async ({ page }) => {
    await openEditor(page);
    await openHelp(page);
    await page.locator(".readora-edit-help-row").first().click();
    await expect(helpPanel(page)).toBeVisible();

    // backdrop 是面板外面那一层：用坐标点在其之外的一角。
    await page.locator(".readora-settings-backdrop").click({ position: { x: 4, y: 4 } });
    await expect(helpPanel(page)).toHaveCount(0);
  });

  test("手册是模态的：先收掉它才能再用顶栏；退出编辑不留浮层", async ({ page }) => {
    await openEditor(page);
    await openHelp(page);
    // 面板带 `aria-modal="true"`，backdrop 盖住整屏 —— 开着手册时顶栏点不到。
    // 这不是缺陷，是它跟 Settings 弹层共用的那一条模态契约；代价是
    // 「开着手册退出编辑」在鼠标路径上不可达，那一条接线只有单测能钉
    // （`app-edit-mode.spec.tsx` 直接调 React 的 onClick，不过指针层）。
    // 这里测的是浏览器里真会发生的那一段：关掉手册之后退出，不留孤儿浮层。
    await helpPanel(page).getByRole("button", { name: "Close editing guide" }).click();
    await expect(helpPanel(page)).toHaveCount(0);

    await editToggle(page).click();
    await expect(helpToggle(page)).toHaveCount(0);
    await expect(page.locator("[data-readora-editable]")).toHaveCount(0);

    await editToggle(page).click();
    await expect(helpToggle(page)).toHaveCount(1);
    await expect(helpToggle(page)).toHaveAttribute("aria-expanded", "false");
    await expect(helpPanel(page)).toHaveCount(0);
  });
});
