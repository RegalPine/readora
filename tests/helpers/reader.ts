/**
 * e2e / integration 用例的共享入口（IMP-003 §7.1）。
 *
 * 只有一件事住在这里：**按生产时序把阅读器开到「有一篇文档」的状态**。
 * 每个 spec 自己重写一遍 goto + ready 等待，等于把门控时序复制了 N 份，
 * 将来时序改了要改一片文件，而且很可能只改对一半。
 *
 * 控制器类型直接 `import type` 夹具自己导出的 `E2EHost`：夹具改一个方法名，
 * 这里立刻编译不过，而不是等用例在浏览器里报 undefined。
 */
import { expect, type Page } from "@playwright/test";
import type { MessageType } from "@readora/contracts";
import type {
  E2EHost,
  NavigateScript,
  ResourceScript
} from "../../apps/webview/dev/e2e";

export const FIXTURE_URL = "/dev/e2e.html";

export interface DocInput {
  text: string;
  documentUri?: string;
  version?: number;
}

declare global {
  interface Window {
    __readora: E2EHost;
  }
}

/** 一份够用的文档：标题层级、代码、表格、列表、链接各有其一，搜索与大纲才有的可测。 */
export const RICH_DOC = [
  "# Reader Guide",
  "",
  "The quick brown fox jumps over the lazy dog.",
  "",
  "## Outline behaviour",
  "",
  "Clicking an entry scrolls the document to the matching heading.",
  "",
  "### Nested detail",
  "",
  "- first bullet with **needle**",
  "- second bullet",
  "",
  "```ts",
  "const needle = 42;",
  "```",
  "",
  "| Column | Value |",
  "| --- | --- |",
  "| needle | 42 |",
  "",
  "[外部链接](https://example.com/needle) 与 `needle` 行内代码。",
  "",
  // 字面量 `a.b` 与 `axb` 同时在场：查询串里那个点要是被当成正则元字符，
  // 命中数就会从 1 变 2 —— 这一条比「填个 ( 不炸」更能证明搜索是字面量匹配。
  "Literal `a.b` sits beside axb in the same paragraph.",
  "",
  "## Search scope",
  "",
  "Search only covers the current document.",
  ""
].join("\n");

/**
 * 造一条形状**合法**的 host→view 信封，只让 payload 出问题。
 *
 * `MessageEnvelopeSchema` 是 `strictObject`：多写一个 `direction` 字段就会被信封
 * 校验先丢掉。那样的用例看着在测 payload 护栏，实际测的是信封护栏 —— 注释与
 * 被验的代码不是同一件事。要测 payload，就得先把 `{id, type, version, payload}`
 * 四键做对，并且配一条同形状但合法的对拍照证明这条通道本身是通的。
 */
export function hostMessage(
  type: string,
  payload: unknown
): { id: string; type: string; version: 1; payload: unknown } {
  return { id: `raw-${type}`, type, version: 1 as const, payload };
}

/**
 * 打开夹具页并等到正文出现。
 *
 * 顺序刻意是「先 load 再等 ready」：`load` 在 `reader.ready` 之前到达会被脚本化
 * Host 排队，这正是 ARC-004 §8.7 的门控形态。反过来说，这里永远测不到
 * 「ready 之前就把快照投出去」那条错误路径 —— 那条由 `tests/integration` 里
 * 直接调 `postRaw` 的用例覆盖。
 */
export interface OpenOptions {
  /** 在 `load` **之前**装好：快照投出去之后再改就来不及（懒加载可能已问过并记住失败）。 */
  resourceScript?: ResourceScript;
  navigateScript?: NavigateScript;
}

export async function openReader(
  page: Page,
  doc: DocInput = { text: RICH_DOC },
  scripts: OpenOptions = {}
): Promise<void> {
  await page.goto(FIXTURE_URL);
  await page.waitForFunction(() => typeof window.__readora === "object");
  if (scripts.resourceScript) {
    await page.evaluate((script) => window.__readora.setResourceScript(script), scripts.resourceScript);
  }
  if (scripts.navigateScript) {
    await page.evaluate((script) => window.__readora.setNavigateScript(script), scripts.navigateScript);
  }
  await page.evaluate(async (input) => {
    window.__readora.load(input);
    await window.__readora.ready();
  }, doc);
  await expect(page.locator(".readora-document")).toBeVisible();
}

/**
 * 一份**足够长**的文档：滚动恢复、进度百分比这类断言要求页面真的可滚，
 * 短文档上 `scrollTo(700)` 会被浏览器夹回 0，用例就会假绿。
 */
export function longDoc(sections = 12): string {
  const body = Array.from({ length: sections }, (_unused, index) => {
    const number = index + 1;
    return [
      `## Section ${number}`,
      "",
      `Paragraph for section ${number}. ${"Filler text keeps the block tall enough to scroll. ".repeat(6)}`,
      ""
    ].join("\n");
  });
  return ["# Long Guide", "", "Intro paragraph.", "", ...body].join("\n");
}

/** 读 View 发给 Host 的某类消息（断言 config.patch / metrics.report / document.navigate）。 */
export async function viewMessages<T = unknown>(page: Page, type: MessageType): Promise<T[]> {
  return page.evaluate((kind) => window.__readora.messages(kind) as unknown as T[], type);
}

/**
 * 触发一次滚动并**等它落定**，返回落定后的 scrollY。
 *
 * 为什么不滚动完就直接读：首屏之后还有字体换版、公式与图表异步插入这些会改变文档
 * 高度的动作，未落定的读数当基线，后面「位置没变」的断言就会偶发失败 ——
 * 而且失败得像是产品的错。返回值让用例不必自己再读一次。
 */
export async function scrollTo(page: Page, top: number): Promise<number> {
  await page.evaluate((value) => {
    window.scrollTo({ top: value, behavior: "auto" });
  }, top);

  let previous = -1;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await nextFrame(page);
    const current = await page.evaluate(() => window.scrollY);
    if (current === previous) {
      return current;
    }
    previous = current;
  }
  return previous;
}

/** 等一帧：让「DOM 已写入但浏览器还没画」这类中间态落定。 */
export async function nextFrame(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => resolve());
        });
      })
  );
}
