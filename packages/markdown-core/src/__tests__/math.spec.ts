/**
 * 数学公式用例（IMP-001 §10.2 / §10.3，EPIC-06 / STORY-06-01）。
 *
 * 断言分四层，与实现的分工一一对应：
 * 1. 规则层（本文件「定界符」组）：什么才算公式，什么必须留在散文里；
 * 2. 处理器层（另见 processors.spec）：标记节点如何归类、不成立如何还原；
 * 3. 渲染层（本文件「降级」组）：单条失败只降级本条，绝不炸整篇；
 * 4. 净化层（本文件「白名单限域」组）：扩了公式白名单不等于扩了可达面。
 */
import { describe, expect, it } from "vitest";
import { buildAst } from "../ast";
import { renderMarkdown } from "../index";
import { countSourceLines } from "../normalize";
import { createMarkdownParser } from "../parser";
import { runProcessors } from "../processors";
import {
  KATEX_OPTIONS,
  MATH_SOURCE_MAX_LENGTH,
  isDisplayMathMarkup,
  isRenderableMath,
  renderMathExpression
} from "../math";
import {
  DEFAULT_SANITIZATION_POLICY,
  MATH_MARKUP_SCOPE,
  sanitizeHtml
} from "../sanitizer";
import { DOCUMENT_ID, DOCUMENT_URI } from "./helpers";
import type { MarkdownDocument, MarkdownNode } from "../types";

function documentOf(source: string): MarkdownDocument {
  const tokens = createMarkdownParser().parse(source);
  return buildAst(tokens, DOCUMENT_ID, countSourceLines(source));
}

function allOf(document: MarkdownDocument, type: string): MarkdownNode[] {
  const found: MarkdownNode[] = [];
  const walk = (node: MarkdownNode): void => {
    if (node.type === type) {
      found.push(node);
    }
    for (const child of node.children ?? []) {
      walk(child);
    }
  };
  walk(document);
  return found;
}

function render(text: string): ReturnType<typeof renderMarkdown> {
  return renderMarkdown({ documentId: DOCUMENT_ID, documentUri: DOCUMENT_URI, version: 1, text });
}

function dom(html: string): Document {
  return new DOMParser().parseFromString(`<div>${html}</div>`, "text/html");
}

function container(html: string): HTMLElement {
  return dom(html).body.firstElementChild as HTMLElement;
}

