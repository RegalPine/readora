/**
 * 安全用例的页面装配：把**生产 HTML 模板 + 生产 bundle** 开在真浏览器里。
 *
 * 为什么不能用 dev 夹具页（`tests/helpers/reader.ts` 那套）：
 * - 夹具页是 Vite dev 直出的 `<script type="module">`，没有 CSP、没有 nonce、也没有
 *   生产构建的产物；拿它测 CSP 等于测一份不存在的 HTML；
 * - CSP/nonce/净化的失败模式（inline 脚本漏网、`unsafe-eval` 混进策略、
 *   `</style>` breakout）只在「真实模板 + 真实构建」上才会出现。
 *
 * 因此这里刻意**不复制任何被测逻辑**：HTML 由 `renderWebviewHtml()` 现场生成，
 * 静态资源从 `pnpm build:webview` 的产物原样读出。被测代码与线上代码是同一份，
 * 测试只扮演 Host（`acquireVsCodeApi` 替身）并记录浏览器的举报。
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page } from "@playwright/test";
// 值导入必须走文件路径：根包没有依赖 `@readora/contracts`，而 Playwright 的
// ESM loader 只按路径转译 `.ts`。类型导入不受影响（编译期就擦掉了），
// 所以 `tests/helpers/reader.ts` 里那种 `import type` 写法不必跟着改。
import {
  DEFAULT_READER_PREFERENCES,
  READORA_ERROR_CODES,
  type ReaderPreferences
} from "../../packages/contracts/src/index.ts";
// 同样是「值导入走文件路径」：`@readora/design-tokens` 不在根包依赖里。
// 这个包是 `type: module`，Node 能直接加载它的 `.ts`。
import {
  sanitizeCustomCss,
  type CustomCssResult
} from "../../packages/design-tokens/src/custom-css.ts";
import type { WebviewHtmlOptions } from "../../apps/extension/src/webview/html-template";

/** 生产 HTML 模板的源文件（唯一权威）：测试不重写第二份 CSP 字符串。 */
const TEMPLATE_SOURCE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../apps/extension/src/webview/html-template.ts"
);

type HtmlTemplate = typeof import("../../apps/extension/src/webview/html-template");

let templateLoading: Promise<HtmlTemplate> | undefined;

/**
 * 把生产模板源文件装进 Node。
 *
 * 为什么不直接 `import`：`apps/extension/package.json` 没有 `"type": "module"`
 * （它是 CJS 打包的 VS Code 扩展，`dist/extension.js` 必须继续是 CJS），于是 Node
 * 把该目录下的 `.ts` 当 CommonJS 读，`export function` 直接 SyntaxError。
 * 这里用 esbuild —— 仓库既有依赖、`pnpm build:host` 用的同一工具 —— 把那份**源文件**
 * 转成 ESM 后经 `data:` URL 装载：被测的仍是生产那一份，测试里不落第二份实现，
 * 模板改了策略而用例没跟着改时，红的是断言而不是编译错误。
 */
function htmlTemplate(): Promise<HtmlTemplate> {
  templateLoading ??= (async () => {
    const { transformSync } = await import("esbuild");
    const code = transformSync(readFileSync(TEMPLATE_SOURCE, "utf8"), {
      loader: "ts",
      format: "esm"
    }).code;
    return (await import(
      `data:text/javascript,${encodeURIComponent(code)}`
    )) as HtmlTemplate;
  })();
  return templateLoading;
}

/** 生产 webview 产物目录：vite 的 `outDir` 直接落到扩展包内（apps/webview/vite.config.ts）。 */
const ASSET_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../apps/extension/dist/webview/assets"
);

/** 页面地址与资源前缀都是固定的：路由按它们匹配，用例也按它们断言「没有别的请求」。 */
export const PRODUCTION_URL = "/readora-host.html";
export const ASSET_PREFIX = "/readora-assets/";

/** 已经装好替身 Host 的页面：路由与 init script 只装一次（见 `openProductionReader`）。 */
const WIRED = new WeakSet<Page>();

/** 每次会话一个 nonce：模板要求「每次打开面板重新生成」，用例不能指望固定值。 */
const NONCE = `n-${Math.random().toString(36).slice(2, 12)}`;

