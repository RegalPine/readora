/**
 * 大纲章节结构操作（ARC-009 §12 E7 行）。
 *
 * 判据与段落就地编辑同一条：**动作落地后宿主模型逐字节可预期**。
 * 这条在 e2e 层独有的证据是 frontmatter 补偿 —— 纯函数与面板测试里行号是
 * 手摆的，只有真实链路（`extractOutline` 的 body 相对行 → 面板 → `document.edit`
 * → 夹具按行替换）会暴露「忘加 offset 就删错行」这类错位。夹具的应答器对
 * `baseVersion` 严判（L456），连续动作的版本记账一旦回归，第二笔当场 stale。
 *
 * 断言权威是 `window.__readora.model()`（宿主模型），不是屏上文本（§15-3）；
 * 大纲回显只作为「回声确实到达」的旁证。
 */
import { expect, test, type Page } from "@playwright/test";
import { openReader } from "../helpers/reader";
import type { EditScript } from "../../apps/webview/dev/e2e";

/**
 * 带 frontmatter 的夹具（文件绝对行 0 基，行号就是用例的一部分）：
 * 0-2 frontmatter，4 `# Guide`，8 `## Alpha`，12 `### Alpha child`，16 `## Beta`。
 * `extractOutline` 给的是 body 相对行（1/5/9/13），补偿差 3 行。
 */
const DOC = [
  "---", // 0
  "title: Sections", // 1
  "---", // 2
  "", // 3
  "# Guide", // 4
  "", // 5
  "Intro paragraph.", // 6
  "", // 7
  "## Alpha", // 8
  "", // 9
  "Alpha body.", // 10
  "", // 11
  "### Alpha child", // 12
  "", // 13
  "Child body.", // 14
  "", // 15
  "## Beta", // 16
  "", // 17
  "Beta body." // 18
].join("\n");

interface Model {
  documentUri: string;
  text: string;
  version: number;
}

function model(page: Page): Promise<Model> {
  return page.evaluate(() => window.__readora.model());
}

/** 夹具应答器的行替换期望：把 `[start, end]` 换成 `replacement` 的那些行。 */
function withRange(text: string, start: number, end: number, replacement: string[]): string {
  const lines = text.split("\n");
  return [...lines.slice(0, start), ...replacement, ...lines.slice(end + 1)].join("\n");
}

function moreButton(page: Page, label: string) {
  // 不用 getByRole：行尾 ⋯ 平时是 `opacity:0`，Playwright 的 role 引擎会把
  // 不渲染的元素从可访问性树里过滤掉（与规范相反），选择器直接碰壁。
  return page.locator(`button[aria-label="Section actions for ${label}"]`);
}

function menuButton(page: Page, name: string) {
  // 菜单内的文本按钮：用文本内容锁定位，避开 role 引擎的可见性歧义。
  return page.locator(`.readora-outline-menu button`, { hasText: name });
}

/** 开 ⋯ 菜单：hover 行尾让按钮真正可见后再点（与用户动作同形）。 */
async function openMenu(page: Page, label: string): Promise<void> {
  const more = moreButton(page, label);
  await more.hover();
  await expect(more).toBeVisible();
  await more.click();
  await expect(page.locator(".readora-outline-menu")).toBeVisible();
}

async function setEditScript(page: Page, script: EditScript): Promise<void> {
  await page.evaluate((value) => window.__readora.setEditScript(value), script);
}

/** 开到「编辑模式已开启」：⋯ 的门槛含 editMode（§7.2 同一入口）。 */
async function openEditor(page: Page, documentUri = "file:///vault/e2e/sections.md"): Promise<void> {
  await openReader(page, { text: DOC, documentUri });
  await page.getByRole("button", { name: "Edit mode" }).click();
  await expect(page.locator("[data-readora-editable]")).not.toHaveCount(0);
}