describe("定界符识别（IMP-001 §10.1）", () => {
  it("行内 $…$ 与句中 $$…$$ 各自成式", () => {
    const result = render("质能方程 $E=mc^2$，级数 $$\\sum_{i=1}^{n} x_i$$ 结束。\n");
    const root = container(result.html);
    expect(root.querySelectorAll(".readora-math--inline")).toHaveLength(1);
    // 源码写的是双美元符，即使夹在句中，也按 display 语义落 block
    expect(root.querySelectorAll(".readora-math--block")).toHaveLength(1);
    expect(root.querySelector(".katex")).not.toBeNull();
  });

  it("独占一行的 $$…$$ 成为块级公式并保留源行区间", () => {
    const result = render("前段\n\n$$\n\\frac{a}{b} = c\n$$\n\n后段\n");
    const root = container(result.html);
    const block = root.querySelector(".readora-math--block");
    expect(block).not.toBeNull();
    // 块级公式不应当被包进某个 <p>：它自己就是一个顶层块
    expect(block?.parentElement?.tagName).not.toBe("P");

    const document = runProcessors(documentOf("前段\n\n$$\n\\frac{a}{b} = c\n$$\n\n后段\n"));
    const mathBlock = allOf(document, "mathBlock");
    expect(mathBlock).toHaveLength(1);
    expect(mathBlock[0]?.attributes?.source).toBe("\\frac{a}{b} = c");
    expect(mathBlock[0]?.position).toEqual({ startLine: 2, endLine: 4 });
  });

  it("货币写法三种拒判全部命中：开界后空白、闭界前空白、跨行", () => {
    const money = render("总价 $100 和 $200 都还是文本。\n");
    expect(money.html).toContain("总价 $100 和 $200");
    expect(money.html).not.toContain("readora-math");

    // 开界符后紧跟空白：`$ x$` 不是公式
    expect(render("看 $ x$ 这里\n").html).not.toContain("readora-math");
    // 闭界符前紧跟空白：`$x $` 不是公式
    expect(render("看 $x $ 这里\n").html).not.toContain("readora-math");
    // 跨行：行内式不得跨越换行
    expect(render("起 $x\ny$ 止\n").html).not.toContain("readora-math");
    // 空表达式没有渲染意义
    expect(render("空 $$$$$ 也还原\n").html).not.toContain("readora-math");
  });

  it("下划线与反斜杠不被 escape 抢先损坏（规则顺序不变量）", () => {
    // `_` 若先被 emphasis 规则吃掉，x_i 会变成 <em>i</em>；
    // `\\` 与 `\,` 若先被 escape 规则吃掉，KaTeX 收到的就是坏源码。
    const result = render("求和 $\\sum_{i=1}^{n} x_i$ 与间距 $a\\,b$。\n");
    expect(result.html).not.toContain("<em>");
    expect(result.html).not.toContain("readora-unsupported");
    const root = container(result.html);
    expect(root.querySelectorAll(".readora-math--inline")).toHaveLength(2);
    expect(
      result.diagnostics.filter((item) => item.code === "readora.render.math-failed")
    ).toHaveLength(0);
  });

  it("嵌套与长公式照常渲染", () => {
    const nested = render("$$\n\\sqrt{\\frac{\\sum_{i=1}^{n} i^2}{n}} \\le \\left(\\frac{n+1}{2}\\right)^{2}\n$$\n");
    expect(nested.html).toContain('data-readora-math-status="ok"');
    // 根式的伸缩定界符走 svg：它必须留在公式子树内
    expect(nested.html).toContain("<svg");
    expect(nested.html.indexOf("<svg")).toBeGreaterThan(nested.html.indexOf(MATH_MARKUP_SCOPE));

    const long = render(`$$\n${"x_{i} + ".repeat(200)}y\n$$\n`);
    expect(long.html).toContain('data-readora-math-status="ok"');
    expect(
      long.diagnostics.filter((item) => item.severity === "error")
    ).toHaveLength(0);
  });

  it("代码块与行内代码里的美元符不是公式", () => {
    const result = render("`$x^2$` 是代码\n\n```\n$$\nx\n$$\n```\n");
    expect(result.html).not.toContain("readora-math");
    expect(result.html).toContain("<code");
  });
});

