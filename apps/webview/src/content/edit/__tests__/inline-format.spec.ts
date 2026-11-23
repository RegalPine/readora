/**
 * 行内格式化动作层取证（ARC-009 §6.3，E3）。
 *
 * 这一层是纯字符串，所以本文件**不需要 DOM**：所有断言都在问同一句话
 * 「写回去的那一行会不会是损坏的 Markdown」。四类最容易写坏的形状各有用例：
 * 跨行（列表两项之间不能出现孤立 `**`）、空行段（两行引用之间那条 `>` 不能变成
 * `**`）、形态 B（`- ` / `> ` 之后才是插入点）、代码段内（`**` 进去就是字面噪声）。
 *
 * 幂等（同一选区连按两次回到原串）是这里最强的整体判据：它同时约束了包裹与
 * 解包的对称性，四类区块各一条。
 */
import { describe, expect, test } from "vitest";
import { composeNewText, parseBlockSource } from "../source-text";
import {
  applyInlineAction,
  detectWrap,
  insideCodeSpan,
  nextFootnoteLabel,
  withHeadingLevel,
  type InlineInput
} from "../inline-format";

function run(input: Partial<InlineInput> & Pick<InlineInput, "action" | "text">) {
  return applyInlineAction({
    from: 0,
    to: input.text.length,
    type: "paragraph",
    mode: "text",
    ...input
  } as InlineInput);
}

/** applied 支的下标访问；不是 applied 就是断言失败，不让分支静默。 */
function applied(result: ReturnType<typeof run>) {
  if (result.kind !== "applied") {
    throw new Error(`expected applied, got ${result.kind}`);
  }
  return result;
}

describe("包裹与解包幂等（四类区块各一条）", () => {
  const CASES: Array<{ label: string; text: string; from: number; to: number; wrapped: string }> = [
    {
      label: "paragraph",
      text: "Alpha paragraph one.",
      from: 6,
      to: 15,
      wrapped: "Alpha **paragraph** one."
    },
    { label: "heading", text: "Section two", from: 0, to: 12, wrapped: "**Section two**" },
    {
      label: "blockquote",
      text: "quote line one\n\nquote line two",
      from: 0,
      to: 14,
      wrapped: "**quote line one**\n\nquote line two"
    },
    {
      label: "list",
      text: "first item\nsecond item",
      from: 0,
      to: 10,
      wrapped: "**first item**\nsecond item"
    }
  ];

  for (const entry of CASES) {
    test(`${entry.label}：包上再点一次回到原串`, () => {
      const once = applied(run({ action: "bold", text: entry.text, from: entry.from, to: entry.to }));
      expect(once.text).toBe(entry.wrapped);
      const twice = applied(
        run({ action: "bold", text: once.text, from: once.from, to: once.to })
      );
      expect(twice.text).toBe(entry.text);
      // 解包后的新选区回到「正文那一段」，于是第三次点又是包裹 —— 循环闭合。
      expect(run({ action: "bold", text: twice.text, from: twice.from, to: twice.to })).toEqual(once);
    });
  }

  test("四种标记各自的字面量", () => {
    expect(applied(run({ action: "bold", text: "ab", from: 0, to: 2 })).text).toBe("**ab**");
    expect(applied(run({ action: "italic", text: "ab", from: 0, to: 2 })).text).toBe("*ab*");
    expect(applied(run({ action: "strike", text: "ab", from: 0, to: 2 })).text).toBe("~~ab~~");
    expect(applied(run({ action: "code", text: "ab", from: 0, to: 2 })).text).toBe("`ab`");
  });

  test("选中 `**foo**` 里的 foo（标记在外侧）→ 解包而不是再包一层", () => {
    const result = applied(run({ action: "bold", text: "**foo**", from: 2, to: 5 }));
    expect(result.text).toBe("foo");
    expect(result.from).toBe(0);
    expect(result.to).toBe(3);
  });

  test("部分重叠不硬拆：只包不拆（拆一半会留下孤立的 `**`）", () => {
    // 选区从 `**foo**` 的中间伸出去：两边都不是「正好那一对」，于是走 wrap。
    // 字面量不好看（`****` 连写），但这是决策的既定取舍：不猜别人的标记边界。
    // 同一口径登记在 README 的已知限制（选区内含未转义 `*` 时渲染可能与直觉不同）。
    const result = applied(run({ action: "bold", text: "a**foo**b", from: 0, to: 3 }));
    expect(result.text).toBe("**a****foo**b");
  });
});

