/**
 * 块属性白名单用例（MPE 借鉴项，M10）。
 *
 * 覆盖面按「围栏 info + 块级尾随 + 图片尾随」这一档（`{: …}` 独占行与
 * `.class` / `#id` 简写登记在未纳入清单），因此断言分四组：
 * 1. 形状判定：什么才算一次属性书写；
 * 2. 挂载点：三种写法各自落到哪个节点、渲出什么；
 * 3. 拒收：任一键不合法 ⇒ 整串留在正文，绝不出现「一半生效」；
 * 4. 边界：正文里的花括号（JSON 尾巴、KaTeX 转义花括号、未闭合）一个字节都不许动。
 *
 * 第 3 组里的「挂载点不认的键也算拒收」是本轮补的一条：段落尾巴写 `{width=…}`
 * 时，如果只按白名单放行，花括号会被吃掉而产物里什么也没有 —— 静默失效比不支持更难排查。
 */
import { describe, expect, it } from "vitest";
import { buildAst } from "../ast";
import {
  ALIGN_ATTR,
  FILENAME_ATTR,
  HEIGHT_ATTR,
  WIDTH_ATTR,
  isAllowedFilenameValue,
  isDelimitedSizeValue,
  parseAttributeString,
  scanAttributePairs
} from "../attrs";
import { RENDER_DIAGNOSTIC_CODES } from "../diagnostics";
import { renderMarkdown } from "../index";
import { countSourceLines } from "../normalize";
import { createMarkdownParser } from "../parser";
import { DOCUMENT_ID, DOCUMENT_URI, htmlOf } from "./helpers";
import type { MarkdownDocument, MarkdownNode } from "../types";

function documentOf(source: string): MarkdownDocument {
  const env: Record<string, unknown> = {};
  const tokens = createMarkdownParser().parse(source, env);
  return buildAst(tokens, DOCUMENT_ID, countSourceLines(source));
}

function topLevel(document: MarkdownDocument): MarkdownNode[] {
  return document.children;
}

function render(text: string): ReturnType<typeof renderMarkdown> {
  return renderMarkdown({ documentId: DOCUMENT_ID, documentUri: DOCUMENT_URI, version: 1, text });
}

function container(html: string): HTMLElement {
  const dom = new DOMParser().parseFromString(`<div>${html}</div>`, "text/html");
  return dom.body.firstElementChild as HTMLElement;
}

describe("块属性形状判定（attrs.ts）", () => {
  it("严格 k=v / k=\"v\"：合法键值对成表", () => {
    expect(parseAttributeString("align=center")).toEqual({ align: "center" });
    expect(parseAttributeString('filename="my file.js" width=60%')).toEqual({
      filename: "my file.js",
      width: "60%"
    });
    expect(scanAttributePairs("code_block=true header=false")).toHaveLength(2);
  });

  it("任一键不在白名单、值不合形状或键重复 ⇒ 整体拒绝", () => {
    expect(parseAttributeString("json=1")).toBeNull();
    expect(parseAttributeString("a, b")).toBeNull();
    expect(parseAttributeString("align=justify")).toBeNull();
    expect(parseAttributeString("width=abc")).toBeNull();
    expect(parseAttributeString("align=center align=left")).toBeNull();
    // 一半合法一半非法也不放行：绝不出现「一半生效」
    expect(parseAttributeString("align=center json=1")).toBeNull();
  });

  it("尺寸值：整数/小数带 px 或 % 可，裸超长值不可", () => {
    expect(isDelimitedSizeValue("60%")).toBe(true);
    expect(isDelimitedSizeValue("120px")).toBe(true);
    expect(isDelimitedSizeValue("12.5%")).toBe(true);
    expect(isDelimitedSizeValue("60em")).toBe(false);
    expect(isDelimitedSizeValue("-60px")).toBe(false);
    expect(isDelimitedSizeValue("calc(100%)")).toBe(false);
    expect(isDelimitedSizeValue("".padEnd(17, "1"))).toBe(false);
  });

  it("filename：拒控制字符、HTML 特殊字符与 `@` / `#` 前缀", () => {
    expect(isAllowedFilenameValue("app.js")).toBe(true);
    expect(isAllowedFilenameValue("@README.md")).toBe(false);
    expect(isAllowedFilenameValue("#frag.md")).toBe(false);
    expect(isAllowedFilenameValue('a"b')).toBe(false);
    expect(isAllowedFilenameValue("<script>")).toBe(false);
    expect(isAllowedFilenameValue("a\u0007b")).toBe(false);
    expect(isAllowedFilenameValue("x".repeat(121))).toBe(false);
  });
});

