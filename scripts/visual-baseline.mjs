/**
 * 视觉基线采集与比对（PRD-003 §14，IMP-003 §4.6 交付物 8）。
 *
 * 显式步骤，不进默认门禁链：`pnpm visual:check` 比对 `tests/visual/baseline.json`，
 * `pnpm visual:update` 重新采集并写回。理由见 README 偏差登记——浏览器基线依赖
 * 本机 Chromium/Chrome，把它塞进门禁链会让「没装浏览器的机器」变成红灯。
 *
 * SKIPPED 语义：Playwright 或浏览器起不来时打印 `SKIPPED: <原因>` 并 exit 0。
 * 基线是取证工具，缺失取证不等于代码有问题；但一旦能跑，值不对就是硬失败。
 *
 * 采什么：
 * - 每个 palette 下全部 `--readora-*` Token 的计算值（名字从 tokens.css 现读，
 *   不在这儿抄第二份清单）；
 * - 关键选择器的计算样式（颜色、底色、字号、字族、字重、行高）；
 * - 关键 rect：内容宽度、目录宽、工具栏高、grid 列轨道，含 ≤900px 的单栏形态；
 * - 每个 palette 一张 PNG（`tests/visual/artifacts/`，gitignore）与其 sha256。
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runTool } from "./lib/run-tool.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const webviewDir = path.join(root, "apps/webview");
const tokensFile = path.join(webviewDir, "src/styles/tokens.css");
const baselineFile = path.join(root, "tests/visual/baseline.json");
const artifactDir = path.join(root, "tests/visual/artifacts");

const FIXTURE_PATH = "dev/visual.html";
/**
 * 待测档：palette × 预设 × 字族的采样清单，与 `dev/visual.tsx` 的读参一一对应。
 *
 * M5 只有 4 档（palette），M6 加了两条正交的维度，所以这里必须扩：
 * - `preset=high-contrast` 覆写的是语义层的四个色，四档 palette 都要各量一次，
 *   否则「高对比只在 light 成立」这种事没人发现（ARC-006 §13.1 的边界）；
 * - `typography` 覆写的是两个字族 token，只取打包了字体的 geist —— inter 不打包
 *   （M5 起的既定偏差），落进基线就把「本机装了什么字体」写进了仓库文件。
 *
 * 键名同时是基线里的条目名与截图文件名，`--` 之后是被采的那一维。夹具加载后会
 * 回报 data-visual-palette / data-readora-preset / data-readora-typography，
 * 与请求的三元组不一致即硬失败，所以清单不会和页面上的实际形态各说各话。
 */
const PALETTE_LABELS = ["light", "dark", "vscode-light", "vscode-dark"];
const SAMPLES = [
  ...PALETTE_LABELS.map((palette) => ({
    key: palette,
    palette,
    preset: "default",
    typography: "newsreader"
  })),
  ...PALETTE_LABELS.map((palette) => ({
    key: `${palette}--high-contrast`,
    palette,
    preset: "high-contrast",
    typography: "newsreader"
  })),
  ...["light", "dark"].map((palette) => ({
    key: `${palette}--geist`,
    palette,
    preset: "default",
    typography: "geist"
  }))
];
const VIEWPORT = { width: 1280, height: 900 };
/** 窄窗口断点（ARC-005 §5.3）：900px 以下必须退成单栏。 */
const COMPACT_VIEWPORT = { width: 880, height: 900 };
/** 采集作用域：主题属性与派生 Token 都落在 `<html>`，量它就是量生产形态。 */
const SCOPE_SELECTOR = "html";

/** 关键选择器：正文、外壳、代码与语法色各有代表。 */
const SELECTORS = [
  ".readora-document-title",
  ".readora-document-source",
  ".readora-paragraph",
  ".readora-heading--h2",
  ".readora-document a",
  ".readora-inline-code",
  ".readora-blockquote",
  ".readora-list",
  ".readora-table-cell--header",
  ".readora-code-pre",
  ".readora-code-lang",
  ".readora-code-copy",
  ".hljs-keyword",
  ".hljs-comment",
  ".hljs-string",
  ".readora-shell-nav",
  ".readora-toolbar",
  ".readora-toolbar-button",
  ".readora-outline-link",
  ".readora-outline-link[aria-current=\"location\"]",
  // M6：外壳四段、阅读辅助组件与两类新内容各取一处代表。
  ".readora-topbar",
  ".readora-searchbar",
  ".readora-statusbar",
  ".readora-quickbar",
  ".readora-pill",
  ".readora-zoom",
  ".readora-properties",
  ".readora-property-key",
  ".readora-math--block",
  ".katex",
  ".readora-link--wikilink"
];