describe("跨行选区一律逐行包裹（决策 2）", () => {
  test("列表两项之间被选中：每行各包一对，不出现跨行的孤立 `**`", () => {
    const result = applied(
      run({ action: "bold", text: "first item\nsecond item", from: 0, to: 22 })
    );
    expect(result.text).toBe("**first item**\n**second item**");
    expect(result.multiline).toBe(true);
    // 关键判据：任何一行都不成对即为损坏
    for (const line of result.text.split("\n")) {
      expect(line.split("**").length - 1).toBe(2);
    }
  });

  test("选区只盖住每行的一部分时，也按行各自的边界包", () => {
    const result = applied(
      run({ action: "bold", text: "first item\nsecond item", from: 6, to: 17 })
    );
    expect(result.text).toBe("first **item**\n**second** item");
  });

  test("跨段落软换行同样逐行包", () => {
    const result = applied(run({ action: "bold", text: "一\n二\n三", from: 0, to: 5 }));
    expect(result.text).toBe("**一**\n**二**\n**三**");
  });

  test("空行段跳过：中间那行只有一个空格时不被包成 `**`", () => {
    const result = applied(run({ action: "bold", text: "一\n \n三", from: 0, to: 5 }));
    expect(result.text).toBe("**一**\n \n**三**");
  });

  test("两段引用之间那条真正的空行也不会被包", () => {
    const result = applied(
      run({ action: "bold", text: "quote line one\n\nquote line two", from: 0, to: 30 })
    );
    expect(result.text).toBe("**quote line one**\n\n**quote line two**");
    expect(result.text.split("\n")[1]).toBe("");
  });

  test("只选中一个换行符 → blocked（夹完长度 0 就什么都不做）", () => {
    expect(run({ action: "bold", text: "甲\n乙", from: 1, to: 2 }).kind).toBe("blocked");
  });

  test("整行首尾各留一个字符时不算跨行（multiline=false）", () => {
    const result = applied(run({ action: "bold", text: "abcd\nefgh", from: 0, to: 4 }));
    expect(result.multiline).toBe(false);
    expect(result.text).toBe("**abcd**\nefgh");
  });
});

describe("形态 B：插入点在行首 marker 之后", () => {
  test("列表两行：`- ` 之后才是 `**`，marker 本身一个字节不动", () => {
    const result = applied(
      run({
        action: "bold",
        text: "- first item\n- second item",
        type: "list",
        mode: "source"
      })
    );
    expect(result.text).toBe("- **first item**\n- **second item**");
  });

  test("引用行 `>` 无空格、有序 `10)`、缩进列表 —— marker 长度全取 markerLengthOf", () => {
    const quote = applied(
      run({ action: "bold", text: ">旧内容", from: 0, to: 4, type: "blockquote", mode: "source" })
    );
    expect(quote.text).toBe(">**旧内容**");
    const ordered = applied(
      run({ action: "bold", text: "10) 甲", from: 0, to: 6, type: "list", mode: "source" })
    );
    expect(ordered.text).toBe("10) **甲**");
    const nested = applied(
      run({ action: "bold", text: "  - 缩进项", from: 0, to: 7, type: "list", mode: "source" })
    );
    expect(nested.text).toBe("  - **缩进项**");
  });

  test("setext 标题解析不出 ATX marker → 退到行首插入，不猜", () => {
    const result = applied(
      run({ action: "bold", text: "标题\n====", from: 0, to: 2, type: "heading", mode: "source" })
    );
    expect(result.text).toBe("**标题**\n====");
  });

  test("形态 B 的解包不会把行首 `- ` 当成 open 拆掉", () => {
    const result = applied(
      run({
        action: "bold",
        text: "- **foo** bar",
        from: 4,
        to: 7,
        type: "list",
        mode: "source"
      })
    );
    expect(result.text).toBe("- foo bar");
  });
});

