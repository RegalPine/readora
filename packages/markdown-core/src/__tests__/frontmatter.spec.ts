/**
 * Frontmatter 提取单测（ARC-002 §4.2 Frontmatter 节点 / §12.1 metadata）。
 *
 * M6（STORY-06-02）起 metadata 多了一份 **properties 名单**：属性卡片要的是
 * 「作者写下的每个键 + 它的类型」，而 title / description / tags 三个槽位是
 * 给应用层用的归一化视图。两组断言分别锁住这两层，互不代替。
 */
import { describe, expect, it } from "vitest";
import {
  FRONTMATTER_PROPERTY_LIMIT,
  classifyFrontmatterValue,
  extractFrontmatter
} from "../frontmatter";
import { RENDER_DIAGNOSTIC_CODES } from "../index";
import { normalizeSource } from "../normalize";
import { htmlOf, render } from "./helpers";

function extract(source: string) {
  return extractFrontmatter(normalizeSource(source));
}

describe("元数据提取", () => {
  it("title / description / tags 提取到 metadata", () => {
    const outcome = extract("---\ntitle: 我的文档\ndescription: 摘要文字\ntags: [a, b]\n---\n\n# 正文\n");
    expect(outcome.metadata).toEqual({
      title: "我的文档",
      description: "摘要文字",
      tags: ["a", "b"],
      // 三个槽位对应的键同时进名单：卡片展示的是完整 Frontmatter，不做去重。
      properties: [
        { key: "title", kind: "text", text: "我的文档" },
        { key: "description", kind: "text", text: "摘要文字" },
        { key: "tags", kind: "list", text: "[a, b]", items: ["a", "b"] }
      ]
    });
    expect(outcome.body).toBe("\n# 正文\n");
    expect(outcome.diagnostics).toEqual([]);
  });

  it("引号值与 keywords 别名", () => {
    const outcome = extract('---\ntitle: "带引号: 冒号"\nkeywords: ["阅读", note]\n---\n正文\n');
    expect(outcome.metadata.title).toBe("带引号: 冒号");
    expect(outcome.metadata.tags).toEqual(["阅读", "note"]);
  });

  it("块序列 tags", () => {
    const outcome = extract("---\ntags:\n  - 一\n  - 二\n---\n\n正文\n");
    expect(outcome.metadata.tags).toEqual(["一", "二"]);
  });

  it("单值 tags 归一为数组", () => {
    expect(extract("---\ntags: 单个\n---\n\nx\n").metadata.tags).toEqual(["单个"]);
  });

  it("未知键忽略但不报错", () => {
    const outcome = extract("---\ntitle: T\nauthor: 某人\n---\n\nx\n");
    expect(outcome.metadata.title).toBe("T");
    expect(outcome.diagnostics).toEqual([]);
  });

  it("闭合围栏 ... 同样有效", () => {
    expect(extract("---\ntitle: T\n...\n\nx\n").metadata.title).toBe("T");
  });

  it("CRLF 输入经 normalize 后可解析", () => {
    expect(extract("---\r\ntitle: T\r\n---\r\n\r\nx\r\n").metadata.title).toBe("T");
  });
});

describe("降级与不影响整篇（§14.3）", () => {
  it("无 frontmatter 时正文原样返回", () => {
    const outcome = extract("# 直接正文\n");
    expect(outcome.body).toBe("# 直接正文\n");
    expect(outcome.metadata).toEqual({ tags: [], properties: [] });
    expect(outcome.diagnostics).toEqual([]);
  });

  it("未闭合围栏保留为正文并给出 info 诊断", () => {
    const outcome = extract("---\ntitle: T\n\n# 正文\n");
    expect(outcome.body).toBe("---\ntitle: T\n\n# 正文\n");
    expect(outcome.metadata).toEqual({ tags: [], properties: [] });
    const diagnostic = outcome.diagnostics[0];
    expect(diagnostic?.code).toBe(RENDER_DIAGNOSTIC_CODES.FRONTMATTER_INVALID);
    expect(diagnostic?.severity).toBe("info");
  });

  it("非法行跳过并给出 info，其余字段仍解析", () => {
    const outcome = extract("---\ntitle: T\n这不是键值对\n---\n\nx\n");
    expect(outcome.metadata.title).toBe("T");
    expect(outcome.diagnostics[0]?.severity).toBe("info");
    expect(outcome.diagnostics[0]?.message).toContain("这不是键值对");
  });

  it("正文中的 --- 分隔线不会被误当 frontmatter", () => {
    const html = htmlOf("# 标题\n\n---\n\ntitle: 不是元数据\n");
    expect(html).toContain("<hr");
    expect(html).toContain("title: 不是元数据");
    expect(render("# 标题\n\n---\n\n段落\n").metadata.title).toBeUndefined();
  });

  it("frontmatter 不出现在渲染正文中", () => {
    const result = render("---\ntitle: 隐藏区\n---\n\n# 可见标题\n");
    expect(result.html).not.toContain("隐藏区");
    expect(result.metadata.title).toBe("隐藏区");
  });

  it("空 frontmatter 不产生诊断", () => {
    const outcome = extract("---\n---\n\n正文\n");
    expect(outcome.diagnostics).toEqual([]);
    expect(outcome.body).toBe("\n正文\n");
  });
});

