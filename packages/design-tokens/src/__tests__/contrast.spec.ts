/**
 * 对比度工具的自证（PRD-003 §14.1）。
 *
 * 这里断言的是**算法**：合成、亮度、比值、门槛。配色本身合不合格在
 * `apps/webview/src/styles/__tests__/contrast.spec.ts`，那边读 CSS 取值。
 */
import { describe, expect, test } from "vitest";
import {
  composite,
  contrastRatio,
  meetsNonTextAA,
  meetsTextAA,
  parseCssColor,
  relativeLuminance
} from "../contrast";

describe("parseCssColor", () => {
  test("三位 / 四位 / 六位 / 八位十六进制", () => {
    expect(parseCssColor("#fff")).toEqual({ r: 255, g: 255, b: 255, alpha: 1 });
    expect(parseCssColor("#0b1c30")).toEqual({ r: 11, g: 28, b: 48, alpha: 1 });
    expect(parseCssColor("#f8f9ff").r).toBe(248);
    const translucent = parseCssColor("#5300b780");
    expect(translucent.r).toBe(0x53);
    expect(translucent.alpha).toBeCloseTo(0x80 / 255, 6);
    const shortAlpha = parseCssColor("#0008");
    expect(shortAlpha.r).toBe(0);
    expect(shortAlpha.alpha).toBeCloseTo(0x88 / 255, 6);
  });

  test("空格分隔与逗号分隔的 rgb()，含百分比 alpha", () => {
    expect(parseCssColor("rgb(204 195 215 / 0.7)")).toEqual({
      r: 204,
      g: 195,
      b: 215,
      alpha: 0.7
    });
    expect(parseCssColor("rgba(11, 28, 48, 50%)")).toEqual({
      r: 11,
      g: 28,
      b: 48,
      alpha: 0.5
    });
    expect(parseCssColor("rgb(1 2 3)").alpha).toBe(1);
  });

  test("不认识的写法抛错而不是回落到某个颜色", () => {
    for (const value of ["rebeccapurple", "hsl(120 50% 50%)", "#gg0000", "rgb(1 2)"]) {
      expect(() => parseCssColor(value)).toThrow();
    }
  });
});

describe("composite", () => {
  test("半透明按 alpha 线性混合", () => {
    const grey = composite(parseCssColor("#ffffff80"), parseCssColor("#000000"));
    expect(grey).toEqual({ r: 128, g: 128, b: 128, alpha: 1 });
  });

  test("不透明前景直接覆盖", () => {
    expect(composite(parseCssColor("#6d28d9"), parseCssColor("#f8f9ff"))).toEqual({
      ...parseCssColor("#6d28d9"),
      alpha: 1
    });
  });

  test("底色不透明才谈合成", () => {
    expect(() =>
      composite(parseCssColor("#00000080"), parseCssColor("#ffffff80"))
    ).toThrow(/opaque background/u);
  });
});

describe("relativeLuminance / contrastRatio", () => {
  test("两端锚点：纯白 1、纯黑 0、黑白对比 21:1", () => {
    expect(relativeLuminance(parseCssColor("#ffffff"))).toBeCloseTo(1, 6);
    expect(relativeLuminance(parseCssColor("#000000"))).toBeCloseTo(0, 6);
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 1);
  });

  test("前景与背景互换，比值不变", () => {
    const a = contrastRatio("#0b1c30", "#f8f9ff");
    const b = contrastRatio("#f8f9ff", "#0b1c30");
    expect(a).toBeCloseTo(b, 6);
  });

  test("半透明文字按合成后的实际颜色计，比直接用原色更暗→对比度更低", () => {
    const solid = contrastRatio("#ffffff", "#000000");
    const faded = contrastRatio("#ffffff80", "#000000");
    expect(solid).toBeCloseTo(21, 1);
    expect(faded).toBeLessThan(solid);
    expect(faded).toBeGreaterThan(4);
  });

  test("半透明底色必须给出它落在哪块表面上", () => {
    expect(() => contrastRatio("#0b1c30", "rgb(204 195 215 / 0.7)")).toThrow(
      /underlying surface/u
    );
    const withBase = contrastRatio("#0b1c30", "rgb(204 195 215 / 0.7)", "#f8f9ff");
    expect(withBase).toBeGreaterThan(1);
  });

  test("PRD-003 §4.2 的 text-muted 加深是必须的，不是审美微调", () => {
    const canvas = "#f8f9ff";
    // 原型基准值 #7b7486 在画布上约 4.3:1，不过小字号 AA。
    expect(meetsTextAA(contrastRatio("#7b7486", canvas))).toBe(false);
    expect(meetsTextAA(contrastRatio("#6b6478", canvas))).toBe(true);
  });
});

describe("AA 门槛", () => {
  test("普通正文 4.5、大字号与非文本 3", () => {
    expect(meetsTextAA(4.5)).toBe(true);
    expect(meetsTextAA(4.49)).toBe(false);
    expect(meetsTextAA(3.2, true)).toBe(true);
    expect(meetsTextAA(2.9, true)).toBe(false);
    expect(meetsNonTextAA(3)).toBe(true);
    expect(meetsNonTextAA(2.99)).toBe(false);
  });
});
