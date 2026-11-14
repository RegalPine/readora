/**
 * Token 结构护栏（PRD-003 §13.4 / §13.1，ARC-006 §4）。
 *
 * 权威在 CSS 文本本身：本包不生成样式、不存第二份色值（见 token-registry.ts 头
 * 注释），所以这套断言直接读 `src/styles/*.css` 拼接后的文本按名逐项查。
 * 漏一项的表现是「暗色里渗出一块亮色」和「构建全绿但界面无色」，都只能在这里拦住。
 */
import {
  COLOR_COMPONENT_TOKEN_NAMES,
  COMPONENT_TOKEN_NAMES,
  FONT_SCALE_TOKEN_NAMES,
  MOTION_TOKEN_NAMES,
  PALETTE_SCHEMES,
  RADIUS_TOKEN_NAMES,
  SEMANTIC_TOKEN_NAMES,
  SHADOW_COMPONENT_TOKEN_NAMES,
  SHADOW_TOKEN_NAMES,
  SPACING_TOKEN_NAMES,
  paletteToken,
  semanticToken
} from "@readora/design-tokens";
import { describe, expect, it } from "vitest";
import { declarationsFor, regionOf, stripComments, styleFile, styleFiles } from "./css-tokens";

const FILES = styleFiles();

// 拼接全文由 css-tokens 负责：声明与引用跨文件成立即可，不要求同一文件内先声明后使用。
const LIGHT = declarationsFor(":root");
const DARK = declarationsFor('[data-readora-theme="dark"]');
const VSCODE = declarationsFor('[data-readora-theme="vscode"]');

const TOKENS = styleFile("tokens.css", FILES);

function fallbackRegion(query: string, inner: string): string {
  return regionOf(TOKENS[1], query, inner);
}

describe("三层结构的取值来源", () => {
  it("Primitive：两套色板按名齐备，前缀是契约不可改（ARC-006 §4.2）", () => {
    for (const scheme of PALETTE_SCHEMES) {
      for (const name of SEMANTIC_TOKEN_NAMES) {
        expect(LIGHT.get(paletteToken(scheme, name)), `${scheme}-${name} 缺 Primitive`).toBeTruthy();
      }
    }
  });

  it("语义层：light / dark / vscode 三块逐名覆盖 21 个语义名", () => {
    for (const [label, block] of [
      ["light", LIGHT],
      ["dark", DARK],
      ["vscode", VSCODE]
    ] as const) {
      for (const name of SEMANTIC_TOKEN_NAMES) {
        expect(block.get(semanticToken(name)), `${label} 漏了 ${name}`).toBeTruthy();
      }
    }
  });

  it("语义 token 的取值只能来自色板或宿主变量", () => {
    const relay = declarationsFor(":root");
    for (const [label, block] of [
      ["light", LIGHT],
      ["dark", DARK],
      ["vscode", VSCODE]
    ] as const) {
      for (const [name, value] of block) {
        if (!name.startsWith("--readora-color-")) {
          continue;
        }
        if (label === "vscode") {
          // §13.3 的中转层是允许的：`var(--readora-host-*)` 一跳就到宿主变量，
          // 但中转声明本身必须真的挂在 `--vscode-*` 上，否则是断了路的假映射。
          const inner = /^var\((--readora-host-[\w-]+)\)$/u.exec(value);
          if (inner?.[1]) {
            const source = relay.get(inner[1]);
            expect(source, `${inner[1]} 没有宿主取值`).toMatch(/--vscode-/u);
            continue;
          }
        }
        expect(value, `${label} 的 ${name} 既非色板也非宿主`).toMatch(
          /--readora-palette-|--vscode-/u
        );
      }
    }
  });

  it("组件层（取色类）必须往下引用语义层", () => {
    for (const name of COLOR_COMPONENT_TOKEN_NAMES) {
      const value = LIGHT.get(name);
      expect(value, `${name} 未在组件层声明`).toBeTruthy();
      expect(value, `${name} 没有引用语义层`).toContain("var(--readora-color-");
    }
  });

  it("阴影换的是形状，且挂在明暗轴上——两种暗色形态都要覆盖（PRD-003 §7.2）", () => {
    // 写在 `[data-readora-theme="dark"]` 上只覆盖产品暗色：宿主模式的主题属性是
    // `vscode`，暗色宿主就会留着一圈带紫调的亮色投影——同一类「渗出亮色」的缺陷。
    // scheme 轴由 applyTheme 与首帧预置共同保证存在，所以它是唯一的正确落点。
    const DARK_SCHEME = declarationsFor('[data-readora-scheme="dark"]');
    const names = [
      ...SHADOW_COMPONENT_TOKEN_NAMES,
      ...SHADOW_TOKEN_NAMES.filter((name) => name !== "--readora-shadow-none")
    ];
    for (const name of names) {
      const value = DARK_SCHEME.get(name);
      expect(value, `${name} 未在明暗轴覆盖`).toMatch(/rgb\(0 0 0 \/ 0\.\d+\)/u);
    }
  });
});

