/**
 * WCAG 2.2 AA 对比度矩阵（PRD-003 §14.1，§4.2 注释点名的即本文件）。
 *
 * 色值一律从 tokens.css 现场解析，不在这儿抄第二份：抄来的数字会在调色后仍然
 * 「通过」，那就等于没有门禁。`--vscode-*` 取不到时按 CSS 的 fallback 计算，
 * 也就是无宿主环境（纯浏览器、基线采集）下用户真正看到的颜色。
 *
 * 门槛口径见 design-tokens 的 `contrast.ts`：正文 4.5:1，大字号与非文本 3:1。
 */
import { contrastRatio, meetsNonTextAA, meetsTextAA } from "@readora/design-tokens";
import { describe, expect, it } from "vitest";
import { declarationsFor, resolveLiteral, styleFile } from "./css-tokens";

const ROOT = declarationsFor(":root");
const DARK = declarationsFor('[data-readora-theme="dark"]');
const VSCODE = declarationsFor('[data-readora-theme="vscode"]');
const VSCODE_DARK = declarationsFor('[data-readora-theme="vscode"][data-readora-scheme="dark"]');
const HC_LIGHT = declarationsFor(
  '[data-readora-theme="light"][data-readora-preset="high-contrast"]'
);
const HC_DARK = declarationsFor('[data-readora-theme="dark"][data-readora-preset="high-contrast"]');
const HC_VSCODE = declarationsFor('[data-readora-theme="vscode"][data-readora-preset="high-contrast"]');
const HC_VSCODE_DARK = declarationsFor(
  '[data-readora-theme="vscode"][data-readora-scheme="dark"][data-readora-preset="high-contrast"]'
);

/** 解析作用域：暗色块覆盖在 `:root` 之上，与级联一致。 */
const SCOPES: Record<"light" | "dark", Array<Map<string, string>>> = {
  light: [ROOT],
  dark: [DARK, ROOT]
};

const SCHEMES = ["light", "dark"] as const;
type Scheme = (typeof SCHEMES)[number];

function color(token: string, scheme: Scheme): string {
  return resolveLiteral(`--readora-color-${token}`, SCOPES[scheme]);
}

/** 报告里带上实测比值，失败时要能一眼看出差多少，而不是只有一个 boolean。 */
function ratio(fg: string, bg: string, scheme: Scheme): number {
  const foreground = color(fg, scheme);
  const background = color(bg, scheme);
  return Number(contrastRatio(foreground, background).toFixed(2));
}

/**
 * 承担 AA 义务的文字对（PRD-003 §4.4「accent 是填充色，accent-text 才是文字色」）。
 *
 * 五组落在 canvas 上，一组落在 accent 填充上：正文、次文、弱文、链接、强调文字。
 */
const TEXT_PAIRS: Array<readonly [string, string]> = [
  ["text-primary", "canvas"],
  ["text-secondary", "canvas"],
  ["text-muted", "canvas"],
  ["link", "canvas"],
  ["accent-text", "canvas"],
  ["accent-on", "accent"]
];

/**
 * 承担 1.4.11 非文本义务的边界：焦点环与控件状态色。
 *
 * `border-strong` 不在这一组里：它按 PRD-003 §4.2/§4.3 固定为 #c2c7cf / #434850，
 * 用于引用左轨、代码块与表格分隔线这类「有文字或色块在旁边才成立」的容器边界，
 * 本身不是识别控件的唯一线索；把它拉到 3:1 会同时改掉四篇文档的色板表。
 * 这里仍给它一条下限断言（见下），保证它在两套色板下都不会淡到看不见。
 */
const NON_TEXT_PAIRS: Array<readonly [string, string]> = [
  ["focus", "canvas"],
  ["focus", "surface"],
  ["accent", "canvas"],
  ["warning", "canvas"],
  ["danger", "canvas"]
];

describe("文本对比度矩阵（≥ 4.5:1）", () => {
  for (const scheme of SCHEMES) {
    for (const [fg, bg] of TEXT_PAIRS) {
      it(`${scheme}：${fg} on ${bg}`, () => {
        const value = ratio(fg, bg, scheme);
        expect(meetsTextAA(value), `${fg}(${color(fg, scheme)}) on ${bg}(${color(bg, scheme)}) = ${value}:1`).toBe(
          true
        );
      });
    }
  }
});