test.describe("大纲章节结构操作", () => {
  test("只读没有入口；非 file: 文档开了编辑也没有", async ({ page }) => {
    await openReader(page, { text: DOC });
    await expect(moreButton(page, "Alpha")).toHaveCount(0);
    await page.getByRole("button", { name: "Edit mode" }).click();
    await expect(moreButton(page, "Alpha")).toHaveCount(1);
    // untitled 文档：编辑开关整个禁用（§7.2），结构菜单自然零 affordance。
    await openReader(page, { text: DOC, documentUri: "untitled:Untitled-1" });
    await expect(moreButton(page, "Alpha")).toHaveCount(0);
  });

  test("Add section after：新节落在子树末行之后、Beta 之前，其余行逐字节不变", async ({ page }) => {
    await openEditor(page);
    await openMenu(page, "Alpha");
    await menuButton(page, "Add section after").click();
    // 期望：15 行的空位换成 ["", "## 新章节"]（锚点行保留 + 新节尾随一行）。
    await expect.poll(() => model(page)).toEqual({
      documentUri: "file:///vault/e2e/sections.md",
      text: withRange(DOC, 15, 15, ["", "## 新章节"]),
      version: 2
    });
    // 回声旁证：大纲里出现了新条目。
    await expect(page.getByRole("link", { name: "新章节" })).toBeVisible();
  });

  test("Add sub-section：级别钳到下一档（##→###），落点同样在子树末行", async ({ page }) => {
    await openEditor(page);
    await openMenu(page, "Alpha");
    await menuButton(page, "Add sub-section").click();
    await expect.poll(() => model(page)).toMatchObject({
      text: withRange(DOC, 15, 15, ["", "### 新章节"]),
      version: 2
    });
  });

  test("删除两步确认：第一步只报数不动文件，确认才删整棵子树", async ({ page }) => {
    await openEditor(page);
    await openMenu(page, "Alpha");
    await menuButton(page, "Delete section").click();
    // 报的是「点确认会发生的数」：8–15 共 8 行，含 1 个子节。
    await expect(page.getByText("Delete 8 lines including 1 sub-section?")).toBeVisible();
    expect((await model(page)).version).toBe(1);
    await menuButton(page, "Confirm delete").click();
    // 期望：8–15 换成一行空位（newText="" 占位是契约的固有行为），
    // Alpha 与其子节整体消失，frontmatter / Guide / Beta 逐字节不动。
    await expect.poll(() => model(page)).toEqual({
      documentUri: "file:///vault/e2e/sections.md",
      text: withRange(DOC, 8, 15, [""]),
      version: 2
    });
    const text = (await model(page)).text;
    expect(text).not.toContain("Alpha");
    expect(text).toContain("## Beta");
  });

  test("连续两笔动作不互相误杀：第二笔用上一笔的回执版本", async ({ page }) => {
    await openEditor(page);
    await openMenu(page, "Alpha");
    await menuButton(page, "Add section after").click();
    await expect.poll(() => model(page)).toMatchObject({ version: 2 });
    // 第二笔换一节操作；若版本记错（仍报 1），夹具应答器会当场回 stale。
    await openMenu(page, "Beta");
    await menuButton(page, "Add sub-section").click();
    await expect
      .poll(() => model(page))
      .toMatchObject({
        text: withRange(withRange(DOC, 15, 15, ["", "## 新章节"]), 19, 19, [
          "Beta body.",
          "### 新章节"
        ]),
        version: 3
      });
    await expect(page.locator('[data-readora-outline="section-note"]')).toHaveCount(0);
  });

  test("stale 剧本：失败提示留在面板内，文件一个字节不动", async ({ page }) => {
    await openEditor(page);
    await setEditScript(page, { mode: "stale" });
    await openMenu(page, "Alpha");
    await menuButton(page, "Add section after").click();
    await expect(page.locator('[data-readora-outline="section-note"]')).toContainText(
      "The document changed outside the outline"
    );
    await expect.poll(() => model(page)).toEqual({
      documentUri: "file:///vault/e2e/sections.md",
      text: DOC,
      version: 1
    });
    // 换回 ok 剧本后可重试：菜单失败时不收，直接再点动作。
    await setEditScript(page, { mode: "ok" });
    await menuButton(page, "Add section after").click();
    await expect.poll(() => model(page)).toMatchObject({ version: 2 });
  });
});
