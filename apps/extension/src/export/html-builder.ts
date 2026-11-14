/**
 * 导出 HTML 组装（M11 · 导出链路）。
 *
 * 交付物是**单文件自包含**的：样式表全文内联、字体与图片已是 `data:`，因此它
 * 一旦离开本机也能原样打开 —— 这也决定了这里的 CSP 与面板模板是两套策略：
 *
 * - 面板：`script-src 'nonce-…'`，脚本是产品本体；
 * - 导出件：**永不带 `<script>`**，`script-src 'none'` 直接封死。净化后的图表 SVG
 *   与正文 HTML 都是从已净化 DOM 上摘下来的，本层只拼接不解析，纵深防御仍在。
 *
 * `img-src data:` / `font-src data:` 是关键的一条：被资源策略拦住的远程图在屏上
 * 本来就是占位卡，导出件里就算残留了引用也加载不了 —— 但这不是理由，而是双重
 * 保证（序列化层已把 `img[src]` 摘干净，安全用例钉住不含 `vscode-webview://`）。
 *
 * 根元素的三个偏好变量写进行内 `style`：那是屏上排版的唯一作者（`theme.ts`），
 * 放样式表里会被 main.css 的 `:root` 分支覆盖，导出就会「比屏幕小一号」。
 */
import type {
  ReaderTypography,
  ResolvedTheme,
  ThemePalette,
  ThemePreset
} from "@readora/contracts";
import { escapeAttribute, sanitizeInjectedCss } from "../webview/html-template";

/**
 * 导出件 CSP（固定串，逐条可断言）。
 *
 * `style-src 'unsafe-inline'` 是本方案的必要条件：样式与根变量都以 inline 形态存在，
 * 没有它整份交付物就没有排版。除此之外一切外联通道都是 `'none'` 或 `data:`。
 */
export const EXPORT_CSP_DIRECTIVES = [
  "default-src 'none'",
  "script-src 'none'",
  "img-src data:",
  "font-src data:",
  "style-src 'unsafe-inline'",
  "connect-src 'none'",
  "frame-src 'none'"
] as const;

export const EXPORT_CSP = `${EXPORT_CSP_DIRECTIVES.join("; ")};`;

/**
 * 打印层（PDF 版面）。
 *
 * 纸张与边距是本轮锁定口径（A4 / 18 mm），`break-inside:avoid` 落在会被切碎的
 * 容器上：图表被分成两页等于不可读，代码块与表格同理。标题只禁止「紧跟其后
 * 就断页」，不禁止自身跨页。关过渡与动画是因为 `--virtual-time-budget` 会快进
 * 时间：留着它们，截图与 PDF 会抓到中间帧。
 */
export const EXPORT_PRINT_CSS = [
  "@page{size:A4;margin:18mm}",
  ".readora-diagram,pre,table,blockquote,figure{break-inside:avoid}",
  "h1,h2,h3{break-after:avoid}",
  "@media print{*,*::before,*::after{transition:none!important;animation:none!important}}"
].join("");

export const EXPORT_DOCUMENT_CLASS = "readora-document";
export const EXPORT_CANVAS_CLASS = "readora-canvas";
export const EXPORT_PRINT_STYLE_ATTRIBUTE = "data-readora-export-print";
export const EXPORT_CUSTOM_STYLE_ATTRIBUTE = "data-readora-custom-css";

export interface ExportHtmlInput {
  /** 序列化层交出的正文片段（已剥交互节点、已摘 img src）。 */
  readonly bodyHtml: string;
  /** 字体已内联为 `data:` 的 main.css 全文。 */
  readonly cssText: string;
  /** 根元素上的三个偏好声明（`--readora-font-size: …`），原样进行内 style。 */
  readonly rootStyleText: string;
  /** 自定义 CSS 原文：本层自己再走一次 `sanitizeInjectedCss`，不接受「已净化」承诺。 */
  readonly customCss: string;
  readonly palette: ThemePalette;
  readonly scheme: ResolvedTheme;
  readonly typography: ReaderTypography;
  readonly preset: ThemePreset;
  readonly documentVersion: number;
  readonly title: string;
}

/**
 * `<html>` 上的四个主题属性必须与面板 `open()` 写入的同一批值：
 * 交付物的取色、明暗、字族、高对比预设都由这四个属性选择，少一个就换一套颜色。
 */
function documentAttributes(input: ExportHtmlInput): string {
  return [
    'lang="en"',
    `style="${escapeAttribute(input.rootStyleText)}"`,
    `data-readora-theme="${escapeAttribute(input.palette)}"`,
    `data-readora-scheme="${escapeAttribute(input.scheme)}"`,
    `data-readora-typography="${escapeAttribute(input.typography)}"`,
    `data-readora-preset="${escapeAttribute(input.preset)}"`
  ].join(" ");
}

export function composeExportHtml(input: ExportHtmlInput): string {
  const csp = escapeAttribute(EXPORT_CSP);
  const title = escapeAttribute(input.title);
  // 与面板同一判据：为空就不出现，拒绝的 CSS 也不该在交付物里留一个空块。
  const customCss = sanitizeInjectedCss(input.customCss);
  const customStyle = customCss
    ? `\n<style ${EXPORT_CUSTOM_STYLE_ATTRIBUTE}>${customCss}</style>`
    : "";
  const version = Number.isInteger(input.documentVersion) && input.documentVersion >= 0
    ? input.documentVersion
    : 0;
  return `<!DOCTYPE html>
<html ${documentAttributes(input)}>
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<style>${input.cssText}</style>${customStyle}
<style ${EXPORT_PRINT_STYLE_ATTRIBUTE}>${EXPORT_PRINT_CSS}</style>
<title>${title}</title>
</head>
<body>
<main class="${EXPORT_CANVAS_CLASS}">
<div class="${EXPORT_DOCUMENT_CLASS}" data-readora-document-version="${version}">${input.bodyHtml}</div>
</main>
</body>
</html>
`;
}
