/**
 * 不可信 CSS 的注入拦截（F08-011 / IMP-003 §7.2 安全准入）。
 *
 * 与 `@readora/design-tokens` 的 `custom-css.spec.ts` 分工：那份量的是**净化规则**
 * （为什么这段 CSS 不合法），本份量的是**注入通道**（被拒的东西确实一个字节都没
 * 落进 HTML）。两者都要有：只测规则会出现「规则对但接线错」——例如忘了判 `ok`
 * 就把 `reason` 当样式注进去，那才是最糟的那种失败。
 *
 * 走的是真实链路：`readora.customCss` 原文 → `sanitizeCustomCss()` →
 * `renderWebviewHtml()`，与 `WebviewManager` 里的调用点逐字一致。
 */
import { READORA_ERROR_CODES } from "@readora/contracts";
import { DEFAULT_CUSTOM_CSS_MAX_CHARS, sanitizeCustomCss } from "@readora/design-tokens";
import { beforeEach, describe, expect, it, test, vi } from "vitest";

vi.mock("vscode", async () => await import("../__stubs__/vscode"));

import type * as vscode from "vscode";
import type { ReaderPreferences } from "@readora/contracts";
import { MessageDispatcher } from "../messaging/dispatcher";
import { SessionManager } from "../session/session-manager";
import { WebviewManager } from "../webview/webview-manager";
import { renderWebviewHtml, type WebviewHtmlOptions } from "../webview/html-template";
import { createdPanels, resetVscodeStub, Uri, type FakePanel } from "../__stubs__/vscode";

const preferences: ReaderPreferences = {
  theme: "auto",
  fontSize: 16,
  lineHeight: 1.75,
  contentWidth: 820,
  showOutline: true,
  typography: "newsreader",
  themePreset: "default"
};

const options: Omit<WebviewHtmlOptions, "customCss"> = {
  nonce: "n0nce",
  cspSource: "https://stub.vscode-cdn.net",
  scriptUri: "https://stub.vscode-cdn.net/assets/main.js",
  styleUri: "https://stub.vscode-cdn.net/assets/main.css",
  palette: "light",
  scheme: "light",
  typography: "newsreader",
  preset: "default"
};

/**
 * 长度上限取净化器默认值：manifest 的 `maxLength` 与它同源（`manifest.spec.ts`
 * 双向锁定），这里显式带上「配置层」语义，避免测试与调用点用的是两套边界。
 */
const CUSTOM_CSS_LIMIT = DEFAULT_CUSTOM_CSS_MAX_CHARS;

/** 从原文到最终 HTML：拒绝时与 Host 的 `resolveCustomCss` 一样注入空串。 */
function renderWithCustomCss(source: string): string {
  const outcome = sanitizeCustomCss(source, { maxChars: CUSTOM_CSS_LIMIT });
  return renderWebviewHtml({
    ...options,
    customCss: outcome.ok ? outcome.css : ""
  });
}

/** 六类攻击面，逐类给出「原文里的特征片段」用于 HTML 侧的反向断言。 */
const HOSTILE: Array<readonly [label: string, sources: string[], fragments: string[]]> = [
  [
    "@import 拉远端样式",
    ["@import url('https://evil.example/x.css'); .readora-prose { line-height: 2 }"],
    ["@import", "evil.example", ".readora-prose"]
  ],
  [
    "expression() 执行脚本",
    [".readora-prose { width: expression(window.location=1) }"],
    ["expression(", "window.location"]
  ],
  [
    "</style> 提前收尾再插标签",
    [".readora-prose{color:red}</style><img src=x onerror=alert(1)>"],
    ["</style><img", "onerror", "<img"]
  ],
  [
    "反斜杠混淆选择器",
    ["\\2e readora-prose { color: red }", ".readora\\2d prose { color: red }"],
    ["\\2e", "\\2d", "readora-prose"]
  ],
  [
    "越权选择器改写宿主与全局",
    [
      "body { display: none }",
      ":root { --readora-font-size: 40px }",
      ".readora-prose, html { position: fixed; inset: 0 }"
    ],
    ["display:none", "--readora-font-size: 40px", "position:fixed"]
  ],
  [
    "超长内容",
    [`/* ${"y".repeat(CUSTOM_CSS_LIMIT + 64)} */ .readora-prose { color: red }`],
    ["yyyy", ".readora-prose"]
  ]
];

describe("不可信 CSS 整段不落进 HTML", () => {
  for (const [label, sources, fragments] of HOSTILE) {
    for (const source of sources) {
      it(label, () => {
        const html = renderWithCustomCss(source);
        // 「整段拒绝」的判据：连一个样式节点都不产生。
        expect(html).not.toContain("<style");
        for (const fragment of fragments) {
          expect(html, `${label}：${fragment} 漏进了 HTML`).not.toContain(fragment);
        }
      });
    }
  }

  test("被拒的原文与 reason 都不会被当成样式文本", () => {
    const outcome = sanitizeCustomCss("@import url(https://evil.example/x.css);");
    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      throw new Error("这条必须被拒");
    }
    // reason 里带的是违规选择器/at-rule 的名字，只能进日志，不能进 <style>。
    const html = renderWebviewHtml({ ...options, customCss: "" });
    expect(html).not.toContain(outcome.reason);
  });
});

