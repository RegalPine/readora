/**
 * P04 / P05 AST Processor（ARC-002 §5）。
 *
 * 处理顺序固定为 §5.3：Frontmatter → Heading → Code Block → CSV → Math → Wiki Link →
 * Footnote → Asset。M10 新插两个槽位（已在 README 登记偏差，docs 不改）：
 * - `csv` 紧跟 codeBlock：它改写的就是 codeBlock 节点，排在 math 之前才不会被
 *   公式处理器拿去当作带标记的 text；
 * - `footnote` 排在 wikiLink 之后、asset 之前：它要同时改写引用（行内）与定义
 *   （块级），必须晚于所有产生行内节点的处理器。
 * - Frontmatter 在解析前已被消费（否则 `---` 会被当作分隔线），此处保留顺序槽位；
 * - Math 与 Wiki Link 自 M6 / EPIC-06 起为真实处理器（IMP-001 §10.3 / §12.2）；
 * - Asset（由 Image Renderer 与 Host 承担，§5.1 注记）不注册为独立处理器，
 *   仅在顺序表中登记，测试锁定这一不变量。
 */
import { createAnchorRegistry } from "./outline";
import { textOf } from "./nodes";
import { diagnostic } from "./renderers/support";
import {
  CSV_LANGUAGES,
  delimiterFor,
  parseDelimitedTable
} from "./csv";
import { RENDER_DIAGNOSTIC_CODES } from "./diagnostics";
import {
  FOOTNOTE_MAX_ITEMS,
  footnoteAnchor,
  footnoteRefAnchor
} from "./footnote";
import {
  isRenderableMath,
  MATH_DISPLAY_ATTR,
  MATH_SOURCE_ATTR
} from "./math";
import {
  isResolvableWikiTarget,
  WIKI_ALIAS_ATTR,
  WIKI_TARGET_ATTR,
  wikiLinkLabel
} from "./wiki-link";
import type {
  MarkdownDocument,
  MarkdownNode,
  MarkdownNodeType,
  RenderDiagnostic
} from "./types";

/** ARC-002 §5.3 完整顺序（含预留位与本批新增槽位）。 */
export const PROCESSOR_ORDER = [
  "frontmatter",
  "heading",
  "codeBlock",
  "csv",
  "math",
  "wikiLink",
  "footnote",
  "asset"
] as const;

export type ProcessorName = (typeof PROCESSOR_ORDER)[number];

/** 诊断收集口：处理器需要报告「没成」的原因，但不能抛穿整篇（§14.3 第 1 条）。 */
export interface DiagnosticSink {
  push(diagnostic: RenderDiagnostic): void;
}

/** 未注册的顺序项：ARC-002 §5.1 注记「资源解析由 Image Renderer 与 Host 承担」。 */
export const RESERVED_PROCESSORS: readonly ProcessorName[] = ["asset"];

/** mermaid 语言标识（ARC-002 §10.1）。 */
const DIAGRAM_LANGUAGES = new Set(["mermaid"]);

function visit(node: MarkdownNode, visitNode: (node: MarkdownNode) => void): void {
  visitNode(node);
  for (const child of node.children ?? []) {
    visit(child, visitNode);
  }
}

export interface Processor {
  readonly name: ProcessorName;
  process(document: MarkdownDocument, diagnostics?: DiagnosticSink): void;
}

const frontmatterProcessor: Processor = {
  name: "frontmatter",
  // 提取工作已在 parse 之前完成（index.ts），此处仅维持 §5.3 顺序不变量。
  process(): void {}
};

const headingProcessor: Processor = {
  name: "heading",
  process(document): void {
    const anchors = createAnchorRegistry();
    visit(document, (node) => {
      if (node.type !== "heading") {
        return;
      }
      const attributes = node.attributes ?? {};
      const rawLevel = attributes["level"];
      const level = typeof rawLevel === "number" ? Math.min(Math.max(Math.trunc(rawLevel), 1), 6) : 1;
      attributes["level"] = level;
      const title = textOf(node);
      attributes["text"] = title;
      // 空标题没有可 slug 的文本，退化为 heading-{level}（走 reserve 保留连字符并保证唯一）。
      attributes["anchor"] =
        title.length > 0 ? anchors.assign(title) : anchors.reserve(`heading-${level}`);
      node.attributes = attributes;
    });
  }
};

