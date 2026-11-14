/**
 * Token 清单（ARC-006 §4 / PRD-003 §13.1）。
 *
 * 这里只有**名字**，没有色值：取值的权威是 `apps/webview/src/styles/*.css`
 * 的文本（PRD-003 §13.4 规定 `design-tokens.spec.ts` 从 CSS 拼接后断言）。
 * 本包再存一份色值就等于造第二个真相源，两处一旦漂移，测试就只是在自证。
 *
 * 命名规则是 `--readora-{category}-{name}`（PRD-003 §13.1），因此清单按层拆分：
 * Primitive（`--readora-palette-*`）→ 语义（`--readora-color-*`）→ 组件。
 */

/** Primitive 层前缀：语义层必须引用它，改前缀等于让规则不可验证（ARC-006 §4.2）。 */
export const PALETTE_PREFIX = "--readora-palette-" as const;
/** 语义层前缀。 */
export const COLOR_PREFIX = "--readora-color-" as const;
/** 宿主中转层前缀（PRD-003 §13.3）。 */
export const HOST_PREFIX = "--readora-host-" as const;

/** 明暗两套 Primitive 的后缀。 */
export const PALETTE_SCHEMES = ["light", "dark"] as const;
export type PaletteScheme = (typeof PALETTE_SCHEMES)[number];

export function paletteToken(scheme: PaletteScheme, name: string): string {
  return `${PALETTE_PREFIX}${scheme}-${name}`;
}

export function semanticToken(name: string): string {
  return `${COLOR_PREFIX}${name}`;
}

/**
 * 语义 token 短名，PRD-003 §4.2 的 21 行为准（ARC-006 §4.3 同一张表）。
 * 暗色块必须逐名覆盖，漏一个就表现为「暗色里渗出一块亮色」，
 * 所以这份清单是断言的输入，扩充语义 token 必须同步扩充它。
 */
export const SEMANTIC_TOKEN_NAMES = [
  "canvas",
  "surface",
  "surface-subtle",
  "surface-raised",
  "surface-sunken",
  "glass",
  "text-primary",
  "text-secondary",
  "text-muted",
  "border",
  "border-strong",
  "accent",
  "accent-text",
  "accent-on",
  "accent-soft",
  "link",
  "info",
  "success",
  "warning",
  "danger",
  "overlay"
] as const;

export type SemanticTokenName = (typeof SEMANTIC_TOKEN_NAMES)[number];

/**
 * 取值必须引用语义层的组件 token（ARC-006 §4.4：值里必须出现
 * `var(--readora-color-`）。尺寸与阴影类组件 token 不在此列，
 * 它们的值是物理尺寸或投影，把它们塞进这条断言只会逼出假写法。
 */
export const COLOR_COMPONENT_TOKEN_NAMES = [
  // 面板 / 浮层（ARC-006 §4.4）
  "--readora-panel-background",
  "--readora-panel-border",
  "--readora-search-panel-background",
  "--readora-lightbox-backdrop",
  // 按钮与控件
  "--readora-button-hover-bg",
  "--readora-button-text",
  "--readora-button-border",
  // 正文块（PRD-003 §8）
  "--readora-inline-code-background",
  "--readora-quote-background",
  "--readora-code-background",
  "--readora-code-border",
  "--readora-table-header-bg",
  "--readora-table-stripe-bg",
  // 目录与工具栏
  "--readora-outline-active-bg",
  "--readora-outline-active-color",
  "--readora-outline-link-color",
  "--readora-toolbar-background",
  "--readora-toolbar-border",
  // 状态色派生的柔和底：语义色直接当大面积底色会刺眼，掺透明后两套主题各自跟随
  "--readora-note-background",
  "--readora-note-color",
  "--readora-danger-background",
  "--readora-danger-color",
  "--readora-warning-background",
  "--readora-warning-border",
  // 搜索命中高亮（ARC-007 §9.4）
  "--readora-hit-background",
  "--readora-hit-active-background",
  "--readora-hit-active-border"
] as const;

/**
 * 语法高亮 token：每主题一组，值指向 Primitive 的 `syntax` 子组。
 *
 * 它们跟着 **scheme 轴**（`[data-readora-scheme="dark"]`）而不是 palette 轴切换：
 * `vscode` 模式下代码配色也该跟着宿主明暗走，而语法色需要的色相数远超
 * 21 个语义色，硬套进语义层只会逼出「链接色当关键字色」这类假映射。
 */
export const SYNTAX_TOKEN_NAMES = [
  "--readora-syntax-foreground",
  "--readora-syntax-comment",
  "--readora-syntax-keyword",
  "--readora-syntax-string",
  "--readora-syntax-number",
  "--readora-syntax-title",
  "--readora-syntax-attr",
  "--readora-syntax-deletion"
] as const;

/**
 * 图表 token（ARC-003 §8.2）。名字由 `PELE_TOKEN_MAP` 双向锁定，
 * 其中 `--readora-diagram-font` 是字族不是颜色，故不进色彩断言。
 * `--readora-diagram-line` 是后补的一路颜色：引擎的 `--pele-line`（连线色）原先
 * 没人映射，暗色主题下会把默认的 `#1f1f1f` 直接贴到深色画布上。
 */
export const DIAGRAM_TOKEN_NAMES = [
  "--readora-diagram-canvas",
  "--readora-diagram-text",
  "--readora-diagram-muted",
  "--readora-diagram-border",
  "--readora-diagram-line",
  "--readora-diagram-surface",
  "--readora-diagram-surface-subtle",
  "--readora-diagram-accent",
  "--readora-diagram-font"
] as const;

