/**
 * 导出链路在真实浏览器里交出的那一帧（M11 · IMP-003 §7.1）。
 *
 * 单测（`export-document.spec.ts`）在 jsdom 里造 DOM，它证不了四件只有浏览器能答的事：
 * 1. **接管层真的挂上了**：CodeMirror 是滚动懒挂载的，jsdom 里 `.readora-code-editor`
 *    是我们手搓的，浏览器里它是真的；「摘掉它之后静态 `<pre>` 仍完整」要真层叠才算数；
 * 2. **图表 SVG 是真的**：mermaid 产物含 `<style>` 与内联色，序列化只许原样带走；
 * 3. **量出来的两个数是真的**：`scrollHeight` / `offsetWidth` 在 jsdom 恒为 0，
 *    PNG 视口拿的就是它们；
 * 4. **状态属性与屏上同源**：远程图被拦时交付物里仍是那张占位卡，这是锁定口径。
 *
 * 时序按生产走：菜单点击只发 `export.request`，Host 确认落盘位置后才回 `export.capture`
 * （夹具经 `__readora.exportCapture` 扮演那一步），View 序列化后回 `export.data`。
 * 因此这里断言的载荷就是真 Host 会写进文件的那一份。
 */
import { expect, test, type Page } from "@playwright/test";
import type { ExportDataPayload, ExportFormat } from "@readora/contracts";
import { RICH_DOC, openReader, viewMessages } from "../helpers/reader";

/** `viewMessages` 交出的是整条信封，载荷在这一格里。 */
interface ExportDataMessage {
  payload: ExportDataPayload;
}

interface ExportRequestMessage {
  payload: { format: ExportFormat };
}

/** 只服务导出用例的一篇文档：代码块、图表、本地与远程图、可滚长度各有其一。 */
const CODE_DOC = [
  "# Code Export",
  "",
  "Intro paragraph above the block so the editor has to be scrolled into view.",
  "",
  "```typescript",
  "export function pick(items: string[]): number {",
  "  const index = items.indexOf('zebra');",
  "  return index;",
  "}",
  "```",
  ""
].join("\n");

const DIAGRAM_DOC = [
  "# Diagram Export",
  "",
  "```mermaid",
  "graph TD",
  "  A[Start] --> B{Done?}",
  "  B -->|yes| C[Ship]",
  "```",
  ""
].join("\n");

const REMOTE_IMAGE_DOC = [
  "# Remote Image Export",
  "",
  "![remote](https://example.invalid/shot.png)",
  ""
].join("\n");

/** 走一遍「Host 确认了路径 → 来取帧」，返回 View 交回的那一帧。 */
async function captureFrame(
  page: Page,
  requestId = "e2e-export",
  format: ExportFormat = "html"
): Promise<ExportDataPayload> {
  await page.evaluate(
    ({ id, kind }) => window.__readora.exportCapture(id, kind),
    { id: requestId, kind: format }
  );
  // 序列化是同步的，但 `export.capture` 的投递与 React 订阅调度之间有帧际，
  // 所以拿 web-first 轮询而不是读一次就算数。
  await expect
    .poll(async () => (await viewMessages(page, "export.data")).length, { timeout: 10_000 })
    .toBeGreaterThan(0);
  const frames = await viewMessages<ExportDataMessage>(page, "export.data");
  const frame = frames.at(-1);
  if (frame === undefined) {
    throw new Error("export.capture 之后没有等到 export.data");
  }
  return frame.payload;
}

/** 导出一句话只发的 `export.request` 载荷。 */
async function requestedFormats(page: Page): Promise<ExportFormat[]> {
  const requests = await viewMessages<ExportRequestMessage>(page, "export.request");
  return requests.map((entry) => entry.payload.format);
}

/** 正文容器上的真实读数，用作「量出来的数不是 0」的对照。 */
function liveMetrics(page: Page): Promise<{ scrollHeight: number; canvasWidth: number }> {
  return page.evaluate(() => {
    const container = document.querySelector<HTMLElement>(".readora-document");
    const canvas = document.querySelector<HTMLElement>("main.readora-canvas");
    return {
      scrollHeight: container?.scrollHeight ?? 0,
      canvasWidth: canvas?.offsetWidth ?? 0
    };
  });
}

const TRIGGER = '[data-readora-export-menu]';