describe("三个挂载点", () => {
  it("围栏 info 尾部：lang 仍是第一个词，属性进节点", () => {
    const [codeBlock] = topLevel(documentOf('```js {filename="app.js"}\nconst a = 1;\n```\n'));
    expect(codeBlock?.type).toBe("codeBlock");
    expect(codeBlock?.attributes?.["lang"]).toBe("js");
    expect(codeBlock?.attributes?.[FILENAME_ATTR]).toBe("app.js");
    expect(htmlOf('```js {filename="app.js"}\nx\n```\n')).toContain(
      '<span class="readora-code-filename" title="app.js">app.js</span>'
    );
  });

  it("围栏属性可给 diagram 与 csv 用：code_block / header 各归各的消费方", () => {
    const diagram = container(
      htmlOf("```mermaid {code_block=true filename=\"flow\"}\ngraph TD;\nA-->B;\n```\n")
    ).querySelector(".readora-diagram") as HTMLElement;
    expect(diagram.getAttribute("data-readora-diagram-code-block")).toBe("true");
    expect(diagram.getAttribute("data-readora-diagram-filename")).toBe("flow");
    const [csvTable] = topLevel(documentOf("```csv {header=false}\na,b\n1,2\n```\n"));
    expect(csvTable?.attributes?.[ALIGN_ATTR]).toBeUndefined();
  });

  it("块级尾随：标题、段落、列表项、引用块、脚注定义都收 align", () => {
    const nodes = topLevel(documentOf("# 标题 {align=center}\n"));
    expect(nodes[0]?.attributes?.[ALIGN_ATTR]).toBe("center");
    expect(container(htmlOf("段落 {align=right}\n")).firstElementChild?.getAttribute("data-align")).toBe(
      "right"
    );
    expect(htmlOf("- 项目 {align=center}\n")).toContain('<li class="readora-list-item" data-align="center">');
    expect(htmlOf("> 引用 {align=left}\n")).toContain("data-align=\"left\"");
    const refs = htmlOf("引 [^a]。\n\n[^a]: 定义 {align=center}\n");
    expect(refs).toContain("data-align=\"center\"");
  });

  it("图片尾随：width / height 落 data-readora-*，产物里没 style", () => {
    const paragraph = topLevel(documentOf("![图](./a.png){width=60% height=120px}\n"))[0] as MarkdownNode;
    const image = (paragraph.children ?? [])[0] as MarkdownNode;
    expect(image.type).toBe("image");
    // 键名走 attrs 常量：渲染器与 Webview 接管层读的是同一张表，不各自写一份字面量。
    expect(image.attributes?.[WIDTH_ATTR]).toBe("60%");
    expect(image.attributes?.[HEIGHT_ATTR]).toBe("120px");
    const result = htmlOf("![图](./a.png){width=60% height=120px}\n");
    expect(result).toContain('data-readora-width="60%"');
    expect(result).toContain('data-readora-height="120px"');
    expect(result).not.toContain("style=");
    // 图片与花括号之间允许一个空格
    expect(htmlOf("![图](./a.png) {width=50%}\n")).toContain('data-readora-width="50%"');
  });

  it("表格尾随落在表级：属性归整张表，不进单元格", () => {
    const result = htmlOf("| a | b |\n| - | - |\n| 1 | 2 {align=center} |\n");
    const table = container(result).querySelector(".readora-table-scroll") as HTMLElement;
    expect(table.getAttribute("data-align")).toBe("center");
    expect(result).not.toContain('<td class="readora-table-cell" data-align');
  });
});