const CONTENT_TYPES: Record<string, string> = {
  ".js": "text/javascript",
  ".css": "text/css",
  ".woff2": "font/woff2",
  ".png": "image/png"
};

function readAsset(name: string): Buffer {
  const file = path.join(ASSET_ROOT, name);
  if (!existsSync(file)) {
    throw new Error(
      `Readora: 缺少生产产物 ${file}；跑安全用例前需要先 pnpm build:webview。`
    );
  }
  return readFileSync(file);
}

/** 生产模板下发的 CSP 原文（用例据此断言 meta，而不是自己再拼一份字符串）。 */
export async function productionCsp(): Promise<string> {
  const { buildContentSecurityPolicy } = await htmlTemplate();
  return buildContentSecurityPolicy(htmlOptions({}));
}

/** 模板入参的公共形状；nonce/cspSource 由这里统一给，用例只覆盖自己关心的那一格。 */
function htmlOptions(options: ProductionOptions): WebviewHtmlOptions {
  return {
    nonce: NONCE,
    cspSource: "'self'",
    scriptUri: `${ASSET_PREFIX}main.js`,
    styleUri: `${ASSET_PREFIX}main.css`,
    palette: "light",
    scheme: "light",
    typography: options.typography ?? "newsreader",
    preset: options.preset ?? "default",
    // `rawCustomCss` 存在 = 用例刻意跳过 Host 净化，直投模板（测模板那道防线）。
    customCss: options.rawCustomCss ?? options.customCss
  };
}

export interface ProductionOptions {
  /** 覆盖首帧预设（自定义 CSS 注入与预设类用例用）。 */
  preset?: WebviewHtmlOptions["preset"];
  typography?: WebviewHtmlOptions["typography"];
  /** 已经过 `sanitizeCustomCss()` 放行的样式文本，与 `webview-manager.ts` 交出的同一形状。 */
  customCss?: string;
  /** 未经任何净化的原文：只用于「调用方忘了净化」那条防线，别拿它当真实链路。 */
  rawCustomCss?: string;
}

/**
 * Host 侧的 CSS 净化权威（`packages/design-tokens`，扩展运行时用的就是它）。
 *
 * 用例不许在这里补规则或正则 —— 那样「拦截成功」可能只是测试自己拦的。
 * 这里只做一次转发，判断全部留在那份生产实现里。
 */
export async function hostSanitizedCss(source: string): Promise<CustomCssResult> {
  return sanitizeCustomCss(source);
}

/** 生产 HTML 原文（模板现场生成）：注入类用例要先看字符串，再看浏览器怎么解析它。 */
export async function productionHtml(options: ProductionOptions = {}): Promise<string> {
  const { renderWebviewHtml } = await htmlTemplate();
  return renderWebviewHtml(htmlOptions(options));
}

export type ResourceReply =
  | { ok: true; payload: unknown }
  | { ok: false; code: string; message: string };

/** 替身 Host 的默认回话：一律拒答。想要别的结果，用例自己给表。 */
const DENIAL_REPLY: ResourceReply = {
  ok: false,
  code: READORA_ERROR_CODES.RESOURCE_DENIED,
  message: "stub host denies by default"
};

/** 页面上攒下的三类证据：浏览器举报、脚本异常、View→Host 消息。 */
export interface StubState {
  posted: unknown[];
  violations: {
    blockedURI: string;
    directive: string;
    html: string;
    source: string;
    at: string;
  }[];
  errors: string[];
  resourceReply: ResourceReply;
  /** 按引用原文分配的回复；命中即用，未命中回退到 `resourceReply`。 */
  resourceEntries: Record<string, ResourceReply>;
}

