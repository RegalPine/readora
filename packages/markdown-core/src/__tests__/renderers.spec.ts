/**
 * 基础语法渲染单测（ARC-002 §7，验收 RND-AC-001）。
 *
 * 断言针对 sanitize 后的最终 HTML：既验证结构，也验证白名单没有吃掉语义标记。
 */
import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../index";
import type { MarkdownNode } from "../types";
import { DOCUMENT_ID, DOCUMENT_URI, htmlOf, renderNode } from "./helpers";

describe("标题与段落（§7.1 / §7.2）", () => {
  it("1..6 级标题产出对应标签与锚点 id", () => {
    const html = htmlOf("# 一\n\n## 二\n\n###### 六\n");
    expect(html).toContain('<h1 id="一" class="readora-heading readora-heading--h1"');
    expect(html).toContain('<h2 id="二" class="readora-heading readora-heading--h2"');
    expect(html).toContain('<h6 id="六" class="readora-heading readora-heading--h6"');
    expect(html).toContain("data-readora-heading=");
  });

  it("标题内的行内标记保留结构，锚点取纯文本", () => {
    const html = htmlOf("# 粗体 **强调** 结尾\n");
    expect(html).toContain('<h1 id="粗体-强调-结尾"');
    expect(html).toContain('<strong class="readora-strong">强调</strong>');
  });

  it("段落与行内语法（粗体/斜体/删除线/行内码/硬换行）", () => {
    const html = htmlOf("普通 **粗** *斜* ~~删~~ `码` 换行  \n第二行\n");
    expect(html).toContain('<p class="readora-paragraph">');
    expect(html).toContain('<strong class="readora-strong">粗</strong>');
    expect(html).toContain('<em class="readora-emphasis">斜</em>');
    expect(html).toContain('<del class="readora-delete">删</del>');
    expect(html).toContain('<code class="readora-inline-code">码</code>');
    expect(html).toMatch(/<br[^>]*class="readora-break"/);
  });

  it("转义字符以原文呈现，不产生标签", () => {
    const html = htmlOf("字面 \\*星号\\* 与 <尖括号>\n");
    expect(html).toContain("*星号*");
    expect(html).toContain("&lt;尖括号&gt;");
    expect(html).not.toContain("<尖括号>");
  });
});

describe("列表（§7.3）", () => {
  it("无序 / 有序列表与嵌套层级", () => {
    const html = htmlOf("- 一\n  - 嵌套\n\n1. 甲\n2. 乙\n");
    expect(html).toContain('<ul class="readora-list">');
    expect(html).toContain('<ol class="readora-list">');
    expect(html).toContain('<li class="readora-list-item">');
    // 嵌套：ul 内部再出现 ul
    const first = html.indexOf("<ul");
    const nested = html.indexOf("<ul", first + 1);
    expect(nested).toBeGreaterThan(first);
  });

  it("非 1 起始的有序列表保留 start", () => {
    const html = htmlOf("3. 甲\n4. 乙\n");
    expect(html).toContain('start="3"');
  });

  it("任务列表为展示态：结构标记存在但无可交互控件（F01-016）", () => {
    const html = htmlOf("- [x] 已完成\n- [ ] 未完成\n");
    expect(html).toContain('class="readora-list readora-list--task"');
    expect(html).toContain('data-readora-task="checked"');
    expect(html).toContain('data-readora-task="unchecked"');
    expect(html).toContain('aria-label="completed task"');
    expect(html).not.toContain("<input");
    expect(html).not.toContain("[x]");
  });

  it("tight 列表项不产生多余段落", () => {
    expect(htmlOf("- 一\n- 二\n")).not.toContain("<p ");
  });

  it("loose 列表项保留段落结构", () => {
    const html = htmlOf("- 一\n\n- 二\n");
    expect(html).toContain('<p class="readora-paragraph">一</p>');
  });
});

describe("引用块（§7.4）", () => {
  it("嵌套引用保留层级", () => {
    const html = htmlOf("> 外层\n>\n> > 内层\n");
    expect(html).toContain('<blockquote class="readora-blockquote">');
    const first = html.indexOf("<blockquote");
    expect(html.indexOf("<blockquote", first + 1)).toBeGreaterThan(first);
  });

  it("引用内多块内容齐全", () => {
    const html = htmlOf("> 段落\n>\n> - 列表项\n");
    expect(html).toContain("段落");
    expect(html).toContain('<li class="readora-list-item">列表项</li>');
  });
});

