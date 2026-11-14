/**
 * @readora/design-tokens：主题 token 清单、宿主映射与对比度工具（ARC-006 / PRD-003）。
 *
 * 取值的权威在 `apps/webview/src/styles/*.css`，本包不生成 CSS、不存第二份色值，
 * 只提供三件构建期要用的东西：清单（护栏测试按名断言）、宿主映射（tokens.css 的
 * vscode 块按它写）、对比度工具（WCAG AA 矩阵）。详见 `token-registry.ts` 头注释。
 */

export {
  COLOR_PREFIX,
  COLOR_COMPONENT_TOKEN_NAMES,
  COMPONENT_TOKEN_NAMES,
  DIAGRAM_COLOR_TOKEN_NAMES,
  DIAGRAM_TOKEN_NAMES,
  DIMENSION_COMPONENT_TOKEN_NAMES,
  FOCUS_TOKEN_NAME,
  FONT_FAMILY_TOKEN_NAMES,
  FONT_SCALE_NAMES,
  FONT_SCALE_TOKEN_NAMES,
  FONT_STACK_TOKEN_NAMES,
  HOST_PREFIX,
  MOTION_NAMES,
  MOTION_TOKEN_NAMES,
  PALETTE_PREFIX,
  PALETTE_SCHEMES,
  PREFERENCE_TOKEN_NAMES,
  RADIUS_NAMES,
  RADIUS_TOKEN_NAMES,
  SEMANTIC_TOKEN_NAMES,
  SHADOW_COMPONENT_TOKEN_NAMES,
  SHADOW_NAMES,
  SHADOW_TOKEN_NAMES,
  SPACING_NAMES,
  SPACING_TOKEN_NAMES,
  SYNTAX_TOKEN_NAMES,
  TRACKING_NAMES,
  TRACKING_TOKEN_NAMES,
  isTokenName,
  paletteToken,
  semanticToken
} from "./token-registry";
export type { PaletteScheme, SemanticTokenName } from "./token-registry";

export {
  HOST_MAPPED_SEMANTIC_NAMES,
  HOST_RELAY_TOKEN_NAMES,
  HOST_THEME_MAP,
  hostDeclaration
} from "./host-theme-map";
export type { HostThemeMapping } from "./host-theme-map";

export {
  NON_TEXT_AA,
  TEXT_AA_LARGE,
  TEXT_AA_NORMAL,
  composite,
  contrastRatio,
  meetsNonTextAA,
  meetsTextAA,
  parseCssColor,
  relativeLuminance
} from "./contrast";
export type { RgbaColor } from "./contrast";

/**
 * 自定义 CSS 净化（PRD-001 F08-011）。
 *
 * 只有 Extension Host 可以调用：它带 `css-tree` 依赖（约 800 KB），Webview 侧
 * 一旦 import 就会进 `main.js` 预算。注入点唯一，是 `html-template.ts` 的
 * `<style data-readora-custom-css>`（ARC-004 §10 的 CSP 已允许 cspSource 内联样式）。
 */
export {
  ALLOWED_AT_RULE_NAMES,
  DEFAULT_CUSTOM_CSS_MAX_CHARS,
  FORBIDDEN_CUSTOM_CSS_PROPERTIES,
  sanitizeCustomCss
} from "./custom-css";
export type { CustomCssPolicy, CustomCssResult } from "./custom-css";