describe("非颜色尺度", () => {
  it("字号 / 间距 / 圆角 / motion 按名存在", () => {
    for (const name of [...FONT_SCALE_TOKEN_NAMES, ...SPACING_TOKEN_NAMES, ...RADIUS_TOKEN_NAMES, ...MOTION_TOKEN_NAMES]) {
      expect(LIGHT.get(name), `${name} 缺失`).toBeTruthy();
    }
  });

  it("组件 token 清单里的名字全部有声明", () => {
    const missing = COMPONENT_TOKEN_NAMES.filter((name) => !LIGHT.has(name));
    expect(missing).toStrictEqual([]);
  });
});

describe("引用完整性", () => {
  it("样式里不存在悬空的 var(--readora-*)", () => {
    const declared = new Set<string>();
    for (const [, text] of FILES) {
      for (const match of stripComments(text).matchAll(/(--readora-[\w-]+)\s*:/gu)) {
        if (match[1]) {
          declared.add(match[1]);
        }
      }
    }
    const referenced = new Set<string>();
    for (const [, text] of FILES) {
      for (const match of stripComments(text).matchAll(/var\(\s*(--readora-[\w-]+)/gu)) {
        if (match[1]) {
          referenced.add(match[1]);
        }
      }
    }
    // 宿主注入的 --vscode-* 与引擎自有的 --pele-* 不在本清单内。
    const dangling = [...referenced].filter((name) => !declared.has(name)).sort();
    expect(dangling).toStrictEqual([]);
  });

  it("每一层都只由 tokens.css 声明", () => {
    const offenders = FILES.filter(
      ([name, text]) => name !== "tokens.css" && /--readora-[\w-]+\s*:/u.test(stripComments(text))
    ).map(([name]) => name);
    expect(offenders).toStrictEqual([]);
  });
});

describe("无障碍回退", () => {
  it("四组偏好查询都在：reduced-motion / forced-colors / prefers-contrast / reduced-transparency", () => {
    const body = stripComments(TOKENS[1]);
    for (const query of [
      "@media (prefers-reduced-motion: reduce)",
      "@media (forced-colors: active)",
      "@media (prefers-contrast: more)",
      "@media (prefers-reduced-transparency: reduce)"
    ]) {
      expect(body, `${query} 缺失`).toContain(query);
    }
  });

  it("forced-colors 下边界与焦点仍然可用（ARC-006 §12 第 6 条）", () => {
    const region = fallbackRegion("@media (forced-colors: active)", ":root");
    expect(region).toContain("--readora-color-border: CanvasText");
    expect(region).toContain("--readora-color-border-strong: CanvasText");
    expect(region).toContain("--readora-color-focus: Highlight");
  });

  it("reduced-motion 把四档动效收敛到 1ms", () => {
    const region = fallbackRegion("@media (prefers-reduced-motion: reduce)", ":root");
    for (const name of MOTION_TOKEN_NAMES) {
      expect(region, `${name} 未被收敛`).toContain(`${name}: 1ms`);
    }
  });

  it("去透明与高对比回退还指向本体系的名字", () => {
    const transparency = fallbackRegion("@media (prefers-reduced-transparency: reduce)", ":root");
    expect(transparency).toContain("--readora-color-glass");
    const contrast = fallbackRegion("@media (prefers-contrast: more)", ":root");
    expect(contrast).toContain("--readora-color-border");
    expect(contrast).toContain("--readora-color-text-muted");
  });
});
