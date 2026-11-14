/**
 * 安全与 XSS 单测（ARC-002 §11 / §15.3，验收 RND-AC-007）。
 *
 * 覆盖 §15.3 七类输入：script 标签、事件属性、javascript:/data: URL、
 * 恶意 SVG、非法与嵌套 HTML、超长输入、白名单逃逸尝试。
 * 断言只看两件事：可执行内容必须消失，正文内容必须保留。
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_SANITIZATION_POLICY, sanitizeHtml } from "../index";
import { htmlOf, render } from "./helpers";

const EXECUTABLE_TAGS = [
  "script",
  "iframe",
  "object",
  "embed",
  "link",
  "meta",
  "style",
  "svg",
  "form",
  "input",
  "img",
  "math",
  "base",
  "frame",
  "frameset"
];

/**
 * DOM 级审计：用 DOMParser（不执行脚本、不加载资源）解析产物后检查结构，
 * 避免「转义后的字面文本」被误判成可执行内容。
 */
function audit(html: string): {
  elements: string[];
  attributes: string[];
  hrefs: string[];
  nodes: Element[];
} {
  const root = new DOMParser().parseFromString(`<div>${html}</div>`, "text/html");
  const nodes = Array.from(root.body.querySelectorAll("*"));
  const elements = nodes.map((element) => element.tagName.toLowerCase());
  const attributes: string[] = [];
  const hrefs: string[] = [];
  for (const element of nodes) {
    for (const name of element.getAttributeNames()) {
      attributes.push(`${element.tagName.toLowerCase()}/${name.toLowerCase()}`);
      const value = element.getAttribute(name) ?? "";
      if (name.toLowerCase() === "href") {
        hrefs.push(value);
      }
      // 属性值里的危险 scheme 只在真实属性上判定，正文文本允许出现字面量。
      if (/^\s*(javascript|data|vbscript|file|vscode)\s*:/i.test(value)) {
        attributes.push(`VALUE_SCHEME:${element.tagName.toLowerCase()}/${name}`);
      }
    }
  }
  return { elements, attributes, hrefs, nodes };
}

function expectInert(html: string): void {
  const { elements, attributes, nodes } = audit(html);
  for (const tag of EXECUTABLE_TAGS) {
    if (tag === "img") {
      // 渲染器的图片占位是「无 src 的 <img>」：结构存在但永不发请求（ARC-008 §8.1）。
      // 带 src / srcset 的 img 属于可加载内容，必须视为违规。
      for (const element of nodes.filter((node) => node.tagName.toLowerCase() === "img")) {
        expect(element.getAttribute("src"), `loadable img in: ${html}`).toBeNull();
        expect(element.getAttribute("srcset"), `loadable img in: ${html}`).toBeNull();
      }
      continue;
    }
    expect(elements, `unexpected <${tag}> in: ${html}`).not.toContain(tag);
  }
  const eventHandlers = attributes.filter((name) => /\son[a-z]+$/.test(` ${name}`));
  expect(eventHandlers).toEqual([]);
  const schemeValues = attributes.filter((name) => name.startsWith("VALUE_SCHEME:"));
  expect(schemeValues).toEqual([]);
  expect(attributes.filter((name) => name.endsWith("/style"))).toEqual([]);
  expect(attributes.join()).not.toContain("srcdoc");
}

describe("§15.3 第 1 类：script 标签", () => {
  it("块级与行内 script 全部失效，文本仍可见", () => {
    const html = htmlOf(
      "<script>alert(1)</script>\n\n文字 <script>document.cookie</script> 后续\n\n```html\n<script>bad()</script>\n```\n"
    );
    expectInert(html);
    expect(html).toContain("alert(1)");
    // 代码块内的 script 源码被高亮 span 拆分，只需保证源码可见且不执行
    expect(html).toContain("bad");
    expect(html).toContain("&lt;script");
  });

  it("大小写与混淆写法同样拦截", () => {
    const html = htmlOf("<ScRiPt>aleRt(2)</ScRiPt>\n\n<img src=x onerror=alert(3)>\n");
    expectInert(html);
  });
});

describe("§15.3 第 2 类：事件处理属性", () => {
  it("onerror / onload / onclick 不进入产物", () => {
    const html = htmlOf(
      '<img src=x onerror="alert(1)">\n\n<div onload=alert(2)>x</div>\n\n[a](https://example.com "onclick=alert(3)")\n'
    );
    expectInert(html);
    // 事件属性只可能以「转义后的可见文本」形式存在，DOM 中不得有真实属性
    expect(html).toContain("&lt;img src=x onerror=");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<div onload");
  });

  it("属性注入尝试（title / href 内嵌引号）被转义", () => {
    const html = htmlOf('[x](https://example.com/)" onmouseover="alert(1))\n');
    expectInert(html);
  });
});

