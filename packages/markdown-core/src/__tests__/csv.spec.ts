/**
 * CSV / TSV 围栏用例（MPE 借鉴项，M10）。
 *
 * 分工：`csv.ts` 只判形状，`processors.ts` 的 csv 处理器只改 AST，
 * 渲染完全复用 `renderers/table.ts`。因此断言分三层：
 * 1. 形状判定：引号、CRLF、上限、不规则；
 * 2. 改写：节点结构、id 类型段、表头与 `header=false`；
 * 3. 退回：不成表 ⇒ 一个字都不动地留作代码块 + info 诊断。
 *
 * 「不成即退回代码块」是本模块的全部人格：残缺数据摆成一张看着完整的表，
 * 比不摆表更糟（用户会拿它当已核对过的数字）。
 */
import { describe, expect, it } from "vitest";
import { buildAst } from "../ast";
import {
  CSV_MAX_COLUMNS,
  CSV_MAX_ROWS,
  CSV_SOURCE_MAX_LENGTH,
  CSV_LANGUAGES,
  delimiterFor,
  parseDelimitedTable,
  scanDelimitedRows
} from "../csv";
import { RENDER_DIAGNOSTIC_CODES } from "../diagnostics";
import { renderMarkdown } from "../index";
import { countSourceLines } from "../normalize";
import { createMarkdownParser } from "../parser";
import { runProcessors } from "../processors";
import { DOCUMENT_ID, DOCUMENT_URI, htmlOf } from "./helpers";
import type { MarkdownDocument, MarkdownNode, RenderDiagnostic } from "../types";

function documentOf(source: string): { document: MarkdownDocument; diagnostics: RenderDiagnostic[] } {
  const tokens = createMarkdownParser().parse(source);
  const diagnostics: RenderDiagnostic[] = [];
  const document = runProcessors(
    buildAst(tokens, DOCUMENT_ID, countSourceLines(source)),
    diagnostics
  );
  return { document, diagnostics };
}

function walk(node: MarkdownNode, collect: (node: MarkdownNode) => void): void {
  collect(node);
  for (const child of node.children ?? []) {
    walk(child, collect);
  }
}

function allOf(document: MarkdownDocument, type: string): MarkdownNode[] {
  const found: MarkdownNode[] = [];
  walk(document, (node) => {
    if (node.type === type) {
      found.push(node);
    }
  });
  return found;
}

function render(text: string): ReturnType<typeof renderMarkdown> {
  return renderMarkdown({ documentId: DOCUMENT_ID, documentUri: DOCUMENT_URI, version: 1, text });
}

function container(html: string): HTMLElement {
  const dom = new DOMParser().parseFromString(`<div>${html}</div>`, "text/html");
  return dom.body.firstElementChild as HTMLElement;
}

describe("分隔符形状判定（csv.ts）", () => {
  it("语言标识 → 分隔符，其余一律不认", () => {
    expect(CSV_LANGUAGES.has("csv") && CSV_LANGUAGES.has("tsv")).toBe(true);
    expect(delimiterFor("CSV")).toBe(",");
    expect(delimiterFor("tsv")).toBe("\t");
    expect(delimiterFor("TSV")).toBe("\t");
    expect(delimiterFor("text")).toBeNull();
    expect(delimiterFor("")).toBeNull();
  });

  it("引号包裹：分隔符与换行属字段内容，`\"\"` 是一个字面双引号", () => {
    expect(scanDelimitedRows('"a,b",c\n1,2', ",")).toEqual([
      ["a,b", "c"],
      ["1", "2"]
    ]);
    expect(scanDelimitedRows('"说""法",b\n1,2', ",")).toEqual([
      ['说"法', "b"],
      ["1", "2"]
    ]);
    expect(scanDelimitedRows('"多行\n字段",b\n1,2', ",")?.[0]?.[0]).toBe("多行\n字段");
  });

  it("CRLF 与尾部空行不产出一行空白单元格", () => {
    expect(scanDelimitedRows("a,b\r\n1,2\r\n", ",")).toEqual([
      ["a", "b"],
      ["1", "2"]
    ]);
    expect(parseDelimitedTable("a,b\n\n", ",")).toBeNull();
  });

  it("三条硬口径：未闭合引号、行列不规则、不足两行两列 ⇒ null", () => {
    expect(parseDelimitedTable('"a,b\nc,d\n', ",")).toBeNull();
    expect(parseDelimitedTable("a,b\nc\n", ",")).toBeNull();
    expect(parseDelimitedTable("单列一列\n第二列\n", ",")).toBeNull();
    expect(parseDelimitedTable("a\n", ",")).toBeNull();
    expect(parseDelimitedTable("", ",")).toBeNull();
  });

  it("上限：超行数、超列数、超源码长度都拒", () => {
    const manyColumns = Array.from({ length: CSV_MAX_COLUMNS + 1 }, (_u, i) => `c${i}`).join(",");
    expect(parseDelimitedTable(`${manyColumns}\n1,2`, ",")).toBeNull();
    const rows = Array.from({ length: CSV_MAX_ROWS + 1 }, (_u, i) => `a${i},b`).join("\n");
    expect(parseDelimitedTable(rows, ",")).toBeNull();
    const oversized = `a,b\n${"x".repeat(CSV_SOURCE_MAX_LENGTH + 1)},y`;
    expect(parseDelimitedTable(oversized, ",")).toBeNull();
  });
});