describe("LaTeX 传统定界符 \\(…\\) 与 \\[…\\]", () => {
  it("行内 \\(…\\) 与句中 \\[…\\] 各自成式", () => {
    const result = render("收益率为 \\(r_i\\)，级数 \\[\\sum_{i=1}^{n} x_i\\] 结束。\n");
    const root = container(result.html);
    expect(root.querySelectorAll(".readora-math--inline")).toHaveLength(1);
    // 源码写的是 \[ ，即使夹在句中也按 display 语义落 block —— 与 $$ 同口径
    expect(root.querySelectorAll(".readora-math--block")).toHaveLength(1);
    expect(root.querySelector(".katex")).not.toBeNull();
    // 定界符本身不得以裸文本留下
    expect(result.html).not.toContain("\\(");
    expect(result.html).not.toContain("\\[");
  });

  it("独占一行的 \\[…\\] 成为块级公式并保留源行区间", () => {
    const source = "前段\n\n\\[\n\\frac{a}{b} = c\n\\]\n\n后段\n";
    const root = container(render(source).html);
    const block = root.querySelector(".readora-math--block");
    expect(block).not.toBeNull();
    expect(block?.parentElement?.tagName).not.toBe("P");

    const document = runProcessors(documentOf(source));
    const mathBlock = allOf(document, "mathBlock");
    expect(mathBlock).toHaveLength(1);
    expect(mathBlock[0]?.attributes?.source).toBe("\\frac{a}{b} = c");
    expect(mathBlock[0]?.position).toEqual({ startLine: 2, endLine: 4 });
  });

  it("tex 族不做货币式空白拒判：\\( a+b \\) 仍是公式", () => {
    // `\(` 没有「钱」这种歧义，套 $ 的紧贴空白规则只会误伤合法写法
    const root = container(render("空格包围的 \\( a+b \\) 也要渲染。\n").html);
    expect(root.querySelectorAll(".readora-math--inline")).toHaveLength(1);
    expect(root.querySelector(".katex")).not.toBeNull();
  });

  it("跨行与未闭合都交回散文，且绝不吞后文", () => {
    // 行内式不跨行
    expect(render("起 \\(x\ny\\) 止\n").html).not.toContain("readora-math");
    // 未闭合的 \( ：escape 规则接手，产物与扩展前一致
    const unclosed = render("未闭合 \\(x 在此结束\n");
    expect(unclosed.html).not.toContain("readora-math");
    expect(unclosed.html).toContain("未闭合");
    // 未闭合的 \[ 块：整段按散文，后面的段落照常存在
    const openBlock = render("前段\n\n\\[\nx\n\n后段\n");
    expect(openBlock.html).not.toContain("readora-math");
    expect(openBlock.html).toContain("后段");
  });

  it("矩阵行尾 \\\\ 不吃掉闭界符", () => {
    const inline = render("矩阵 \\(a \\\\ b\\) 结束。\n");
    expect(inline.html).toContain('data-readora-math-status="ok"');
    const block = render("\\[\n\\begin{matrix}a & b \\\\\\ c & d\\end{matrix}\n\\]\n");
    expect(block.html).toContain('data-readora-math-status="ok"');
  });

  it("下划线与反斜杠不被 escape 抢先损坏", () => {
    const result = render("求和 \\(\\sum_{i=1}^{n} x_i\\) 与间距 \\(a\\,b\\)。\n");
    expect(result.html).not.toContain("<em>");
    const root = container(result.html);
    expect(root.querySelectorAll(".readora-math--inline")).toHaveLength(2);
    expect(
      result.diagnostics.filter((item) => item.code === "readora.render.math-failed")
    ).toHaveLength(0);
  });

  it("代码块与行内代码里的 \\[ 不是公式", () => {
    const result = render("`\\[x\\]` 是代码\n\n```\n\\[\nx\n\\]\n```\n");
    expect(result.html).not.toContain("readora-math");
    expect(result.html).toContain("<code");
  });

  it("tex 式非法时降级为自身源码，同段另一条照常", () => {
    const result = render("甲 \\(\\rule{100m}{100m}\\) 乙，丙 \\(x^2\\) 丁。\n");
    const root = container(result.html);
    const failed = root.querySelector("[data-readora-math-status='error']");
    expect(failed?.textContent).toBe("\\rule{100m}{100m}");
    expect(root.textContent).toContain("乙，丙");
    expect(root.querySelectorAll("[data-readora-math-status='ok']")).toHaveLength(1);
    expect(result.diagnostics.filter((item) => item.severity === "error")).toHaveLength(0);
  });

  it("isDisplayMathMarkup 只认块级族的开界符", () => {
    expect(isDisplayMathMarkup("$$")).toBe(true);
    expect(isDisplayMathMarkup("\\[")).toBe(true);
    expect(isDisplayMathMarkup("$")).toBe(false);
    expect(isDisplayMathMarkup("\\(")).toBe(false);
    expect(isDisplayMathMarkup(undefined)).toBe(false);
    expect(isDisplayMathMarkup("[[")).toBe(false);
  });

  it("已知代价：想写裸方括号的 \\[Nota\\] 会被当公式尝试", () => {
    // 这是接管 \[ \] 的固有代价（KaTeX auto-render 同此），README 偏差登记；
    // 要写 literal 方括号请用未转义的 [Nota] 或反引号包裹。
    const result = render("参见 \\[Nota\\] 一节。\n");
    expect(result.html).toContain("readora-math");
  });
});

