import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default tseslint.config(
  {
    // `test-results/` 是 `playwright.config.ts` 的 outputDir，与 `**/coverage/**` 同一性质：
    // 整目录都是跑出来的产物（trace / 截图 / JSON / 一次性取证脚本），不进任何人的评审面。
    // 不忽略它，任何一次 `pnpm test:e2e` 之后都可能多出一批与产品无关的 lint 报错。
    // `.tmp-evidence/` 同一性质（已在 .gitignore 内）：门禁日志与临时取证脚本落在这里，
    // 不忽略则每次出包都会因为几个 `require()` / `console` 报红。
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/coverage/**",
      "**/test-results/**",
      "**/.tmp-evidence/**",
      "docs/**",
      "*.vsix"
    ]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.browser
      }
    }
  },
  {
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      globals: { ...globals.node }
    }
  },
  {
    // 这几个脚本里混着两种运行环境：外层跑在 node，采集函数（readPalette、
    // waitForFunction/evaluate 的回调）由 Playwright 序列化进页面执行，只能引用
    // 浏览器全局。整文件放开 browser 全局，换来不必在几十个页面侧调用上逐行 disable。
    // `export-evidence.mjs` 与 perf / visual 同一形状（取证脚本不是门禁产物）。
    files: ["scripts/visual-baseline.mjs", "scripts/perf-report.mjs", "scripts/export-evidence.mjs"],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser }
    }
  },
  {
    // 测试替身常需要「声明参数形状但只用到其中一部分」：TS 要求签名完整，
    // 于是下划线前缀成为「有意为之的不使用」的唯一可表达形式。`__stubs__` 同性质 ——
    // 它按宿主真实 API 的完整签名建模（如 registerCustomEditorProvider 的 options），
    // 替身只用其中一部分，多余形参同样只能靠下划线表达「故意不用」。
    files: ["**/__tests__/**/*.{ts,tsx}", "**/__stubs__/**/*.{ts,tsx}"],
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" }
      ]
    }
  },
  {
    // IMP-001 §9.3 / ARC-003 §4.1：Pele 只能经 Adapter 使用，写成机器约束而非口头约定。
    files: ["packages/diagram-core/src/**/*.ts", "!packages/diagram-core/src/engines/pele/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              // 必须锚定：group 走 gitignore 语义，未锚定时连 "./engines/pele/registry" 也会被 ban。
              regex: "^pele(?:/.*)?$",
              message:
                "Pele 只允许在 packages/diagram-core/src/engines/pele/** 内使用（IMP-001 §9.3）。"
            }
          ]
        }
      ]
    }
  },
  {
    // Adapter 自身是白名单区：只放行 core 与 diagrams/*，禁全量入口与 lazy 入口。
    files: ["packages/diagram-core/src/engines/pele/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex: "^pele$|^pele/lazy$|^pele/global$",
              message:
                "只用 pele/core 与 pele/diagrams/*：全量入口违背包体预算，lazy 入口与 Webview 的 nonce CSP 冲突。"
            }
          ]
        }
      ]
    }
  }
);