describe("codeBlock → table 改写（csv 处理器）", () => {
  it("形状成立：节点被改写成 table / tableRow / tableCell，首行为表头", () => {
    const { document, diagnostics } = documentOf("```csv\nname,qty\n苹果,3\n香蕉,7\n```\n");
    expect(allOf(document, "codeBlock")).toHaveLength(0);
    const table = allOf(document, "table")[0] as MarkdownNode;
    expect(table.id).toContain("|table|");
    expect(table.id).not.toContain("|codeBlock|");
    expect(allOf(document, "tableRow")).toHaveLength(3);
    const cells = allOf(document, "tableCell");
    expect(cells).toHaveLength(6);
    expect(cells[0]?.attributes?.["header"]).toBe(true);
    expect(cells[2]?.attributes?.["header"]).toBe(false);
    expect(diagnostics).toHaveLength(0);
    // 单元格文本是真正的 text 子节点：转义与后续处理器都要能在表里生效
    expect(cells[2]?.children?.[0]?.type).toBe("text");
    expect(cells[2]?.children?.[0]?.value).toBe("苹果");
  });

  it("tsv 走制表符分隔", () => {
    const html = htmlOf("```tsv\nx\ty\n1\t2\n```\n");
    expect(html).toContain("readora-table");
    expect(html).not.toContain("readora-code-block");
  });

  it("`header=false` 时整表都是 td", () => {
    const html = htmlOf("```csv {header=false}\na,b\n1,2\n```\n");
    expect(html).not.toContain("<thead");
    expect(html).not.toContain("<th ");
    expect(container(html).querySelectorAll("td")).toHaveLength(4);
  });

  it("`align` 透传到表级，`filename` 留在围栏属性里不影响表", () => {
    const html = htmlOf("```csv {align=center}\na,b\n1,2\n```\n");
    expect(container(html).querySelector(".readora-table-scroll")?.getAttribute("data-align")).toBe(
      "center"
    );
  });

  it("单元格内容按普通散文转义", () => {
    const html = htmlOf("```csv\na,b\n<script>,\"x\"\n```\n");
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("不成表即退回代码块", () => {
  it("行列不规则：保留 codeBlock + info 诊断，正文一字节不丢", () => {
    const result = render("```csv\na,b\nc\n```\n");
    expect(result.html).toContain("readora-code-block");
    expect(result.html).toContain("a,b");
    expect(result.diagnostics.map((item) => item.code)).toContain(
      RENDER_DIAGNOSTIC_CODES.CSV_NOT_TABULAR
    );
    const diagnostic = result.diagnostics.find(
      (item) => item.code === RENDER_DIAGNOSTIC_CODES.CSV_NOT_TABULAR
    );
    expect(diagnostic?.severity).toBe("info");
  });

  it("引号未闭合同样退回代码块", () => {
    const result = render('```csv\n"a,b\nc,d\n```\n');
    expect(result.html).toContain("readora-code-block");
    expect(result.html).not.toContain("readora-table");
  });

  it("只有一行（没数据）不算表", () => {
    const result = render("```csv\nonly,one\n```\n");
    expect(result.html).toContain("readora-code-block");
  });

  it("普通代码块不受影响：非 csv 围栏永不进这条路径", () => {
    const { document, diagnostics } = documentOf("```js\nconst a = 'x,y';\n```\n");
    expect(allOf(document, "table")).toHaveLength(0);
    expect(allOf(document, "codeBlock")).toHaveLength(1);
    expect(diagnostics).toHaveLength(0);
  });
});