describe("合法微调照常注入", () => {
  test("通过净化后只有一个 style 节点，位置在 main.css 之后、脚本之前", () => {
    const html = renderWithCustomCss(
      "/* 我想让正文松一点 */\n.readora-prose { line-height: 2.1 }\n"
    );
    expect(html.match(/<style/gu)).toHaveLength(1);
    const linkIndex = html.indexOf('<link rel="stylesheet"');
    const styleIndex = html.indexOf("<style data-readora-custom-css>");
    const scriptIndex = html.indexOf("<script");
    expect(styleIndex).toBeGreaterThan(linkIndex);
    expect(styleIndex).toBeLessThan(scriptIndex);
    // 注入的是 AST 重生成文本：注释与原文格式都不带。
    expect(html).toContain("<style data-readora-custom-css>.readora-prose{line-height:2.1}</style>");
    expect(html).not.toContain("我想让正文松一点");
  });

  test("注入自定义 CSS 不放宽 CSP（样式仍只认 cspSource 与 inline）", () => {
    const plain = renderWebviewHtml(options);
    const withCss = renderWithCustomCss(".readora-prose { line-height: 2 }");
    const cspOf = (html: string): string => /<meta http-equiv="Content-Security-Policy" content="([^"]+)"/u.exec(html)?.[1] ?? "";
    expect(cspOf(withCss)).toBe(cspOf(plain));
    expect(cspOf(withCss)).not.toContain("unsafe-eval");
  });

  test("自定义 CSS 与预设/字族三个属性互不影响", () => {
    const html = renderWebviewHtml({
      ...options,
      preset: "high-contrast",
      typography: "geist",
      customCss: ".readora-prose { line-height: 2 }"
    });
    expect(html).toContain('data-readora-preset="high-contrast"');
    expect(html).toContain('data-readora-typography="geist"');
    expect(html).toContain("<style data-readora-custom-css>");
  });

  test("未设置自定义 CSS 时产物里没有 style 节点（首帧零成本）", () => {
    expect(renderWithCustomCss("")).not.toContain("<style");
    expect(renderWithCustomCss("   \n  ")).not.toContain("<style");
  });
});

/**
 * Host 接线：`WebviewManager` 只准把 `outcome.css` 交给模板，被拒时交空串。
 *
 * 上面那组测的是「模板 + 净化器」这两个零件，这一组测的是装配它们的那一行代码。
 * 少了它，`customCss: outcome.reason` 这种接线错误照样能让全部单测变绿。
 */
describe("Host 建面板时的注入", () => {
  beforeEach(() => {
    resetVscodeStub();
  });

  function openPanelWith(source: string): FakePanel {
    const sessions = new SessionManager();
    const webviews = new WebviewManager({
      extensionUri: Uri.file("/ext") as unknown as vscode.Uri,
      dispatcher: new MessageDispatcher(),
      sessions,
      getPreferences: () => preferences,
      resolveTheme: () => ({ mode: "light", source: "product" }),
      resolveCustomCss: () => sanitizeCustomCss(source, { maxChars: CUSTOM_CSS_LIMIT }),
      workspaceFolders: () => [],
      onSessionDisposed: (session) => sessions.disposeSession(session)
    });
    const { session } = sessions.getOrCreate("file:///tmp/doc.md");
    webviews.open(
      session,
      { documentUri: "file:///tmp/doc.md", languageId: "markdown", version: 1, text: "# Hi" },
      preferences,
      -1 as vscode.ViewColumn
    );
    const panel = createdPanels[0];
    if (!panel) {
      throw new Error("panel was not created");
    }
    return panel;
  }

  test("合法微调进面板，且带着预设与字族两个首帧属性", () => {
    const panel = openPanelWith(".readora-prose { line-height: 2.1 }");
    expect(panel.webview.html).toContain(
      "<style data-readora-custom-css>.readora-prose{line-height:2.1}</style>"
    );
    expect(panel.webview.html).toContain('data-readora-preset="default"');
    expect(panel.webview.html).toContain('data-readora-typography="newsreader"');
  });

  test("非法微调整段不进面板", () => {
    const panel = openPanelWith("body { display: none } @import url(https://evil.example/x.css);");
    expect(panel.webview.html).not.toContain("<style");
    expect(panel.webview.html).not.toContain("evil.example");
  });

  test("拒绝用的错误码是稳定名字（诊断日志与 README 对照它）", () => {
    expect(READORA_ERROR_CODES.CUSTOM_CSS_REJECTED).toBe("readora.custom-css.rejected");
  });
});