describe("代码段内屏蔽（决策 2 第 4 条 / §6.3）", () => {
  test("bold / italic / strike / link 落在 code span 内一律 blocked", () => {
    const text = "see `a b` here";
    const from = 5;
    const to = 8;
    for (const action of ["bold", "italic", "strike"] as const) {
      expect(run({ action, text, from, to })).toEqual({ kind: "blocked", reason: "inside-code" });
    }
    expect(run({ action: "link", text, from, to, url: "https://example.com" })).toEqual({
      kind: "blocked",
      reason: "inside-code"
    });
  });

  test("code 按钮自己走解包，但嵌套反引号仍 blocked", () => {
    expect(applied(run({ action: "code", text: "see `a b` here", from: 5, to: 8 })).text).toBe(
      "see a b here"
    );
    expect(run({ action: "code", text: "see `a b` here", from: 5, to: 6 })).toEqual({
      kind: "blocked",
      reason: "inside-code"
    });
  });

  test("insideCodeSpan：奇偶判定、转义反引号不计数、从行首起算", () => {
    const text = "`x` and `z";
    expect(insideCodeSpan(text, 0, 0)).toBe(false);
    expect(insideCodeSpan(text, 0, 1)).toBe(true);
    expect(insideCodeSpan(text, 0, 3)).toBe(false);
    expect(insideCodeSpan(text, 0, 10)).toBe(true);
    // 反斜线转义的那个反引号不计数
    expect(insideCodeSpan("a\\`b", 0, 4)).toBe(false);
    // 从行首起算：上一行的反引号不算到本行
    expect(insideCodeSpan("`甲\n乙", 0, 1)).toBe(true);
    expect(insideCodeSpan("`甲\n乙", 2, 3)).toBe(false);
  });

  test("detectWrap 只回答要不要包，不回答拆哪一对", () => {
    expect(detectWrap("**foo**", 2, 5, "**")).toBe("unwrap");
    expect(detectWrap("**foo**", 0, 7, "**")).toBe("unwrap");
    expect(detectWrap("**foo", 2, 5, "**")).toBe("wrap");
    expect(detectWrap("foo", 0, 3, "**")).toBe("wrap");
  });
});

describe("链接", () => {
  test("包成 `[词](url)`，新选区覆盖整个链接", () => {
    const result = applied(
      run({ action: "link", text: "see docs now", from: 4, to: 8, url: "https://example.com" })
    );
    expect(result.text).toBe("see [docs](https://example.com) now");
    expect(result.text.slice(result.from, result.to)).toBe("[docs](https://example.com)");
  });

  test("整段已经是链接 → 解包回文字", () => {
    const result = applied(
      run({ action: "link", text: "[docs](https://example.com)", url: "https://other.test" })
    );
    expect(result.text).toBe("docs");
  });

  test("URL 空白 → blocked（不写出 `[...]()`）", () => {
    expect(run({ action: "link", text: "docs", from: 0, to: 4, url: "  " })).toEqual({
      kind: "blocked",
      reason: "empty"
    });
    expect(run({ action: "link", text: "docs", from: 0, to: 4 })).toEqual({ kind: "blocked", reason: "empty" });
  });

  test("跨行链接逐个包，每行都是合法链接语法", () => {
    const result = applied(
      run({ action: "link", text: "一\n二", from: 0, to: 3, url: "https://a.test" })
    );
    expect(result.text).toBe("[一](https://a.test)\n[二](https://a.test)");
  });
});

describe("脚注引用（决策 6：只插引用，不写定义行）", () => {
  test("无标签时取 1；已有 `[^3]` 时取 4；命名标签不参与取号", () => {
    expect(nextFootnoteLabel("普通文档")).toBe("1");
    expect(nextFootnoteLabel("甲[^1] 乙\n\n[^1]: 定义")).toBe("2");
    expect(nextFootnoteLabel("甲[^3] 乙 [^12] 丙")).toBe("13");
    expect(nextFootnoteLabel("甲[^note] 乙")).toBe("1");
  });

  test("光标处插入：不新增行，选区落在插入的引用上", () => {
    const result = applied(run({ action: "footnote", text: "一句引文", from: 4, to: 4 }));
    expect(result.text).toBe("一句引文[^1]");
    expect(result.text.split("\n").length).toBe(1);
  });

  test("有选区时接在选区末尾（选中「词」→「词[^n]」）", () => {
    const result = applied(
      run({
        action: "footnote",
        text: "一句引文 with 词",
        from: 13,
        to: 14,
        documentText: "前文[^2] 与 [^2]: 定义"
      })
    );
    expect(result.text).toBe("一句引文 with 词[^3]");
  });

  test("降级端点也算得出锚：from 为 null 时用 to", () => {
    const result = applyInlineAction({
      action: "footnote",
      text: "abc",
      from: null,
      to: 1,
      type: "paragraph",
      mode: "text"
    });
    expect(result.kind).toBe("applied");
  });
});