const STYLE_PROPS = [
  "color",
  "backgroundColor",
  "borderTopColor",
  "borderLeftColor",
  "fontSize",
  "fontFamily",
  "fontWeight",
  "lineHeight"
];

const update = process.argv.includes("--update");

function skip(reason) {
  console.log(`SKIPPED: ${reason}`);
  console.log("[visual] 基线为显式步骤，不参与默认门禁链（见 README M5 章节）。");
  process.exit(0);
}

/** 目录形态的包只能按文件路径 import：优先 ESM 入口，其次 package.json 的 main。 */
async function importPackageDir(dir) {
  const esm = path.join(dir, "index.mjs");
  if (existsSync(esm)) {
    return import(pathToFileURL(esm).href);
  }
  const manifest = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf-8"));
  const entry = path.join(dir, manifest.main ?? "index.js");
  if (existsSync(entry)) {
    return import(pathToFileURL(entry).href);
  }
  return null;
}

/**
 * 解析 Playwright。
 *
 * M6（IMP-003 §7.1）起 `playwright` 是仓库 devDependency，正常路径就是第一条
 * `import("playwright")` 命中本地 node_modules。保留后面的「全局 npm root」兜底
 * 只为一件事：在还没 `pnpm install` 的机器上，这套基线仍能给一条明确的 SKIPPED
 * 而不是抛一串 module-not-found —— 基线是显式取证步骤，起不来不判红。
 */
async function loadPlaywright() {
  for (const specifier of ["playwright", "playwright-core"]) {
    try {
      return await import(specifier);
    } catch {
      // 继续找下一个来源。
    }
  }
  let globalRoot;
  try {
    // 走 runTool：Windows 上 `npm` 是 `.cmd` 垫片，不经 shell 直接 spawn 报 ENOENT，
    // 这里会被 `catch` 吞成「拿不到全局 root」，看起来像没装 npm，而不是调不起来。
    const probe = runTool("npm", ["root", "-g"], {
      encoding: "utf-8",
      // npm 的版本告警不该混进取证输出。
      stdio: ["ignore", "pipe", "ignore"]
    });
    if (probe.status !== 0 || !probe.stdout) {
      return null;
    }
    globalRoot = probe.stdout.trim();
  } catch {
    return null;
  }
  for (const relative of ["playwright", path.join("@playwright/cli/node_modules/playwright")]) {
    const dir = path.join(globalRoot, relative);
    if (existsSync(dir)) {
      const loaded = await importPackageDir(dir);
      if (loaded) {
        return loaded;
      }
    }
  }
  return null;
}

async function loadVite() {
  try {
    return await import("vite");
  } catch {
    // 落到按路径解析。
  }
  const entry = path.join(webviewDir, "node_modules/vite/dist/node/index.js");
  if (!existsSync(entry)) {
    return null;
  }
  return await import(pathToFileURL(entry).href);
}

/** Token 名字清单：唯一权威是 tokens.css 的声明。 */
function tokenNames() {
  const css = readFileSync(tokensFile, "utf-8");
  const names = new Set();
  for (const match of css.matchAll(/^\s*(--readora-[\w-]+)\s*:/gmu)) {
    names.add(match[1]);
  }
  return [...names].sort();
}

/**
 * 页面侧采集函数。
 *
 * 只通过参数取数据、不引用 node 作用域：Playwright 会把它序列化进页面执行，
 * 闭包外的名字在浏览器里一律是 undefined。
 */