const codeBlockProcessor: Processor = {
  name: "codeBlock",
  process(document): void {
    const children = document.children;
    const convert = (node: MarkdownNode): MarkdownNode => {
      if (node.type !== "codeBlock") {
        // 递归处理容器节点内的代码块。
        if (node.children) {
          node.children = node.children.map(convert);
        }
        return node;
      }
      const lang = node.attributes?.["lang"];
      if (typeof lang !== "string" || !DIAGRAM_LANGUAGES.has(lang.toLowerCase())) {
        return node;
      }
      const attributes = { ...(node.attributes ?? {}), source: node.value ?? "" };
      const diagram: MarkdownNode = {
        id: node.id.replace("|codeBlock|", "|diagramBlock|"),
        type: "diagramBlock",
        ...(node.position ? { position: node.position } : {}),
        ...(node.value !== undefined ? { value: node.value } : {}),
        attributes
      };
      return diagram;
    };
    document.children = children.map(convert);
  }
};

/**
 * CSV / TSV 处理器（M10）：` ```csv ` / ` ```tsv ` 形状成立即改写为表格节点。
 *
 * 只造 AST 不拼 HTML：交给 `renderers/table.ts` 之后，滚动容器、`scope="col"`、
 * 对齐规则与表格的所有现存样式一并到位 —— 多一个渲染器就多一份会漂移的口径。
 * 单元格文本走真正的 text 子节点，于是转义、搜索高亮、公式识别在表格里都成立。
 *
 * 不成则一个节点都不动：围栏仍是 codeBlock（带 `lang=csv`），只多一条 info 诊断。
 * 宁可展示原文，不拿残缺数据摆一张看着完整的表（csv.ts 头注）。
 */
function toTableNode(
  node: MarkdownNode,
  delimiter: "," | "\t",
  diagnostics?: DiagnosticSink
): MarkdownNode {
  const table = parseDelimitedTable(node.value ?? "", delimiter);
  if (!table) {
    diagnostics?.push(
      diagnostic(
        node,
        RENDER_DIAGNOSTIC_CODES.CSV_NOT_TABULAR,
        "info",
        'Delimited block is not a regular table (ragged rows, unterminated quote, fewer than two rows or columns, or above the size limit); rendered as a code block.'
      )
    );
    return node;
  }
  const headerDisabled = node.attributes?.["header"] === "false";
  const tableId = node.id.replace("|codeBlock|", "|table|");
  const rows: MarkdownNode[] = table.rows.map((cells, rowIndex) => {
    const rowId = `${tableId}|row-${rowIndex}`;
    const children: MarkdownNode[] = cells.map((text, columnIndex) => {
      const cellId = `${rowId}|cell-${columnIndex}`;
      return {
        id: cellId,
        type: "tableCell",
        attributes: { header: !headerDisabled && rowIndex === 0 },
        children: [{ id: `${cellId}|text`, type: "text", value: text }]
      };
    });
    return { id: rowId, type: "tableRow", children };
  });
  const attributes: Record<string, unknown> = {};
  const align = node.attributes?.["align"];
  if (align === "left" || align === "center" || align === "right") {
    attributes.align = align;
  }
  return {
    id: tableId,
    type: "table",
    ...(node.position ? { position: node.position } : {}),
    attributes,
    children: rows
  };
}

const csvProcessor: Processor = {
  name: "csv",
  process(document, diagnostics): void {
    const convert = (node: MarkdownNode): MarkdownNode => {
      if (node.type === "codeBlock") {
        const lang = node.attributes?.["lang"];
        if (typeof lang !== "string" || !CSV_LANGUAGES.has(lang.toLowerCase())) {
          return node;
        }
        const delimiter = delimiterFor(lang);
        if (!delimiter) {
          return node;
        }
        return toTableNode(node, delimiter, diagnostics);
      }
      if (node.children) {
        node.children = node.children.map(convert);
      }
      return node;
    };
    document.children = document.children.map(convert);
  }
};

/**
 * Math 处理器（IMP-001 §10.3 第 2 条，M6 落地）。
 *
 * AST 阶段只把 `$…$` / `$$…$$` 落成「带 mathSource 标记的 text」，归类在此完成：
 * - 成立 → 改写为 mathInline / mathBlock，节点 ID 的类型段同步替换；
 * - 不成立 → **只摘掉标记**，节点仍是原来的 text、value 仍是源码本身，
 *   于是渲染器按普通散文输出。这正是 §10.3「判定不成立的表达式原样还原为散文」
 *   的实现形态：不需要额外的还原代码，还原就是「什么都不做地退回上一层」。
 */
const mathProcessor: Processor = {
  name: "math",
  process(document): void {
    const convert = (node: MarkdownNode): MarkdownNode => {
      const source = node.attributes?.[MATH_SOURCE_ATTR];
      if (node.type === "text" && typeof source === "string") {
        const display = node.attributes?.[MATH_DISPLAY_ATTR] === "block" ? "block" : "inline";
        if (!isRenderableMath(source)) {
          // 逐个删标记而不是重建节点：位置、id、value 都必须与原样输出时一致。
          const attributes = { ...(node.attributes ?? {}) };
          delete attributes[MATH_SOURCE_ATTR];
          delete attributes[MATH_DISPLAY_ATTR];
          node.attributes = attributes;
          return node;
        }
        const type: MarkdownNodeType = display === "block" ? "mathBlock" : "mathInline";
        node.type = type;
        node.id = node.id.replace("|text|", `|${type}|`);
        node.attributes = { source, display };
        return node;
      }
      if (node.children) {
        node.children = node.children.map(convert);
      }
      return node;
    };
    document.children = document.children.map(convert);
  }
};