/**
 * 属性名单（STORY-06-02 / PRD-003 §4.6）。
 *
 * 卡片的全部依据就是这份名单，所以这里锁的是「类型判对没判对」与「有没有求值」，
 * 而不是卡片的外观 —— 外观在 apps/webview 的 DocumentHeader 用例里。
 */
describe("属性名单与类型分类（STORY-06-02）", () => {
  it("五类字面量各自归类，文本保留原文", () => {
    expect(classifyFrontmatterValue("42")).toEqual({ kind: "number", text: "42" });
    expect(classifyFrontmatterValue("-3.5e2")).toEqual({ kind: "number", text: "-3.5e2" });
    expect(classifyFrontmatterValue("true")).toEqual({ kind: "boolean", text: "true" });
    expect(classifyFrontmatterValue('"FALSE"')).toEqual({ kind: "boolean", text: "FALSE" });
    expect(classifyFrontmatterValue("2024-01-02")).toEqual({ kind: "date", text: "2024-01-02" });
    expect(classifyFrontmatterValue("2024-01-02T08:30")).toEqual({
      kind: "date",
      text: "2024-01-02T08:30"
    });
    expect(classifyFrontmatterValue("draft")).toEqual({ kind: "text", text: "draft" });
    expect(classifyFrontmatterValue("[a, b]")).toEqual({
      kind: "list",
      text: "[a, b]",
      items: ["a", "b"]
    });
  });

  it("不执行任何表达式：模板语法、公式与等号开头一律是文本", () => {
    // STORY-06-02 的验收线。这三条若被判成别的类型，就意味着提取层在求值。
    for (const hostile of ["{{7*7}}", "=1+1", "new Date(0)"]) {
      expect(classifyFrontmatterValue(hostile)).toEqual({ kind: "text", text: hostile });
    }
    const outcome = extract("---\nexploit: =CMD('/S calc.exe')\n---\n\nx\n");
    expect(outcome.metadata.properties).toEqual([
      { key: "exploit", kind: "text", text: "=CMD('/S calc.exe')" }
    ]);
  });

  it("日期只做模式匹配，不重新格式化也不换算时区", () => {
    // `2024-01-02` 在任何机器上都显示成 `2024-01-02`：卡片交出的就是源码字面量。
    expect(extract("---\ndate: 2024-01-02\n---\n\nx\n").metadata.properties[0]?.text).toBe(
      "2024-01-02"
    );
  });

  it("键名保留原文大小写，未知键也进名单", () => {
    const outcome = extract("---\nStatus: draft\nAuthor_Name: 某人\n---\n\nx\n");
    expect(outcome.metadata.properties.map((item) => item.key)).toEqual([
      "Status",
      "Author_Name"
    ]);
    // 归一化视图只认小写键：title / tags 的既有口径不因名单而改变。
    expect(outcome.metadata.title).toBeUndefined();
    expect(outcome.diagnostics).toEqual([]);
  });

  it("块序列进名单是 list，键存在但没有条目时空序列仍然登记", () => {
    const outcome = extract("---\naliases:\n  - A\n  - B\nempty:\n---\n\nx\n");
    expect(outcome.metadata.properties).toEqual([
      { key: "aliases", kind: "list", text: "", items: ["A", "B"] },
      // 「这个键写了但没值」是作者的事实，卡片要能把它跟「没这个键」区分开。
      { key: "empty", kind: "list", text: "", items: [] }
    ]);
  });

  it("引号里的冒号不拆分，值整体保留", () => {
    const outcome = extract('---\ntitle: "带引号: 冒号"\n---\n\nx\n');
    expect(outcome.metadata.properties[0]).toEqual({
      key: "title",
      kind: "text",
      text: "带引号: 冒号"
    });
  });

  it("超过上限只截名单并给一条 info 诊断，正文不受影响", () => {
    const keys = Array.from({ length: FRONTMATTER_PROPERTY_LIMIT + 5 }, (_unused, index) =>
      `k${index}: ${index}`
    );
    const outcome = extract(`---\n${keys.join("\n")}\n---\n\n# 正文\n`);
    expect(outcome.metadata.properties).toHaveLength(FRONTMATTER_PROPERTY_LIMIT);
    expect(outcome.body).toBe("\n# 正文\n");
    // 只报一条：逐键刷屏会让人以为出了 5 个不同的问题。
    const truncated = outcome.diagnostics.filter(
      (item) => item.code === RENDER_DIAGNOSTIC_CODES.FRONTMATTER_INVALID
    );
    expect(truncated).toHaveLength(1);
    expect(truncated[0]?.message).toContain(String(FRONTMATTER_PROPERTY_LIMIT));
  });

  it("非法行跳过，其余键照常进名单（§14.3 不影响整篇）", () => {
    const outcome = extract("---\ntitle: T\n这不是键值对\ndraft: false\n---\n\nx\n");
    expect(outcome.metadata.properties.map((item) => item.key)).toEqual(["title", "draft"]);
    expect(outcome.metadata.properties[1]).toEqual({
      key: "draft",
      kind: "boolean",
      text: "false"
    });
  });
});
