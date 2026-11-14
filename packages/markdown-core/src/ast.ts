/**
 * P03 AST Builder（ARC-002 §4）。
 *
 * markdown-it 原生 Token 不适合作为长期业务契约（§4.1），故在此收敛为内部 AST：
 * - 节点 ID 由「文档标识 + 节点类型 + 源码位置 + 序号」生成，禁止随机 ID（§4.4）；
 * - 位置信息取 Token.map，供诊断定位与后续增量处理使用（§4.1）；
 * - tight 列表的隐藏 paragraph 解包，避免渲染出多余 `<p>`；
 * - 任务列表标记在此识别（markdown-it 原生不支持，ARC-002 §7.3 要求展示）；
 * - 未知容器 token 作为透明容器处理，内容一律保留，不丢正文（§14.3 第 5 条）。
 *
 * 行内 HTML（html_inline）在冻结节点表中没有对应类型，复用 htmlBlock 承载，
 * 渲染期一律转义为可见文本（§11.2「默认不执行原始 HTML」）。
 *
 * M10 新增两类搬运：脚注 token（`footnote_ref` / `footnote_def_open`）落成
 * 脚注节点；块属性（`attrs.ts` 白名单）从 token.attrs 原样搬进节点 attributes。
 * 两者都只搬运事实：「这条引用有没有定义、排第几号」是 footnote 处理器的职责。
 */
import type { Token } from "./parser";
import { whitelistedAttributes } from "./attrs";
import {
  FOOTNOTE_DEF_OPEN_TOKEN,
  FOOTNOTE_LABEL_ATTR,
  FOOTNOTE_REF_TOKEN
} from "./footnote";
import {
  MATH_BLOCK_TOKEN,
  MATH_DISPLAY_ATTR,
  MATH_SOURCE_ATTR,
  MATH_SPAN_TOKEN,
  isDisplayMathMarkup
} from "./math";
import { WIKI_ALIAS_ATTR, WIKI_LINK_TOKEN, WIKI_TARGET_ATTR } from "./wiki-link";
import {
  DEFAULT_PARSER_OPTIONS,
  type MarkdownDocument,
  type MarkdownNode,
  type MarkdownParserOptions,
  type MarkdownNodeType,
  type SourcePosition
} from "./types";

const TASK_MARKER = /^\[([ xX])\]\s+/;

function positionOf(token: Token): SourcePosition | undefined {
  const map = token.map;
  if (!map) {
    return undefined;
  }
  const startLine = map[0] ?? 0;
  const endLine = Math.max((map[1] ?? startLine + 1) - 1, startLine);
  return { startLine, endLine };
}

function attrOf(token: Token, name: string): string | undefined {
  const value = token.attrGet(name);
  // markdown-it 允许 attrSet 写入 number（如 ordered list 的 start）。
  return value === null || value === undefined ? undefined : String(value);
}

function alignOf(token: Token): string | undefined {
  const style = attrOf(token, "style");
  if (!style) {
    return undefined;
  }
  return /text-align:\s*(left|right|center)/.exec(style)?.[1];
}

/**
 * 块属性透传：`attrs.ts` 的 core 规则已经把 `{k=v}` 校验过一遍并写进 token.attrs，
 * 这里 `whitelistedAttributes` 再校一次（纵深防御：属性表只有白名单一份作者），
 * 于是「谁在决定属性有效性」这个问题在 AST 层不存在 —— 两处都必须同意。
 */
function withAttrs(
  base: Record<string, unknown>,
  token: Token
): Record<string, unknown> {
  const attrs = whitelistedAttributes(token);
  return Object.keys(attrs).length > 0 ? { ...base, ...attrs } : base;
}

/**
 * 公式 token → 标记属性。
 *
 * `markup` 是 markdown-it 记录定界符的字段：`$$` 与 `\[` 即 display，`$` 与 `\(` 即行内。
 * 这里只搬运事实，不做任何「这算不算公式」的判断 —— 那是处理器的职责。
 */
