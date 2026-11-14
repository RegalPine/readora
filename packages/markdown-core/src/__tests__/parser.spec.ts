/**
 * P02 Markdown Parser 单测（ARC-002 §3.3 / §3.4，IMP-001 §8.2）。
 *
 * 重点锁定冻结配置：html:false / linkify:true / typographer:false / breaks:false，
 * 以及「markdown-it 实例不对外暴露」。
 */
import { describe, expect, it } from "vitest";
import * as markdownCore from "../index";
import { createMarkdownParser, getParser, parserOptionsOf, type Token } from "../parser";
import { DEFAULT_PARSER_OPTIONS } from "../types";

function types(tokens: Token[]): string[] {
  return tokens.map((token) => token.type);
}

function collectTokens(tokens: Token[]): Token[] {
  const flat: Token[] = [];
  const walk = (list: Token[]): void => {
    for (const token of list) {
      flat.push(token);
      if (token.children) {
        walk(token.children);
      }
    }
  };
  walk(tokens);
  return flat;
}

describe("Parser 配置契约", () => {
  it("冻结配置逐字一致（ARC-002 §3.4）", () => {
    expect(DEFAULT_PARSER_OPTIONS).toEqual({
      html: false,
      linkify: true,
      typographer: false,
      breaks: false
    });
    expect(parserOptionsOf()).toEqual(DEFAULT_PARSER_OPTIONS);
  });

  it("html:false：原始 HTML 不产生可执行 token", () => {
    const tokens = createMarkdownParser().parse("<script>alert(1)</script>\n\n<p onclick=x>hi</p>\n");
    const dangerous = collectTokens(tokens).filter(
      (token) => token.type === "html_block" || token.type === "html_inline"
    );
    expect(dangerous).toHaveLength(0);
    expect(types(tokens)).not.toContain("html_block");
  });

  it("html:false：行内 HTML 同样不进入 token 流", () => {
    const tokens = createMarkdownParser().parse("文字 <b>粗</b> 更多\n");
    expect(collectTokens(tokens).some((token) => token.type === "html_inline")).toBe(false);
  });

  it("linkify:true：带 scheme 的裸 URL 自动成为 link_open", () => {
    const tokens = createMarkdownParser().parse("see https://example.com now\n");
    expect(collectTokens(tokens).map((token) => token.type)).toContain("link_open");
  });

  it("linkify:true：邮箱自动 linkify；无 scheme 的裸域名按 linkify-it v5 默认保持文本", () => {
    const email = collectTokens(createMarkdownParser().parse("mail a@b.com now\n"))
      .map((token) => token.type);
    expect(email).toContain("link_open");
    const bare = collectTokens(createMarkdownParser().parse("访问 example.com 即可\n"))
      .map((token) => token.type);
    expect(bare).not.toContain("link_open");
  });

  it("typographer:false：不做标点替换", () => {
    const tokens = createMarkdownParser().parse("(c) (tm) \"引号\"\n");
    const text = collectTokens(tokens)
      .filter((token) => token.type === "text")
      .map((token) => token.content)
      .join("");
    expect(text).toContain("(c)");
    expect(text).not.toContain("©");
  });

  it("breaks:false：单个换行是 softbreak 而非硬换行", () => {
    const tokens = createMarkdownParser().parse("a\nb\n");
    const inlineTypes = collectTokens(tokens).map((token) => token.type);
    expect(inlineTypes).toContain("softbreak");
    expect(inlineTypes).not.toContain("hardbreak");
  });

  it("breaks:false 下行尾两空格仍是硬换行（CommonMark 语义）", () => {
    const tokens = createMarkdownParser().parse("a  \nb\n");
    expect(collectTokens(tokens).map((token) => token.type)).toContain("hardbreak");
  });
});

describe("Parser 实例管理", () => {
  it("同配置复用实例，不同配置分开缓存", () => {
    const first = getParser(DEFAULT_PARSER_OPTIONS);
    const again = getParser({ ...DEFAULT_PARSER_OPTIONS });
    const withHtml = getParser({ ...DEFAULT_PARSER_OPTIONS, html: true });
    expect(again).toBe(first);
    expect(withHtml).not.toBe(first);
  });

  it("对外只暴露 Token 流，不暴露 markdown-it 实例方法", () => {
    const parser = createMarkdownParser();
    const keys = Object.keys(parser).sort().join(",");
    expect(keys).toBe("parse");
    expect(typeof parser.parse).toBe("function");
  });

  it("parse 结果携带 map 位置信息供 AST 使用", () => {
    const tokens = createMarkdownParser().parse("# 标题\n\n段落\n");
    const heading = tokens.find((token) => token.type === "heading_open");
    expect(heading?.map).toEqual([0, 1]);
  });

  it("空输入返回空 token 流，不抛错", () => {
    expect(createMarkdownParser().parse("")).toEqual([]);
  });
});

describe("包门面暴露面（§3.3 / §12.2）", () => {
  const exported = Object.keys(markdownCore).sort();

  it("门面不导出 Parser 工厂与实例获取器", () => {
    expect(exported).not.toContain("createMarkdownParser");
    expect(exported).not.toContain("getParser");
    expect(exported).not.toContain("parserOptionsOf");
    expect(exported).not.toContain("MarkdownIt");
  });

  it("应用层只能拿到管线入口 renderMarkdown", () => {
    expect(typeof markdownCore.renderMarkdown).toBe("function");
    // 拿不到解析器就没有「绕过管线自行 parse」的可能（ARC-002 §12.2）
    const forbidden = new Set([
      "parse",
      "parseSource",
      "createParser",
      "createMarkdownParser",
      "getParser",
      "parserOptionsOf",
      "MarkdownIt"
    ]);
    expect(exported.filter((name) => forbidden.has(name))).toEqual([]);
  });

  it("内部 Parser 抽象仍只透出 parse 一个方法", () => {
    const parser = createMarkdownParser();
    const instance = getParser(DEFAULT_PARSER_OPTIONS) as unknown as Record<string, unknown>;
    for (const member of ["renderer", "parseInline", "inline", "block", "core", "utils"]) {
      expect(instance[member]).toBeDefined();
      expect(Object.hasOwn(parser, member)).toBe(false);
    }
  });
});
