/**
 * 依赖与运行环境兼容性单测（IMP-001 §3.3 第 7 条、§4.3 依赖边界）。
 *
 * 本 spec 自身只在测试进程使用 node:fs 做静态守护；
 * 被测运行时代码（src 下所有模块）必须保持零 VS Code / 零 node: 依赖。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import hljs from "highlight.js/lib/core";
import DOMPurify from "dompurify";
import MarkdownIt from "markdown-it";
import { escapeHtml } from "../escape";
import { createMarkdownParser } from "../parser";
import { DEFAULT_SANITIZATION_POLICY, sanitizeHtml } from "../sanitizer";
import { computeContentHash, renderMarkdown } from "../index";
import { DOCUMENT_ID, DOCUMENT_URI } from "./helpers";

const SOURCE_ROOT = resolve(process.cwd(), "src");

function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "__tests__") {
        continue;
      }
      files.push(...sourceFiles(full));
      continue;
    }
    if (entry.endsWith(".ts")) {
      files.push(full);
    }
  }
  return files;
}

describe("依赖边界（IMP-001 §4.2 / §4.3）", () => {
  it("运行时代码不 import vscode 与 node: 内置模块", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SOURCE_ROOT)) {
      const content = readFileSync(file, "utf8");
      if (/from\s+["']vscode["']|require\(\s*["']vscode["']/.test(content)) {
        offenders.push(`${file}: vscode`);
      }
      if (/from\s+["']node:|require\(\s*["']node:/.test(content)) {
        offenders.push(`${file}: node:`);
      }
      // 只匹配真实使用形态（process.cwd 等），不误伤名为 process 的接口方法。
      if (/\b(?:process|__dirname|__filename|Buffer)\s*[.[]/.test(content)) {
        offenders.push(`${file}: node global`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("package.json 运行时依赖只有四个已审定库", () => {
    const manifest = JSON.parse(
      readFileSync(resolve(process.cwd(), "package.json"), "utf8")
    ) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(Object.keys(manifest.dependencies ?? {}).sort()).toEqual([
      "dompurify",
      "highlight.js",
      "katex",
      "markdown-it"
    ]);
    expect(manifest.devDependencies?.["@types/vscode"]).toBeUndefined();
    // markdown-it 15 自带类型定义，不需要 @types/markdown-it。
    expect(manifest.devDependencies?.["@types/markdown-it"]).toBeUndefined();
  });
});

describe("markdown-it 在目标环境的最小可用性", () => {
  it("ESM 默认导出可 new，parse 返回 Token 数组", () => {
    const md = new MarkdownIt({ html: false, linkify: true });
    expect(md.parse("# a\n", {})).toBeInstanceOf(Array);
    expect(md.render("# a\n")).toContain("<h1");
  });

  it("管线封装与直接使用结果一致", () => {
    const source = "段落 **粗**\n";
    const viaParser = createMarkdownParser().parse(source);
    const viaDirect = new MarkdownIt({ html: false, linkify: true, typographer: false, breaks: false }).parse(
      source,
      {}
    );
    expect(viaParser.map((token) => token.type)).toEqual(viaDirect.map((token) => token.type));
  });

  it("jsdom 环境下不依赖 window 之外的浏览器专有 API", () => {
    expect(() => createMarkdownParser().parse("a\n")).not.toThrow();
  });
});

describe("DOMPurify 在 jsdom / Webview 环境的最小可用性", () => {
  it("isSupported 为 true，否则管线必须走 fail-closed", () => {
    expect(DOMPurify.isSupported).toBe(true);
  });

  it("危险标签与属性被剥离，正文保留", () => {
    const outcome = sanitizeHtml(
      '<p>正文</p><script>alert(1)</script><img src=x onerror=alert(1)>',
      DEFAULT_SANITIZATION_POLICY
    );
    expect(outcome.diagnostics).toEqual([]);
    expect(outcome.html).toContain("<p>正文</p>");
    expect(outcome.html).not.toContain("<script");
    expect(outcome.html).not.toContain("onerror");
  });

  it("配置对象形态受支持（RETURN_DOM:false 返回字符串）", () => {
    const outcome = sanitizeHtml("<div>x</div>", DEFAULT_SANITIZATION_POLICY);
    expect(typeof outcome.html).toBe("string");
  });
});

describe("highlight.js core 子集可用性", () => {
  it("core 入口不含全量语言，仅注册子集", () => {
    expect(hljs.listLanguages().length).toBeLessThan(25);
    expect(hljs.getLanguage("javascript")).toBeDefined();
  });

  it("highlight 返回 { value } 契约稳定", () => {
    const result = hljs.highlight("const a = 1;", { language: "javascript", ignoreIllegals: true });
    expect(typeof result.value).toBe("string");
    expect(result.value).toContain("hljs-");
  });

  it("高亮产物只含 span/class，可通过自家白名单", () => {
    const highlighted = hljs.highlight("SELECT * FROM t;", { language: "sql", ignoreIllegals: true })
      .value;
    const outcome = sanitizeHtml(
      `<pre><code>${highlighted}</code></pre>`,
      DEFAULT_SANITIZATION_POLICY
    );
    expect(outcome.html).toContain("hljs-");
    expect(outcome.html).not.toContain("<script");
  });
});

describe("三库组合后的端到端最小契约", () => {
  const source = "# 标题\n\n正文 `code` 与 [链接](https://example.com)\n";

  it("同输入多次渲染结果完全一致（无时间/随机因素）", () => {
    const request = {
      documentId: DOCUMENT_ID,
      documentUri: DOCUMENT_URI,
      version: 3,
      text: source
    };
    const first = renderMarkdown(request);
    const second = renderMarkdown(request);
    expect(first).toEqual(second);
    expect(first.version).toBe(3);
  });

  it("computeContentHash 稳定、短小、可区分内容", () => {
    expect(computeContentHash(source)).toBe(computeContentHash(source));
    expect(computeContentHash(source)).toMatch(/^[0-9a-f]{8}$/);
    expect(computeContentHash(`${source}\n`)).not.toBe(computeContentHash(source));
    expect(computeContentHash("")).toBe(computeContentHash(""));
  });

  it("转义工具与产物口径一致", () => {
    expect(escapeHtml('<a href="x">&</a>')).toBe(
      "&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;"
    );
  });
});
