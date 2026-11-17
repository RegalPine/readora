#!/usr/bin/env node
/**
 * M11 导出链路的一次性取证（**不进门禁链**，人跑给自己看的那一步）。
 *
 * 为什么门禁绿了还要这一步：`pnpm test` 里 Host 侧全是端口替身，`pnpm test:e2e` 验的是
 * View 交回的载荷形状。两者都没有回答「真浏览器里那枚按钮长什么样」「真 Chrome 拿到那份
 * HTML 会不会出个能看的 PDF」。这一脚把五个问题换成实测数字：
 *
 * 1. 顶栏：动作区控件顺序、触发器包围盒、菜单三项、键盘环、专注模式下不可达；
 * 2. 载荷：`export.capture` 之后 View 交回的八字段（含量高与画布宽的真实读数）；
 * 3. 交付物：用**生产源码** + 真 `dist/webview/assets` 组装出的单文件字节与残留计数；
 * 4. 渲染：`file://` 直开交付物，记录每一个非 `file://` 请求（应当为 0）；
 * 5. PDF / PNG：本机 Chrome CLI 真跑的退出码、页数、MediaBox、内嵌字体、像素尺寸。
 *
 * 住在 `scripts/` 而不是 `test-results/` 是有原因的：后者是 `playwright.config.ts` 的
 * `outputDir`，**每次 `pnpm test:e2e` 都会把它整个清空**。取证脚本放那儿等于活不过下一次
 * 门禁，而这里印出来的每个数字都会被 README / release notes 引用。
 *
 * 用法：`node scripts/export-evidence.mjs`（`EVIDENCE_URL` 可指向已在跑的 dev server；
 * 端口没人监听时本脚本自己起一个并在结束时收掉）。产物写 `test-results/export-evidence/`。
 * 退出码：任何一段取证抛错 → 1。
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import zlib from "node:zlib";
import { killToolTree, spawnTool } from "./lib/run-tool.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "test-results", "export-evidence");
const ASSET_DIR = join(ROOT, "apps/extension", "dist", "webview", "assets");
const PORT = 5199;
const BASE_URL = process.env.EVIDENCE_URL ?? `http://127.0.0.1:${PORT}/dev/e2e.html`;

/** 一份「五种块级形态同时在场」的样本：代码块、图表、表格、脚注、正文。 */
const DOC = [
  "# Export Evidence",
  "",
  "A paragraph above the fenced block so the CodeMirror host has to mount.",
  "",
  "```typescript",
  "export function pick(items: string[]): number {",
  "  const index = items.indexOf('zebra');",
  "  return index;",
  "}",
  "```",
  "",
  "```mermaid",
  "graph TD",
  "  A[Start] --> B{Done?}",
  "  B -->|yes| C[Ship]",
  "```",
  "",
  "| Column | Value |",
  "| --- | --- |",
  "| needle | 42 |",
  "",
  "A footnote marker[^1] sits in this sentence.",
  "",
  "[^1]: The footnote body, which the sanitizer moves into a list.",
  ""
].join("\n");

const report = {};
const log = (...args) => console.log(...args);

/** 把 extension 侧的一个生产源文件装进 Node：与 `tests/helpers/export-artifact.ts` 同口径。
 *
 * 这里的 `import("data:…")` 不是执行外来输入：字符串就是上一行 `buildSync` 从**本仓库自己
 * 的源文件**编出来的产物，与仓库里 `tests/helpers/export-artifact.ts`、
 * `tests/helpers/production-page.ts` 已有的同一手法（目的是让取证读的是生产代码而不是副本）。
 */
async function loadExtensionModule(relative) {
  const { buildSync } = await import("esbuild");
  const result = buildSync({
    entryPoints: [join(ROOT, relative)],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node24",
    write: false,
    // 导出层本身不 import vscode；这条 external 只是保险：万一有人日后从
    // `constants.ts` 那边牵进宿主 API，装载阶段就炸，而不是静默把宿主拖进来。
    external: ["vscode"],
    alias: { "@readora/contracts": join(ROOT, "packages", "contracts", "src", "index.ts") }
  });
  const code = result.outputFiles[0]?.text ?? "";
  return import(`data:text/javascript,${encodeURIComponent(code)}`);
}