describe("§15.3 第 3 类：危险 URL scheme", () => {
  it("javascript: 与 data: 链接不产生 href", () => {
    const html = htmlOf(
      "[a](javascript:alert(1))\n\n[b](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)\n\n[c](vbscript:msgbox(1))\n"
    );
    expectInert(html);
    expect(html).not.toMatch(/href="javascript/i);
    expect(html).not.toMatch(/href="data:/i);
  });

  it("file: 与 vscode: 一律拒绝，Webview 不拼本地路径（IMP-001 §12.2）", () => {
    const html = htmlOf("[a](file:///etc/passwd)\n\n[b](vscode://settings/x)\n");
    expect(html).not.toMatch(/href="(file|vscode):/i);
  });

  it("Sanitizer 层独立拦截危险 scheme（渲染器之外的第二道闸门）", () => {
    const outcome = sanitizeHtml(
      '<a href="javascript:alert(1)">j</a><a href="#ok">a</a><a href="https://ok">e</a>',
      DEFAULT_SANITIZATION_POLICY
    );
    expect(outcome.html).not.toContain("javascript:");
    expect(outcome.html).toContain('href="#ok"');
    expect(outcome.html).toContain("https://ok");
  });

  it("策略关闭外链时 http/https 也被剥离", () => {
    const outcome = sanitizeHtml('<a href="https://example.com">x</a>', {
      ...DEFAULT_SANITIZATION_POLICY,
      allowExternalLinks: false
    });
    expect(outcome.html).not.toContain("https://example.com");
    expect(outcome.html).toContain(">x</a>");
  });

  it("mailto 属清洗层 URI 白名单，收窄策略后仍被剥离", () => {
    const allowed = sanitizeHtml('<a href="mailto:a@b.c">m</a>', DEFAULT_SANITIZATION_POLICY);
    expect(allowed.html).toContain("mailto:a@b.c");
    const blocked = sanitizeHtml('<a href="mailto:a@b.c">m</a>', {
      ...DEFAULT_SANITIZATION_POLICY,
      allowedUrlSchemes: ["http", "https"]
    });
    expect(blocked.html).not.toContain("mailto:");
  });

  it("data / javascript / file scheme 的 href 一律剥离（ARC-008 §8.3）", () => {
    for (const href of [
      "javascript:alert(1)",
      "data:text/html;base64,PHNjcmlwdD4=",
      "file:///etc/passwd",
      "vscode://fake/command"
    ]) {
      const outcome = sanitizeHtml(`<a href="${href}">x</a>`, DEFAULT_SANITIZATION_POLICY);
      expect(outcome.html, href).not.toContain("href=");
    }
  });
});

describe("§15.3 第 4 类：恶意 SVG", () => {
  it("SVG 默认整体关闭，script / foreignObject / animate 均不残留", () => {
    const html = htmlOf(
      '<svg><script>alert(1)</script></svg>\n\n<svg><foreignObject><body onload=alert(2)>x</body></foreignObject></svg>\n\n<svg><animate xlink:href="#x" attributeName="href" values="javascript:alert(3)"/></svg>\n'
    );
    expectInert(html);
    expect(html).not.toContain("<svg");
    expect(html).toContain("alert(1)");
  });

  it("Sanitizer 直接输入 SVG 时被剥离标签仅保留文本", () => {
    const outcome = sanitizeHtml("<svg><circle r=9 /></svg><p>keep</p>", DEFAULT_SANITIZATION_POLICY);
    expect(outcome.html).not.toContain("<svg");
    expect(outcome.html).not.toContain("circle");
    expect(outcome.html).toContain("keep");
  });
});

describe("§15.3 第 5 类：非法与嵌套 HTML", () => {
  it("未闭合、交叉嵌套、畸形标签不产生可执行结构", () => {
    const samples = [
      "<p>未闭合",
      "<b><i>交叉</b></i>",
      "<<div>>嵌套</div>",
      "<div><span onclick=alert(1)>x",
      "<!--注释 -->与 <?pi?> 处理指令",
      "<textarea></textarea><script>alert(1)</script>"
    ];
    for (const sample of samples) {
      expectInert(htmlOf(`${sample}\n`));
    }
  });

  it("NUL 与控制字符在 normalize 阶段被清除", () => {
    const html = htmlOf("a\u0000<b\u0009ascript>alert(1)</b\u0009ascript>\n");
    expectInert(html);
    expect(html).not.toContain("\u0000");
  });
});

describe("§15.3 第 6 类：超长输入", () => {
  it("20 万字符文档仍完成渲染且不产生 error", () => {
    const line = "这是一段很长的中文正文，用于压力测试渲染管线。";
    const source = `# 超长标题\n\n${line.repeat(9000)}\n`;
    expect(source.length).toBeGreaterThan(200_000);
    const startedAt = Date.now();
    const result = render(source);
    expect(result.html.length).toBeGreaterThan(1000);
    expect(result.diagnostics.filter((item) => item.severity === "error")).toEqual([]);
    expect(Date.now() - startedAt).toBeLessThan(15_000);
  });

  it("超长单行属性值与超长标题不撑破结构", () => {
    const long = "x".repeat(50_000);
    const html = htmlOf(`# ${long}\n\n[${long}](https://example.com/${long})\n`);
    expectInert(html);
    expect(html).toContain("readora-heading");
  });
});

describe("§15.3 第 7 类：白名单逃逸与产物形态", () => {
  it("产物不含内联脚本、事件属性与 style 属性", () => {
    const html = render(
      [
        "# 标题",
        "",
        "正文 <style>body{background:url(evil)}</style>",
        "",
        "<div style=\"background:url(javascript:alert(1))\">样式攻击</div>",
        "",
        "[按钮](https://example.com)"
      ].join("\n")
    ).html;
    expectInert(html);
    const { elements } = audit(html);
    expect(elements).not.toContain("style");
  });

  it("DOMPurify 保留渲染器所需的 data / alt / aria 标记", () => {
    const html = render("![说明](https://example.com/a.png)\n\n- [x] 任务\n").html;
    expect(html).toContain("data-readora-image");
    expect(html).toContain('alt="说明"');
    expect(html).toContain("data-readora-task");
    expect(html).toContain('aria-hidden="true"');
  });

  it("正文文本不因清洗丢失（KEEP_CONTENT）", () => {
    const html = htmlOf("安全正文 <nope>被剥离但文本保留</nope> 结束\n");
    expect(html).toContain("被剥离但文本保留");
    expect(html).not.toContain("<nope>");
  });

  it("渲染结果与 CSP 基线兼容：无 objectURL / data URI 资产、无可加载 img", () => {
    const html = render("# a\n\n![图](https://example.com/a.png)\n\n```js\nx\n```\n").html;
    expect(html).not.toContain("data:image");
    expect(html).not.toContain("blob:");
    const { attributes } = audit(html);
    expect(attributes).not.toContain("img/src");
    expect(attributes).not.toContain("img/srcset");
  });
});

describe("M10 语义三件套的安全边界", () => {
  // 新增能力不扩可达面：脚注只用白名单内的 span/a/div/p/ol/li，块属性只出 data-*，
  // csv 单元格走同一套转义。因此这三条全部复用 expectInert，没有第二套判定口径。
  it("脚注定义里的 script、属性注入尝试与自带 style 全部失效", () => {
    const html = htmlOf(
      '引 [^a] 与 [^b]。\n\n[^a]: <script>window.__pwned = 1</script>\n\n[^b]: <span style="width:10px">文本</span> {width=1px" onload="x}\n'
    );
    expectInert(html);
    const root = new DOMParser().parseFromString(`<div>${html}</div>`, "text/html");
    expect(root.body.querySelectorAll("[style], [onload], [onclick]").length).toBe(0);
    // 白名单标签保留，但内容仍然可见（不丢正文）
    expect(root.body.textContent).toContain("文本");
    expect(root.body.querySelector(".readora-footnotes")).not.toBeNull();
  });

  it("脚注锚点的 id / href 在清洗后存活（安全不靠剥锚点）", () => {
    const html = htmlOf("引 [^a]。\n\n[^a]: 定义。\n");
    expectInert(html);
    const root = new DOMParser().parseFromString(`<div>${html}</div>`, "text/html");
    const ref = root.body.querySelector(".readora-footnote-ref");
    expect(ref?.getAttribute("href")).toBe("#readora-fn-1");
    expect(ref?.getAttribute("id")).toBe("readora-fnref-1");
    expect(ref?.getAttribute("data-readora-anchor")).toBe("readora-fn-1");
    expect(root.body.querySelector(".readora-footnote-item")?.getAttribute("id")).toBe("readora-fn-1");
    const backref = root.body.querySelector(".readora-footnote-backref");
    expect(backref?.getAttribute("href")).toBe("#readora-fnref-1");
    // 带连字符的 id 不与 document 具名属性相撞（SANITIZE_DOM 不会把它吃掉）
    expect(backref?.hasAttribute("id")).toBe(false);
  });

  it("csv 与块属性写进敌意文本也不产生可执行结构", () => {
    const html = htmlOf(
      '```csv\na,b\n<script>alert(1)</script>,"<img src=x onerror=alert(2)>"\n```\n\n' +
        "# 标题 {align=center onerror=alert(3)}\n\n" +
        '![图](https://example.com/a.png){width=60%" onload="alert(4)}\n\n' +
        '![合](https://example.com/b.png){width=50%}\n'
    );
    expectInert(html);
    const root = new DOMParser().parseFromString(`<div>${html}</div>`, "text/html");
    expect(root.body.querySelectorAll("[onerror], [onload], [style]").length).toBe(0);
    // 任一项不合格 ⇒ 整串留在正文（不出现「一半生效」），而不是静默消失
    expect(root.body.textContent).toContain("{align=center onerror=alert(3)}");
    expect(root.body.textContent).toContain('{width=60%" onload="alert(4)}');
    // 干净的那一条照常落地
    expect(html).toContain('data-readora-width="50%"');
  });
});
