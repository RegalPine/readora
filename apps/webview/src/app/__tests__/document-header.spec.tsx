/**
 * Frontmatter 属性卡片测试（PRD-003 §4.6 / IMP-002 STORY-06-02）。
 *
 * 卡片是 M6 新增的唯一「把作者写下的键值摊开给人看」的地方，因此两条验收
 * 必须在这里被锁住，而不是只锁在 markdown-core 的提取层：
 * 1. **不执行任何脚本或表达式** —— `{{7*7}}`、`=1+1`、`new Date()` 都只按字面量显示；
 * 2. **按类型排版** —— 五种 kind 各有可断言的 DOM 形态，取值仍是原文。
 *
 * 数据来源刻意走真实的 `renderMarkdown`：卡片读的就是 markdown-core 交出的
 * properties 名单，这里不手搓一份「测试专用 metadata」，否则上游改了分类
 * 而卡片用例仍绿，就是两个口径。
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { renderMarkdown } from "@readora/markdown-core";
import { DocumentHeader } from "../DocumentHeader";

function cardOf(source: string) {
  const result = renderMarkdown({
    documentId: "doc-header",
    documentUri: "file:///vault/note.md",
    version: 1,
    text: source
  });
  const view = render(
    <DocumentHeader
      title={result.metadata.title ?? "note.md"}
      fileName="note.md"
      properties={result.metadata.properties}
    />
  );
  return { view, properties: result.metadata.properties };
}

function rows(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(".readora-property-row")];
}

function rowOf(container: HTMLElement, key: string): HTMLElement {
  const row = rows(container).find((item) => item.querySelector("th")?.textContent === key);
  if (!row) {
    throw new Error(`property row ${key} missing; got ${rows(container).length} rows`);
  }
  return row;
}

afterEach(() => {
  cleanup();
});

describe("按类型排版", () => {
  const SOURCE = [
    "---",
    "title: 阅读笔记",
    "draft: true",
    "words: 842",
    "created: 2024-05-01",
    "tags: [阅读, markdown]",
    "---",
    "",
    "# 正文",
    ""
  ].join("\n");

  it("五种类型都拿到自己的 kind 标记，顺序与源码一致", () => {
    const { view } = cardOf(SOURCE);
    const container = view.container;
    expect(rows(container).map((row) => row.dataset.readoraPropertyType)).toEqual([
      "text",
      "boolean",
      "number",
      "date",
      "list"
    ]);
  });

  it("文本与布尔都是原文；数字带等宽类名；日期带 <time> 且 dateTime 等于原文", () => {
    const { view } = cardOf(SOURCE);
    const container = view.container;

    expect(rowOf(container, "title").querySelector("td")?.textContent).toBe("阅读笔记");
    expect(rowOf(container, "draft").querySelector("td")?.textContent).toBe("true");

    const number = rowOf(container, "words").querySelector("td");
    expect(number?.textContent).toBe("842");
    expect(number?.querySelector(".readora-property-number")).not.toBeNull();

    // 不格式化、不换算时区：卡片上的日期就是作者打的那几个字符。
    const time = rowOf(container, "created").querySelector("time");
    expect(time?.getAttribute("dateTime")).toBe("2024-05-01");
    expect(time?.textContent).toBe("2024-05-01");

    const list = rowOf(container, "tags").querySelector("ul");
    expect(list?.querySelectorAll("li")).toHaveLength(2);
    expect(list?.textContent).toBe("阅读markdown");
  });

  it("行标题用 th scope=row，卡片是可命名 landmark", () => {
    const { view } = cardOf(SOURCE);
    const heading = view.container.querySelector('[aria-label="Document properties"]');
    expect(heading).not.toBeNull();
    const first = rows(view.container)[0];
    const th = first?.querySelector("th");
    expect(th?.getAttribute("scope")).toBe("row");
    expect(th?.textContent).toBe("title");
    // caption 只给读屏器：数目写在这里，不让视觉层多一行小字。
    expect(heading?.querySelector("caption")?.textContent).toBe("5 frontmatter properties");
  });

  it("空列表显示「没有条目」而不是留白", () => {
    const { view } = cardOf("---\naliases: []\n---\n\n正文\n");
    const cell = rowOf(view.container, "aliases").querySelector("td");
    expect(cell?.querySelector("[data-readora-property-state=\"empty\"]")).not.toBeNull();
    expect(cell?.textContent).toBe("No entries");
  });

  it("键名保留大小写：Title 与 title 是两个键", () => {
    const { view } = cardOf("---\nTitle: 甲\ntitle: 乙\n---\n\n正文\n");
    const keys = rows(view.container).map((row) => row.querySelector("th")?.textContent);
    // 归一化槽位只认 title（大小写不敏感），名单却是原样 —— 两者各有口径。
    expect(keys).toEqual(["Title", "title"]);
  });
});

describe("不执行任何脚本或表达式（STORY-06-02 验收线）", () => {
  it("模板表达式、公式、构造调用都按字面量显示，且产物里没有可执行元素", () => {
    const { view } = cardOf(
      [
        "---",
        "calc: {{7*7}}",
        "formula: =1+1",
        "ctor: new Date(0)",
        "js: '<img src=x onerror=alert(1)>'",
        "---",
        "",
        "# 正文",
        ""
      ].join("\n")
    );
    const container = view.container;

    // 求值结果一个都不许出现：这是「不执行」最直接的证伪方式。
    expect(container.textContent).not.toContain("49");
    expect(container.textContent).not.toContain("1970");
    expect(container.querySelectorAll("script, iframe, object, embed")).toHaveLength(0);
    expect(container.querySelectorAll("[onerror], [onclick], [onload]")).toHaveLength(0);

    expect(rowOf(container, "calc").querySelector("td")?.textContent).toBe("{{7*7}}");
    expect(rowOf(container, "formula").querySelector("td")?.textContent).toBe("=1+1");
    expect(rowOf(container, "ctor").querySelector("td")?.textContent).toBe("new Date(0)");
    // 带引号的字符串值：脱引号后仍是纯文本，`<img` 不会变成元素。
    expect(rowOf(container, "js").querySelector("td")?.textContent).toContain("<img");
    expect(container.querySelectorAll("img")).toHaveLength(0);
  });

  it("日期只承认真实存在的日子：闰年 02-29 挂 <time>，平年与 02-30 不挂", () => {
    // 这一条原本想用 Date.parse 实现，实测把 2024-02-30 也认成了日期（V8 的
    // legacy 回退会把它进位成 3 月 1 日）—— 所以判据换成「UTC 组装后回读分量」。
    const leap = cardOf("---\nok: 2024-02-29\n---\n\n正文\n");
    expect(rowOf(leap.view.container, "ok").querySelector("time")).not.toBeNull();

    const plain = cardOf("---\nbad: 2023-02-29\nworse: 2024-02-30\n---\n\n正文\n");
    expect(rowOf(plain.view.container, "bad").querySelector("time")).toBeNull();
    expect(rowOf(plain.view.container, "worse").querySelector("time")).toBeNull();
    // 不挂 <time> 不等于删掉内容：字面量仍按原样可见。
    expect(rowOf(plain.view.container, "worse").querySelector("td")?.textContent).toBe(
      "2024-02-30"
    );
  });

  it("没有 Frontmatter 时整张卡不出现，正文一个字不丢（§14.3）", () => {
    const { view, properties } = cardOf("# 只有正文\n");
    expect(properties).toEqual([]);
    expect(view.container.querySelector('[aria-label="Document properties"]')).toBeNull();
    expect(view.container.querySelector(".readora-document-title")?.textContent).toBe("note.md");
  });

  it("未闭合的 Frontmatter 不产出半个卡片：名单为空即不显示", () => {
    // 提取层把整块退回正文（info 诊断），卡片这边只有一条规则：名单空 → 不出现。
    const { view } = cardOf("---\ntitle: 未闭合\n");
    expect(view.container.querySelector('[aria-label="Document properties"]')).toBeNull();
  });

  it("单数 caption 与多键并存时措辞随数量变", () => {
    const single = cardOf("---\nowner: 某人\n---\n\n正文\n");
    expect(single.view.container.querySelector("caption")?.textContent).toBe(
      "1 frontmatter property"
    );
  });
});