function readPalette(input) {
  const scope = document.querySelector(input.scopeSelector);
  if (!scope) {
    throw new Error(`夹具缺少 ${input.scopeSelector}`);
  }
  const style = getComputedStyle(scope);
  const tokens = {};
  for (const name of input.names) {
    tokens[name] = style.getPropertyValue(name).trim();
  }
  const pick = (element) => {
    const computed = getComputedStyle(element);
    const found = {};
    for (const prop of input.props) {
      found[prop] = String(computed[prop]).trim();
    }
    return found;
  };
  const styles = {};
  for (const selector of input.selectors) {
    const element = scope.querySelector(selector);
    styles[selector] = element ? pick(element) : null;
  }
  const rect = (selector) => {
    const element = scope.querySelector(selector);
    if (!element) {
      return null;
    }
    const box = element.getBoundingClientRect();
    return { width: Math.round(box.width), height: Math.round(box.height) };
  };
  const shell = scope.querySelector(".readora-shell");
  // M6 起两列栅格在 `.readora-body`（`.readora-shell` 改成 flex 纵向四段）：这里若还量
  // shell，`gridTemplateColumns` 会恒为 "none"，「窄窗口收成单列」这条护栏就悄悄失效了。
  // 优先量 body，量不到（旧产物 / 单列退化）才回退 shell，保持字段有实际判别力。
  const grid = scope.querySelector(".readora-body") ?? shell;
  return {
    tokens,
    styles,
    rects: {
      ".readora-canvas": rect(".readora-canvas"),
      ".readora-document": rect(".readora-document"),
      ".readora-shell-nav": rect(".readora-shell-nav"),
      ".readora-toolbar": rect(".readora-toolbar"),
      // M6 四段栅格：三条带子的高度与内容宽都随栅格变，只量 toolbar 量不出来。
      ".readora-topbar": rect(".readora-topbar"),
      ".readora-searchbar": rect(".readora-searchbar"),
      ".readora-body": rect(".readora-body"),
      ".readora-statusbar": rect(".readora-statusbar"),
      ".readora-quickbar": rect(".readora-quickbar"),
      ".readora-shell-main": rect(".readora-shell-main"),
      ".readora-properties": rect(".readora-properties")
    },
    gridTemplateColumns: grid ? getComputedStyle(grid).gridTemplateColumns : null
  };
}

/**
 * 等所有外壳的列数收敛到目标值。
 *
 * 这同时是 ARC-005 §5.3「≤900px 收单栏」这条规则本身的断言：超时说明夹具没按规则
 * 收起左栏，属于硬失败，不是环境缺失。
 */
async function waitForColumns(page, columns) {
  await page.waitForFunction(
    (want) => {
      const shells = [...document.querySelectorAll(".readora-shell")];
      return shells.length > 0 && shells.every((el) => el.dataset.readoraColumns === want);
    },
    columns,
    { timeout: 10_000 }
  );
}

/**
 * 等 `<html>` 上的颜色过渡真正跑完再量。
 *
 * 主题属性写在 `<html>`，`base.css` 给 body 配了 220ms 的 background/color 过渡；
 * 首帧之后就量会把「黑 → 目标色」的中间值记进基线（实测 rgb(6,15,25) 记成了
 * `.readora-paragraph` 的字色，而 Token 是 #0b1c30），正文颜色是从 body 继承的，
 * 于是整套色值都跟着计时器漂。判据取「新插入元素的颜色」为目标值：新建元素不参与
 * 过渡，拿到的必然是收敛后的值——比睡固定时长可靠，也比「两次采样相等」更强。
 * 收敛不了就是硬失败（有人把过渡写成无限长，也该由这里报出来）。
 */
async function waitForSettled(page) {
  await page.waitForFunction(
    () => {
      const probe = document.createElement("span");
      probe.style.cssText =
        "position:absolute;transition:none;" +
        "color:var(--readora-color-text-primary);" +
        "background-color:var(--readora-color-canvas)";
      document.body.append(probe);
      const computed = getComputedStyle(probe);
      const targetColor = computed.color;
      const targetBackground = computed.backgroundColor;
      probe.remove();
      const body = getComputedStyle(document.body);
      return body.color === targetColor && body.backgroundColor === targetBackground;
    },
    undefined,
    { timeout: 10_000 }
  );
}

