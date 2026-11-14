/**
 * Tailwind utility 层护栏（ARC-005 §11.3 / PRD-003 §13.5）。
 *
 * 断言的是**结构**而不是产物字节：utility 是否生成由 vite 构建负责，这里守的是
 * 「theme 层只能有一处真相」——Tailwind 的尺度必须整体换成我们的 token，否则
 * `bg-canvas` 会取 Tailwind 调色板里的同名默认色，主题切换对它失效。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { FOCUS_TOKEN_NAME, SEMANTIC_TOKEN_NAMES } from "@readora/design-tokens";
import { describe, expect, it } from "vitest";

// vitest 以 apps/webview 为 cwd 运行（与 images-fixture.spec.ts 同一口径）。
const STYLE_DIR = resolve(process.cwd(), "src/styles");
const read = (relative: string): string => readFileSync(resolve(STYLE_DIR, relative), "utf8");

const TAILWIND_CSS = read("tailwind.css");
const ENTRY = read("../main.tsx");

/** `@theme inline` 块内的声明，逐条 `--key: value`。 */
function themeDeclarations(source: string): Map<string, string> {
  const start = source.indexOf("@theme inline {");
  expect(start, "必须用 `@theme inline`，退回 `@theme` 会让值多间接一层").toBeGreaterThan(-1);
  const rest = source.slice(start + "@theme inline {".length);
  const body = rest.slice(0, rest.indexOf("}"));
  const entries = new Map<string, string>();
  for (const line of body.split("\n")) {
    const match = /^\s*(--[\w-]+):\s*(.+);/u.exec(line);
    if (match) {
      const [, key = "", value = ""] = match;
      entries.set(key, value);
    }
  }
  return entries;
}

describe("theme 层映射", () => {
  const declarations = themeDeclarations(TAILWIND_CSS);

  it("语义色逐名映射，取值直连 var(--readora-color-*)", () => {
    for (const name of SEMANTIC_TOKEN_NAMES) {
      expect(declarations.get(`--color-${name}`), `--color-${name} 缺少映射`).toBe(
        `var(--readora-color-${name})`
      );
    }
    // 焦点环落在语义层前缀下，同样必须直连 token。
    expect(declarations.get("--color-focus")).toBe(`var(${FOCUS_TOKEN_NAME})`);
  });

  it("不保留第二份色值：theme 层每一条都指向 readora token", () => {
    const foreign = [...declarations].filter(([, value]) => !value.includes("var(--readora-"));
    expect(foreign).toStrictEqual([]);
  });

  it("尺度 token 按名映射，不允许局部改值", () => {
    expect(declarations.get("--text-base")).toBe("var(--readora-font-base)");
    expect(declarations.get("--text-3xl")).toBe("var(--readora-font-3xl)");
    expect(declarations.get("--spacing")).toBe("var(--readora-space-1)");
    expect(declarations.get("--radius-md")).toBe("var(--readora-radius-md)");
    expect(declarations.get("--shadow-pill")).toBe("var(--readora-shadow-pill)");
    expect(declarations.get("--default-transition-duration")).toBe(
      "var(--readora-motion-normal)"
    );
  });
});

describe("引入顺序与 preflight", () => {
  it("tailwind.css 排在 tokens.css 之后、业务样式之前", () => {
    const order = ["./styles/tokens.css", "./styles/tailwind.css", "./styles/base.css"].map(
      (path) => ENTRY.indexOf(`"${path}"`)
    );
    expect(order.every((index) => index >= 0)).toBe(true);
    expect(order).toStrictEqual([...order].sort((a, b) => a - b));
  });

  it("不启用 preflight，基础重置留在 base.css", () => {
    expect(TAILWIND_CSS).not.toContain("tailwindcss/preflight");
    expect(TAILWIND_CSS).toContain('@import "tailwindcss/theme.css" layer(theme)');
    expect(TAILWIND_CSS).toContain('@import "tailwindcss/utilities.css" layer(utilities)');
  });
});

describe("任意值与变体护栏", () => {
  it("无任意色值：bg-[#..] / text-[#..] 一类写法不进 class", () => {
    // index.html 与构建产物不参与，只扫样式目录与入口。
    for (const file of sourceFiles()) {
      const text = read(file);
      expect(text, `${file} 出现任意色值`).not.toMatch(/\b(?:bg|text|border|ring)-\[[#]/u);
      expect(text, `${file} 出现 Tailwind 默认色名`).not.toMatch(
        /\b(?:bg|text|border|ring)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}\b/u
      );
    }
  });

  it("不使用跟随 prefers-color-scheme 的 dark: 变体（ARC-006 §10.2）", () => {
    for (const file of sourceFiles()) {
      if (file.endsWith("tailwind.css")) {
        continue;
      }
      const text = read(file);
      expect(text, `${file} 出现 dark: 变体`).not.toMatch(/["'\s]dark:/u);
    }
    // 误用的 `dark:` 必须仍然按属性判定，而不是按系统偏好。
    expect(TAILWIND_CSS).toContain('@custom-variant dark (&:where([data-readora-theme="dark"]');
  });
});

/** 护栏覆盖的范围：样式目录全部 CSS + 入口。 */
function sourceFiles(): string[] {
  return [
    "tailwind.css",
    "tokens.css",
    "base.css",
    "markdown.css",
    "components.css",
    "shell.css",
    "lightbox-search.css",
    "../main.tsx"
  ];
}