interface VsCodeApiStub {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare global {
  interface Window {
    /** 生产入口唯一的宿主句柄：这里给替身，页面才敢真跑起来（ARC-005 §5）。 */
    acquireVsCodeApi?: () => VsCodeApiStub;
    __readoraSecurity: StubState;
  }
}

/**
 * 装一个替身 Host 并打开生产页。
 *
 * 三件事必须早于页面任何脚本，所以走 `addInitScript` 而不是 `page.evaluate`：
 * 1. `acquireVsCodeApi()` —— 生产入口缺了它直接抛错，页面就是白的；
 * 2. `securitypolicyviolation` 监听 —— 晚装一帧，第一条违规就漏记；
 * 3. `error` / `unhandledrejection` 收集 —— 「净化漏一个 `onerror`」通常正表现为
 *    一次被 CSP 拦下的脚本异常，两头都得有数。
 *
 * 可以对本页多次调用（换 `options` 重新加载）：路由与 init script 只装一次，
 * 重复注册会让每次违规被记两遍，那就不叫计数了。
 */
export async function openProductionReader(
  page: Page,
  options: ProductionOptions = {}
): Promise<void> {
  if (!WIRED.has(page)) {
    WIRED.add(page);
    // 资源路由先装：HTML 一落地就会去要 main.js / main.css / woff2。
    await page.route(`**${ASSET_PREFIX}**`, (route) => {
      const url = route.request().url();
      const name = url.slice(url.indexOf(ASSET_PREFIX) + ASSET_PREFIX.length);
      const ext = path.extname(name);
      return route.fulfill({
        status: 200,
        contentType: CONTENT_TYPES[ext] ?? "application/octet-stream",
        body: readAsset(name)
      });
    });

    await page.addInitScript((denial) => {
      const state: StubState = {
        posted: [],
        violations: [],
        errors: [],
        // 默认拒绝：替身 Host 不主动交出任何可寻址 URI，用例想要图就自己配。
        resourceReply: denial,
        // 「哪条引用换成什么回复」由用例给表，替身只做一次查表：
        // 它不含任何策略判断，所以测出来的「页面不自拼路径」不会被测试逻辑冒充。
        resourceEntries: {}
      };
      window.__readoraSecurity = state;

      window.acquireVsCodeApi = () => ({
        postMessage(message: unknown): void {
          state.posted.push(message);
          const entry = message as { id?: unknown; type?: unknown; payload?: unknown };
          // 契约里只有 resource.resolve 是请求-响应，其余通知即发即忘。
          // 替身不额外发明通道，否则「产品其实没等回复」这类回归就测不出来。
          if (entry.type === "resource.resolve" && typeof entry.id === "string") {
            const reference = (entry.payload as { reference?: string } | undefined)?.reference;
            const scripted = reference === undefined ? undefined : state.resourceEntries[reference];
            const reply = scripted ?? state.resourceReply;
            const response = reply.ok
              ? { id: entry.id, success: true, payload: reply.payload }
              : {
                  id: entry.id,
                  success: false,
                  error: { code: reply.code, message: reply.message }
                };
            window.dispatchEvent(new MessageEvent("message", { data: response }));
          }
        },
        getState: () => undefined,
        setState: () => undefined
      });

      window.addEventListener("securitypolicyviolation", (event) => {
        state.violations.push({
          blockedURI: event.blockedURI,
          directive: event.violatedDirective,
          // `blockedURI` 已经能分入口：inline 脚本是字面量 "inline"，外链与远端图是 URL。
          // `originalHTML` 按规范只在 Trusted Types 违规时填充，这里存下来说明它确实是空的，
          // 而不是我们没接住。
          html: event.originalHTML ?? "",
          // 举报里带来源：红灯时先看清是文档塞进来的，还是我们自己的 bundle 在 eval。
          source: event.sourceURL ?? "",
          at: `${event.lineNumber}:${event.columnNumber}`
        });
      });
      window.addEventListener("error", (event) => {
        state.errors.push(String(event.message));
      });
      window.addEventListener("unhandledrejection", (event) => {
        state.errors.push(`rejection: ${String(event.reason)}`);
      });
    }, DENIAL_REPLY);
  }

  const html = await productionHtml(options);
  await page.route("**" + PRODUCTION_URL, (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html",
      body: html
    })
  );
  await page.goto(PRODUCTION_URL);
}

/**
 * 生产 bundle 是否真的把阅读器挂起来了。
 *
 * 白屏也能「零违规」，所以每条安全用例都得先证明脚本执行过、React 真的写进了
 * `#root`。只断言这一件事，不去猜当前是空态还是正文态 —— 那由用例自己决定投不投文档。
 */
export async function expectReaderAlive(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(() => document.getElementById("root")?.childElementCount ?? 0)
    )
    .toBeGreaterThan(0);
}