async function main() {
  const playwright = await loadPlaywright();
  if (!playwright?.chromium) {
    skip("Playwright 不可用：pnpm add -D playwright 或安装 @playwright/cli 后再跑");
  }
  const vite = await loadVite();
  if (!vite?.createServer) {
    skip("Vite 不可用：先在 apps/webview 安装依赖");
  }

  let browser;
  try {
    browser = await playwright.chromium.launch({ headless: true });
  } catch {
    try {
      // 没有下载 Playwright 自带浏览器的机器上，用系统 Chrome 顶上。
      browser = await playwright.chromium.launch({ headless: true, channel: "chrome" });
    } catch (error) {
      skip(`无法启动 Chromium/Chrome：${String(error).split("\n")[0]}`);
    }
  }

  const names = tokenNames();
  const server = await vite.createServer({
    configFile: path.join(webviewDir, "vite.config.ts"),
    root: webviewDir,
    // 端口交给系统分配，避免与手工开着的 dev server 抢 5173。
    server: { host: "127.0.0.1", port: 0 },
    logLevel: "warn"
  });

  const page = await browser.newPage({ viewport: VIEWPORT });
  const consoleErrors = [];
  page.on("pageerror", (error) => consoleErrors.push(String(error)));
  page.on("console", (message) => {
    if (message.type() !== "error") {
      return;
    }
    const url = message.location()?.url ?? "";
    // 浏览器自己会去探 favicon，夹具页没有图标，这一条与视觉无关。
    if (url.endsWith("/favicon.ico")) {
      return;
    }
    consoleErrors.push(`${message.text()} @ ${url || "inline"}`);
  });

  try {
    await server.listen();
    const fixtureUrl = new URL(FIXTURE_PATH, server.resolvedUrls.local[0]).href;
    const samples = {};
    mkdirSync(artifactDir, { recursive: true });

    for (const sample of SAMPLES) {
      const url = new URL(fixtureUrl);
      url.searchParams.set("palette", sample.palette);
      url.searchParams.set("preset", sample.preset);
      url.searchParams.set("typography", sample.typography);
      await page.goto(url.href, { waitUntil: "load" });
      // 夹具回报的三元组必须就是请求的那一档：名字写错要硬失败，不能静默退到默认。
      await page.waitForFunction(
        (want) => {
          const root = document.documentElement.dataset;
          return (
            root.visualPalette === want.palette &&
            root.readoraPreset === want.preset &&
            root.readoraTypography === want.typography
          );
        },
        sample,
        { timeout: 30_000 }
      );
      await page.waitForFunction(
        () => document.querySelectorAll(".readora-document .readora-paragraph").length > 0
      );
      // 字体没就位就量，字族回退会让 rect 漂；等一次 fonts.ready 再采。
      await page.evaluate(() => document.fonts.ready);
      // 首帧的 matchMedia 回调也要落定，否则第一轮量到的是未收敛的布局。
      await waitForColumns(page, "two");
      // 色值过渡同样要等：不等就会把过渡中间值当成 palette 的真相记进基线。
      await waitForSettled(page);

      const input = {
        scopeSelector: SCOPE_SELECTOR,
        names,
        selectors: SELECTORS,
        props: STYLE_PROPS
      };
      const desktop = await page.evaluate(readPalette, input);

      // 任何一条选择器没命中都记为 null：漏了 M6 的哪一段要能看出来，
      // 不能让「少测一项」和「测到同一个值」长得一样。
      const missing = Object.entries(desktop.styles)
        .filter(([, value]) => value === null)
        .map(([selector]) => selector);
      if (missing.length > 0) {
        console.error(`[visual] ${sample.key}: 选择器未命中 ${missing.join(", ")}`);
        process.exitCode = 1;
        return;
      }

      // 单栏断点在窗口级（ReaderShell 用 matchMedia），所以窄屏要整页换尺寸再量。
      // 换完必须等 React 把 `data-readora-columns` 改到位：不等就会量到上一档布局，
      // 基线就成了随机数。
      await page.setViewportSize(COMPACT_VIEWPORT);
      await waitForColumns(page, "one");
      const compact = await page.evaluate(readPalette, input);
      await page.setViewportSize(VIEWPORT);
      await waitForColumns(page, "two");

      const png = await page.screenshot({ path: path.join(artifactDir, `${sample.key}.png`) });
      const sha256 = createHash("sha256").update(Buffer.from(png)).digest("hex");

      samples[sample.key] = {
        palette: sample.palette,
        preset: sample.preset,
        typography: sample.typography,
        tokens: desktop.tokens,
        styles: desktop.styles,
        rects: desktop.rects,
        gridTemplateColumns: desktop.gridTemplateColumns,
        compact: { rects: compact.rects, gridTemplateColumns: compact.gridTemplateColumns },
        screenshot: { path: `artifacts/${sample.key}.png`, sha256 }
      };
      console.log(
        `[visual] ${sample.key}: ${Object.keys(desktop.tokens).length} tokens, ${sha256.slice(0, 12)}…`
      );
    }

    if (consoleErrors.length > 0) {
      console.error(`[visual] 夹具运行期有 ${consoleErrors.length} 条错误：\n${consoleErrors.join("\n")}`);
      process.exitCode = 1;
      return;
    }

    const baseline = {
      // schemaVersion 2：待测档从「palette 一项」扩成「palette × preset × typography 的采样清单」，
      // 条目里同时记下这三元组，读基线的人不必回头猜每一档是怎么凑出来的。
      schemaVersion: 2,
      viewport: { desktop: VIEWPORT, compact: COMPACT_VIEWPORT },
      generatedBy: "scripts/visual-baseline.mjs",
      samples
    };

    if (update) {
      // 采集前先把旧基线读一遍：M6 的偏差登记要「前后差异清单」，
      // 而只有 --update 这一趟看得到旧值（写回去之后就没了）。
      let previous = null;
      if (existsSync(baselineFile)) {
        try {
          previous = JSON.parse(readFileSync(baselineFile, "utf-8"));
        } catch {
          previous = null;
        }
      }
      writeFileSync(baselineFile, `${JSON.stringify(baseline, null, 2)}\n`);
      console.log(`[visual] 已写入 ${path.relative(root, baselineFile)}（${SAMPLES.length} 个待测档）`);
      if (previous) {
        const beforeKeys = Object.keys(previous.samples ?? previous.palettes ?? {});
        const afterKeys = Object.keys(samples);
        const added = afterKeys.filter((key) => !beforeKeys.includes(key));
        const removed = beforeKeys.filter((key) => !afterKeys.includes(key));
        const changed = afterKeys.filter(
          (key) => beforeKeys.includes(key) && diffSample(previous.samples?.[key] ?? previous.palettes?.[key], samples[key])
        );
        console.log(
          `[visual] 与上一版基线：新增 ${added.length} 档、移除 ${removed.length} 档、取值变化 ${changed.length} 档`
        );
        if (added.length > 0) {
          console.log(`  + ${added.join(", ")}`);
        }
        if (removed.length > 0) {
          console.log(`  - ${removed.join(", ")}`);
        }
        if (changed.length > 0) {
          console.log(`  ~ ${changed.join(", ")}`);
        }
      }
      return;
    }

    if (!existsSync(baselineFile)) {
      console.error("[visual] 没有基线文件，先跑 `pnpm visual:update` 采集一次。");
      process.exitCode = 1;
      return;
    }
    const expected = JSON.parse(readFileSync(baselineFile, "utf-8"));
    const diffs = [];
    compare(expected.samples ?? {}, samples, "", diffs);
    const shaDrift = [];
    for (const [key, entry] of Object.entries(samples)) {
      const before = expected.samples?.[key]?.screenshot?.sha256;
      if (before && before !== entry.screenshot.sha256) {
        shaDrift.push(`${key}.png`);
      }
    }
    if (diffs.length === 0) {
      console.log(`[visual] 与基线一致：${Object.keys(samples).length} 个待测档全等。`);
    } else {
      console.error(`[visual] 与基线不一致（${diffs.length} 处）：`);
      for (const line of diffs.slice(0, 60)) {
        console.error(`  - ${line}`);
      }
      if (diffs.length > 60) {
        console.error(`  …另有 ${diffs.length - 60} 处`);
      }
      process.exitCode = 1;
    }
    if (shaDrift.length > 0) {
      // 像素差只提示不判红：抗锯齿与字体次像素随环境变，值不对才是硬失败。
      console.log(
        `[visual] NOTE 截图像素与基线不同，请人工复核：${shaDrift.join(", ")}（artifacts/ 已被 gitignore）`
      );
    }
  } finally {
    await browser.close();
    await server.close();
  }
}