function mathAttributes(token: Token): Record<string, unknown> {
  return {
    [MATH_SOURCE_ATTR]: token.content,
    [MATH_DISPLAY_ATTR]: isDisplayMathMarkup(token.markup) ? "block" : "inline"
  };
}

/**
 * wiki 引用 token → 标记属性。
 *
 * 与公式同一口径：这里只搬运「target / alias」两个事实，
 * 「这算不算一条可跳转的引用」由 processors 的 wikiLink 处理器判定。
 */
function wikiAttributes(token: Token): Record<string, unknown> {
  return {
    [WIKI_TARGET_ATTR]: attrOf(token, WIKI_TARGET_ATTR) ?? "",
    [WIKI_ALIAS_ATTR]: attrOf(token, WIKI_ALIAS_ATTR) ?? ""
  };
}

interface BlockSpec {
  type: MarkdownNodeType;
  attributes: Record<string, unknown>;
  /** 透明容器不产生节点，子内容上提一级（thead / tbody / tight paragraph / 未知容器）。 */
  transparent: boolean;
}

function blockSpecOf(token: Token): BlockSpec {
  const attributes: Record<string, unknown> = {};
  switch (token.type) {
    case "heading_open": {
      const level = Number.parseInt(token.tag.replace(/\D/g, ""), 10);
      return {
        type: "heading",
        attributes: withAttrs(
          { level: Number.isFinite(level) ? Math.min(Math.max(level, 1), 6) : 1 },
          token
        ),
        transparent: false
      };
    }
    case "paragraph_open":
      return { type: "paragraph", attributes: withAttrs(attributes, token), transparent: token.hidden === true };
    case "blockquote_open":
      return { type: "blockquote", attributes: withAttrs(attributes, token), transparent: false };
    case "bullet_list_open":
      return {
        type: "list",
        attributes: withAttrs({ ordered: false }, token),
        transparent: false
      };
    case "ordered_list_open": {
      const start = attrOf(token, "start");
      const parsed = start === undefined ? Number.NaN : Number.parseInt(start, 10);
      if (Number.isFinite(parsed)) {
        attributes.start = parsed;
      }
      return {
        type: "list",
        attributes: withAttrs({ ordered: true, ...attributes }, token),
        transparent: false
      };
    }
    case "list_item_open":
      return { type: "listItem", attributes: withAttrs(attributes, token), transparent: false };
    case FOOTNOTE_DEF_OPEN_TOKEN:
      // 脚注定义先落成普通容器节点：编号与配对由 footnote 处理器决定，
      // 定义内容（含 inline 子树）在这里必须原样保住。
      return {
        type: "footnoteDefinition",
        attributes: withAttrs({ label: attrOf(token, FOOTNOTE_LABEL_ATTR) ?? "" }, token),
        transparent: false
      };
    case "table_open":
      // 表级块属性（`{align=center}`）只有 table 节点能用：单元格对齐仍走 `:---:`（alignOf）。
      return { type: "table", attributes: withAttrs(attributes, token), transparent: false };
    case "thead_open":
    case "tbody_open":
      return { type: "table", attributes, transparent: true };
    case "tr_open":
      return { type: "tableRow", attributes, transparent: false };
    case "th_open":
    case "td_open": {
      const align = alignOf(token);
      const cellAttributes: Record<string, unknown> = { header: token.type === "th_open" };
      if (align !== undefined) {
        cellAttributes.align = align;
      }
      return { type: "tableCell", attributes: cellAttributes, transparent: false };
    }
    default:
      // 未知容器（插件语法等）：透明穿透，保证内容不丢、结构不错乱。
      return { type: "paragraph", attributes, transparent: true };
  }
}

function inlineTypeOf(token: Token): MarkdownNodeType {
  switch (token.type) {
    case "em_open":
      return "emphasis";
    case "strong_open":
      return "strong";
    case "s_open":
      return "delete";
    case "link_open":
      return "link";
    default:
      return "paragraph";
  }
}

interface StackEntry {
  node: MarkdownNode | null;
  list: MarkdownNode[];
}

export class AstBuilder {
  private sequence = 0;