describe("非文本对比度矩阵（≥ 3:1）", () => {
  for (const scheme of SCHEMES) {
    for (const [fg, bg] of NON_TEXT_PAIRS) {
      it(`${scheme}：${fg} on ${bg}`, () => {
        const value = ratio(fg, bg, scheme);
        expect(
          meetsNonTextAA(value),
          `${fg}(${color(fg, scheme)}) on ${bg}(${color(bg, scheme)}) = ${value}:1`
        ).toBe(true);
      });
    }
  }
});

describe("弱文字与容器边界的固化断言", () => {
  it("light 的 text-muted 是加深后的 #6b6478，不是原型 #7b7486（PRD-003 §4.2）", () => {
    expect(color("text-muted", "light")).toBe("#6b6478");
    expect(meetsTextAA(ratio("text-muted", "canvas", "light"))).toBe(true);
    // 回退到原型值即红灯：4.3:1 过不了 12–13px 小字号的 AA。
    const prototype = Number(contrastRatio("#7b7486", color("canvas", "light")).toFixed(2));
    expect(meetsTextAA(prototype), `原型值竟也过线：${prototype}:1`).toBe(false);
  });

  it("dark 的三档文字与浅字色板逐项固化（PRD-003 §4.3 / 附录 A）", () => {
    expect(color("text-primary", "dark")).toBe("#dfe2eb");
    expect(color("text-secondary", "dark")).toBe("#c2c8d2");
    expect(color("text-muted", "dark")).toBe("#8e949f");
    expect(color("canvas", "dark")).toBe("#10141a");
  });

  it("border-strong 淡而不失：两套色板下都还看得见", () => {
    for (const scheme of SCHEMES) {
      const value = ratio("border-strong", "canvas", scheme);
      expect(value, `${scheme} 的 border-strong 淡到消失了`).toBeGreaterThanOrEqual(1.5);
    }
  });

  it("半透明的强调底必须先合成再算：活动条目文字过 AA", () => {
    for (const scheme of SCHEMES) {
      // accent-soft 是叠在面板底色上的半透明层，直接用原色会系统性高估对比度。
      const soft = color("accent-soft", scheme);
      const panel = color("surface", scheme);
      const composited = contrastRatio(soft, panel);
      expect(composited).toBeLessThan(21);
      const value = Number(contrastRatio(color("accent-text", scheme), soft, panel).toFixed(2));
      expect(meetsTextAA(value), `${scheme} 活动条目文字 = ${value}:1`).toBe(true);
    }
  });
});

describe("语法色落在代码块底上", () => {
  it("每套 scheme 的前景与八类语法色都过 AA（代码配色挂在 --readora-syntax-*）", () => {
    // 代码块底色是 surface-sunken，语法色按 `[data-readora-scheme]` 分两组。
    const syntaxes = [
      "syntax-foreground",
      "syntax-comment",
      "syntax-keyword",
      "syntax-string",
      "syntax-number",
      "syntax-title",
      "syntax-attr",
      "syntax-deletion"
    ];
    for (const scheme of SCHEMES) {
      const scopes = scheme === "dark" ? [DARK, declarationsFor('[data-readora-scheme="dark"]'), ROOT] : [ROOT];
      const background = resolveLiteral("--readora-color-surface-sunken", scopes);
      for (const name of syntaxes) {
        const token = resolveLiteral(`--readora-${name}`, scopes);
        const value = Number(contrastRatio(token, background).toFixed(2));
        expect(meetsTextAA(value), `${scheme} 的 ${name}(${token}) on ${background} = ${value}:1`).toBe(true);
      }
    }
  });
});

/* ---------- 行内代码色块（PRD-003 §8.6.1） ----------
 *
 * 这一组不在 §4.2 的语义配对表里：色块不是「文字压在一个固定 token 上」，而是
 * 「一层柔光叠在它实际落进的容器上」，所以必须按落点逐个合成再算。旧写法
 * （色块 = `surface-subtle`）在这套断言下会同时红两类：落进引用块（同取
 * `surface-subtle`）是 1.00 逐字节撞色，落在正文画布上只有 1.11 —— 用户报的
 * 「亮色下 `code` 对比度不够」量的就是这两项，而它当时的文字对比度是 14.59，
 * 完全合格。于是门禁必须测「色块 vs 容器」这一维，只测文字会漏掉整类缺陷。 */

