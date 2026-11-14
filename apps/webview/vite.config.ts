/**
 * Webview 构建配置（IMP-001 §7 / ARC-005）。
 *
 * 产物固定命名 assets/main.js / assets/main.css（无 hash），
 * Host 的 HTML 模板按确定性路径引用；outDir 直接落到扩展包内。
 * 入口键名 main 保证 CSS 产物同样命名为 main.css。
 *
 * M5 起多两件事：Tailwind 的 utility 层由官方 vite 插件提供（ARC-005 §11.3），
 * 字体本地化按 IMP-001 §「字体本地化」的同一口径只保留 woff2。
 */
import type { Plugin } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vitest/config";

/**
 * woff2 单格式。
 *
 * @fontsource 的每条 `src` 都带一个 woff 回退，供旧版 Safari / Android 内置浏览器用；
 * KaTeX 更进一步，woff 之后还挂了一个 ttf 回退（IMP-001 §10.3 要求对它做同一件事）。
 * Webview 内嵌的是 Chromium，永远命中不了这两种回退，但那 40 个文件（实测 KaTeX 0.19.1
 * 是 20 woff + 20 ttf，约 1.9 MB）会照原样进 vsix。构建期把回退引用剥掉、连带不生成
 * 对应产物，`scripts/verify-vsix.mjs` 反向校验归档里既无 woff/ttf、样式表的每个
 * `url()` 又都能在归档内解析。
 *
 * 挂在 generateBundle 而不是 transform：fontsource 的 css 是被 Vite 的 @import
 * 内联读进来的，插件 transform 收不到那个 id。
 */
function woff2Only(): Plugin {
  // `,\s*url(...) format(...)` —— 只删尾随回退，永不删首条 woff2（删了就没有字体可加载）。
  const LEGACY_SOURCE = /,\s*url\([^)]*\.(?:woff|ttf)\)\s*format\(["'](?:woff|truetype)["']\)/gu;
  return {
    name: "readora:woff2-only",
    generateBundle(_options, bundle) {
      for (const [key, item] of Object.entries(bundle)) {
        if (item.type !== "asset") {
          continue;
        }
        if (/\.(?:woff|ttf)$/u.test(key)) {
          delete bundle[key];
          continue;
        }
        if (key.endsWith(".css") && typeof item.source === "string") {
          item.source = item.source.replace(LEGACY_SOURCE, "");
        }
      }
    }
  };
}

export default defineConfig({
  base: "./",
  plugins: [woff2Only(), tailwindcss()],
  build: {
    outDir: "../extension/dist/webview",
    emptyOutDir: true,
    target: "es2022",
    /**
     * 字体一律落文件，绝不内联成 `data:`。
     *
     * Vite 默认把 4 KB 以下的资源转成 base64 内联，KaTeX 的 Size3 恰好只有 2 KB，
     * 于是会被转成 `url(data:font/woff2;base64,…)`。而 ARC-005 / CSP 的 `font-src`
     * 只放行 `{{cspSource}}`，不含 `data:` —— 内联的字体在真实 Webview 里会被浏览器
     * 直接拦掉，本地看不出来，只有装进 vsix 才暴露。按文件名判定而不是按体积，
     * 是为了让「以后再多一个很小的字体」也不会悄悄退回内联。
     */
    assetsInlineLimit: (filePath, content) =>
      /\.(?:woff2?|ttf|otf|eot)$/u.test(filePath) ? false : content.byteLength <= 4096,
    // 单入口 + 无动态 import：产物天然单文件，无需代码拆分选项。
    rollupOptions: {
      input: { main: "index.html" },
      output: {
        entryFileNames: "assets/main.js",
        chunkFileNames: "assets/[name].js",
        assetFileNames: "assets/[name][extname]"
      }
    }
  },
  test: {
    // DOMPurify 与 Testing Library 需要真实 DOM（IMP-001 §14 测试矩阵）。
    environment: "jsdom",
    include: ["src/**/*.spec.ts", "src/**/*.spec.tsx"]
  }
});