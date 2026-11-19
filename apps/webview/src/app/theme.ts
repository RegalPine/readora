/**
 * 主题运行时（ARC-006 §8 / §11）。
 *
 * 权威在 CSS：三层 Token 全在 `styles/tokens.css`，切换主题只需把两个属性写到
 * `<html>` 上，JS 不搬色值——ARC-006 §8.1 的 `applyTheme` 逐 token 注入在这里
 * 收敛成「属性 + 三个偏好变量」，否则 tokens.css 与 JS 各持一份取值就又是双源。
 *
 *  palette 轴 → `data-readora-theme`（light / dark / vscode，取值只走 themePalette）
 *  scheme  轴 → `data-readora-scheme`（light / dark，代码配色与图表系列色跟它）
 *
 * 偏好同样走变量（PRD-003 §11.4 单一变量驱动）：正文字号、行高、内容宽度写在
 * `:root` 上，正文与按 em 给的标题一起跟着走，不再叠内联样式。
 */
import {
  CONTENT_WIDTH_MAX,
  CONTENT_WIDTH_MIN,
  isReaderTypography,
  isThemePreset,
  themePalette,
  type ReaderPreferences,
  type ThemeState
} from "@readora/contracts";

/**
 * 接续 Host 写入 HTML 的首帧主题，避免 React 挂载时用默认亮色覆盖暗色。
 * HTML 仅含 palette/scheme；auto 与产品主题同用产品色板，来源元数据稍后由
 * theme.update 补齐。宿主色板必须保留 vscode 来源，否则明暗相同也会换色。
 */
export function readInitialTheme(root: HTMLElement): ThemeState {
  const palette = root.dataset.readoraTheme;
  const scheme = root.dataset.readoraScheme;
  return {
    mode: scheme === "dark" || scheme === "light" ? scheme : palette === "dark" ? "dark" : "light",
    source: palette === "vscode" ? "vscode" : "product"
  };
}

/** 正文字号区间：与 `ReaderPreferencesSchema.fontSize` 同边界（护栏测试逐值锁定）。 */
export const FONT_SIZE_MIN = 8;
export const FONT_SIZE_MAX = 32;
/** 行高是无单位倍数（1.0 以下会让行间咬在一起，3.0 以上正文散架）。 */
export const LINE_HEIGHT_MIN = 1;
export const LINE_HEIGHT_MAX = 3;

/** 三个偏好变量的名字：CSS 侧的消费点在 `styles/base.css`。 */
export const FONT_SIZE_VARIABLE = "--readora-font-size" as const;
export const LINE_HEIGHT_VARIABLE = "--readora-line-height" as const;
export const CONTENT_WIDTH_VARIABLE = "--readora-content-width" as const;

/**
 * 生效的阅读偏好中影响视觉的那几项。
 *
 * 主题与布局开关（`showOutline`）不在此列：它们走各自的通道。
 * `themePreset` / `typography` 是**属性**而不是变量，因此可选 —— Host 还没下发
 * 偏好时不动它们，让首帧预置（`html-template.ts` 写的那四个 data-*）继续生效，
 * 否则一次 `theme.update` 就会把首帧的字族与预设抹回默认值。
 */
export type ThemePreferences = Pick<
  ReaderPreferences,
  "fontSize" | "lineHeight" | "contentWidth"
> &
  Partial<Pick<ReaderPreferences, "themePreset" | "typography">>;

/**
 * 数值 → 长度值。
 *
 * 只接受有限数并夹回区间，产出必然是 `<number>px` 这一种形状：偏好来自 Host 的
 * 配置项，用户可以往里面写任意值，不能让它把自由文本拼进 CSS（ARC-006 §8.1
 * 「禁止把不可信输入直接拼接进 CSS」）。`null` 同样按无效处理——上游
 * （`scaledFontSize`）判定不成立时不要写变量，让 tokens.css 的声明继续生效。
 */
function lengthPx(value: number | null, min: number, max: number, unit = "px"): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  const clamped = Math.min(max, Math.max(min, value));
  return `${clamped}${unit}`;
}

/**
 * 基准字号 × 会话内缩放（PRD-003 §10.5 缩放组、§11.4）。
 *
 * 只做「相乘 + 量化到整像素」，把**夹区间留给 lengthPx**：这里再夹一遍就是两处
 * 口径，改边界时必漏一处。`16 × 1.15 = 18.4` 这类半像素字号会让行高与字距在小数
 * 上抖，所以先 round。
 *
 * 基准非有限值返回 null，由调用方**不写这个变量** —— 退回 16px 这种硬编码等于在
 * JS 里再存一份缺省值，而缺省值的权威是 tokens.css（ARC-006 §8.1 单一真相源）。
 * 缩放是内部状态，异常值只可能是编程错误，按 1 处理即可，不值得为此抹掉字号偏好。
 */
export function scaledFontSize(fontSize: number, zoom: number): number | null {
  if (typeof fontSize !== "number" || !Number.isFinite(fontSize)) {
    return null;
  }
  const scale = typeof zoom === "number" && Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  return Math.round(fontSize * scale);
}

/**
 * 把主题状态落到根元素上：两个属性 + （给了偏好时）预设/字族两个属性与三个变量。
 *
 * 幂等且不触碰任何其他状态——切换主题只改属性值，不重载文档、不重置滚动、
 * 不清导航状态、不重建 Reader Shell（ARC-006 §11.1 六条约束由调用方与本函数
 * 各配一条断言，见 `__tests__/theme-runtime.spec.tsx`）。
 *
 * @param zoom 会话内缩放，只影响 `--readora-font-size` 这一个变量；行高是倍数、
 *             内容宽度是版面约束，都不跟着缩放走（否则缩放的正是「字相对行」的
 *             关系，那属于字号偏好的职责）。
 */
export function applyTheme(
  root: HTMLElement,
  theme: ThemeState,
  preferences?: ThemePreferences,
  zoom = 1
): void {
  root.dataset.readoraTheme = themePalette(theme);
  root.dataset.readoraScheme = theme.mode;
  if (!preferences) {
    return;
  }
  // 预设与字族走属性：取值先过枚举护栏。偏好来自 Host 配置（用户可以往里面
  // 写任意字符串），白名单之外的值一律不落 DOM——与下面 lengthPx 同一口径。
  if (isThemePreset(preferences.themePreset)) {
    root.dataset.readoraPreset = preferences.themePreset;
  }
  if (isReaderTypography(preferences.typography)) {
    root.dataset.readoraTypography = preferences.typography;
  }
  // 缩放后的字号仍是「数字 + px」这一种形状：lengthPx 的白名单出口照旧守着
  // ARC-006 §8.1「禁止把不可信输入直接拼接进 CSS」。
  const fontSize = lengthPx(scaledFontSize(preferences.fontSize, zoom), FONT_SIZE_MIN, FONT_SIZE_MAX);
  if (fontSize) {
    root.style.setProperty(FONT_SIZE_VARIABLE, fontSize);
  }
  // 行高写无单位倍数：带 px 的行高会让正文按 px 解释，行间关系整个变形。
  const lineHeight = lengthPx(preferences.lineHeight, LINE_HEIGHT_MIN, LINE_HEIGHT_MAX, "");
  if (lineHeight) {
    root.style.setProperty(LINE_HEIGHT_VARIABLE, lineHeight);
  }
  const contentWidth = lengthPx(preferences.contentWidth, CONTENT_WIDTH_MIN, CONTENT_WIDTH_MAX);
  if (contentWidth) {
    root.style.setProperty(CONTENT_WIDTH_VARIABLE, contentWidth);
  }
}