/** 只比数值不比字节：截图 sha 单独报，避免把渲染环境的噪声当成回归。 */
function compare(expected, actual, prefix, diffs) {
  if (expected === actual) {
    return;
  }
  if (
    typeof expected !== "object" ||
    typeof actual !== "object" ||
    expected === null ||
    actual === null
  ) {
    if (JSON.stringify(expected) !== JSON.stringify(actual)) {
      diffs.push(`${prefix || "/"}: ${JSON.stringify(expected)} → ${JSON.stringify(actual)}`);
    }
    return;
  }
  const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
  for (const key of [...keys].sort()) {
    compare(expected[key], actual[key], `${prefix}/${key}`, diffs);
  }
}

// 只比 measured 字段，不比 palette/preset/typography 这些描述符，也不比截图 sha。
// 用途是 --update 时给出「取值变化的档」，让偏差登记数得出来；旧基线（schemaVersion 1）
// 没有描述符字段，正好也只比这些 measured 项，两版可比。
const MEASURED_FIELDS = ["tokens", "styles", "rects", "gridTemplateColumns"];

function diffSample(before, after) {
  if (!before) {
    return false;
  }
  const diffs = [];
  for (const field of MEASURED_FIELDS) {
    compare(before[field], after[field], field, diffs);
  }
  return diffs.length > 0;
}

main().catch((error) => {
  console.error(`[visual] FAILED: ${error instanceof Error ? error.stack : String(error)}`);
  process.exit(1);
});