/** dev server：已在跑就复用，否则起一个并在退出时收掉（`--strictPort` 让端口冲突当场可见）。 */
async function ensureServer() {
  const reachable = async () => {
    try {
      const response = await fetch(BASE_URL, { signal: AbortSignal.timeout(1500) });
      return response.ok;
    } catch {
      return false;
    }
  };
  if (await reachable()) {
    return { stop() {} };
  }
  const child = spawnTool(
    "pnpm",
    ["--filter", "@readora/webview", "dev", "--port", String(PORT), "--strictPort", "--host", "127.0.0.1"],
    { cwd: ROOT, stdio: "ignore", detached: true }
  );
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (await reachable()) {
      return {
        stop() {
          killToolTree(child);
        }
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  // 超时就先把刚起的树收掉再报错：不然取证失败一次就漏一个 vite 在后台占端口。
  killToolTree(child);
  throw new Error(`dev server 起来了但 ${BASE_URL} 始终不可达`);
}

/** 打开拓展夹具页并装载 `DOC`（顺序与 `tests/helpers/reader.ts` 一致：先 load 再等 ready）。 */
async function openReader(page) {
  await page.goto(BASE_URL);
  await page.waitForFunction(() => typeof window.__readora === "object");
  await page.evaluate(async (input) => {
    window.__readora.load(input);
    await window.__readora.ready();
  }, { text: DOC, documentUri: "file:///docs/evidence.md", version: 3 });
  await page.waitForSelector(".readora-document", { state: "visible" });
}

async function sectionTopbar(browser) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const consoleErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => consoleErrors.push(String(error)));
  await openReader(page);

  const order = await page.$$eval(".readora-topbar button", (nodes) =>
    nodes.map((node) => node.getAttribute("aria-label") ?? node.textContent?.trim() ?? "")
  );
  const trigger = page.locator("[data-readora-export-menu]");
  const box = await trigger.boundingBox();
  await page.screenshot({ path: join(OUT_DIR, "topbar.png"), clip: { x: 0, y: 0, width: 1280, height: 52 } });

  await trigger.click();
  const menu = page.getByRole("menu", { name: "Export document" });
  await menu.waitFor();
  const items = await menu.getByRole("menuitem").allTextContents();
  await page.screenshot({ path: join(OUT_DIR, "menu-open.png"), clip: { x: 720, y: 0, width: 560, height: 180 } });

  await page.keyboard.press("ArrowDown");
  const first = await page.evaluate(() => document.activeElement?.textContent?.trim() ?? null);
  await page.keyboard.press("ArrowUp");
  const wrapped = await page.evaluate(() => document.activeElement?.textContent?.trim() ?? null);
  await page.keyboard.press("Escape");
  const afterEscape = await page.evaluate(() => ({
    menuGone: document.querySelector('[role="menu"]') === null,
    focusBackOnTrigger: document.activeElement?.hasAttribute("data-readora-export-menu") ?? false
  }));

  // 菜单点击只发一条 request：View 不因「用户点了格式」就假定写盘被授权，一个字节都不本地序列化。
  await trigger.click();
  await page.getByRole("menuitem", { name: "Export as PDF" }).click();
  await page.waitForTimeout(300);
  const traffic = await page.evaluate(() => ({
    requests: window.__readora.messages("export.request").map((entry) => entry.payload.format),
    dataFrames: window.__readora.messages("export.data").length,
    menuClosed: document.querySelector('[role="menu"]') === null
  }));

  await page.getByRole("button", { name: "Enter focus mode" }).click();
  await page.waitForTimeout(250);
  const focusMode = await page.evaluate(() => ({
    exportTriggers: document.querySelectorAll("[data-readora-export-menu]").length,
    toolbarButtons: [...document.querySelectorAll(".readora-topbar button")].map(
      (node) => node.getAttribute("aria-label") ?? node.textContent?.trim() ?? ""
    )
  }));
  await page.screenshot({ path: join(OUT_DIR, "focus-mode.png"), clip: { x: 0, y: 0, width: 1280, height: 52 } });
  await page.getByRole("button", { name: "Exit focus mode" }).click();

  report.topbar = { order, triggerText: (await trigger.textContent())?.trim(), box, items, first, wrapped, afterEscape, traffic, focusMode, consoleErrors };
  log("[topbar] order=", JSON.stringify(order));
  log("[topbar] trigger=", JSON.stringify(box), "text=", report.topbar.triggerText);
  log("[menu] items=", JSON.stringify(items), "ArrowDown→", first, "ArrowUp→", wrapped, "Esc→", JSON.stringify(afterEscape));
  log("[traffic] ", JSON.stringify(traffic));
  log("[focus]  ", JSON.stringify(focusMode));
  log("[console] errors=", consoleErrors.length);
  await page.close();
}