export const DIAGRAM_COLOR_TOKEN_NAMES = DIAGRAM_TOKEN_NAMES.filter(
  (name) => name !== "--readora-diagram-font"
);

/** 尺寸 / 投影类组件 token：只断言存在且被使用，不断言取色来源。 */
export const DIMENSION_COMPONENT_TOKEN_NAMES = [
  "--readora-topbar-height",
  // M6 外壳四段：搜索段的下限由它给出，段高「随内容」但不能塌成 0（PRD-003 §10.5）。
  "--readora-searchbar-height",
  "--readora-statusbar-height",
  "--readora-outline-width",
  "--readora-hairline",
  // ARC-007：标题定位预留与活动标题基准线，M4 起被 JS 与 CSS 共用。
  "--readora-navigation-offset",
  "--readora-baseline-ratio",
  // ARC-003 §7.3：图表连线宽度（引擎不写 stroke-width，只能由我们把 SVG 初始的 1px 提上来）。
  "--readora-diagram-edge-width"
] as const;

/**
 * `--readora-shadow-pill` 是少数随主题换**形状**而非换颜色的 token
 * （PRD-003 §7.2），因此它必须同时出现在亮色块与暗色块。
 */
export const SHADOW_COMPONENT_TOKEN_NAMES = ["--readora-shadow-pill"] as const;

/**
 * 焦点环色（ARC-006 §12 第 3 条：环色必须是 token）。
 * 名字落在语义层前缀下，取值走宿主优先 + palette 兜底，因此它跟
 * `host-theme-map` 一起被「语义层取值必含 `--readora-palette-` 或 `--vscode-`」
 * 这条断言覆盖，不进组件层的 `var(--readora-color-` 断言。
 */
export const FOCUS_TOKEN_NAME = "--readora-color-focus" as const;

export const COMPONENT_TOKEN_NAMES = [
  ...COLOR_COMPONENT_TOKEN_NAMES,
  ...SYNTAX_TOKEN_NAMES,
  ...DIAGRAM_TOKEN_NAMES,
  ...DIMENSION_COMPONENT_TOKEN_NAMES,
  ...SHADOW_COMPONENT_TOKEN_NAMES
] as const;

/** 字号尺度名，`font-xs` ~ `font-3xl` 不可改名（PRD-003 §5.3）。 */
export const FONT_SCALE_NAMES = [
  "xs",
  "sm",
  "md",
  "base",
  "lg",
  "xl",
  "2xl",
  "3xl",
  "4xl"
] as const;

export const FONT_SCALE_TOKEN_NAMES = FONT_SCALE_NAMES.map(
  (name) => `--readora-font-${name}`
) as readonly string[];

/** 字距 token（PRD-003 §5.3）。 */
export const TRACKING_NAMES = ["tight", "label"] as const;
export const TRACKING_TOKEN_NAMES = TRACKING_NAMES.map(
  (name) => `--readora-tracking-${name}`
) as readonly string[];

/** 三套字族，主题只改颜色不改字族（PRD-003 §5.2）。 */
export const FONT_FAMILY_TOKEN_NAMES = [
  "--readora-font-family-display",
  "--readora-font-family-body",
  "--readora-font-family-mono"
] as const;

/**
 * 字族栈（M6）：栈本身只在这里出现一次，`[data-readora-typography=...]` 的三个
 * 取值只改上面三个语义名的指向。字族偏好要有三档可选，就必然需要一份独立的栈表。
 *
 * 三个取值不在这里列名：`READER_TYPOGRAPHIES` 的权威在 `@readora/contracts`，
 * 本包重复一份就是第二个真相源。webview 侧的门禁用例把那份枚举与 CSS 里的
 * `[data-readora-typography=...]` 块直接对撞（§7）。
 */
export const FONT_STACK_TOKEN_NAMES = [
  "--readora-font-stack-serif",
  "--readora-font-stack-sans",
  "--readora-font-stack-ui",
  "--readora-font-stack-mono"
] as const;

/** 4px 基础间距单位（PRD-003 §6.1）。 */
export const SPACING_NAMES = [
  "1",
  "2",
  "3",
  "4",
  "5",
  "6",
  "8",
  "10",
  "12",
  "16"
] as const;
export const SPACING_TOKEN_NAMES = SPACING_NAMES.map(
  (name) => `--readora-space-${name}`
) as readonly string[];

/** 圆角尺度（PRD-003 §7.1）。 */
export const RADIUS_NAMES = ["none", "sm", "md", "lg", "xl", "full"] as const;
export const RADIUS_TOKEN_NAMES = RADIUS_NAMES.map(
  (name) => `--readora-radius-${name}`
) as readonly string[];

/** 投影尺度（PRD-003 §7.2，`shadow-pill` 单列为组件 token）。 */
export const SHADOW_NAMES = ["none", "sm", "md", "lg"] as const;
export const SHADOW_TOKEN_NAMES = SHADOW_NAMES.map(
  (name) => `--readora-shadow-${name}`
) as readonly string[];

/** motion 四档（PRD-003 §12.2）。 */
export const MOTION_NAMES = ["fast", "normal", "slow", "dialog"] as const;
export const MOTION_TOKEN_NAMES = MOTION_NAMES.map(
  (name) => `--readora-motion-${name}`
) as readonly string[];

/** 阅读偏好变量（PRD-003 §11.4：偏好只改这三个变量）。 */
export const PREFERENCE_TOKEN_NAMES = [
  "--readora-font-size",
  "--readora-line-height",
  "--readora-content-width"
] as const;

const TOKEN_NAME_RE = /^--readora-[a-z0-9]+(-[a-z0-9]+)*$/;

export function isTokenName(name: string): boolean {
  return TOKEN_NAME_RE.test(name);
}