test.describe("顶栏 Export 菜单", () => {
  test("打开是三项菜单，选 PDF 只发一条 export.request，菜单随即收起", async ({ page }) => {
    await openReader(page);
    const trigger = page.locator(TRIGGER);
    await expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    await expect(trigger).toHaveAttribute("aria-expanded", "false");

    await trigger.click();
    const menu = page.getByRole("menu", { name: "Export document" });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("menuitem")).toHaveCount(3);
    await expect(trigger).toHaveAttribute("aria-expanded", "true");

    await menu.getByRole("menuitem", { name: "Export as PDF" }).click();
    expect(await requestedFormats(page)).toEqual(["pdf"]);
    // View 不因为「用户点了菜单」就假定写盘被授权：这里一个字节都不该本地序列化。
    expect(await viewMessages(page, "export.data")).toHaveLength(0);
    await expect(menu).toHaveCount(0);
  });

  test("键盘全程可达：Enter 开、方向键走、Enter 选、Esc 关并把焦点还给触发器", async ({ page }) => {
    await openReader(page);
    const trigger = page.locator(TRIGGER);
    await trigger.focus();
    await trigger.press("Enter");
    await expect(page.getByRole("menu", { name: "Export document" })).toBeVisible();

    // 挂载时焦点收在菜单容器上：首枚方向键落在第一项（`role="menu"` 的读屏预期），
    // 再下一枚才巡回 —— 与 `ReaderSettingsDialog` 的环转同一口径。
    await page.keyboard.press("ArrowDown");
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.textContent ?? ""))
      .toBe("Export as HTML");
    await page.keyboard.press("ArrowDown");
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.textContent ?? ""))
      .toBe("Export as PDF");

    await page.keyboard.press("Enter");
    expect(await requestedFormats(page)).toEqual(["pdf"]);

    // 焦点归还触发器是 `ReaderSettingsDialog` 那套 a11y 契约的一部分：
    // 菜单关掉后还停在已卸载的节点上，键盘用户就得从头找一遍顶栏。
    await trigger.click();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu", { name: "Export document" })).toHaveCount(0);
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.getAttribute("data-readora-export-menu")))
      .toBe("true");
  });

  test("专注模式下顶栏整体收起，导出不可达（锁定口径：不新增第二条入口）", async ({ page }) => {
    await openReader(page);
    await page.evaluate(() => window.__readora.setViewState({ focusMode: true }));
    await expect(page.locator(TRIGGER)).toHaveCount(0);
  });
});