/** 摘掉按钮前后各采一张，页内 canvas 求差；对照组是「DOM 不动连摄两张」，应当恒为 0 px。 */
async function measureRegion(browser, theme) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await openReader(page);
  if (theme !== "light") {
    await page.evaluate((kind) => window.__readora.setTheme(kind), theme);
    await page.waitForFunction(
      (kind) => document.documentElement.dataset.readoraTheme === kind,
      theme
    );
  }
  await page.waitForTimeout(400);
  const shot = () => page.screenshot({ clip: { x: 0, y: 0, width: 1280, height: 900 } });
  const withButton = await shot();
  const control = await shot();
  await page.evaluate(() => {
    document.querySelector("[data-readora-export-menu]")?.closest("button")?.remove();
  });
  const withoutButton = await shot();

  const diff = async (a, b) =>
    page.evaluate(async ([left, right]) => {
      const decode = async (base64) => {
        const bitmap = await createImageBitmap(
          await (await fetch(`data:image/png;base64,${base64}`)).blob()
        );
        const canvas = Object.assign(document.createElement("canvas"), {
          width: bitmap.width,
          height: bitmap.height
        });
        const ctx = canvas.getContext("2d");
        ctx.drawImage(bitmap, 0, 0);
        return { width: bitmap.width, height: bitmap.height, data: ctx.getImageData(0, 0, bitmap.width, bitmap.height).data };
      };
      const [x, y] = [await decode(left), await decode(right)];
      let changed = 0;
      const box = { x0: 1e9, y0: 1e9, x1: -1, y1: -1 };
      for (let i = 0; i < x.data.length; i += 4) {
        const same =
          x.data[i] === y.data[i] &&
          x.data[i + 1] === y.data[i + 1] &&
          x.data[i + 2] === y.data[i + 2] &&
          x.data[i + 3] === y.data[i + 3];
        if (same) continue;
        changed += 1;
        const px = (i / 4) % x.width;
        const py = Math.floor(i / 4 / x.width);
        box.x0 = Math.min(box.x0, px);
        box.y0 = Math.min(box.y0, py);
        box.x1 = Math.max(box.x1, px);
        box.y1 = Math.max(box.y1, py);
      }
      return { changed, total: x.width * x.height, box };
    }, [a.toString("base64"), b.toString("base64")]);

  const result = {
    theme,
    control: await diff(control, withButton),
    withVsWithout: await diff(withButton, withoutButton)
  };
  log(
    `[region:${theme}] control(应当是 0 px)=`,
    result.control.changed,
    "changed=",
    JSON.stringify(result.withVsWithout)
  );
  await page.close();
  return result;
}

async function sectionRegion(browser) {
  // light 与 dark 分开量：两档下那枚按钮的像素不同，只量一档就把另一档的数字当作同值
  // 是拿结论当证据（视觉基线是 10 档，本批重采影响了每一档）。
  report.region = [
    await measureRegion(browser, "light"),
    await measureRegion(browser, "dark")
  ];
}

