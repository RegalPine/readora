/**
 * 导出 HTML 组装（M11 · 产物门禁的第一层）。
 *
 * 这里钉住的是「交付物能不能离线打开、会不会带进脚本」两件事：
 * CSP 串、`<script>` 缺席、四个主题属性、自定义 CSS 的最后一道净化，
 * 都是对外可见的承诺，改一个字都该有用例拦下来。
 */
import { describe, expect, test } from "vitest";
import {
  EXPORT_CSP,
  EXPORT_CSP_DIRECTIVES,
  EXPORT_CUSTOM_STYLE_ATTRIBUTE,
  EXPORT_PRINT_CSS,
  EXPORT_PRINT_STYLE_ATTRIBUTE,
  composeExportHtml,
  type ExportHtmlInput
} from "../export/html-builder";

function input(overrides: Partial<ExportHtmlInput> = {}): ExportHtmlInput {
  return {
    bodyHtml: '<p class="readora-paragraph">Hello</p>',
    cssText: ":root{--readora-font-size:16px}",
    rootStyleText: "--readora-font-size: 18px; --readora-line-height: 1.75;",
    customCss: "",
    palette: "dark",
    scheme: "dark",
    typography: "newsreader",
    preset: "default",
    documentVersion: 7,
    title: "doc",
    ...overrides
  };
}

describe("composeExportHtml", () => {
  test("以 DOCTYPE 开头，交付物是完整文档而不是片段", () => {
    expect(composeExportHtml(input()).startsWith("<!DOCTYPE html>")).toBe(true);
  });

  test("CSP 串逐条可断言：script-src 'none' 与 img-src data: 都在", () => {
    expect(EXPORT_CSP_DIRECTIVES).toEqual([
      "default-src 'none'",
      "script-src 'none'",
      "img-src data:",
      "font-src data:",
      "style-src 'unsafe-inline'",
      "connect-src 'none'",
      "frame-src 'none'"
    ]);
    expect(EXPORT_CSP).toBe(`${EXPORT_CSP_DIRECTIVES.join("; ")};`);
    // meta 里的串是属性转义后的形态：还原实体必须与常量一字不差（单引号被转成 `&#39;`）。
    const html = composeExportHtml(input());
    const content = /<meta http-equiv="Content-Security-Policy" content="([^"]*)" \/>/u.exec(
      html
    )?.[1];
    expect(content?.replaceAll("&#39;", "'")).toBe(EXPORT_CSP);
  });

  test("本层不写入任何 script 元素，带 </style> 的自定义 CSS 整段拒掉", () => {
    // 正文里的交互节点是序列化层的职责（那一边有 DOM）；本层要钉住的是
    // 「拼接代码自己绝不产生 script」与「注入串不能提前收尾样式块」。
    const html = composeExportHtml(
      input({ customCss: "body{}</style><script>alert(1)</script>" })
    );
    expect(html).not.toContain("<script");
    expect(html).not.toContain(EXPORT_CUSTOM_STYLE_ATTRIBUTE);
  });

  test("四个主题属性与 lang 一起写在 <html> 上，与面板 open() 同源", () => {
    const html = composeExportHtml(
      input({ palette: "vscode", scheme: "light", typography: "geist", preset: "high-contrast" })
    );
    expect(html).toContain('lang="en"');
    expect(html).toContain('data-readora-theme="vscode"');
    expect(html).toContain('data-readora-scheme="light"');
    expect(html).toContain('data-readora-typography="geist"');
    expect(html).toContain('data-readora-preset="high-contrast"');
  });

  test("根偏好变量写进行内 style，不放样式表（否则被 :root 分支覆盖）", () => {
    const html = composeExportHtml(input());
    expect(html).toContain('style="--readora-font-size: 18px; --readora-line-height: 1.75;"');
  });

  test("rootStyleText 里的引号被转义，不能提前收尾属性", () => {
    const html = composeExportHtml(input({ rootStyleText: '--x: "a"; --y: <b>' }));
    expect(html).toContain('style="--x: &quot;a&quot;; --y: &lt;b&gt;"');
    expect(html).not.toContain('--x: "a"');
  });

  test("样式表全文内联，且排在自定义 CSS 之前", () => {
    const html = composeExportHtml(input({ customCss: ".readora-x{color:red}" }));
    const styleIndex = html.indexOf(":root{--readora-font-size:16px}");
    const customIndex = html.indexOf(".readora-x{color:red}");
    expect(styleIndex).toBeGreaterThan(-1);
    expect(customIndex).toBeGreaterThan(styleIndex);
    expect(html).toContain(`<style ${EXPORT_CUSTOM_STYLE_ATTRIBUTE}>`);
  });

  test("自定义 CSS 含 </style> 时整段丢弃，连空块都不留", () => {
    const html = composeExportHtml(input({ customCss: "a{}</style><script>alert(1)</script>" }));
    expect(html).not.toContain(EXPORT_CUSTOM_STYLE_ATTRIBUTE);
  });

  test("自定义 CSS 为空时不出现对应 style 标签", () => {
    expect(composeExportHtml(input())).not.toContain(EXPORT_CUSTOM_STYLE_ATTRIBUTE);
  });

  test("打印层存在：A4 / 18mm / 关键容器 break-inside:avoid / 关过渡", () => {
    const html = composeExportHtml(input());
    expect(html).toContain(`<style ${EXPORT_PRINT_STYLE_ATTRIBUTE}>${EXPORT_PRINT_CSS}</style>`);
    expect(EXPORT_PRINT_CSS).toContain("@page{size:A4;margin:18mm}");
    expect(EXPORT_PRINT_CSS).toContain("break-inside:avoid");
    expect(EXPORT_PRINT_CSS).toContain("h1,h2,h3{break-after:avoid}");
    expect(EXPORT_PRINT_CSS).toContain("@media print");
  });

  test("正文包在 canvas + document 两层里，版本随属性写出", () => {
    const html = composeExportHtml(input());
    expect(html).toContain('<main class="readora-canvas">');
    expect(html).toContain(
      '<div class="readora-document" data-readora-document-version="7">'
    );
    expect(html).toContain('<p class="readora-paragraph">Hello</p>');
  });

  test("非法版本号落到 0，不写出负数或非整数", () => {
    expect(composeExportHtml(input({ documentVersion: -1 }))).toContain(
      'data-readora-document-version="0"'
    );
    expect(composeExportHtml(input({ documentVersion: 1.5 }))).toContain(
      'data-readora-document-version="0"'
    );
  });

  test("标题做属性级转义，含尖括号的文档名不能破坏 head", () => {
    const html = composeExportHtml(input({ title: 'a<b>"&' }));
    expect(html).toContain("<title>a&lt;b&gt;&quot;&amp;</title>");
  });
});