describe("降级三态（§6.3）", () => {
  test("一端映射不出来 → 只在能映射的那端插成对标记，光标落在中间", () => {
    const result = applyInlineAction({
      action: "bold",
      text: "Alpha paragraph one.",
      from: null,
      to: 15,
      type: "paragraph",
      mode: "text"
    });
    if (result.kind !== "degraded") {
      throw new Error(`expected degraded, got ${result.kind}`);
    }
    expect(result.text).toBe("Alpha paragraph**** one.");
    expect(result.caret).toBe(17);
    // 「不动结构」在这条断言里：长度只增加了两个标记
    expect(result.text.length).toBe("Alpha paragraph one.".length + 4);
  });

  test("空选区同样走降级（光标处插一对）", () => {
    const result = applyInlineAction({
      action: "code",
      text: "ab",
      from: 1,
      to: 1,
      type: "paragraph",
      mode: "text"
    });
    expect(result.kind).toBe("degraded");
  });

  test("两端都映射不出来 → blocked empty", () => {
    expect(
      applyInlineAction({
        action: "bold",
        text: "ab",
        from: null,
        to: null,
        type: "paragraph",
        mode: "text"
      })
    ).toEqual({ kind: "blocked", reason: "empty" });
  });

  test("选区越界一律夹到单元内，不抛错也不写飞", () => {
    const result = applied(run({ action: "bold", text: "ab", from: -10, to: 99 }));
    expect(result.text).toBe("**ab**");
  });
});

describe("withHeadingLevel（决策 5 的形态 A 支路）", () => {
  test("换级别只动 `#` 的个数，空白组与缩进原样", () => {
    expect(withHeadingLevel("## ", 3)).toBe("### ");
    expect(withHeadingLevel("###  ", 2)).toBe("##  ");
    expect(withHeadingLevel("   # ", 6)).toBe("   ###### ");
    expect(withHeadingLevel("#\t", 4)).toBe("####\t");
  });

  test("解析不出 ATX marker 就返回 null：setext、`#` 后无空格、空串", () => {
    expect(withHeadingLevel("", 2)).toBeNull();
    expect(withHeadingLevel("====", 2)).toBeNull();
    expect(withHeadingLevel("#Title", 2)).toBeNull();
    expect(withHeadingLevel("#######", 2)).toBeNull();
  });

  test("形态 A 改级别只改 markers[0]：文本一个字符都不动", () => {
    const parsed = parseBlockSource("## Section two", "heading");
    const marker = withHeadingLevel(parsed.markers[0] as string, 3);
    expect(marker).toBe("### ");
    const rewritten = composeNewText(parsed.lines.join("\n"), {
      ...parsed,
      markers: [marker as string]
    });
    expect(rewritten).toBe("### Section two");
  });
});

describe("与 composeNewText 的接缝（形态 A 提交出去的字节）", () => {
  test("引用块里包裹一个词：补回 `> ` 之后是 `> **词**`", () => {
    const source = "> quote line one";
    const parsed = parseBlockSource(source, "blockquote");
    expect(parsed.lines.join("\n")).toBe("quote line one");
    const result = applied(
      run({ action: "bold", text: parsed.lines.join("\n"), from: 0, to: 5, type: "blockquote" })
    );
    expect(composeNewText(result.text, parsed)).toBe("> **quote** line one");
  });

  test("跨两行包裹一个有序列表：两行各自成对，编号不被改写", () => {
    const source = "3. 甲\n4. 乙";
    const parsed = parseBlockSource(source, "list");
    const result = applied(
      run({ action: "bold", text: parsed.lines.join("\n"), from: 0, to: 3, type: "list" })
    );
    expect(result.text).toBe("**甲**\n**乙**");
    expect(composeNewText(result.text, parsed)).toBe("3. **甲**\n4. **乙**");
  });
});