describe("表格（§7.5）", () => {
  const html = htmlOf("| 左 | 中 | 右 |\n| :-- | :-: | --: |\n| a | b | c |\n");

  it("表头与表体结构重建", () => {
    expect(html).toContain('<thead class="readora-table-head">');
    expect(html).toContain('<tbody class="readora-table-body">');
    expect(html).toContain('<th class="readora-table-cell readora-table-cell--header"');
    expect(html).toContain('<td class="readora-table-cell"');
  });

  it("对齐信息落到 data-align", () => {
    expect(html).toContain('data-align="left"');
    expect(html).toContain('data-align="center"');
    expect(html).toContain('data-align="right"');
  });

  it("外层滚动容器存在（长内容横向滚动）", () => {
    expect(html).toContain('<div class="readora-table-scroll"><table class="readora-table">');
  });

  it("单元格内行内语法可渲染", () => {
    const cellHtml = htmlOf("| a | b |\n| - | - |\n| **粗** | `码` |\n");
    expect(cellHtml).toContain('<strong class="readora-strong">');
    expect(cellHtml).toContain('<code class="readora-inline-code">');
  });
});

describe("分隔线与链接图片（§7.2 / §7.6）", () => {
  it("分隔线产出 hr", () => {
    expect(htmlOf("---\n")).toMatch(/<hr[^>]*class="readora-thematic-break"/);
  });

  it("外部链接写 href 并打 external 标记，附加 rel", () => {
    const html = htmlOf("[文档](https://example.com/page)\n");
    expect(html).toContain('href="https://example.com/page"');
    expect(html).toContain("data-readora-external=");
    expect(html).toContain('rel="noopener noreferrer nofollow"');
  });

  it("文档内锚点写 #href 并打 anchor 标记", () => {
    const html = htmlOf("# 目标\n\n[跳转](#目标)\n");
    expect(html).toContain('data-readora-anchor=');
    expect(html).toMatch(/href="#[^"]*"/);
  });

  it("相对链接降级为 inert，不生成 href、不拼接路径（IMP-001 §12.2）", () => {
    const html = htmlOf("[其它文档](./other.md)\n");
    expect(html).toContain('data-readora-relative="./other.md"');
    expect(html).toContain('aria-disabled="true"');
    expect(html).not.toContain("href=\"./other.md\"");
  });

  it("图片产出 <img> 语义结构但不写 src、不发起请求（ARC-008 §8.1）", () => {
    const html = htmlOf("![说明文字](https://example.com/a.png)\n");
    expect(html).toContain('data-readora-image="https://example.com/a.png"');
    expect(html).toContain('data-readora-image-state="pending"');
    expect(html).toContain('<img class="readora-image-element" alt="说明文字">');
    expect(html).toContain("图片加载待资源解析（M3）");
    expect(html).not.toMatch(/src=/);
  });

  it("本地相对图片标记为 local", () => {
    const html = htmlOf("![本地图](./assets/a.png)\n");
    expect(html).toContain('readora-image--local');
  });
});

/**
 * 受控 HTML 渲染器契约（计划 §renderers html.ts / ARC-002 §11.2）。
 *
 * 两条路径都要锁住：
 * - 存在 htmlBlock 节点时：转义为可见文本 + `warning`，绝不落进 DOM；
 * - 冻结的 html:false 下：markdown-it 根本不产出 html_block / html_inline token，
 *   原始 HTML 以文本进入 AST 并由 text 渲染器转义 —— 同样「不执行」，
 *   但不额外报 warning（避免对 `<尖括号>` 之类正文误报，也避免二次解析）。
 */
describe("受控 HTML（§11.2）", () => {
  function htmlBlockNode(value: string): MarkdownNode {
    return {
      id: `${DOCUMENT_ID}|htmlBlock|1|0`,
      type: "htmlBlock",
      value,
      position: { startLine: 1, endLine: 1 }
    };
  }

  it("htmlBlock 节点转义为可见文本并给出 warning", () => {
    const outcome = renderNode(htmlBlockNode('<img src=x onerror="alert(1)">'));
    expect(outcome.html).toContain('data-readora-html-state="escaped"');
    expect(outcome.html).toContain("&lt;img src=x");
    expect(outcome.html).not.toContain("<img");
    expect(outcome.diagnostics).toEqual([
      expect.objectContaining({
        code: "readora.render.html-block-disabled",
        severity: "warning"
      })
    ]);
  });

  it("htmlBlock 产物再过 Sanitizer，仍然没有可执行结构", () => {
    const html = renderNode(htmlBlockNode("<script>alert(1)</script>")).html;
    const root = new DOMParser().parseFromString(`<div>${html}</div>`, "text/html");
    expect(root.body.querySelectorAll("script").length).toBe(0);
    expect(root.body.textContent).toContain("<script>alert(1)</script>");
  });

  it("管线在 html:true 策略下仍把 HtmlBlock 转义并告警", () => {
    const result = renderMarkdown(
      {
        documentId: DOCUMENT_ID,
        documentUri: DOCUMENT_URI,
        version: 1,
        text: '<div onclick="alert(1)">块级 HTML</div>\n',
        options: { html: true }
      },
      {}
    );
    expect(result.html).toContain("&lt;div onclick=");
    expect(result.html).not.toContain("<div onclick");
    expect(
      result.diagnostics.some(
        (item) =>
          item.code === "readora.render.html-block-disabled" && item.severity === "warning"
      )
    ).toBe(true);
  });

  it("冻结配置不产出 html token：原始 HTML 走转义文本路径，同样不执行", () => {
    const html = htmlOf('<div onclick="alert(1)">块级 HTML</div>\n\n正文 <span style="color:red">行内</span>\n');
    const root = new DOMParser().parseFromString(`<div>${html}</div>`, "text/html");
    expect(root.body.querySelectorAll("div[onclick], span[style]").length).toBe(0);
    expect(root.body.textContent).toContain('<div onclick="alert(1)">块级 HTML</div>');
    expect(root.body.textContent).toContain('<span style="color:red">行内</span>');
  });
});

