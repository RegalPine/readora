/**
 * 公式、图片与图表在浏览器里的真实形态（IMP-001 §10.3 / ARC-008 §9 / EPIC-07）。
 *
 * 这三类产物的共同点：**渲染期之外还有加载期**。单测里 KaTeX 是纯函数、图片没有
 * 解码、图表引擎是假实现；浏览器里才有的失败模式是「woff2 没打到 → 公式用系统字
 * 糊成一团」「`<img>` 解码失败 → 状态从 ready 退回 missing」「mermaid 真的画出
 * svg，且切主题时重画」。这一组只断言这些只有真实布局与真实解码能回答的事。
 */
import { expect, test, type Locator, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { nextFrame, openReader } from "../helpers/reader";

/** 1×1 PNG：够让 `<img>` 真的走一遍解码，`naturalWidth` 为 1。 */
const PNG_1X1 =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const MATH_DOC = [
  "# Math",
  "",
  "行内公式 $E = mc^2$ 混在散文里。",
  "",
  "$$\\int_{0}^{1} x^{2}\\,dx = \\frac{1}{3}$$",
  "",
  "坏表达式 $\\thisisnotakatexcommand{unclosed$ 不能拖垮整篇。",
  ""
].join("\n");

const IMAGE_DOC = ["# Image", "", "![截图](./assets/shot.png)", ""].join("\n");

const DIAGRAM_DOC = [
  "# Diagram",
  "",
  "[Jump to system map](#system-map)",
  "",
  '```mermaid {diagram_id="system-map" diagram_title="System map"}',
  "graph TD",
  "  A[Start] --> B{Done?}",
  "  B -->|yes| C[Ship]",
  "```",
  ""
].join("\n");

/**
 * 一张**比正文栏宽**的图：Fit 只有在图溢出栏宽时才看得出它真的动了。
 *
 * 窄图（上面那张 130px）上未缩放态本来就装得下，点 Fit 前后 viewBox 一字不差，
 * 拿它做判据会让「Fit 什也没做」也能绿。
 */
const WIDE_DIAGRAM_DOC = [
  "# Wide Diagram",
  "",
  "```mermaid",
  "graph LR",
  "  A[A] --> B[B]",
  "  B --> C[C]",
  "  C --> D[D]",
  "  D --> E[E]",
  "  E --> F[F]",
  "  F --> G[G]",
  "  G --> H[H]",
  "  H --> I[I]",
  "  I --> J[J]",
  "  J --> K[K]",
  "  K --> L[L]",
  "  L --> M[M]",
  "  M --> N[N]",
  "```",
  ""
].join("\n");

test.describe("数学公式", () => {
  test("行内与块级各出一枚 KaTeX 根节点，非法表达式就地降级而不炸整篇", async ({ page }) => {
    await openReader(page, { text: MATH_DOC });

    const ok = page.locator('.readora-math[data-readora-math-status="ok"]');
    await expect(ok).toHaveCount(2);
    // `.katex` 是引擎自己的根：有它才说明真的走了一遍排版，而不只是留了个占位 span。
    await expect(ok.locator(".katex")).toHaveCount(2);
    await expect(ok.filter({ has: page.locator(".katex-display") })).toHaveCount(1);

    // 失败的那条降级成源码本身，且**同一篇里它后面的内容照常渲染**（§10.3 单条失败隔离）。
    const failed = page.locator('.readora-math[data-readora-math-status="error"]');
    await expect(failed).toHaveCount(1);
    await expect(failed).toContainText("thisisnotakatexcommand");
    await expect(page.locator(".readora-document h1")).toHaveText("Math");
  });

  test("公式字体真的按 katex 的 @font-face 加载（woff2 打进产物不等于用得上）", async ({ page }) => {
    await openReader(page, { text: MATH_DOC });
    await expect(page.locator('.readora-math[data-readora-math-status="ok"]').first()).toBeVisible();

    // KaTeX 的 .mi/.mfrac 等类名依赖 KaTeX_Main/Math 字体族；这里验字体族真的落到
    // 计算样式上，而不是只验 class 存在 —— 剥离 woff 后 class 一个不少，字形全错。
    const family = await page.evaluate(() => {
      const node = document.querySelector(".readora-math .katex-html");
      return node ? getComputedStyle(node).fontFamily : "";
    });
    expect(family).toContain("KaTeX_Main");

    const loaded = await page.evaluate(async () => {
      await document.fonts.ready;
      return [...document.fonts].filter((face) => face.family.startsWith("KaTeX")).length;
    });
    expect(loaded).toBeGreaterThan(0);
  });
});

test.describe("图片与 Lightbox", () => {
  test("Host 解析成功后补 src 并进入 ready，点击开 Lightbox、Escape 收回", async ({ page }) => {
    await openReader(
      page,
      { text: IMAGE_DOC },
      {
        resourceScript: {
          mode: "ok",
          result: { webviewUri: PNG_1X1, mimeType: "image/png", kind: "image" }
        }
      }
    );

    const figure = page.locator("[data-readora-image]");
    await expect(figure).toHaveAttribute("data-readora-image-state", "ready");
    // 解码过才算真的ready：naturalWidth 为 0 会被 image-layer 退回 missing。
    await expect
      .poll(() => figure.locator("img").evaluate((img) => (img as HTMLImageElement).naturalWidth))
      .toBe(1);

    await figure.click();
    const lightbox = page.locator('[data-readora-lightbox-state="open"]');
    await expect(lightbox).toBeVisible();
    await expect(lightbox).toHaveAttribute("role", "dialog");
    // Lightbox 里的图与正文是两处独立节点（正文那份被原地隐藏或保留都不影响这一份的 src）。
    await expect(lightbox.locator(".readora-lightbox-image")).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(lightbox).toHaveCount(0);
    // 关闭后焦点回到正文，键盘用户不该掉到 body 上从头 Tab。
    await expect(figure).toBeVisible();
  });

  test("解析失败的图就地给原因，不弹对话框也不留空白", async ({ page }) => {
    await openReader(
      page,
      { text: IMAGE_DOC },
      {
        resourceScript: {
          mode: "error",
          code: "readora.resource.notFound",
          message: "e2e: missing"
        }
      }
    );

    const figure = page.locator("[data-readora-image]");
    await expect(figure).toHaveAttribute("data-readora-image-state", "missing");
    await expect(figure.locator(".readora-image-hint")).toContainText("本地图片不存在或不可读");

    await figure.click();
    await expect(page.locator('[data-readora-lightbox-state="open"]')).toHaveCount(0);
  });
});

interface DiagramGeometry {
  host: { left: number; width: number };
  box: { left: number; width: number; height: number };
  ink: { left: number; top: number; width: number; height: number };
}

/**
 * 一次 `evaluate` 取齐三份几何：宿主栏宽、svg 元素盒、真正画出来的墨。
 *
 * 元素盒会跟着 letterbox 留白变（`preserveAspectRatio="meet"` 只在盒内等比缩放），
 * 所以「居中没居中」看元素盒、「有没有被拉形」只能看 `getBBox()` 过屏幕变换后的墨。
 */
async function geometryOf(host: Locator): Promise<DiagramGeometry> {
  return host.evaluate((node) => {
    const rectOf = (el: Element) => {
      const r = el.getBoundingClientRect();
      return { left: r.left, top: r.top, width: r.width, height: r.height };
    };
    const svg = node.querySelector("svg") as SVGSVGElement | null;
    if (!svg) {
      throw new Error("图表容器里没有 svg");
    }
    const ctm = svg.getScreenCTM();
    if (!ctm) {
      throw new Error("svg 尚未参与布局");
    }
    const bbox = svg.getBBox();
    const point = svg.createSVGPoint();
    point.x = bbox.x;
    point.y = bbox.y;
    const origin = point.matrixTransform(ctm);
    const hostRect = rectOf(node);
    const svgRect = rectOf(svg);
    return {
      host: { left: hostRect.left, width: hostRect.width },
      box: { left: svgRect.left, width: svgRect.width, height: svgRect.height },
      ink: { left: origin.x, top: origin.y, width: bbox.width * ctm.a, height: bbox.height * ctm.d }
    };
  });
}

/** 开一篇只有一张图的文档，并等到它真的画完（懒挂载 + mermaid 动态载入都要时间）。 */
async function openDiagram(page: Page, text: string): Promise<Locator> {
  await openReader(page, { text });
  const block = page.locator(".readora-diagram");
  await expect(block).toHaveCount(1);
  await expect(block).toHaveAttribute("data-readora-diagram-state", "rendered", {
    timeout: 30_000
  });
  return block;
}

/**
 * 缩放状态的浏览器读数：viewBox + 「一个图纸单位等于几个 CSS 像素」。
 *
 * 引擎的缩放只改 viewBox 与内联尺寸，所以 `getScreenCTM().a` 才是倍率的直接判据；
 * 只看元素盒宽度的话缩放前后的读数都等于栏宽（实测同为 754px），恰好把要量的区别抹平。
 */
async function zoomReadingOf(block: Locator): Promise<{ viewBox: string; unitPx: number }> {
  return block.locator(".readora-diagram-container svg").evaluate((node) => {
    const svg = node as SVGSVGElement;
    const ctm = svg.getScreenCTM();
    return { viewBox: svg.getAttribute("viewBox") ?? "", unitPx: ctm ? ctm.a : Number.NaN };
  });
}

/**
 * 等读数不再变之后才拿它当基准（未缩放态的 viewBox 宽与 width 属性都靠它）。
 *
 * 本文件头注点名的就是字体加载这件事：未缩放态的图纸宽度是引擎按 SVG 文字量出来的，
 * woff2 换版会改这份度量 —— 实测并行负载下首读 131、换版后 130。拿未落定的读数
 * 当基准，「缩放后一字不差复原」就会偶发红，而且红得像是产品的缩放有残留。
 */
async function settledZoomReading(
  page: Page,
  block: Locator
): Promise<{ viewBox: string; unitPx: number }> {
  let previous = await zoomReadingOf(block);
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await nextFrame(page);
    const current = await zoomReadingOf(block);
    if (current.viewBox === previous.viewBox) {
      return current;
    }
    previous = current;
  }
  return previous;
}

