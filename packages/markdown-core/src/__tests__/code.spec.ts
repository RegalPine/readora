/**
 * 代码块与语法高亮单测（ARC-002 §8，验收 RND-AC-004）。
 */
import hljs from "highlight.js/lib/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  highlightCode,
  isLanguageRegistered,
  registerLanguages,
  supportedLanguages
} from "../highlight";
import { RENDER_DIAGNOSTIC_CODES } from "../index";
import { htmlOf, render } from "./helpers";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("语言标识与结构（§8.1）", () => {
  it("围栏语言、复制入口、横向滚动容器齐备", () => {
    const html = htmlOf("```python\nprint('hi')\n```\n");
    expect(html).toContain('data-readora-code-lang="python"');
    expect(html).toContain('<pre class="readora-code-pre">');
    expect(html).toContain('class="hljs language-python"');
    expect(html).toContain("data-readora-copy");
    expect(html).toContain('<span class="readora-code-lang">python</span>');
  });

  it("高亮只产出 hljs span，不含脚本与内联事件", () => {
    const html = htmlOf("```javascript\nconst a = 1;\n```\n");
    expect(html).toContain('<span class="hljs-keyword">const</span>');
    expect(html).not.toContain("<script");
    expect(html).not.toMatch(/on\w+=/);
  });

  it("无语言围栏渲染为普通代码块，不产生 warning", () => {
    const result = render("```\nplain text\n```\n");
    expect(result.html).toContain('data-readora-code-state="plain"');
    expect(result.diagnostics.filter((item) => item.severity !== "info")).toEqual([]);
  });

  it("text / plaintext 别名为普通代码块", () => {
    expect(htmlOf("```text\nx\n```\n")).toContain('data-readora-code-state="plain"');
    expect(highlightCode("x", "plaintext").kind).toBe("plain");
  });

  it("内容 HTML 转义（§8.3 第 3 条）", () => {
    const html = htmlOf("```\n<script>alert(1)</script>\n<div>a&b</div>\n```\n");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&amp;");
  });

  it("代码内容原样保留（空行、缩进、长行）", () => {
    const code = "第一行\n\n    缩进行\n".repeat(3);
    const result = render("```\n" + code + "```\n");
    expect(result.html).toContain("第一行");
    expect(result.html).toContain("缩进行");
  });
});

describe("未注册语言降级（§8.3 第 2 条）", () => {
  it("未知语言 → 普通代码块 + warning 诊断，内容不丢", () => {
    const result = render("```brainfuck\n++++[<->-]\n```\n");
    expect(result.html).toContain('data-readora-code-state="unsupported"');
    expect(result.html).toContain("++++[&lt;-&gt;-]");
    const warning = result.diagnostics.find(
      (item) => item.code === RENDER_DIAGNOSTIC_CODES.UNSUPPORTED_LANGUAGE
    );
    expect(warning?.severity).toBe("warning");
    expect(warning?.message).toContain("brainfuck");
  });

  it("语言标识大小写与别名由 highlight.js 判定", () => {
    expect(isLanguageRegistered("js")).toBe(true);
    expect(highlightCode("const a = 1;", "JavaScript").kind).toBe("highlighted");
    expect(highlightCode("x", "klingon").kind).toBe("unsupported");
  });

  it("只注册常用语言子集，未引入全量语言包（IMP-001 §3.5 / F11-001）", () => {
    const registered = supportedLanguages();
    expect(registered.length).toBeLessThanOrEqual(20);
    for (const language of [
      "javascript",
      "typescript",
      "json",
      "python",
      "bash",
      "shell",
      "yaml",
      "markdown",
      "css",
      "scss",
      "html",
      "diff",
      "sql",
      "rust",
      "go"
    ]) {
      expect(registered).toContain(language);
    }
    expect(registered).not.toContain("matlab");
    expect(registered).not.toContain("vim");
  });
});

describe("高亮异常局部降级（§8.3 第 1 条、§14.3）", () => {
  it("highlight 调用抛错时退化为转义纯文本并给出 warning", () => {
    vi.spyOn(hljs, "highlight").mockImplementation(() => {
      throw new Error("highlight internal failure");
    });
    const result = render("```python\nprint(1)\n```\n");
    expect(result.html).toContain('data-readora-code-state="failed"');
    expect(result.html).toContain("print(1)");
    const warning = result.diagnostics.find(
      (item) => item.code === RENDER_DIAGNOSTIC_CODES.HIGHLIGHT_FAILED
    );
    expect(warning?.severity).toBe("warning");
    expect(warning?.message).toContain("python");
  });

  it("单个语言定义损坏不影响同篇其它代码块与正文", () => {
    // 用损坏的语言定义模拟「高亮内部故障」：实测 highlight.js 11 自行兜底为
    // Plain text（不把异常抛给调用方），因此这里锁定的契约是故障隔离——
    // 正文与其它代码块不受牵连，且不产生 error 诊断。
    hljs.registerLanguage("python", () => {
      throw new Error("broken language definition");
    });
    try {
      const result = render(
        "# 标题\n\n```python\nbad block\n```\n\n```javascript\nconst ok = 1;\n```\n\n段落仍在\n"
      );
      expect(result.html).toContain("bad block");
      expect(result.html).toContain('data-readora-code-lang="javascript"');
      expect(result.html).toContain('data-readora-code-state="highlighted"');
      expect(result.html).toContain("ok");
      expect(result.html).toContain('<h1 id="标题"');
      expect(result.html).toContain("段落仍在");
      expect(result.diagnostics.filter((item) => item.severity === "error")).toEqual([]);
      expect(result.html.match(/<pre/g)?.length).toBe(2);
    } finally {
      registerLanguages();
    }
    expect(isLanguageRegistered("python")).toBe(true);
    expect(highlightCode("print(1)", "python").kind).toBe("highlighted");
  });

  it("对抗性输入不抛穿（模糊样本）", () => {
    const samples = ["", "\n", "<<>>", "&amp;&lt;", "🙂".repeat(50), "a".repeat(5000), "\\x00"];
    for (const language of ["javascript", "python", "html", "sql", "yaml"]) {
      for (const code of samples) {
        expect(() => highlightCode(code, language)).not.toThrow();
      }
    }
  });
});
