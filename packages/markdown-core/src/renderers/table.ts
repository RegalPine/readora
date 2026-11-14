/**
 * 表格渲染器（ARC-002 §7.5）。
 *
 * AST 只保留 table / tableRow / tableCell（表头由单元格 header 标记还原），
 * 渲染期重建 thead / tbody 以获得可解析、可无障碍朗读的表格结构。
 * 长文本换行与横向滚动由 CSS 承担（§7.5「横向滚动」），外层滚动容器在此给出。
 */
import { readBoolean } from "../nodes";
import type { MarkdownNode, MarkdownRenderer, RenderDiagnostic } from "../types";
import { alignAttribute, fragment } from "./support";

type RenderCtx = Parameters<MarkdownRenderer["render"]>[1];

function cellAlign(node: MarkdownNode): string {
  const align = node.attributes?.["align"];
  return align === "left" || align === "right" || align === "center" ? align : "";
}

function renderCellHtml(cell: MarkdownNode, context: RenderCtx, diagnostics: RenderDiagnostic[]): string {
  const header = readBoolean(cell, "header") === true;
  const tag = header ? "th" : "td";
  const align = cellAlign(cell);
  const alignAttribute = align === "" ? "" : ` data-align="${align}"`;
  const scope = header ? ' scope="col"' : "";
  const inner = context.renderChildren(cell);
  diagnostics.push(...inner.diagnostics);
  const className = header
    ? "readora-table-cell readora-table-cell--header"
    : "readora-table-cell";
  return `<${tag} class="${className}"${alignAttribute}${scope}>${inner.html}</${tag}>`;
}

function isHeaderRow(row: MarkdownNode | undefined): boolean {
  if (!row) {
    return false;
  }
  const cells = (row.children ?? []).filter((cell) => cell.type === "tableCell");
  return cells.length > 0 && cells.every((cell) => readBoolean(cell, "header") === true);
}

export const tableRenderer: MarkdownRenderer = {
  id: "readora.renderer.table",
  supports: (node) => node.type === "table",
  render(node, context) {
    const diagnostics: RenderDiagnostic[] = [];
    const rows = (node.children ?? []).filter((child) => child.type === "tableRow");

    let headerCount = 0;
    while (headerCount < rows.length && isHeaderRow(rows[headerCount])) {
      headerCount += 1;
    }
    const headerRows = rows.slice(0, headerCount);
    const bodyRows = rows.slice(headerCount);

    const renderRow = (row: MarkdownNode): string => {
      const cells = (row.children ?? [])
        .filter((cell) => cell.type === "tableCell")
        .map((cell) => renderCellHtml(cell, context, diagnostics))
        .join("");
      return `<tr class="readora-table-row">${cells}</tr>`;
    };

    const head =
      headerRows.length > 0
        ? `<thead class="readora-table-head">${headerRows.map(renderRow).join("")}</thead>`
        : "";
    const body = `<tbody class="readora-table-body">${bodyRows.map(renderRow).join("")}</tbody>`;

    return fragment(
      `<div class="readora-table-scroll"${alignAttribute(node)}><table class="readora-table">${head}${body}</table></div>`,
      diagnostics
    );
  }
};

/**
 * 行 / 单元格渲染器：正常表格由 tableRenderer 一并产出，
 * 这两个渲染器只在 AST 被外部直接局部渲染（测试与后续增量更新）时兜底，
 * 保证任何节点单独进 Registry 都不会走 unsupported 降级。
 */
export const tableRowRenderer: MarkdownRenderer = {
  id: "readora.renderer.tableRow",
  supports: (node) => node.type === "tableRow",
  render(node, context) {
    const inner = context.renderChildren(node);
    return fragment(`<tr class="readora-table-row">${inner.html}</tr>`, inner.diagnostics);
  }
};

export const tableCellRenderer: MarkdownRenderer = {
  id: "readora.renderer.tableCell",
  supports: (node) => node.type === "tableCell",
  render(node, context) {
    const diagnostics: RenderDiagnostic[] = [];
    return fragment(renderCellHtml(node, context, diagnostics), diagnostics);
  }
};

export const tableRenderers: readonly MarkdownRenderer[] = [
  tableRenderer,
  tableRowRenderer,
  tableCellRenderer
];