describe("降级与隔离（IMP-001 §10.2）", () => {
  it("非法表达式降级为自身源码，整篇照常", () => {
    const result = render("甲 $\\frac{1}{$ 乙，丙 $x^2$ 丁。\n");
    const root = container(result.html);
    const failed = root.querySelector("[data-readora-math-status='error']");
    expect(failed?.textContent).toBe("\\frac{1}{");
    // 同段落其余内容与另一条公式不受影响
    expect(root.textContent).toContain("乙，丙");
    expect(root.querySelectorAll("[data-readora-math-status='ok']")).toHaveLength(1);
    const warning = result.diagnostics.filter(
      (item) => item.code === "readora.render.math-failed"
    );
    expect(warning).toHaveLength(1);
    expect(warning[0]?.severity).toBe("warning");
    expect(result.diagnostics.filter((item) => item.severity === "error")).toHaveLength(0);
  });

  it("降级源码可见且可复制，不带上游错误结构", () => {
    // 尺寸字符串本身非法（不是「超限」），KaTeX 在两种模式下都报 ParseError
    const result = render("$$\n\\rule{100m}{100m}\n$$\n");
    const root = container(result.html);
    const failed = root.querySelector("[data-readora-math-status='error']");
    expect(failed?.textContent).toBe("\\rule{100m}{100m}");
    expect(failed?.getAttribute("data-readora-math-source")).toBe("\\rule{100m}{100m}");
    // 降级产物是纯文本，不带 KaTeX 自己的错误结构（它带内联 style 与 title）
    expect(result.html).not.toContain("katex-error");
  });

  it("不可信命令在 trust:false 下不产生链接与资源引用", () => {
    const result = render("$\\href{https://evil.example/x}{点我}$ 与 $\\includegraphics{a.png}$。\n");
    expect(result.html).not.toContain("<a href");
    expect(result.html).not.toContain("evil.example");
    expect(result.html.match(/href=/g) ?? []).toHaveLength(0);
    // 命令名以纯文本可见，用户能看出文档里写了什么
    expect(result.html).toContain("\\href");
    expect(result.html).toContain("\\includegraphics");
  });

  it("超长源码不进 KaTeX：整条按失败降级", () => {
    const source = "x".repeat(MATH_SOURCE_MAX_LENGTH + 1);
    expect(isRenderableMath(source)).toBe(false);
    const outcome = renderMathExpression(source, "inline");
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toContain(String(MATH_SOURCE_MAX_LENGTH));
  });

  it("maxSize 钳制而非报错：超尺寸请求被限制在排版上限内（偏差登记：docs 写「按失败降级」）", () => {
    const outcome = renderMathExpression("\\rule{100em}{100em}", "block");
    expect(outcome.ok).toBe(true);
    // KaTeX 对超限尺寸的处理是夹到 maxSize，于是产物里出现的最大 em 就是上限本身
    expect(outcome.html).toContain(`height:${KATEX_OPTIONS.maxSize}em`);
    expect(outcome.html).not.toContain("height:100em");
  });

  it("KATEX_OPTIONS 冻结安全口径", () => {
    expect(KATEX_OPTIONS).toMatchObject({
      throwOnError: false,
      strict: false,
      trust: false,
      output: "html"
    });
  });
});

describe("公式白名单限域（IMP-001 §10.3 末段）", () => {
  it("公式产物保留内联 style 与 svg", () => {
    const result = render("$$\n\\sqrt{x}\n$$\n");
    const root = container(result.html);
    const scope = root.querySelector(`.${MATH_MARKUP_SCOPE}`);
    expect(scope?.querySelector("svg")).not.toBeNull();
    expect(scope?.querySelector("[style]")).not.toBeNull();
  });

  it("子树外的 style / svg / path 一律不可得", () => {
    const hostile =
      '<p style="color:red">正文</p><svg data-outside="1"><path d="M0 0"/></svg>' +
      `<span class="${MATH_MARKUP_SCOPE}"><svg data-inside="1"><path d="M1 1"/></svg>` +
      `<span style="height:1em">公式</span></span>`;
    const outcome = sanitizeHtml(hostile, DEFAULT_SANITIZATION_POLICY);
    const root = container(outcome.html);

    // 子树外的 svg 整节点删除（连 path 一起），子树内的 svg 原样保留
    const survivors = Array.from(root.querySelectorAll("svg"));
    expect(survivors).toHaveLength(1);
    expect(survivors[0]?.getAttribute("data-inside")).toBe("1");
    expect(root.querySelectorAll("path")).toHaveLength(1);
    expect(root.querySelector("path")?.getAttribute("d")).toBe("M1 1");
    for (const element of Array.from(root.querySelectorAll("[style]"))) {
      expect(element.closest(`.${MATH_MARKUP_SCOPE}`), element.tagName).not.toBeNull();
    }
    expect(root.textContent).toContain("正文");
    expect(
      outcome.diagnostics.some((item) => item.code === "readora.render.math-scope-stripped")
    ).toBe(true);
  });

  it("文档自带的 script / 事件属性 / xlink:href 仍被剥净", () => {
    const outcome = sanitizeHtml(
      '<span class="readora-math"><svg xlink:href="data:x"><script>alert(1)</script></svg></span>' +
        '<img src="https://evil" onerror="alert(1)">',
      DEFAULT_SANITIZATION_POLICY
    );
    expect(outcome.html).not.toContain("script");
    expect(outcome.html).not.toContain("onerror");
    expect(outcome.html).not.toContain("xlink");
    expect(outcome.html).not.toContain("href=");
  });
});