/** 色块实际会落进的容器：正文、面板、引用底、抬起态、表头。 */
const CHIP_BASES = [
  "canvas",
  "surface",
  "surface-subtle",
  "surface-raised",
  "surface-sunken"
] as const;

/** 色块与容器的区分度下限：低于这个值就量不出「这里有个物件」。 */
const CHIP_FLOOR = 1.15;

const CHIP_DECL_RE =
  /^color-mix\(in srgb, var\(--readora-color-([\w-]+)\) ([\d.]+)%, transparent\)$/u;

/** 从组件层声明里读出色块的着色 token 与掺量，不在测试里抄第二份。 */
function chipDeclaration(): { tint: string; percent: number } {
  const value = ROOT.get("--readora-inline-code-background") ?? "";
  const mix = CHIP_DECL_RE.exec(value);
  if (!mix) {
    throw new Error(`--readora-inline-code-background 不是「语义色掺透明」的写法：${value}`);
  }
  const [, tint = "", percent = "0"] = mix;
  return { tint, percent: Number(percent) };
}

/** 带 alpha 的色块层（八位十六进制），交给 contrastRatio 现场合成到各落点上。 */
function chipLayer(scheme: Scheme): string {
  const { tint, percent } = chipDeclaration();
  const alpha = Math.round((percent / 100) * 255)
    .toString(16)
    .padStart(2, "0");
  return `${color(tint, scheme)}${alpha}`;
}

/** 色块内前景：与代码块里的变量/属性同一路（挂在 scheme 轴上）。 */
function chipForeground(scheme: Scheme): string {
  const scopes =
    scheme === "dark"
      ? [declarationsFor('[data-readora-scheme="dark"]'), ROOT]
      : [ROOT];
  return resolveLiteral("--readora-syntax-attr", scopes);
}

describe("行内代码色块与它的落点", () => {
  // 取值放在 `it` 里而不是 describe 体里：声明写错时 `chipLayer` 会抛，
  // 在 describe 体里抛会让整个 spec 文件收集失败，把无关的门禁一起带走。
  for (const scheme of SCHEMES) {
    for (const base of CHIP_BASES) {
      it(`${scheme}：色块在 ${base} 上拉得开`, () => {
        const layer = chipLayer(scheme);
        const surface = color(base, scheme);
        const value = Number(contrastRatio(layer, surface).toFixed(2));
        expect(
          value,
          `${scheme} 色块(${layer}) on ${base}(${surface}) = ${value}:1`
        ).toBeGreaterThanOrEqual(CHIP_FLOOR);
      });

      it(`${scheme}：色块内文字在 ${base} 上过 AA`, () => {
        const layer = chipLayer(scheme);
        const foreground = chipForeground(scheme);
        const value = Number(contrastRatio(foreground, layer, color(base, scheme)).toFixed(2));
        expect(
          meetsTextAA(value),
          `${foreground} on 色块（叠在 ${base} 上）= ${value}:1`
        ).toBe(true);
      });
    }
  }

  it("色块不复用任何一档 surface：复用就必然与同档容器逐字节撞色", () => {
    expect(ROOT.get("--readora-inline-code-background")).not.toMatch(/color-surface/u);
  });
});

describe("色板与文档同源", () => {
  it("tokens.css 里没有第二份色值来源（Primitive 全部是字面值）", () => {
    const tokens = styleFile("tokens.css")[1];
    // 语义层的取值必须是 var() 引用；出现字面色值即等于把色板抄了一遍。
    const semantic = VSCODE;
    for (const [name, value] of semantic) {
      if (!name.startsWith("--readora-color-")) {
        continue;
      }
      expect(value, `${name} 在 vscode 块里写了字面色值`).toContain("var(");
    }
    expect(tokens).toContain("--readora-palette-light-canvas: #f7f8fa");
    expect(tokens).toContain("--readora-palette-dark-canvas: #10141a");
  });
});

/* ---------- 主题预设：high-contrast（F08-010 / ARC-006 §13.1 的高对比边界） ----------
 *
 * 门槛不写死结论：每条断言都从 tokens.css 现场取值算比值，失败消息里带实测数字。
 * 于是「预设到底补了哪一项」是量出来的，不是注释里声称的（IMP-003 §4.7 只点了
 * `border-strong`，量出来 `border` 漏得更多，本批一并覆写并在 README 登记偏差）。
 */