async function sectionArtifact(browser, page) {
  // View 交回的那一帧：Host 只在用户选定路径之后才取，这里模拟的就是那一次。
  await page.evaluate(() => window.__readora.exportCapture("evidence-1", "html"));
  await page.waitForFunction(() => window.__readora.messages("export.data").length > 0, null, { timeout: 10_000 });
  const frame = (await page.evaluate(() => window.__readora.messages("export.data"))).at(-1).payload;
  report.capture = {
    requestId: frame.requestId,
    format: frame.format,
    documentUri: frame.documentUri,
    version: frame.version,
    bodyChars: frame.bodyHtml.length,
    rootStyleText: frame.rootStyleText,
    canvasWidthPx: frame.canvasWidthPx,
    contentHeightPx: frame.contentHeightPx,
    htmlAttrs: await page.evaluate(() => {
      const root = document.documentElement.dataset;
      return {
        theme: root.readoraTheme,
        scheme: root.readoraScheme,
        typography: root.readoraTypography,
        preset: root.readoraPreset
      };
    }),
    codeEditorNodes: (frame.bodyHtml.match(/readora-code-editor/g) ?? []).length,
    staticPrePresent: frame.bodyHtml.includes("readora-code-pre")
  };
  log("[capture] ", JSON.stringify(report.capture));

  const { composeExportHtml } = await loadExtensionModule("apps/extension/src/export/html-builder.ts");
  const { inlineCssAssets } = await loadExtensionModule("apps/extension/src/export/asset-inliner.ts");
  const { readFileSync: read } = await import("node:fs");
  const cssText = read(join(ASSET_DIR, "main.css"), "utf8");
  const inlined = await inlineCssAssets(cssText, async (name) => {
    const file = join(ASSET_DIR, name);
    if (!existsSync(file)) return null;
    const bytes = new Uint8Array(read(file));
    return { bytes, size: bytes.byteLength, mtimeMs: statSync(file).mtimeMs };
  });
  const html = composeExportHtml({
    bodyHtml: frame.bodyHtml,
    cssText: inlined,
    rootStyleText: frame.rootStyleText,
    customCss: "",
    palette: report.capture.htmlAttrs.theme,
    scheme: report.capture.htmlAttrs.scheme,
    typography: report.capture.htmlAttrs.typography,
    preset: report.capture.htmlAttrs.preset,
    documentVersion: frame.version,
    title: "Export Evidence"
  });
  const artifactPath = join(OUT_DIR, "export.html");
  writeFileSync(artifactPath, html, "utf8");
  report.artifact = {
    bytes: Buffer.byteLength(html, "utf8"),
    dataFontFaces: (html.match(/data:font\//g) ?? []).length,
    urlReferencesLeft: (html.match(/url\((?!["']?data:)/g) ?? []).length,
    scriptTags: (html.match(/<script/gi) ?? []).length,
    webviewUris: (html.match(/vscode-webview:\/\//g) ?? []).length,
    fileUris: (html.match(/file:\//g) ?? []).length,
    relativeUris: (html.match(/src="\.\.\//g) ?? []).length,
    javascriptUris: (html.match(/javascript:/gi) ?? []).length,
    csp: /<meta http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)?.[1] ?? null
  };
  log("[artifact] ", JSON.stringify(report.artifact));
  return { artifactPath, frame };
}

/** `file://` 直开交付物：自包含不是一句措辞，是「除自身外零请求」这个可测事实。 */
async function sectionRender(browser) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const nonFileRequests = [];
  const consoleErrors = [];
  page.on("request", (request) => {
    if (!request.url().startsWith("file://")) nonFileRequests.push(request.url());
  });
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  await page.goto(pathToFileURL(join(OUT_DIR, "export.html")).href);
  await page.waitForSelector(".readora-document", { state: "visible" });
  await page.screenshot({ path: join(OUT_DIR, "artifact-rendered.png"), fullPage: false });

  report.rendered = await page.evaluate(() => {
    const heading = document.querySelector("h1");
    const pre = document.querySelector(".readora-code-pre");
    const svg = document.querySelector(".readora-diagram-container svg");
    return {
      scriptNodes: document.querySelectorAll("script").length,
      h1FontFamily: heading ? getComputedStyle(heading).fontFamily : null,
      bodyFontFamily: getComputedStyle(document.body).fontFamily,
      preText: pre ? (pre.textContent ?? "").slice(0, 48) : null,
      svgInDocument: svg === null ? 0 : 1,
      diagramState: svg?.closest("[data-readora-diagram-state]")?.getAttribute("data-readora-diagram-state") ?? null,
      toolbarNodes: document.querySelectorAll(".readora-toolbar, .readora-diagram-toolbar, .readora-code-editor").length,
      footnoteItems: document.querySelectorAll(".readora-footnotes li").length,
      tableCells: document.querySelectorAll("td").length,
      scrolledHeight: document.documentElement.scrollHeight,
      htmlAttrs: {
        theme: document.documentElement.dataset.readoraTheme,
        scheme: document.documentElement.dataset.readoraScheme,
        typography: document.documentElement.dataset.readoraTypography,
        preset: document.documentElement.dataset.readoraPreset
      }
    };
  });
  report.rendered.nonFileRequests = nonFileRequests;
  report.rendered.consoleErrors = consoleErrors;
  log("[rendered] ", JSON.stringify(report.rendered));
  await context.close();
}

/** `runBrowser` 要的 `BrowserChild` 端口：逐字照 `export/vscode-ports.ts` 里那一份转译。 */
function spawnPort(exe, args) {
  const child = spawn(exe, args, { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  let resolveExit;
  const exited = new Promise((resolve) => {
    resolveExit = resolve;
  });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk) => {
    stderr += chunk;
    if (stderr.length > 8192) stderr = stderr.slice(-8192);
  });
  child.stdout?.resume();
  child.on("error", () => resolveExit?.(-1));
  child.on("close", (code) => resolveExit?.(code ?? -1));
  return { exited, kill: () => child.kill("SIGKILL"), stderrText: () => stderr };
}

/** PDF 的关键结构可能在压缩的对象流里，所以原始字节搜不到时逐个 inflate。 */
function pdfFacts(bytes) {
  if (bytes.length === 0) {
    return { pages: 0, mediaBox: null, fontFile2: 0, mentionsNewsreader: false };
  }
  const haystacks = [bytes.toString("latin1")];
  const streamRe = /stream\r?\n?([\s\S]*?)endstream/g;
  let match;
  while ((match = streamRe.exec(bytes.toString("latin1"))) !== null) {
    try {
      haystacks.push(zlib.inflateSync(Buffer.from(match[1], "latin1")).toString("latin1"));
    } catch {
      /* 不是 FlateDecode，跳过 */
    }
  }
  const all = haystacks.join("\n");
  const mediaBox = /\/MediaBox\s*\[\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/.exec(all);
  return {
    pages: (all.match(/\/Type\s*\/Page[^s]/g) ?? []).length,
    mediaBox: mediaBox ? mediaBox.slice(1).map(Number) : null,
    fontFile2: (all.match(/FontFile2/g) ?? []).length,
    mentionsNewsreader: all.includes("Newsreader")
  };
}

function pngSize(bytes) {
  return bytes.length > 24 ? { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) } : null;
}

async function sectionChrome() {
  const { findChromium } = await loadExtensionModule("apps/extension/src/export/chrome-locator.ts");
  const { buildPdfArgs, buildPngArgs, pngViewportHeight, runBrowser } = await loadExtensionModule(
    "apps/extension/src/export/browser-runner.ts"
  );
  const lookup = findChromium("", { env: process.env, existsSync });
  if (lookup.exe === null) {
    report.chrome = { skipped: "本机没有可用的 Chromium 系浏览器" };
    log("[chrome] SKIPPED —— HTML 一段仍然有效（导出不依赖 Chrome）");
    return;
  }
  const htmlUri = pathToFileURL(join(OUT_DIR, "export.html")).href;
  const pdfPath = join(OUT_DIR, "export.pdf");
  const pngPath = join(OUT_DIR, "export.png");
  // 与 `export-service` 同口径：先把上报高度换算成视口高（×1.08 后按 16 384 裁），再把
  // 这一高交给 `buildPngArgs`。直接传 `contentHeightPx` 会得到与产品不一致的 argv。
  const heightPx = pngViewportHeight(report.capture.contentHeightPx);
  const pngArgs = buildPngArgs(htmlUri, pngPath, report.capture.canvasWidthPx, heightPx);

  const pdfRun = await runBrowser(lookup.exe, buildPdfArgs(htmlUri, pdfPath), 30_000, spawnPort);
  const pngRun = await runBrowser(lookup.exe, pngArgs, 30_000, spawnPort);
  const readIfPresent = (file) => (existsSync(file) ? readFileSync(file) : Buffer.alloc(0));

  report.chrome = {
    exe: lookup.exe,
    pdf: {
      args: buildPdfArgs(htmlUri, pdfPath),
      exitCode: pdfRun.exitCode,
      timedOut: pdfRun.timedOut,
      bytes: existsSync(pdfPath) ? statSync(pdfPath).size : 0,
      ...pdfFacts(readIfPresent(pdfPath))
    },
    png: {
      args: pngArgs,
      heightPx,
      truncated: report.capture.contentHeightPx * 1.08 > heightPx,
      exitCode: pngRun.exitCode,
      timedOut: pngRun.timedOut,
      bytes: existsSync(pngPath) ? statSync(pngPath).size : 0,
      ...pngSize(readIfPresent(pngPath))
    },
    stderr: { pdf: pdfRun.stderrTail ?? "", png: pngRun.stderrTail ?? "" }
  };
  log("[chrome] exe=", lookup.exe);
  log("[chrome] pdf =", JSON.stringify(report.chrome.pdf));
  log("[chrome] png =", JSON.stringify(report.chrome.png));
}

const server = await ensureServer();
// 下面的 `finally` 只顶得住正常退出与抛错：本脚本被终端 SIGKILL 掉时，它自己 spawn 的
// dev server（`--strictPort`，新进程组）会活下来变孤儿，下一次跑就只能“复用”一个行尸。
// 于是再挂三个进程级钩子，SIGTERM / SIGINT / 任意退出路径都走同一个 `stop()`（幂等）。
const reap = () => server.stop();
process.on("exit", reap);
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    reap();
    process.exit(signal === "SIGINT" ? 130 : 143);
  });
}
const { chromium } = await import("playwright");
const browser = await chromium.launch();
try {
  mkdirSync(OUT_DIR, { recursive: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await openReader(page);
  await page.bringToFront();
  await sectionTopbar(browser);
  await sectionArtifact(browser, page);
  await page.close();
  await sectionRender(browser);
  await sectionRegion(browser);
  await sectionChrome();
} finally {
  await browser.close();
  server.stop();
  writeFileSync(join(OUT_DIR, "evidence.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  log(`\n[evidence] JSON → ${join("test-results", "export-evidence", "evidence.json")}`);
}