  constructor(
    private readonly documentId: string,
    private readonly options: MarkdownParserOptions = DEFAULT_PARSER_OPTIONS
  ) {}

  create(
    type: MarkdownNodeType,
    position: SourcePosition | undefined,
    extra: {
      value?: string;
      attributes?: Record<string, unknown>;
      children?: MarkdownNode[];
    } = {}
  ): MarkdownNode {
    this.sequence += 1;
    const id = `${this.documentId}|${type}|${position?.startLine ?? -1}|${this.sequence}`;
    const node: MarkdownNode = { id, type };
    if (position) {
      node.position = position;
    }
    if (extra.value !== undefined) {
      node.value = extra.value;
    }
    if (extra.attributes) {
      node.attributes = extra.attributes;
    }
    if (extra.children) {
      node.children = extra.children;
    }
    return node;
  }

  /** 行内 Token 流 → 子节点数组（无包裹节点）。 */
  inline(tokens: Token[]): MarkdownNode[] {
    const root: MarkdownNode[] = [];
    const stack: StackEntry[] = [{ node: null, list: root }];

    const append = (node: MarkdownNode): void => {
      (stack[stack.length - 1] ?? { list: root }).list.push(node);
    };

    for (const token of tokens) {
      if (token.nesting === 1) {
        const type = inlineTypeOf(token);
        const attributes: Record<string, unknown> = {};
        if (type === "link") {
          const href = attrOf(token, "href");
          const title = attrOf(token, "title");
          if (href !== undefined) {
            attributes.href = href;
          }
          if (title !== undefined) {
            attributes.title = title;
          }
        }
        const children: MarkdownNode[] = [];
        const node = this.create(type, undefined, { attributes, children });
        append(node);
        stack.push({ node, list: children });
        continue;
      }
      if (token.nesting === -1) {
        if (stack.length > 1) {
          stack.pop();
        }
        continue;
      }

      switch (token.type) {
        case "text":
          append(this.create("text", undefined, { value: token.content }));
          break;
        case "code_inline":
          append(this.create("inlineCode", undefined, { value: token.content }));
          break;
        case "html_inline":
          append(this.create("htmlBlock", undefined, { value: token.content }));
          break;
        case "softbreak":
          // markdown-it 的 breaks 选项只作用于它自己的 HTML 渲染器（Token 流里
          // 永远是 softbreak），本管线自渲染，故在此按选项还原为硬换行。
          if (this.options.breaks) {
            append(this.create("break", undefined));
          } else {
            append(this.create("text", undefined, { value: "\n" }));
          }
          break;
        case "hardbreak":
          append(this.create("break", undefined));
          break;
        case "image": {
          const attributes: Record<string, unknown> = { alt: token.content };
          const src = attrOf(token, "src");
          const title = attrOf(token, "title");
          if (src !== undefined) {
            attributes.src = src;
          }
          if (title !== undefined) {
            attributes.title = title;
          }
          // `![alt](path){width=60%}` 的尺寸属性跟在图片 token 上（attrs.ts 形态 A）。
          Object.assign(attributes, whitelistedAttributes(token));
          append(this.create("image", undefined, { attributes }));
          break;
        }
        case FOOTNOTE_REF_TOKEN:
          // 引用先落成一个带标签的节点：编号与「有没有定义」由 footnote 处理器定，
          // 不成则它换回 text、value 仍是 `[^label]` 源码，按字面量显示。
          append(
            this.create("footnoteReference", undefined, {
              value: token.content,
              attributes: { label: attrOf(token, FOOTNOTE_LABEL_ATTR) ?? "" }
            })
          );
          break;
        case MATH_SPAN_TOKEN:
          // 公式在 AST 阶段只是「带标记的 text」：归类由 processors 的 math 处理器完成。
          // 保留 value = 源码本身，于是判定不成立时摘掉标记就是原样还原为散文。
          append(
            this.create("text", undefined, {
              value: token.content,
              attributes: mathAttributes(token)
            })
          );
          break;
        case WIKI_LINK_TOKEN:
          // 同一条两阶段口径：value 留着 `[[…]]` 原文，处理器拒了就走普通文本。
          append(
            this.create("text", undefined, {
              value: token.content,
              attributes: wikiAttributes(token)
            })
          );
          break;
        default:
          // 未知行内 token：按文本降级，内容不丢。
          if (token.content) {
            append(this.create("text", undefined, { value: token.content }));
          }
      }
    }

    return root;
  }

