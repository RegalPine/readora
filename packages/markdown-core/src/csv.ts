/**
 * CSV / TSV 围栏 → 表格的源码解析（MPE 借鉴项，M10）。
 *
 * 只做「形状判定」，不做排版：解析成功交给 `processors.ts` 的 csv 处理器改写成
 * table / tableRow / tableCell 节点，渲染完全复用 `renderers/table.ts`
 * （滚动容器、`scope="col"`、对齐规则一并到位）。
 *
 * 三条硬口径，都服务于「不假装能力」：
 * - **引号未闭合 ⇒ null**：半个字段被吞掉比退回代码块更难排查；
 * - **行列不规则 ⇒ null**：绝不补空单元格把残缺数据摆成一张像样的表；
 * - **不足两行两列 ⇒ null**：那不是一个表，代码块更诚实。
 *
 * 上限与图形层同一量级（`diagram-core/limits.ts` 的 50 000 字符），
 * 超限一律退成代码块：表格渲染要按单元格建 DOM，宽表会长出几千个节点。
 */
export const CSV_SOURCE_MAX_LENGTH = 50_000;
export const CSV_MAX_ROWS = 500;
export const CSV_MAX_COLUMNS = 50;

/** 认可的围栏语言标识（大小写不敏感，判定在 processors 里做一次）。 */
export const CSV_LANGUAGES: ReadonlySet<string> = new Set(["csv", "tsv"]);

export type DelimitedDelimiter = "," | "\t";

/** 语言标识 → 分隔符；不是表格式围栏即返回 null。 */
export function delimiterFor(lang: string): DelimitedDelimiter | null {
  const normalized = lang.trim().toLowerCase();
  if (normalized === "csv") {
    return ",";
  }
  return normalized === "tsv" ? "\t" : null;
}

export interface DelimitedTable {
  rows: string[][];
  columns: number;
}

const QUOTE = 0x22;
const NEWLINE = 0x0a;
const CARRIAGE = 0x0d;

/**
 * 逐字符扫描：`"…"` 里的分隔符与换行都属于字段内容，`""` 是一个字面双引号。
 *
 * 开引号只承认「字段起始处」的那一个：`a"b,c` 里的引号是数据而不是定界符
 * （RFC 4180 也是这个口径），于是无需给畸形 CSV 猜测语义。
 */
export function scanDelimitedRows(source: string, delimiter: DelimitedDelimiter): string[][] | null {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let atFieldStart = true;
  let sawContent = false;

  const endField = (): void => {
    row.push(field);
    field = "";
    quoted = false;
    atFieldStart = true;
  };
  const endRow = (): void => {
    endField();
    rows.push(row);
    row = [];
    sawContent = false;
  };

  for (let index = 0; index < source.length; index += 1) {
    const code = source.charCodeAt(index);
    if (quoted) {
      if (code === QUOTE) {
        if (source.charCodeAt(index + 1) === QUOTE) {
          field += '"';
          index += 1;
          continue;
        }
        quoted = false;
        atFieldStart = false;
        continue;
      }
      field += String.fromCharCode(code);
      continue;
    }
    if (code === QUOTE && atFieldStart) {
      quoted = true;
      atFieldStart = false;
      sawContent = true;
      continue;
    }
    if (code === delimiter.charCodeAt(0)) {
      endField();
      sawContent = true;
      continue;
    }
    if (code === NEWLINE) {
      endRow();
      continue;
    }
    if (code === CARRIAGE) {
      if (source.charCodeAt(index + 1) === NEWLINE) {
        index += 1;
      }
      endRow();
      continue;
    }
    field += String.fromCharCode(code);
    atFieldStart = false;
    sawContent = true;
  }

  if (quoted) {
    // 引号没闭合：整段不认。
    return null;
  }
  if (sawContent || field.length > 0) {
    endRow();
  }
  // 去掉尾部空行（`a,b\n\n` 这种收尾不该多出一行空白单元格）。
  while (rows.length > 0 && rows[rows.length - 1]?.length === 1 && rows[rows.length - 1]?.[0] === "") {
    rows.pop();
  }
  return rows;
}

/** 形状判定 + 上限判定：拿到一张可渲染的表即返回，否则 null。 */
export function parseDelimitedTable(
  source: string,
  delimiter: DelimitedDelimiter
): DelimitedTable | null {
  if (source.length === 0 || source.length > CSV_SOURCE_MAX_LENGTH) {
    return null;
  }
  const rows = scanDelimitedRows(source, delimiter);
  if (!rows || rows.length < 2) {
    return null;
  }
  const columns = rows[0]?.length ?? 0;
  if (columns < 2 || columns > CSV_MAX_COLUMNS || rows.length > CSV_MAX_ROWS) {
    return null;
  }
  for (const row of rows) {
    if (row.length !== columns) {
      return null;
    }
  }
  return { rows, columns };
}