/** 文字与边界的实际落点：只测 canvas 会漏掉浮层、条纹行与抬起态面板。 */
const SURFACES = ["canvas", "surface", "surface-subtle", "surface-raised"] as const;

const PRESETS = ["default", "high-contrast"] as const;
type Preset = (typeof PRESETS)[number];

/**
 * 级联作用域，顺序 = CSS 源码顺序（preset 块排在 palette 与 scheme 之后）。
 *
 * `resolveLiteral` 取第一个命中，所以这里把覆写块放最前；同时保留被覆写的
 * 原块，才能验出「预设漏覆写某一项时它回落到哪一档」——那是真实行为，不是缺陷。
 */
const PRESET_SCOPES: Record<Preset, Record<Scheme, Array<Map<string, string>>>> = {
  default: { light: [ROOT], dark: [DARK, ROOT] },
  "high-contrast": { light: [HC_LIGHT, ROOT], dark: [HC_DARK, DARK, ROOT] }
};

/** 宿主模式的两格：`vscode` 下能覆写的只有仍留在产品色板里的那几项。 */
const VSCODE_SCOPES: Record<Scheme, Array<Map<string, string>>> = {
  light: [HC_VSCODE, VSCODE, ROOT],
  dark: [HC_VSCODE_DARK, HC_VSCODE, VSCODE_DARK, VSCODE, ROOT]
};
const VSCODE_DEFAULT_SCOPES: Record<Scheme, Array<Map<string, string>>> = {
  light: [VSCODE, ROOT],
  dark: [VSCODE_DARK, VSCODE, ROOT]
};

function presetColor(token: string, scheme: Scheme, preset: Preset): string {
  return resolveLiteral(`--readora-color-${token}`, PRESET_SCOPES[preset][scheme]);
}

function presetRatio(fg: string, bg: string, scheme: Scheme, preset: Preset): number {
  return Number(
    contrastRatio(presetColor(fg, scheme, preset), presetColor(bg, scheme, preset)).toFixed(2)
  );
}

describe("两种预设共用的 AA 底线", () => {
  for (const preset of PRESETS) {
    for (const scheme of SCHEMES) {
      for (const name of ["text-primary", "text-secondary", "text-muted", "accent-text", "link"]) {
        for (const surface of SURFACES) {
          it(`${preset} / ${scheme}：${name} on ${surface}`, () => {
            const value = presetRatio(name, surface, scheme, preset);
            expect(meetsTextAA(value), `${name}(${presetColor(name, scheme, preset)}) on ${surface}(${presetColor(surface, scheme, preset)}) = ${value}:1`).toBe(true);
          });
        }
      }
    }
  }
});

describe("high-contrast 把文字抬到 AAA（≥ 7:1）", () => {
  for (const scheme of SCHEMES) {
    for (const name of ["text-primary", "text-secondary", "text-muted", "accent-text"]) {
      for (const surface of SURFACES) {
        it(`${scheme}：${name} on ${surface}`, () => {
          const value = presetRatio(name, surface, scheme, "high-contrast");
          expect(value, `高对比下仍不到 AAA：${value}:1`).toBeGreaterThanOrEqual(7);
        });
      }
    }
  }

  it("活动条目的强调文字（半透明强调底要先合成再算）", () => {
    for (const scheme of SCHEMES) {
      for (const surface of SURFACES) {
        const soft = presetColor("accent-soft", scheme, "high-contrast");
        const panel = presetColor(surface, scheme, "high-contrast");
        const value = Number(
          contrastRatio(presetColor("accent-text", scheme, "high-contrast"), soft, panel).toFixed(2)
        );
        expect(value, `${scheme} 高对比活动条目文字 = ${value}:1`).toBeGreaterThanOrEqual(7);
      }
    }
  });
});

