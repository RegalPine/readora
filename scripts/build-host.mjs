/**
 * Extension Host 构建（IMP-001 §7：esbuild 单文件 bundle）。
 * platform=node / format=cjs / external=["vscode"]；
 * 内部包（@readora/contracts）源码直接参与打包，无独立构建步骤。
 *
 * 构建后立即跑一次产物激活冒烟（scripts/host-activation-smoke.mjs）：
 * 单测跑的是 TS 源码，`import.meta.url` 在 ESM 下天然可用，而产物是单文件 CJS，
 * 依赖里任何运行时的 import.meta 用法都只会在这里才暴露 —— 必须让它在这里失败。
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/**
 * 必须按 CJS 条件打包的依赖。
 *
 * css-tree 3.x 的 ESM 入口（lib/*.js）在模块加载时用
 * `createRequire(import.meta.url)` 读同包的 `data/patch.json`；esbuild 出 CJS 时
 * `import.meta` 只能替换成空对象，于是 `createRequire(undefined)` 在扩展加载当场抛
 * TypeError —— 构建全绿，用户侧只看到「command 'readora.openReader' not found」。
 * 该包的 `exports.require` 入口（cjs/*.cjs）用的是普通 `require(json)`，
 * JSON 由 esbuild 静态内联，产物里不再留任何运行时文件读取。
 */
const CJS_ONLY_PACKAGES = ["css-tree"];

// 从 css-tree 的实际引用方（@readora/design-tokens）出发解析，
// 走 Node 的 exports「require」条件，拿到 cjs/index.cjs 的绝对路径。
const designTokensRequire = createRequire(path.join(root, "packages/design-tokens/index.js"));

const preferCjsEntries = {
  name: "prefer-cjs-entries",
  setup(esbuild) {
    for (const packageName of CJS_ONLY_PACKAGES) {
      const entry = designTokensRequire.resolve(packageName);
      esbuild.onResolve({ filter: new RegExp(`^${packageName}$`) }, () => ({ path: entry }));
    }
  }
};

await build({
  entryPoints: [path.join(root, "apps/extension/src/extension.ts")],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  outfile: path.join(root, "apps/extension/dist/extension.js"),
  external: ["vscode"],
  plugins: [preferCjsEntries],
  sourcemap: false,
  minify: false,
  logLevel: "info"
});

const smoke = spawnSync(
  process.execPath,
  [path.join(root, "scripts/host-activation-smoke.mjs")],
  { stdio: "inherit" }
);
if (smoke.status !== 0) {
  process.exit(smoke.status ?? 1);
}