/**
 * Wiki Link 处理器（ARC-002 §5.3 顺序第 5 位，IMP-001 §12.2 / STORY-06-03，M6 落地）。
 *
 * 与 Math 同构的两阶段：AST 只交出「带 wikiTarget 标记的 text」，是否成链接在这里判。
 * - 成立 → 改写为 wikiLink，attributes 换成 target / label（label 已在渲染前定稿，
 *   渲染器不再回看别名规则，于是「别名缺省用目标」这条口径只有一个作者）；
 * - 不成立（空、scheme、绝对路径、超长）→ 只摘标记，value 仍是 `[[…]]` 源码，
 *   按字面量显示。这与「渲染器把可疑目标包成一个可点击链接、等 Host 拒绝」是两件事：
 *   后者会在正文里摆出一个注定失败的 affordance。
 */
const wikiLinkProcessor: Processor = {
  name: "wikiLink",
  process(document): void {
    const convert = (node: MarkdownNode): MarkdownNode => {
      const target = node.attributes?.[WIKI_TARGET_ATTR];
      if (node.type === "text" && typeof target === "string") {
        if (!isResolvableWikiTarget(target)) {
          const attributes = { ...(node.attributes ?? {}) };
          delete attributes[WIKI_TARGET_ATTR];
          delete attributes[WIKI_ALIAS_ATTR];
          node.attributes = attributes;
          return node;
        }
        const alias = node.attributes?.[WIKI_ALIAS_ATTR];
        node.type = "wikiLink";
        node.id = node.id.replace("|text|", "|wikiLink|");
        node.attributes = {
          target: target.trim(),
          label: wikiLinkLabel(target, typeof alias === "string" ? alias : "")
        };
        return node;
      }
      if (node.children) {
        node.children = node.children.map(convert);
      }
      return node;
    };
    document.children = document.children.map(convert);
  }
};

/** 定义记录：标签 + 原节点（含子树），编号与渲染都从这里取。 */
interface FootnoteDefinition {
  label: string;
  node: MarkdownNode;
}

function stripDefinitions(node: MarkdownNode, collected: FootnoteDefinition[]): void {
  const children = node.children;
  if (!children || children.length === 0) {
    return;
  }
  const kept: MarkdownNode[] = [];
  for (const child of children) {
    if (child.type === "footnoteDefinition") {
      // 定义从正文流里摘走：它不属于叙述，而是脚注区的素材（留在原地会多出一段
      // 没有上下文的花括号文本）。内容不丢：子树整个进到 footnoteItem。
      collected.push({ label: String(child.attributes?.["label"] ?? ""), node: child });
      continue;
    }
    kept.push(child);
    stripDefinitions(child, collected);
  }
  node.children = kept;
}

function collectReferences(node: MarkdownNode, collected: MarkdownNode[]): void {
  if (node.type === "footnoteReference") {
    collected.push(node);
  }
  for (const child of node.children ?? []) {
    collectReferences(child, collected);
  }
}

/** 引用判不成 → 只摘标记、换回 text：value 仍是 `[^label]` 原文，一个字不少。 */
function restoreReference(node: MarkdownNode): void {
  node.type = "text";
  node.id = node.id.replace("|footnoteReference|", "|text|");
  delete node.attributes;
}

/**
 * Footnote 处理器（M10，PRD-001 F01-017）。
 *
 * 与 Math / Wiki Link 同构的两阶段：AST 只交出「带标签的引用与定义」，
 * 编号、配对、脚注区拼装全在这里。三个细节定了就不改：
 * - **编号按首次引用顺序**，未被引用的定义接在后面（按源码顺序）——
 *   与 GFM 一致，于是 `[1]` 就是正文里第一个出现的脚注；
 * - **同名标签的多条定义合并进同一个条目**，而不是丢后者：内容不丢是底线；
 * - **多条引用同一脚注** ⇒ 同一个编号、不同的 `refAnchor`（HTML 里 id 必须唯一），
 *   条目里的回跳指向首次引用。
 */
