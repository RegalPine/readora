/**
 * Webview HTML 模板（ARC-004 §10 安全基线 / ARC-008）。
 *
 * CSP 要点：default-src 'none'；脚本仅 nonce 放行；无 unsafe-eval；
 * 样式/字体/图片限定 cspSource（图片额外允许 data:）。
 * 所有插入属性均转义，nonce 每次打开面板随机生成。
 */
import type {
  ReaderTypography,
  ResolvedTheme,
  ThemePalette,
  ThemePreset
} from "@readora/contracts";

export interface WebviewHtmlOptions {
  nonce: string;
  cspSource: string;
  scriptUri: string;
  styleUri: string;
  /** 首帧取色层（PRD-003 §11.3 防闪白：必须在 paint 之前落到位）。 */
  palette: ThemePalette;
  /** 首帧明暗，供 vscode 取色层挑对应的调色板回退。 */
  scheme: ResolvedTheme;
  /** 首帧字族（PRD-003 §10.5 Reader Typography）：同样为了防止脚本接管后换字体重排。 */
  typography: ReaderTypography;
  /** 首帧主题预设（F08-010 高对比）。 */
  preset: ThemePreset;
  /**
   * 已净化的自定义 CSS（F08-011）。
   *
   * 只接受 `sanitizeCustomCss()` 返回的 `ok: true` 产物 —— 那是 AST 重新生成的文本，
   * 已保证不含 `<`，因此这里可以不再走 `escapeAttribute`（属性转义塞进 `<style>`
   * 反而会把 `&lt;` 之类原样写进样式表）。为空则整个 `<style>` 不出现。
   */
  customCss?: string;
}

/**
 * 属性转义（面板模板与导出模板共用）。
 *
 * 两处必须同一份实现：否则面板侧修了一轮转义规则，导出件还能用旧规则写出可提前
 * 收尾的属性。导出模板不 import 本模块的 CSP（两套策略本就不同：导出件永不带脚本），
 * 只复用这个纯函数。
 */
export function escapeAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function buildContentSecurityPolicy(options: WebviewHtmlOptions): string {
  return [
    "default-src 'none'",
    `script-src 'nonce-${options.nonce}'`,
    `style-src ${options.cspSource} 'unsafe-inline'`,
    `font-src ${options.cspSource}`,
    `img-src ${options.cspSource} data:`,
    "frame-src 'none'",
    "connect-src 'none'"
  ].join("; ");
}

/**
 * 注入前的最后一道防线：即便调用方忘了净化，也绝不允许原文进 `<style>`。
 *
 * 三道判断各自对应一种「提前结束样式块」的写法：`<`（`</style>` 收尾）、
 * `<!--`（注释里藏 HTML）、`\` 加换行（CSS 转义换行把 `</style>` 拆成两行）。
 * `sanitizeCustomCss()` 的输出是 AST 重生成文本，天然不含这些，因此正常情况下
 * 这里只是把「未净化」与「净化过」两种调用者都收敛到同一个安全出口。
 */
export function sanitizeInjectedCss(css: string): string {
  const text = css.trim();
  if (text === "") {
    return "";
  }
  if (text.includes("<") || text.includes("<!--") || /\\(?:\r|\n)/u.test(text)) {
    return "";
  }
  return text;
}

export function renderWebviewHtml(options: WebviewHtmlOptions): string {
  const csp = escapeAttribute(buildContentSecurityPolicy(options));
  const nonce = escapeAttribute(options.nonce);
  const scriptUri = escapeAttribute(options.scriptUri);
  const styleUri = escapeAttribute(options.styleUri);
  const palette = escapeAttribute(options.palette);
  const scheme = escapeAttribute(options.scheme);
  const typography = escapeAttribute(options.typography);
  const preset = escapeAttribute(options.preset);
  const customCss = sanitizeInjectedCss(options.customCss ?? "");
  // 自定义 CSS 落在 main.css 之后、脚本之前：首帧即生效（无 FOUC），
  // 且它在 `<link>` 之后出现，同特异度下按 Cascade 覆盖产品样式。
  const customStyle = customCss
    ? `\n<style data-readora-custom-css>${customCss}</style>`
    : "";
  return `<!DOCTYPE html>
<html lang="en" data-readora-theme="${palette}" data-readora-scheme="${scheme}" data-readora-typography="${typography}" data-readora-preset="${preset}">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<link rel="stylesheet" href="${styleUri}" />${customStyle}
<title>Readora</title>
</head>
<body>
<div id="root"></div>
<script type="module" nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>
`;
}