describe("high-contrast 把边界抬到非文本 AA（≥ 3:1）", () => {
  for (const scheme of SCHEMES) {
    for (const name of ["border", "border-strong"]) {
      for (const surface of SURFACES) {
        it(`${scheme}：${name} on ${surface}`, () => {
          const hc = presetRatio(name, surface, scheme, "high-contrast");
          const base = presetRatio(name, surface, scheme, "default");
          expect(meetsNonTextAA(hc), `${name}(${presetColor(name, scheme, "high-contrast")}) on ${surface} = ${hc}:1`).toBe(true);
          // 两条「预设确实起了作用」的实测断言：默认档量出来就是不达标，
          // 且高对比档必须严格更好。少任何一条，这组数字都可能只是巧合。
          expect(meetsNonTextAA(base), `默认档已经过了，这条覆写是多余的：${base}:1`).toBe(false);
          expect(hc).toBeGreaterThan(base);
        });
      }
    }
  }
});

describe("宿主模式的高对比只补产品色板那几项", () => {
  const OVERRIDDEN_IN_VSCODE = ["text-muted", "border", "border-strong", "accent-text"] as const;
  const HOST_DERIVED = ["text-secondary", "link", "canvas", "danger", "focus"] as const;

  for (const scheme of SCHEMES) {
    it(`${scheme}：覆写项达到与产品预设同一门槛`, () => {
      for (const name of OVERRIDDEN_IN_VSCODE) {
        for (const surface of SURFACES) {
          const fg = resolveLiteral(`--readora-color-${name}`, VSCODE_SCOPES[scheme]);
          const bg = resolveLiteral(`--readora-color-${surface}`, VSCODE_SCOPES[scheme]);
          const value = Number(contrastRatio(fg, bg).toFixed(2));
          const threshold = name === "border" || name === "border-strong" ? 3 : 7;
          expect(value, `${scheme} 宿主高对比 ${name} on ${surface} = ${value}:1`).toBeGreaterThanOrEqual(threshold);
        }
      }
    });

    it(`${scheme}：宿主派生的取色不被预设覆盖（ARC-006 §6.2 融入契约）`, () => {
      for (const name of HOST_DERIVED) {
        expect(
          resolveLiteral(`--readora-color-${name}`, VSCODE_SCOPES[scheme]),
          `预设动了宿主派生的 ${name}`
        ).toBe(resolveLiteral(`--readora-color-${name}`, VSCODE_DEFAULT_SCOPES[scheme]));
      }
    });
  }

  it("产品预设覆写 text-secondary，宿主预设不覆写它", () => {
    expect(HC_LIGHT.has("--readora-color-text-secondary")).toBe(true);
    expect(HC_DARK.has("--readora-color-text-secondary")).toBe(true);
    expect(HC_VSCODE.has("--readora-color-text-secondary")).toBe(false);
    expect(HC_VSCODE_DARK.has("--readora-color-text-secondary")).toBe(false);
  });
});

describe("预设块的级联位置", () => {
  const SELECTORS = [
    '[data-readora-theme="light"][data-readora-preset="high-contrast"]',
    '[data-readora-theme="dark"][data-readora-preset="high-contrast"]',
    '[data-readora-theme="vscode"][data-readora-preset="high-contrast"]',
    '[data-readora-theme="vscode"][data-readora-scheme="dark"][data-readora-preset="high-contrast"]'
  ];

  it("四格齐备，且都排在 palette / scheme 两级之后", () => {
    const tokens = styleFile("tokens.css")[1];
    const paletteAt = tokens.indexOf('[data-readora-theme="dark"] {');
    const schemeAt = tokens.indexOf('[data-readora-theme="vscode"][data-readora-scheme="dark"] {');
    for (const selector of SELECTORS) {
      const at = tokens.indexOf(`${selector} {`);
      expect(at, `${selector} 缺失`).toBeGreaterThan(-1);
      // 特异度相同的两条规则由源码顺序决胜负：预设写在前面会让暗色读到亮色取值。
      expect(at, `${selector} 排在 palette 轴之前，级联会翻车`).toBeGreaterThan(paletteAt);
      expect(at, `${selector} 排在 scheme 轴之前，宿主暗色会翻车`).toBeGreaterThan(schemeAt);
    }
  });

  it("预设块只声明语义层名字，取值一律走 var()", () => {
    for (const selector of SELECTORS) {
      const block = declarationsFor(selector);
      expect(block.size, `${selector} 是空块`).toBeGreaterThan(0);
      for (const [name, value] of block) {
        expect(name, `${selector} 出现了非语义层 token`).toMatch(/^--readora-color-[\w-]+$/u);
        expect(value, `${selector} 的 ${name} 抄了字面色值`).toContain("var(--readora-palette-");
      }
    }
  });
});