const footnoteProcessor: Processor = {
  name: "footnote",
  process(document, diagnostics): void {
    const definitions: FootnoteDefinition[] = [];
    stripDefinitions(document, definitions);
    const references: MarkdownNode[] = [];
    collectReferences(document, references);
    // 定义子树里的引用也算数（它们已离开 document 树，不补一遍就永远得不到编号）。
    for (const definition of definitions) {
      collectReferences(definition.node, references);
    }
    if (definitions.length === 0 && references.length === 0) {
      return;
    }

    const byLabel = new Map<string, FootnoteDefinition>();
    for (const definition of definitions) {
      const existing = byLabel.get(definition.label);
      if (existing) {
        const children = existing.node.children ?? [];
        for (const child of definition.node.children ?? []) {
          children.push(child);
        }
        existing.node.children = children;
        continue;
      }
      byLabel.set(definition.label, { label: definition.label, node: definition.node });
    }

    // 先按引用顺序编号，再把未被引用的定义接在后面。
    const indexes = new Map<string, number>();
    for (const reference of references) {
      const label = String(reference.attributes?.["label"] ?? "");
      if (!indexes.has(label) && byLabel.has(label)) {
        indexes.set(label, indexes.size + 1);
      }
    }
    for (const label of byLabel.keys()) {
      if (!indexes.has(label)) {
        indexes.set(label, indexes.size + 1);
      }
    }

    const occurrences = new Map<number, number>();
    for (const reference of references) {
      const label = String(reference.attributes?.["label"] ?? "");
      const index = indexes.get(label);
      if (index === undefined) {
        restoreReference(reference);
        diagnostics?.push(
          diagnostic(
            reference,
            RENDER_DIAGNOSTIC_CODES.FOOTNOTE_UNRESOLVED,
            "info",
            `Footnote definition "${label}" is missing; the reference is kept as literal text.`
          )
        );
        continue;
      }
      const occurrence = (occurrences.get(index) ?? 0) + 1;
      occurrences.set(index, occurrence);
      reference.attributes = {
        index,
        label,
        anchor: footnoteAnchor(index),
        refAnchor: footnoteRefAnchor(index, occurrence)
      };
    }

    if (byLabel.size === 0) {
      return;
    }

    const ordered = [...byLabel.values()].sort(
      (left, right) => (indexes.get(left.label) ?? 0) - (indexes.get(right.label) ?? 0)
    );
    const overflow = Math.max(ordered.length - FOOTNOTE_MAX_ITEMS, 0);
    const keptItems = overflow > 0 ? ordered.slice(0, FOOTNOTE_MAX_ITEMS) : ordered;

    const items: MarkdownNode[] = keptItems.map((definition) => {
      const index = indexes.get(definition.label) ?? 0;
      const align = definition.node.attributes?.["align"];
      return {
        id: definition.node.id.replace("|footnoteDefinition|", "|footnoteItem|"),
        type: "footnoteItem",
        ...(definition.node.position ? { position: definition.node.position } : {}),
        attributes: {
          index,
          label: definition.label,
          anchor: footnoteAnchor(index),
          backAnchor: footnoteRefAnchor(index, 1),
          // 定义上的 `{align=…}` 必须跟着内容搬进条目，否则属性挂在定义节点上
          // 而定义节点本身不进渲染 —— 又是一个静默失效（attrs.ts BLOCK_KEYS 口径）。
          ...(align === "left" || align === "center" || align === "right" ? { align } : {})
        },
        children: definition.node.children ?? []
      };
    });

    const section: MarkdownNode = {
      id: document.id.replace("|document|", "|footnoteSection|"),
      type: "footnoteSection",
      attributes: { count: items.length },
      children: items
    };
    document.children.push(section);

    if (overflow > 0) {
      diagnostics?.push(
        diagnostic(
          section,
          RENDER_DIAGNOSTIC_CODES.FOOTNOTE_LIMIT,
          "warning",
          `Footnote section holds ${items.length} of ${ordered.length} entries: above the ${FOOTNOTE_MAX_ITEMS} limit the remaining ${overflow} definition(s) are not rendered.`
        )
      );
    }
  }
};

export const PROCESSORS: readonly Processor[] = [
  frontmatterProcessor,
  headingProcessor,
  codeBlockProcessor,
  csvProcessor,
  mathProcessor,
  wikiLinkProcessor,
  footnoteProcessor
];

/** 已注册处理器名称，按 §5.3 相对顺序排列，供测试断言顺序不变量。 */
export const REGISTERED_PROCESSOR_NAMES: readonly ProcessorName[] = PROCESSORS.map(
  (processor) => processor.name
);

export function runProcessors(
  document: MarkdownDocument,
  diagnostics?: RenderDiagnostic[]
): MarkdownDocument {
  const collected = diagnostics ?? [];
  const sink: DiagnosticSink = { push: (item) => collected.push(item) };
  for (const processor of PROCESSORS) {
    processor.process(document, sink);
  }
  return document;
}