describe("块属性与脚注输出（M10）", () => {
  it("align 只认三种取值，其余一个字都不写", () => {
    const aligned = renderNode({ id: "doc|paragraph|0|1", type: "paragraph", attributes: { align: "center" }, children: [] });
    expect(aligned.html).toContain('data-align="center"');
    const bogus = renderNode({ id: "doc|paragraph|0|2", type: "paragraph", attributes: { align: "justify" }, children: [] });
    expect(bogus.html).not.toContain("data-align");
  });

  it("尺寸只出 data-readora-*，渲染器绝不产出 style", () => {
    const html = renderNode({
      id: "doc|image|0|1",
      type: "image",
      attributes: { src: "a.png", alt: "图", width: "60%", height: "20px" }
    }).html;
    expect(html).toContain('data-readora-width="60%"');
    expect(html).toContain('data-readora-height="20px"');
    expect(html).not.toContain("style=");
    // 形状不合的尺寸当没写过（纵深防御：渲染层再校一次正则）
    const bogus = renderNode({
      id: "doc|image|0|2",
      type: "image",
      attributes: { src: "a.png", alt: "图", width: "60em" }
    }).html;
    expect(bogus).not.toContain("data-readora-width");
  });

  it("脚注四类单独进 Registry 也有产出，不落 unsupported", () => {
    const reference = renderNode({
      id: "doc|footnoteReference|0|1",
      type: "footnoteReference",
      value: "[^a]",
      attributes: { index: 1, label: "a", anchor: "readora-fn-1", refAnchor: "readora-fnref-1" }
    });
    expect(reference.html).toContain('href="#readora-fn-1"');
    expect(reference.html).toContain("data-readora-anchor");
    expect(reference.diagnostics).toHaveLength(0);
    const unresolved = renderNode({
      id: "doc|footnoteReference|0|2",
      type: "footnoteReference",
      value: "[^gone]",
      attributes: { label: "gone" }
    });
    expect(unresolved.html).toContain("[^gone]");
    const itemNode = {
      id: "doc|footnoteItem|0|1",
      type: "footnoteItem" as const,
      attributes: { index: 1, anchor: "readora-fn-1", backAnchor: "readora-fnref-1", align: "center" },
      children: [{ id: "doc|text|0|1", type: "text" as const, value: "定义" }]
    };
    const item = renderNode(itemNode);
    expect(item.html).toContain('id="readora-fn-1"');
    expect(item.html).toContain('data-align="center"');
    expect(item.html).toContain('href="#readora-fnref-1"');
    // 回跳没有自己的 id：空 id 是无效 HTML
    expect(item.html).not.toContain('id=""');
    const section = renderNode({
      id: "doc|footnoteSection|0|1",
      type: "footnoteSection",
      children: [itemNode]
    });
    expect(section.html).toContain('<ol class="readora-footnotes-list">');
    expect(section.html).not.toContain("<section");
  });

  it("脚注区标题不是 heading：产物里没有 h1..h6", () => {
    const html = htmlOf("引 [^a]。\n\n[^a]: 定义。\n");
    expect(html).toContain('<p class="readora-footnotes-title">');
    expect(html).not.toContain("<h1");
  });

  it("diagram 的围栏属性出 data 标记，由接管层消费", () => {
    const html = htmlOf("```mermaid {code_block=true filename=\"flow\" width=80%}\ngraph TD;\n```\n");
    expect(html).toContain('data-readora-diagram-code-block="true"');
    expect(html).toContain('data-readora-diagram-filename="flow"');
    expect(html).toContain('data-readora-width="80%"');
  });
});
