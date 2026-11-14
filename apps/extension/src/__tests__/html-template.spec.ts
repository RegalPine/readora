import { describe, expect, test } from "vitest";
import {
  buildContentSecurityPolicy,
  renderWebviewHtml,
  sanitizeInjectedCss,
  type WebviewHtmlOptions
} from "../webview/html-template";

const options: WebviewHtmlOptions = {
  nonce: "abc123",
  cspSource: "https://stub.vscode-cdn.net",
  scriptUri: "https://stub.vscode-cdn.net/assets/main.js",
  styleUri: "https://stub.vscode-cdn.net/assets/main.css",
  palette: "dark",
  scheme: "dark",
  typography: "newsreader",
  preset: "default"
};

describe("buildContentSecurityPolicy", () => {
  test("default-src 'none' 且脚本仅 nonce 放行", () => {
    const csp = buildContentSecurityPolicy(options);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'nonce-abc123'");
  });

  test("禁止 unsafe-eval；脚本源不含 unsafe-inline", () => {
    const csp = buildContentSecurityPolicy(options);
    expect(csp).not.toContain("unsafe-eval");
    const scriptSrc = csp.split("; ").find((part) => part.startsWith("script-src"));
    expect(scriptSrc).toBeDefined();
    expect(scriptSrc).not.toContain("unsafe-inline");
  });

  test("样式/字体/图片限定 cspSource，frame 与 connect 关闭", () => {
    const csp = buildContentSecurityPolicy(options);
    expect(csp).toContain(`style-src ${options.cspSource}`);
    expect(csp).toContain(`font-src ${options.cspSource}`);
    expect(csp).toContain(`img-src ${options.cspSource} data:`);
    expect(csp).toContain("frame-src 'none'");
    expect(csp).toContain("connect-src 'none'");
  });
});

describe("renderWebviewHtml", () => {
  test("脚本带 nonce 与 module 类型，挂载点为 #root", () => {
    const html = renderWebviewHtml(options);
    expect(html).toContain('nonce="abc123"');
    expect(html).toContain('type="module"');
    expect(html).toContain('<div id="root"></div>');
    expect(html).toContain(options.scriptUri);
    expect(html).toContain(options.styleUri);
  });

  test("属性值转义，恶意 nonce 无法逃逸", () => {
    const html = renderWebviewHtml({ ...options, nonce: 'a"b<c>' });
    expect(html).toContain("a&quot;b&lt;c&gt;");
    expect(html).not.toContain('nonce="a"b');
  });

  test("CSP meta 中的引号被转义", () => {
    const html = renderWebviewHtml(options);
    const metaLine = html
      .split("\n")
      .find((line) => line.includes("Content-Security-Policy"));
    expect(metaLine).toBeDefined();
    expect(metaLine).toContain("&#39;none&#39;");
  });

  test("首帧就带上主题属性，不等 theme.update（PRD-003 §11.3 防闪白）", () => {
    const html = renderWebviewHtml({ ...options, palette: "light", scheme: "light" });
    expect(html).toContain('data-readora-theme="light"');
    expect(html).toContain('data-readora-scheme="light"');
  });

  test("vscode 取色层与明暗分两个属性承载，互不覆盖", () => {
    const html = renderWebviewHtml({ ...options, palette: "vscode", scheme: "dark" });
    expect(html).toContain('data-readora-theme="vscode"');
    expect(html).toContain('data-readora-scheme="dark"');
  });

  test("字族与预设同批进首帧 <html>：三者都是 paint 之前必须到位的维度", () => {
    const html = renderWebviewHtml({
      ...options,
      typography: "geist",
      preset: "high-contrast"
    });
    expect(html).toContain('data-readora-typography="geist"');
    expect(html).toContain('data-readora-preset="high-contrast"');
  });

  test("字族取值同样走属性转义，非法字符串无法逃逸", () => {
    const html = renderWebviewHtml({
      ...options,
      typography: 'x" onload="alert(1)' as never
    });
    expect(html).not.toContain('onload="alert(1)');
  });
});

describe("自定义 CSS 注入（F08-011）", () => {
  test("净化后的 CSS 落在 main.css 之后，同特异度下按 Cascade 覆盖", () => {
    const html = renderWebviewHtml({
      ...options,
      customCss: ".readora-prose { line-height: 2; }"
    });
    const styleIndex = html.indexOf('<link rel="stylesheet"');
    const customIndex = html.indexOf("<style data-readora-custom-css>");
    expect(customIndex).toBeGreaterThan(styleIndex);
    expect(html).toContain(".readora-prose { line-height: 2; }");
  });

  test("未设置自定义 CSS 时不产生空 style 节点", () => {
    expect(renderWebviewHtml({ ...options, customCss: "" })).not.toContain(
      "<style"
    );
  });

  test("绕过净化器直接传原文时，含 < 的内容一律不注入", () => {
    const html = renderWebviewHtml({
      ...options,
      customCss: ".readora-prose { color: red; }</style><script>alert(1)</script>"
    });
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("</style><script");
  });

  test("sanitizeInjectedCss 拦三种「提前结束样式块」的写法", () => {
    // 1. 直接写 </style>（任何 `<` 都不放行，属性值里的转义帮不了它）。
    expect(sanitizeInjectedCss("a { }</style><b>")).toBe("");
    // 2. HTML 注释开头，`<!--` 会让后续内容按脚本数据状态解析。
    expect(sanitizeInjectedCss("<!-- .readora-x {} -->")).toBe("");
    // 3. CSS 反斜杠续行：`<` 被拆到下一行，绕过只看单行的 naive 检查。
    expect(sanitizeInjectedCss(".readora-x { color: \\\nred }")).toBe("");
    expect(sanitizeInjectedCss("   ")).toBe("");
    expect(sanitizeInjectedCss(".readora-prose { color: red }")).toBe(
      ".readora-prose { color: red }"
    );
  });
});