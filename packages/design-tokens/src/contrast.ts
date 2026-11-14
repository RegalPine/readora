/**
 * WCAG 2.2 相对亮度与对比度（PRD-003 §14.1）。
 *
 * 本模块只服务门禁内的对比度断言（`styles/__tests__/contrast.spec.ts`），
 * 不参与运行时取色：配色对不对是构建期就能确定的静态事实，
 * 把它放进运行时等于多一条可能出错的路径。
 *
 * 支持的色值写法与 `styles/` 里实际出现的一致：`#rgb` / `#rgba` /
 * `#rrggbb` / `#rrggbbaa` / `rgb(...)` / `rgb(... / a)`。带 alpha 的颜色
 * 必须先合成到不透明底色上再算对比度——半透明文字落在画布上的实际颜色
 * 才是用户看到的那个，直接用原色算会系统性高估对比度。
 */

export interface RgbaColor {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  /** 0~1。 */
  readonly alpha: number;
}

/** AA 门槛：普通正文（PRD-003 §14.1「至少 4.5:1」）。 */
export const TEXT_AA_NORMAL = 4.5;
/** AA 门槛：大字号（≥ 24px，或 ≥ 18.66px 加粗），PRD-003 §14.1「至少 3:1」。 */
export const TEXT_AA_LARGE = 3;
/** AA 门槛：UI 边界与控件状态等非文本内容。 */
export const NON_TEXT_AA = 3;

const HEX_RE = /^#([0-9a-f]{3,8})$/i;
const RGB_RE = /^rgba?\(\s*([\d.]+%?)\s*(?:[, ]\s*([\d.]+%?)\s*(?:[, ]\s*([\d.]+%?))?)?(?:\s*[,/]\s*([\d.]+%?)\s*)?\)$/i;

function clampUnit(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function channelFromToken(token: string): number {
  if (token.endsWith("%")) {
    return Math.round((Number(token.slice(0, -1)) / 100) * 255);
  }
  return Math.round(Number(token));
}

function alphaFromToken(token: string): number {
  if (token.endsWith("%")) {
    return clampUnit(Number(token.slice(0, -1)) / 100);
  }
  return clampUnit(Number(token));
}

/**
 * 解析色值文本。不认识的写法直接抛错，而不是回落到黑色：
 * 回落会让断言「看起来通过」，那比失败更糟。
 */
export function parseCssColor(value: string): RgbaColor {
  const text = value.trim();

  const hex = HEX_RE.exec(text);
  if (hex) {
    const digits = hex[1] ?? "";
    if (digits.length === 3 || digits.length === 4) {
      const expanded = digits
        .split("")
        .map((digit) => `${digit}${digit}`)
        .join("");
      return fromHexGroups(expanded.slice(0, 2), expanded.slice(2, 4), expanded.slice(4, 6), expanded.slice(6, 8));
    }
    if (digits.length === 6 || digits.length === 8) {
      return fromHexGroups(digits.slice(0, 2), digits.slice(2, 4), digits.slice(4, 6), digits.slice(6, 8));
    }
    throw new Error(`unsupported hex color: ${value}`);
  }

  const rgb = RGB_RE.exec(text);
  if (rgb) {
    const [, red, green, blue, alpha] = rgb;
    if (red === undefined || green === undefined || blue === undefined) {
      throw new Error(`incomplete rgb color: ${value}`);
    }
    return {
      r: channelFromToken(red),
      g: channelFromToken(green),
      b: channelFromToken(blue),
      alpha: alpha === undefined ? 1 : alphaFromToken(alpha)
    };
  }

  throw new Error(`unsupported color: ${value}`);
}

function fromHexGroups(
  red: string,
  green: string,
  blue: string,
  alpha: string
): RgbaColor {
  return {
    r: Number.parseInt(red, 16),
    g: Number.parseInt(green, 16),
    b: Number.parseInt(blue, 16),
    alpha: alpha.length === 0 ? 1 : Number.parseInt(alpha, 16) / 255
  };
}

/**
 * 把带 alpha 的前景色合成到不透明背景色上（CSS `normal` 混合模式）。
 * 背景必须已不透明：底色未知时任何合成结果都是编造出来的数字。
 */
export function composite(foreground: RgbaColor, background: RgbaColor): RgbaColor {
  if (background.alpha < 1) {
    throw new Error("composite() requires an opaque background");
  }
  const alpha = foreground.alpha;
  if (alpha >= 1) {
    return { r: foreground.r, g: foreground.g, b: foreground.b, alpha: 1 };
  }
  return {
    r: Math.round(foreground.r * alpha + background.r * (1 - alpha)),
    g: Math.round(foreground.g * alpha + background.g * (1 - alpha)),
    b: Math.round(foreground.b * alpha + background.b * (1 - alpha)),
    alpha: 1
  };
}

function linearize(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG 相对亮度（前提是颜色已不透明）。 */
export function relativeLuminance(color: RgbaColor): number {
  return (
    0.2126 * linearize(color.r) +
    0.7152 * linearize(color.g) +
    0.0722 * linearize(color.b)
  );
}

/**
 * 前景 / 背景对比度，1:1 ~ 21:1。
 *
 * 前景带 alpha 时先合成到背景；背景带 alpha 时必须给出 `base`
 * （它实际落在哪块表面上），否则算出来的是一个无法解释的数字。
 */
export function contrastRatio(
  foreground: string | RgbaColor,
  background: string | RgbaColor,
  base?: string | RgbaColor
): number {
  const back = typeof background === "string" ? parseCssColor(background) : background;
  const front = typeof foreground === "string" ? parseCssColor(foreground) : foreground;
  let opaqueBase = back;
  if (back.alpha < 1) {
    if (base === undefined) {
      throw new Error("contrastRatio() needs the underlying surface when the background has alpha");
    }
    const underlying = typeof base === "string" ? parseCssColor(base) : base;
    if (underlying.alpha < 1) {
      throw new Error("contrastRatio() needs an opaque base surface");
    }
    opaqueBase = composite(back, underlying);
  }
  const frontLuminance = relativeLuminance(composite(front, opaqueBase));
  const backLuminance = relativeLuminance(opaqueBase);
  const [higher, lower] =
    frontLuminance >= backLuminance ? [frontLuminance, backLuminance] : [backLuminance, frontLuminance];
  return (higher + 0.05) / (lower + 0.05);
}

export function meetsTextAA(ratio: number, large = false): boolean {
  return ratio >= (large ? TEXT_AA_LARGE : TEXT_AA_NORMAL);
}

export function meetsNonTextAA(ratio: number): boolean {
  return ratio >= NON_TEXT_AA;
}