  document(tokens: Token[], lineCount: number): MarkdownDocument {
    const children: MarkdownNode[] = [];
    const base = this.create(
      "document",
      { startLine: 0, endLine: Math.max(lineCount - 1, 0) },
      { children }
    );
    const document: MarkdownDocument = { ...base, type: "document", children };
    const stack: StackEntry[] = [{ node: document, list: children }];

    const current = (): StackEntry => stack[stack.length - 1] ?? { node: document, list: children };

    for (const token of tokens) {
      const position = positionOf(token);

      if (token.nesting === 1) {
        const spec = blockSpecOf(token);
        if (spec.transparent) {
          stack.push({ node: null, list: current().list });
          continue;
        }
        const nodeChildren: MarkdownNode[] = [];
        const node = this.create(spec.type, position, {
          attributes: spec.attributes,
          children: nodeChildren
        });
        current().list.push(node);
        stack.push({ node, list: nodeChildren });
        continue;
      }

      if (token.nesting === -1) {
        if (stack.length > 1) {
          const closing = stack.pop();
          if (closing?.node?.type === "list") {
            for (const item of closing.node.children ?? []) {
              if (item.type === "listItem") {
                normalizeTaskItem(item);
              }
            }
          }
        }
        continue;
      }

      switch (token.type) {
        case "inline":
          for (const child of this.inline(token.children ?? [])) {
            current().list.push(child);
          }
          break;
        case "fence":
        case "code_block": {
          const attributes: Record<string, unknown> = {};
          const info = token.type === "fence" ? (token.info ?? "").trim() : "";
          const lang = info.split(/\s+/)[0];
          if (lang) {
            attributes.lang = lang;
          }
          // `{…}` 已由 attrs core 规则从 info 尾部拿下并写进 token.attrs，
          // 于是 `lang` 仍然是第一个词，代码块不会变成一个叫 `{code_block=true}` 的语言。
          Object.assign(attributes, whitelistedAttributes(token));
          current().list.push(
            this.create("codeBlock", position, { value: token.content, attributes })
          );
          break;
        }
        case "hr":
          current().list.push(this.create("thematicBreak", position));
          break;
        case "html_block":
          current().list.push(this.create("htmlBlock", position, { value: token.content }));
          break;
        case MATH_BLOCK_TOKEN:
          // 块级公式同样先落成带标记的 text：与行内共用同一个处理器与同一条判定。
          current().list.push(
            this.create("text", position, {
              value: token.content,
              attributes: mathAttributes(token)
            })
          );
          break;
        default:
          if (token.content) {
            current().list.push(this.create("text", position, { value: token.content }));
          }
      }
    }

    return document;
  }
}

function firstTextNode(item: MarkdownNode): MarkdownNode | undefined {
  const first = item.children?.[0];
  if (!first) {
    return undefined;
  }
  if (first.type === "text") {
    return first;
  }
  if (first.type === "paragraph") {
    return first.children?.[0];
  }
  return undefined;
}

function normalizeTaskItem(item: MarkdownNode): void {
  const textNode = firstTextNode(item);
  if (!textNode || typeof textNode.value !== "string") {
    return;
  }
  const match = TASK_MARKER.exec(textNode.value);
  if (!match) {
    return;
  }
  textNode.value = textNode.value.slice(match[0].length);
  const attributes = item.attributes ?? {};
  attributes.task = true;
  attributes.checked = (match[1] ?? " ").toLowerCase() === "x";
  item.attributes = attributes;
}

export function buildAst(
  tokens: Token[],
  documentId: string,
  lineCount: number,
  options: MarkdownParserOptions = DEFAULT_PARSER_OPTIONS
): MarkdownDocument {
  return new AstBuilder(documentId, options).document(tokens, lineCount);
}