test.describe("export.capture → export.data 的那一帧", () => {
  test("载荷与屏上同源：requestId / format / documentUri / version 全部对得上", async ({ page }) => {
    await openReader(page, { text: RICH_DOC, documentUri: "file:///vault/e2e/reader.md", version: 7 });
    const frame = await captureFrame(page, "req-42", "html");
    expect(frame.requestId).toBe("req-42");
    expect(frame.format).toBe("html");
    expect(frame.documentUri).toBe("file:///vault/e2e/reader.md");
    expect(frame.version).toBe(7);
    expect(frame.bodyHtml).toContain("Reader Guide");
  });

  test("同一个 requestId 重复取帧不会导出第二帧（陈旧 capture 不得触发第二次序列化）", async ({ page }) => {
    await openReader(page);
    await captureFrame(page, "req-once");
    await page.evaluate(() => window.__readora.exportCapture("req-once", "html"));
    await page.waitForTimeout(150);
    expect(await viewMessages(page, "export.data")).toHaveLength(1);
  });

  test("CodeMirror 宿主被摘干净，静态 <pre> 文本一字不少", async ({ page }) => {
    await openReader(page, { text: CODE_DOC });
    // 接管层是滚动懒挂载的：不滚就摘不到东西，用例就成了自证。
    await page.locator(".readora-code-block").first().scrollIntoViewIfNeeded();
    await expect
      .poll(() => page.evaluate(() => document.querySelectorAll(".readora-code-editor").length), {
        timeout: 10_000
      })
      .toBeGreaterThan(0);
    await expect(page.locator(".readora-code-block").first()).toHaveAttribute(
      "data-readora-code-editor-state",
      "mounted"
    );
    // 屏上静态视图的文本：它就是我们期待在交付物里重现的那一段（而不是另一串手增的期望值）。
    const staticText = await page.evaluate(
      () => document.querySelector(".readora-code-pre")?.textContent ?? ""
    );
    expect(staticText).toContain("zebra");

    const frame = await captureFrame(page);
    expect(frame.bodyHtml).not.toContain("readora-code-editor");
    expect(frame.bodyHtml).not.toContain("data-readora-code-editor-state");
    expect(frame.bodyHtml).not.toContain("readora-code-copy");
    // 删属性而不是改 CSS：静态视图本来就在 DOM 里，靠那条隐藏规则失去成立而回到可见。
    expect(frame.bodyHtml.replace(/<[^>]*>/gu, "")).toContain(staticText);
    // 屏上的编辑器不能被这一次序列化扰动（交付物是克隆件）。
    await expect(page.locator(".readora-code-editor")).not.toHaveCount(0);
  });

  test("图表的内联 SVG 原样带走，工具栏与全屏视图态不进文件", async ({ page }) => {
    await openReader(page, { text: DIAGRAM_DOC });
    const block = page.locator(".readora-diagram");
    await expect(block).toHaveAttribute("data-readora-diagram-state", "rendered", {
      timeout: 30_000
    });
    const svgLength = await block
      .locator(".readora-diagram-container svg")
      .evaluate((node) => node.outerHTML.length);

    await page.locator('[data-readora-diagram-action="fullscreen"]').first().click();
    await expect(block).toHaveClass(/readora-diagram--fullscreen/);

    const frame = await captureFrame(page);
    expect(frame.bodyHtml).toContain("readora-diagram-container");
    expect(frame.bodyHtml).toContain('data-readora-diagram-state="rendered"');
    expect(frame.bodyHtml).not.toContain("readora-diagram-toolbar");
    expect(frame.bodyHtml).not.toContain("data-readora-diagram-action");
    expect(frame.bodyHtml).not.toContain("readora-diagram--fullscreen");
    // 「原样带走」是可量的：SVG 子树一段不少（工具栏那几枚图标不在容器里）。
    expect(frame.bodyHtml.length).toBeGreaterThan(svgLength);
    expect((frame.bodyHtml.match(/<svg/gu) ?? []).length).toBeGreaterThan(0);
  });

  test("被策略拦住的远程图导出仍是占位卡：没有 src，也没有那条 M3 提示行", async ({ page }) => {
    await openReader(page, { text: REMOTE_IMAGE_DOC });
    const image = page.locator(".readora-image");
    await expect(image).toHaveAttribute("data-readora-image-state", "blocked");
    // 占位卡里的 `<img>` 不带 src：屏上就没有像素，文件里也不该去请求任何东西。
    await expect(image.locator("img")).not.toHaveAttribute("src");

    const frame = await captureFrame(page);
    expect(frame.bodyHtml).toContain('data-readora-image-state="blocked"');
    expect(frame.bodyHtml).toContain("https://example.invalid/shot.png");
    expect(frame.bodyHtml).not.toContain("src=");
    // 提示行只服务接管期，交付物里留着它等于把内部里程碑写给读者看。
    expect(frame.bodyHtml).not.toContain("readora-image-hint");
  });

  test("rootStyleText 就是屏上那一帧的三个偏好变量（缩放已折进字号）", async ({ page }) => {
    await openReader(page);
    await page.evaluate(() => window.__readora.setPreferences({ fontSize: 20, lineHeight: 1.9 }));
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            getComputedStyle(document.documentElement).getPropertyValue("--readora-font-size").trim()
        )
      )
      .toBe("20px");

    const frame = await captureFrame(page);
    const live = await page.evaluate(() => {
      const style = getComputedStyle(document.documentElement);
      return {
        fontSize: style.getPropertyValue("--readora-font-size").trim(),
        lineHeight: style.getPropertyValue("--readora-line-height").trim(),
        contentWidth: style.getPropertyValue("--readora-content-width").trim()
      };
    });
    expect(frame.rootStyleText).toBe(
      `--readora-font-size: ${live.fontSize}; --readora-line-height: ${live.lineHeight}; --readora-content-width: ${live.contentWidth}`
    );
  });

  test("contentHeightPx 与 canvasWidthPx 是真量出来的（PNG 视口的两个入参）", async ({ page }) => {
    const sections = 14;
    const body = Array.from({ length: sections }, (_unused, index) =>
      [`## Section ${index + 1}`, "", `Paragraph ${index + 1}.`, ""].join("\n")
    ).join("\n");
    await openReader(page, { text: `# Long Export\n\n${body}` });
    await expect(page.locator(".readora-document h2")).toHaveCount(sections);

    const frame = await captureFrame(page);
    const live = await liveMetrics(page);
    expect(frame.contentHeightPx).toBeGreaterThan(1_000);
    expect(frame.contentHeightPx).toBe(live.scrollHeight);
    expect(frame.canvasWidthPx).toBe(live.canvasWidth);
    expect(frame.canvasWidthPx).toBeGreaterThan(0);
  });

  test("搜索高亮只降包裹不删字符：命中词在导出正文里仍然完整", async ({ page }) => {
    await openReader(page, { text: RICH_DOC });
    await page.keyboard.press("Control+f");
    await page.locator(".readora-search-input").fill("needle");
    const hits = page.locator(".readora-document mark[data-readora-search-id]");
    await expect(hits).not.toHaveCount(0);
    const marks = await hits.count();

    const frame = await captureFrame(page);
    expect(frame.bodyHtml).not.toContain("data-readora-search-id");
    expect(frame.bodyHtml).toContain("needle");
    // 高亮的包裹没了、字符还在：unwrap 只许降一层 <mark>。
    expect((frame.bodyHtml.match(/needle/gu) ?? []).length).toBeGreaterThanOrEqual(marks);
    await expect(hits).toHaveCount(marks);
  });
});
