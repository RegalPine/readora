/**
 * 导出交付物的 Host 侧装配：把**生产源码**装进 Node，安全用例据此断言（IMP-003 §7.2）。
 *
 * 为什么不能把 `composeExportHtml` 的规则在测试里重写一遍：那样「交付物没有脚本」
 * 可能只是测试自己没写脚本。与 `production-page.ts` 对 HTML 模板的处理同一口径 ——
 * 用仓库既有依赖 esbuild 把**那一份源文件**转成可装载的 ESM，被测代码与线上代码同源。
 *
 * 两处必要差别：
 * 1. 打包（`bundle: true`）而不是单次 transform：`html-builder.ts` 会相对引入
 *    `webview/html-template.ts`，`asset-inliner.ts` 会引入 `errors.ts` 与
 *    `@readora/contracts` 的**值**（错误码表），裸 import 在 `data:` URL 里无法解析；
 * 2. `@readora/contracts` 用 alias 指到源码入口：根包没有依赖它（见
 *    `production-page.ts` 的头注），而别名解析发生在打包期，不影响运行时。
 *
 * 这两个模块都不 import `vscode`（端口注入的分工），因此不需要任何宿主替身，
 * 也就证明了安全论证里的一条：**导出层拿不到任何文件系统与网络能力**。
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CONTRACTS_ENTRY = path.join(ROOT, "packages", "contracts", "src", "index.ts");

type HtmlBuilder = typeof import("../../apps/extension/src/export/html-builder");
type AssetInliner = typeof import("../../apps/extension/src/export/asset-inliner");

/** 组装入参的真实类型：字面量写错枚举就编译不过，而不是等断言变红。 */
type ExportHtmlInput = Parameters<HtmlBuilder["composeExportHtml"]>[0];

/** 按文件路径装载 extension 侧的一个模块（值导入必须走路径，理由见头注）。 */
async function loadExtensionModule<T>(relative: string): Promise<T> {
  const { buildSync } = await import("esbuild");
  const result = buildSync({
    entryPoints: [path.join(ROOT, relative)],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node24",
    write: false,
    alias: { "@readora/contracts": CONTRACTS_ENTRY }
  });
  const code = result.outputFiles[0]?.text ?? "";
  return (await import(
    `data:text/javascript,${encodeURIComponent(code)}`
  )) as T;
}

let htmlBuilderLoading: Promise<HtmlBuilder> | undefined;

export function exportHtmlBuilder(): Promise<HtmlBuilder> {
  htmlBuilderLoading ??= loadExtensionModule<HtmlBuilder>(
    "apps/extension/src/export/html-builder.ts"
  );
  return htmlBuilderLoading;
}

let assetInlinerLoading: Promise<AssetInliner> | undefined;

export function exportAssetInliner(): Promise<AssetInliner> {
  assetInlinerLoading ??= loadExtensionModule<AssetInliner>(
    "apps/extension/src/export/asset-inliner.ts"
  );
  return assetInlinerLoading;
}

/** 交付物组装入参：测试侧唯一一处「一份好正文」的样本。 */
export const CLEAN_BODY =
  '<p class="readora-paragraph">Body</p>' +
  '<figure class="readora-diagram" data-readora-diagram-state="rendered">' +
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"></rect></svg>' +
  "</figure>" +
  '<span class="readora-image readora-image--ready" data-readora-image="./assets/shot.png" ' +
  'data-readora-image-state="ready"><img class="readora-image-element" alt=""></span>';

/** 一份「除了正文之外都正常」的交付物入参，用例只覆盖自己关心的那一格。 */
export function artifactInput(patch: Partial<ExportHtmlInput> = {}): ExportHtmlInput {
  const base: ExportHtmlInput = {
    bodyHtml: CLEAN_BODY,
    cssText: ":root{--readora-font-size:16px}",
    rootStyleText: "--readora-font-size: 16px; --readora-line-height: 1.6",
    customCss: "",
    palette: "light",
    scheme: "light",
    typography: "newsreader",
    preset: "default",
    documentVersion: 3,
    title: "reader"
  };
  return { ...base, ...patch };
}
