/**
 * 图表主题映射契约（ARC-003 §8.2 / §8.4）。
 *
 * 主题同步走 CSS 变量：图表容器上的 `--pele-*` 由阅读器变量求值，
 * 因此切换 Light / Dark 只改变量值，不重新解析 Mermaid、不重排布局。
 *
 * 声明本体落在 apps/webview 的 styles/tokens.css（M2 起颜色不沉淀在 JS 里），
 * 本表只作为「CSS 必须覆盖的变量清单」被测试双向锁定。
 * M5 起 readerVariable 的右侧引用换成 ARC-003 §8.2 规定的 --readora-color-*
 * 体系（PRD-003 §13.1：组件层只能引用语义层），本表结构不变。
 *
 * 0.7.0 补上 `--pele-line`（连线色）：引擎对边线只认这一个变量，原先不在清单里，
 * 于是两套主题都拿它的内置默认 `#1f1f1f` 画线 —— 暗色下贴在 `#10141a` 的画布上
 * 几乎看不见。ARC-003 §8.2 的「底色 / 文字 / 边框 / 系列色」四路之外多一路。
 */

export interface PeleTokenMapping {
  /** 引擎读取的变量名。 */
  peleVariable: string;
  /** 阅读器侧提供取值的变量名。 */
  readerVariable: string;
}

export const PELE_TOKEN_MAP: readonly PeleTokenMapping[] = [
  { peleVariable: "--pele-bg", readerVariable: "--readora-diagram-canvas" },
  { peleVariable: "--pele-fg", readerVariable: "--readora-diagram-text" },
  { peleVariable: "--pele-muted", readerVariable: "--readora-diagram-muted" },
  { peleVariable: "--pele-border", readerVariable: "--readora-diagram-border" },
  { peleVariable: "--pele-line", readerVariable: "--readora-diagram-line" },
  { peleVariable: "--pele-surface", readerVariable: "--readora-diagram-surface" },
  { peleVariable: "--pele-surface-alt", readerVariable: "--readora-diagram-surface-subtle" },
  { peleVariable: "--pele-accent", readerVariable: "--readora-diagram-accent" },
  { peleVariable: "--pele-font", readerVariable: "--readora-diagram-font" }
];

/** 系列色（饼图、甘特、XY 图等多序列图表用）。 */
export const PELE_SERIES_VARIABLES: readonly string[] = [
  "--pele-series-1",
  "--pele-series-2",
  "--pele-series-3",
  "--pele-series-4",
  "--pele-series-5",
  "--pele-series-6",
  "--pele-series-7",
  "--pele-series-8"
];
