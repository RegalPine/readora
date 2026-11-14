/**
 * Token 清单自检（PRD-003 §13.1 / ARC-006 §4）。
 *
 * 清单本身也会出错：重复名会让 CSS 里后写的覆盖前写的，
 * 不合规的名字会让 `design-tokens.spec.ts` 的按名断言形同虚设。
 */
import { describe, expect, test } from "vitest";
import {
  COMPONENT_TOKEN_NAMES,
  DIAGRAM_COLOR_TOKEN_NAMES,
  DIAGRAM_TOKEN_NAMES,
  FONT_SCALE_NAMES,
  FONT_SCALE_TOKEN_NAMES,
  HOST_PREFIX,
  MOTION_NAMES,
  MOTION_TOKEN_NAMES,
  PALETTE_PREFIX,
  RADIUS_TOKEN_NAMES,
  SEMANTIC_TOKEN_NAMES,
  SPACING_TOKEN_NAMES,
  SYNTAX_TOKEN_NAMES,
  isTokenName,
  paletteToken,
  semanticToken
} from "../token-registry";
import { HOST_RELAY_TOKEN_NAMES, HOST_THEME_MAP, hostDeclaration } from "../host-theme-map";

function expectUnique(label: string, names: readonly string[]): void {
  const duplicated = names.filter((name, index) => names.indexOf(name) !== index);
  expect(duplicated, `${label} 存在重名`).toEqual([]);
}

describe("清单", () => {
  test("语义层 21 名，与 PRD-003 §4.2 的行数一致", () => {
    expect(SEMANTIC_TOKEN_NAMES).toHaveLength(21);
    expect(new Set(SEMANTIC_TOKEN_NAMES).size).toBe(SEMANTIC_TOKEN_NAMES.length);
  });

  test("各层清单内部无重复", () => {
    expectUnique("语义层", SEMANTIC_TOKEN_NAMES);
    expectUnique("组件层", COMPONENT_TOKEN_NAMES);
    expectUnique("语法色", SYNTAX_TOKEN_NAMES);
    expectUnique("图表", DIAGRAM_TOKEN_NAMES);
    expectUnique("字号", FONT_SCALE_TOKEN_NAMES);
    expectUnique("间距", SPACING_TOKEN_NAMES);
    expectUnique("圆角", RADIUS_TOKEN_NAMES);
    expectUnique("motion", MOTION_TOKEN_NAMES);
    expectUnique("宿主中转", HOST_RELAY_TOKEN_NAMES);
  });

  test("全名都匹配 --readora-{category}-{name}", () => {
    const invalid = [
      ...COMPONENT_TOKEN_NAMES,
      ...SYNTAX_TOKEN_NAMES,
      ...DIAGRAM_TOKEN_NAMES,
      ...FONT_SCALE_TOKEN_NAMES,
      ...SPACING_TOKEN_NAMES,
      ...RADIUS_TOKEN_NAMES,
      ...MOTION_TOKEN_NAMES,
      ...HOST_RELAY_TOKEN_NAMES,
      ...SEMANTIC_TOKEN_NAMES.map(semanticToken)
    ].filter((name) => !isTokenName(name));
    expect(invalid).toEqual([]);
  });

  test("图表颜色 token 是 9 名去掉字族，字族不参与对比度", () => {
    expect(DIAGRAM_TOKEN_NAMES).toHaveLength(9);
    expect(DIAGRAM_COLOR_TOKEN_NAMES).toHaveLength(8);
    expect(DIAGRAM_COLOR_TOKEN_NAMES).not.toContain("--readora-diagram-font");
    // 连线色必须在清单里：它是引擎 `--pele-line` 的唯一来源，漏了就会退回 #1f1f1f。
    expect(DIAGRAM_COLOR_TOKEN_NAMES).toContain("--readora-diagram-line");
  });

  test("字号含 xs~3xl（PRD-003 §5.3 不可改名），motion 四档", () => {
    for (const name of ["xs", "sm", "md", "base", "lg", "xl", "2xl", "3xl"]) {
      expect(FONT_SCALE_NAMES).toContain(name);
    }
    expect(MOTION_NAMES).toEqual(["fast", "normal", "slow", "dialog"]);
  });

  test("前缀是契约：改前缀等于把规则从可验证变成不可验证", () => {
    expect(PALETTE_PREFIX).toBe("--readora-palette-");
    expect(HOST_PREFIX).toBe("--readora-host-");
    expect(semanticToken("canvas")).toBe("--readora-color-canvas");
    expect(paletteToken("light", "canvas")).toBe("--readora-palette-light-canvas");
    expect(paletteToken("dark", "accent-text")).toBe("--readora-palette-dark-accent-text");
  });
});

describe("宿主映射", () => {
  test("ARC-006 §6.1 的九条一一对应", () => {
    expect(HOST_THEME_MAP).toHaveLength(9);
    expect(HOST_THEME_MAP.map((entry) => entry.name)).toEqual([
      "canvas",
      "text-primary",
      "surface",
      "border",
      "surface-subtle",
      "text-secondary",
      "focus",
      "link",
      "danger"
    ]);
  });

  test("每条声明都是宿主优先、语义 token 兜底，且 fallback 不写色值", () => {
    for (const entry of HOST_THEME_MAP) {
      const declaration = hostDeclaration(entry);
      expect(declaration).toContain(`var(${entry.hostVariable}, var(${entry.semanticToken}))`);
      expect(declaration).not.toMatch(/#[0-9a-f]{3,8}/iu);
      expect(declaration.startsWith(entry.relay)).toBe(true);
    }
  });

  test("宿主变量名与中转变量名都不重复", () => {
    expect(new Set(HOST_THEME_MAP.map((entry) => entry.hostVariable)).size).toBe(9);
    expect(new Set(HOST_THEME_MAP.map((entry) => entry.relay)).size).toBe(9);
  });

  test("中转变量名一律小写连字符，驼峰段不照搬宿主写法（PRD-003 §13.3）", () => {
    expect(HOST_RELAY_TOKEN_NAMES).toEqual([
      "--readora-host-editor-background",
      "--readora-host-editor-foreground",
      "--readora-host-panel-background",
      "--readora-host-panel-border",
      "--readora-host-side-bar-background",
      "--readora-host-description-foreground",
      "--readora-host-focus-border",
      "--readora-host-text-link-foreground",
      "--readora-host-error-foreground"
    ]);
  });
});