/** 投一条 host→view 消息（形状由调用方给，安全用例正是故意给非法形状）。 */
export async function postToView(page: Page, message: unknown): Promise<void> {
  await page.evaluate((raw) => {
    window.dispatchEvent(new MessageEvent("message", { data: raw }));
  }, message);
}

/**
 * 合法信封：`MessageEnvelopeSchema` 是 strictObject，多余的键会被信封校验先丢。
 *
 * 于是「非法 payload」与「非法信封」是两条不同的护栏。想测前者，必须把后者的
 * 形状做对 —— 否则注释写着测 payload，实际测的是信封。
 */
export function hostMessage(
  type: string,
  payload: unknown,
  id = `host-${Math.random().toString(36).slice(2, 8)}`
): { id: string; type: string; version: 1; payload: unknown } {
  return { id, type, version: 1 as const, payload };
}

/** 合法偏好快照，可按需覆盖单键（超长文本、非法枚举这类用例都在它外面再动一手）。 */
export function preferences(patch: Partial<ReaderPreferences> = {}): ReaderPreferences {
  return { ...DEFAULT_READER_PREFERENCES, ...patch };
}

/**
 * 送一篇文档进阅读器并等到正文出现。
 *
 * 与 dev 夹具不同，生产页没有 `window.__readora`，所以这里按真实协议走：
 * 先等 `reader.ready`（门控时序本身由 tests/integration 覆盖，安全用例只要
 * 「已就绪」这条正常路径），再投 `document.load`。
 */
export async function loadDocument(
  page: Page,
  text: string,
  patch: Partial<ReaderPreferences> = {}
): Promise<void> {
  await page.waitForFunction(
    () =>
      window.__readoraSecurity.posted.some(
        (message) => (message as { type?: string }).type === "reader.ready"
      ),
    undefined,
    { timeout: 10_000 }
  );
  await postToView(
    page,
    hostMessage("document.load", {
      documentUri: "file:///vault/security/target.md",
      languageId: "markdown",
      version: 1,
      text,
      preferences: preferences(patch)
    })
  );
  await expect(page.locator(".readora-document")).toBeVisible();
}

/** 页面上累计的 CSP 违规。 */
export function violations(page: Page): Promise<StubState["violations"]> {
  return page.evaluate(() => window.__readoraSecurity.violations);
}

/** 页面上累计的脚本异常与未处理拒绝。 */
export function pageErrors(page: Page): Promise<string[]> {
  return page.evaluate(() => window.__readoraSecurity.errors);
}

/** View→Host 消息（可按类型筛）。 */
export async function posted(page: Page, type?: string): Promise<unknown[]> {
  const all = await page.evaluate(() => window.__readoraSecurity.posted);
  return type
    ? all.filter((message) => (message as { type?: string }).type === type)
    : all;
}

/** 配好 `resource.resolve` 的默认回话（给数据不给逻辑，免得把 Host 策略抄进测试）。 */
export async function setResourceReply(page: Page, reply: ResourceReply): Promise<void> {
  await page.evaluate((value) => {
    window.__readoraSecurity.resourceReply = value;
  }, reply);
}

/** 按引用原文分别配回话：`{ "./a.png": {ok:true,...} }`，未列出的仍走默认。 */
export async function setResourceEntries(
  page: Page,
  entries: Record<string, ResourceReply>
): Promise<void> {
  await page.evaluate((value) => {
    window.__readoraSecurity.resourceEntries = value;
  }, entries);
}

/** 正文里所有会被浏览器当作可执行/可加载入口的属性值。 */
export function executableAttributes(page: Page): Promise<Record<string, string[]>> {
  return page.evaluate(() => {
    const names = [
      "onclick",
      "onerror",
      "onload",
      "onmouseover",
      "formaction",
      "xlink:href",
      "src",
      "href",
      "srcdoc",
      "style"
    ];
    const found: Record<string, string[]> = {};
    for (const name of names) {
      const nodes = document.querySelectorAll(`[${name}]`);
      // style 属性太长且合法场景很多，这里只留可能藏表达式的样本。
      found[name] = [...nodes].map((node) => node.getAttribute(name) ?? "");
    }
    return found;
  });
}