describe("白名单拒收：整串保留", () => {
  it("非白名单键 ⇒ 花括号原样留在正文 + info 诊断", () => {
    const result = render("坏值 {json=1}\n");
    expect(result.html).toContain("坏值 {json=1}");
    expect(result.html).not.toContain("data-align");
    expect(result.diagnostics.map((item) => item.code)).toContain(
      RENDER_DIAGNOSTIC_CODES.ATTRS_REJECTED
    );
  });

  it("挂载点渲不出的键也算拒收：段落尾巴的 width 不会凭空消失", () => {
    const result = render("正文 {width=2px}\n");
    expect(result.html).toContain("{width=2px}");
    expect(result.diagnostics.map((item) => item.code)).toContain(
      RENDER_DIAGNOSTIC_CODES.ATTRS_REJECTED
    );
  });

  it("`filename=@文件` 的文件导入形态拒收（本批不支持）", () => {
    // info 串本身不进正文，因此拒收的产物是「无文件名 + 一条可取证的诊断」，
    // 而不是在代码块里多出一串花括号；lang 必须仍是 js（不能变成一个叫 `{…}` 的语言）。
    const result = render('```js {filename=@README.md}\nx\n```\n');
    expect(result.html).not.toContain("readora-code-filename");
    expect(result.html).toContain('data-readora-code-lang="js"');
    expect(result.diagnostics.map((item) => item.code)).toContain(
      RENDER_DIAGNOSTIC_CODES.ATTRS_REJECTED
    );
  });

  it("属性注入尝试既被拒也进不了产物", () => {
    const result = render('正文 {width=1px" onload="x}\n');
    expect(result.html).toContain("{width=1px\" onload=\"x}");
    const root = container(result.html);
    expect(root.querySelector("[onload]")).toBeNull();
    expect(root.getAttribute("style")).toBeNull();
    expect(result.html).not.toContain("<span style");
  });

  it("`{: …}` 独占行与 `.class` 简写不实现：正文原样", () => {
    expect(htmlOf("{: .note}\n")).toContain("{: .note}");
    expect(htmlOf("{.note}\n")).toContain("{.note}");
  });
});

describe("正文花括号回归（不许吃掉）", () => {
  it("JSON 尾巴与集合写法一个字都不动", () => {
    expect(htmlOf('{"port": 8080} 配置\n')).toContain('{"port": 8080} 配置');
    expect(htmlOf("集合 {a, b} 结束\n")).toContain("{a, b}");
    expect(htmlOf("配置 { align: \"center\" } 结束\n")).toContain("{ align: \"center\" }");
  });

  it("KaTeX 转义花括号 `\\{` 不当属性起点", () => {
    const result = htmlOf("集合 $f(x) = \\{1\\}$ {align=center}\n");
    expect(result).toContain("readora-math");
    expect(result).toContain('data-align="center"');
    expect(result).not.toContain("\\{1\\}");
    expect(htmlOf("集合 $\\{x\\}$ 结束\n")).not.toContain("data-align");
  });

  it("未闭合与嵌套花括号不动", () => {
    expect(htmlOf("花括号 { 未闭合\n")).toContain("{ 未闭合");
    expect(htmlOf("嵌套 {a{align=center}}\n")).toContain("{a{align=center}}");
  });

  it("围栏 info 与正文尾随互不污染", () => {
    const result = htmlOf(
      '```js {filename="app.js"}\nconst o = { align: "center" };\n```\n\n段落 {align=left}\n'
    );
    expect(result).toContain('title="app.js"');
    // 代码里的 `{ align: "center" }` 已进入高亮 span，但内容一个字节没被抢走
    expect(result).toContain('"center"');
    expect(result).toContain('data-align="left"');
    // lang 不能被花括号污染
    expect(result).toContain('data-readora-code-lang="js"');
    expect(result).not.toContain("readora-code-lang=\"{");
  });
});