/** viewBox 串里的可视宽度（`min-x min-y w h` 的第三项）。 */
function viewBoxWidth(viewBox: string): number {
  return Number(viewBox.split(/\s+/)[2]);
}

test.describe("图表", () => {
  test("标题锚点可定位，SVG / PNG 可下载并以图表标题命名", async ({ page }) => {
    await openReader(page, { text: DIAGRAM_DOC });
    const block = page.locator(".readora-diagram");
    await expect(block).toHaveAttribute("data-readora-diagram-state", "rendered", { timeout: 30_000 });
    await expect(block.locator(".readora-diagram-filename")).toHaveText("System map");

    // 该阅读器在内容容器内处理锚点并移动焦点，URL hash 保持不变。
    await block.evaluate((node) => { node.scrollIntoView = () => {}; });
    await page.locator('a[href="#system-map"]').click();
    await expect(block).toBeFocused();

    const svgDownloadPromise = page.waitForEvent("download");
    await block.locator('[data-readora-diagram-action="export-svg"]').click();
    const svgDownload = await svgDownloadPromise;
    expect(svgDownload.suggestedFilename()).toBe("System-map.svg");
    const svgPath = await svgDownload.path();
    expect(svgPath).not.toBeNull();
    const svg = await readFile(svgPath!);
    expect(svg.toString("utf8")).toContain("<svg");
    expect(svg.toString("utf8")).toContain("style=");

    const pngDownloadPromise = page.waitForEvent("download");
    await block.locator('[data-readora-diagram-action="export-png"]').click();
    const pngDownload = await pngDownloadPromise;
    expect(pngDownload.suggestedFilename()).toBe("System-map.png");
    const pngPath = await pngDownload.path();
    expect(pngPath).not.toBeNull();
    const png = await readFile(pngPath!);
    expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  });

  test("mermaid 真的画出 svg，且切主题时按新配色重画", async ({ page }) => {
    await openReader(page, { text: DIAGRAM_DOC });

    const block = page.locator(".readora-diagram");
    await expect(block).toHaveCount(1);
    // 引擎要动态载 mermaid：给足时间，但仍以状态位为准（pending → mounting → rendered）。
    await expect(block).toHaveAttribute("data-readora-diagram-state", "rendered", {
      timeout: 30_000
    });
    // 工具栏里的全屏图标也是 `svg`，所以取图一律从容器往下拿（下面那三条缩放用例同一口径）。
    const diagramSvg = block.locator(".readora-diagram-container svg");
    await expect(diagramSvg).toBeVisible();

    const svgId = await diagramSvg.evaluate((node) => {
      const marker = node as HTMLElement;
      marker.dataset.readoraE2eSvg = "first";
      return marker.outerHTML.length;
    });
    expect(svgId).toBeGreaterThan(0);

    await page.evaluate(() => window.__readora.setTheme("dark"));
    await expect(block).toHaveClass(/readora-diagram--dark/);
    // 重画后仍处在 rendered：只换个 class、图停在旧配色是 F07-* 的老毛病。
    await expect(block).toHaveAttribute("data-readora-diagram-state", "rendered");
    const repainted = await diagramSvg.evaluate((node) => (node as HTMLElement).outerHTML.length);
    expect(repainted).toBeGreaterThan(0);
  });

  test("图在栏内水平居中，且引擎不自带浮层缩放控件抢栏宽", async ({ page }) => {
    await openReader(page, { text: DIAGRAM_DOC });

    const block = page.locator(".readora-diagram");
    await expect(block).toHaveAttribute("data-readora-diagram-state", "rendered", {
      timeout: 30_000
    });
    // Pele 自带的缩放按钮组会给 svg 写下 `max-width` + `margin-right` 给自己让位，
    // 栏宽被吃掉一截后图永远贴左。zoom-in / out / fit / reset 归图表工具栏
    // （ARC-003 §7.3 偏差 D-5），Adapter 以 `controls: false` 关掉那组重复入口。
    // 这条只有真实布局能证：jsdom 不出宽度，写入不会发生。
    await expect(block.locator(".pele-zoom")).toHaveCount(0);

    const geometry = await geometryOf(block.locator(".readora-diagram-container"));
    // 前置条件：图比栏窄，否则两侧无空档，“居中”无从判断。
    expect(geometry.box.width).toBeLessThan(geometry.host.width);
    const left = geometry.box.left - geometry.host.left;
    expect(Math.abs(left - (geometry.host.width - geometry.box.width - left))).toBeLessThan(2);
  });

  test("点 Fullscreen 后图自动缩放到可用画面，退出还原", async ({ page }) => {
    await openReader(page, { text: DIAGRAM_DOC });

    const block = page.locator(".readora-diagram");
    await expect(block).toHaveAttribute("data-readora-diagram-state", "rendered", {
      timeout: 30_000
    });
    const container = block.locator(".readora-diagram-container");
    const inline = await geometryOf(container);

    await block.locator('[data-readora-diagram-action="fullscreen"]').click();
    await expect(block).toHaveClass(/readora-diagram--fullscreen/);
    const full = await geometryOf(container);

    const viewport = page.viewportSize() ?? { width: 1_280, height: 720 };
    // “自动缩放”的判据是画布真的变大了，而不是只换了个外壳。
    expect(full.ink.width).toBeGreaterThan(inline.ink.width);
    expect(full.box.width).toBeLessThanOrEqual(viewport.width);
    expect(full.box.height).toBeLessThanOrEqual(viewport.height);
    // 等比：墨的宽高比偏移超过 2% 就是被拉形了。
    const ratio = inline.ink.width / inline.ink.height;
    expect(Math.abs(full.ink.width / full.ink.height - ratio) / ratio).toBeLessThan(0.02);

    await block.locator('[data-readora-diagram-action="fullscreen"]').click();
    await expect(block).not.toHaveClass(/readora-diagram--fullscreen/);
    const back = await geometryOf(container);
    expect(Math.abs(back.box.width - inline.box.width)).toBeLessThan(2);
  });

  /**
   * 工具栏三枚缩放按钮真的动手（用户报「放大缩小 Fit 点击没反应」）。
   *
   * 基准必须钉在**比栏窄的图**上：引擎的 zoomBy / zoomTo 在 `zoom: "auto"`（只在溢出
   * 时接管）下对窄图直接 early-return，按钮点了静默失败（实测 130×401 的图
   * 几档点击前后 viewBox 一字不动）；宽图本来就走溢出分支，拿它做用例测不出这个缺陷。
   */
  test("＋ / － 真的改画布：未溢出的窄图也能缩放", async ({ page }) => {
    const block = await openDiagram(page, DIAGRAM_DOC);

    const initial = await settledZoomReading(page, block);
    // 前置条件：未缩放态就是 1:1（图比栏窄，没被 CSS 缩过）。
    expect(initial.unitPx).toBeCloseTo(1, 2);

    await block.locator('[data-readora-diagram-action="zoom-in"]').click();
    // 倍率也要 poll，不能只读一次：引擎把缩放写进 viewBox 与内联尺寸，`getScreenCTM()`
    // 读的是**布局落定之后**的矩阵，并行负载下点击后立刻取会拿到过渡值（实测窄图用例
    // 在多 worker 并跑时会读到 1.0，单跑必绿）。下面那条 viewBox 复原本来就 poll。
    await expect
      .poll(() => zoomReadingOf(block).then((reading) => reading.unitPx), { timeout: 5_000 })
      .toBeCloseTo(1.25, 2);
    const zoomed = await zoomReadingOf(block);
    // ＋ 一档 = ZOOM_IN_FACTOR：1.25 个 CSS 像素对一个图纸单位，且画布真的动了。
    expect(zoomed.viewBox).not.toBe(initial.viewBox);
    expect(zoomed.unitPx).toBeCloseTo(1.25, 2);

    await block.locator('[data-readora-diagram-action="zoom-out"]').click();
    // 回到下限时引擎直接退回未缩放态（拆掉内联尺寸），viewBox 得一字不差地复原。
    await expect
      .poll(() => zoomReadingOf(block).then((reading) => reading.viewBox))
      .toBe(initial.viewBox);
  });

  /**
   * Fit 原先与 1:1 是两个动作（用户问过「1:1 与 fit 有什么区别？」），
   * 现在按产品反馈只留 Fit。
   *
   * 两者的区别在宽图上才存在：引擎的未缩放态被 `max-width: 100%` 夹成 fit，
   * `zoomTo(fit)` 落在区间下限、于是退回未缩放态，实测窄图两个按钮点出的 viewBox 同为
   * `0 0 1159 64`；而 1:1（`zoomTo(1)`）在窄图上与 Fit 完全同义，多一个按钮只是让人猜。
   * 这里拿宽图取证「Fit 真的看得到全图」，并反向断言 1:1 那枚不再存在。
   */
  test("宽图靠 Fit 看全图；1:1 已下掉，不再摆第二枚归位按钮", async ({ page }) => {
    const block = await openDiagram(page, WIDE_DIAGRAM_DOC);
    const svg = block.locator(".readora-diagram-container svg");
    // 先等换版落定再读自然宽：width 属性是引擎量出来的，换版后会重算。
    await settledZoomReading(page, block);
    const natural = Number(await svg.getAttribute("width"));
    const column = await block.locator(".readora-diagram-container").evaluate((node) => node.clientWidth);
    // 前置条件：图比栏宽，否则 Fit 退化成了 100%。
    expect(natural).toBeGreaterThan(column);

    await block.locator('[data-readora-diagram-action="zoom-in"]').click();
    await block.locator('[data-readora-diagram-action="fit"]').click();
    const fitted = await zoomReadingOf(block);
    // Fit：整图都装得下 → 可视宽度 == 图纸自然宽，一个单位不足一个像素。
    expect(viewBoxWidth(fitted.viewBox)).toBeCloseTo(natural, 0);
    expect(fitted.unitPx).toBeLessThan(0.9);

    // 只留一档归位：原来的 1:1 按钮不入工具栏（单测同样反向断言过，两边别漂移）。
    await expect(block.locator('[data-readora-diagram-action="reset"]')).toHaveCount(0);

    // 拖动不在这里测：那是引擎隐式提供的交互（ARC-003 §7.3 注 1），
    // 已固化在 diagram-core 的兼容性用例里。
  });

  test("工具栏靠右收尾，全屏是一枚带名字的图标", async ({ page }) => {
    const block = await openDiagram(page, DIAGRAM_DOC);
    const chrome = await block.locator(".readora-diagram-toolbar").evaluate((bar) => {
      const buttons = [...bar.querySelectorAll("button")];
      const first = buttons[0].getBoundingClientRect();
      const last = buttons[buttons.length - 1].getBoundingClientRect();
      const host = bar.getBoundingClientRect();
      const fullscreen = buttons.find(
        (button) => button.getAttribute("data-readora-diagram-action") === "fullscreen"
      );
      return {
        count: buttons.length,
        leftGap: first.left - host.left,
        rightGap: host.right - last.right,
        text: fullscreen?.textContent ?? null,
        hasIcon: fullscreen?.querySelector("svg.readora-icon") !== null,
        label: fullscreen?.getAttribute("aria-label") ?? null
      };
    });

    expect(chrome.count).toBe(7);
    // 沿右：最后一个按钮贴右沿，首按钮左侧留出大段空白（图在栏内居中）。
    expect(chrome.rightGap).toBeLessThan(2);
    expect(chrome.leftGap).toBeGreaterThan(100);
    // 图标不承载文案，但名字要在：否则读屏器面对一个空按钮。
    expect(chrome.text).toBe("");
    expect(chrome.hasIcon).toBe(true);
    expect(chrome.label).toBe("Fullscreen");
  });

  test("连线宽度走 Token，暗色下换的是看得见的浅色线", async ({ page }) => {
    const block = await openDiagram(page, DIAGRAM_DOC);
    const readEdge = async (): Promise<{ width: string; stroke: string }> =>
      block.locator(".pele-edge > path:not(.pele-marker)").first().evaluate((node) => {
        const style = getComputedStyle(node);
        return { width: style.strokeWidth, stroke: style.stroke };
      });

    const light = await readEdge();
    // 引擎不写 stroke-width，全部落在 SVG 初始的 1px；加粗只能由 Token 接管。
    expect(Number.parseFloat(light.width)).toBeGreaterThanOrEqual(1.4);

    await page.evaluate(() => window.__readora.setTheme("dark"));
    await expect(block).toHaveClass(/readora-diagram--dark/);
    const dark = await readEdge();
    expect(dark.width).toBe(light.width);
    // 边线色一直没进主题映射，两套主题都是 #1f1f1f：暗色下几乎看不见。现在它跟正文色走。
    expect(dark.stroke).not.toBe(light.stroke);
  });
});
