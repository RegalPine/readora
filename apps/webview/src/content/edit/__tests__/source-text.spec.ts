/**
 * 源文本换算层取证（ARC-009 §6.1 / §6.2 / §9.1，E2 · STORY-13-03 前半）。
 *
 * 本文件要钉住三件事，它们全是「写坏文件」与「不写坏文件」的分界：
 * 1. **认领表**：只有顶层的 paragraph / heading / blockquote / list 参与编辑，
 *    表格 / 代码 / 图表 / 公式 / `hr` 一律 `null`（§15-5 的「按钮不该出现」在这一层取证）；
 * 2. **判据双向清单**：等号成立才允许改字（形态 A），不成立必须回落改源（形态 B）。
 *    清单里的每一条都拿**真实渲染产物**去比，不手写 DOM —— 判据的正确性依赖
 *    渲染器今天怎么输出（软换行留在文本节点里、任务标记是一个 span…），
 *    手写 DOM 会把那些依赖伪装成约定；
 * 3. **marker 复用**：形态 A 提交出去的字节 = 原文件按行替换、其余行逐字符不变。
 *    这一条用纯字符串证明（§15-3），不需要 DOM、不需要桥。
 *
 * 判据是实测出来的，不是预测出来的：ARC-009 §16.5 记了本轮推翻的一条口径
 * （`>无空格` 走形态 A 而不是回落），见下面那条用例的注释。
 */
import { describe, expect, test } from "vitest";
import { SOURCE_RANGE_ATTRIBUTE, renderMarkdown } from "@readora/markdown-core";
import {
  blockTypeOf,
  composeNewText,
  editModeFor,
  isFileSchemeUri,
  markerLengthOf,
  parseBlockSource,
  parseRangeKey,
  renderedTextOf,
  sliceBlockSource,
  type EditBlockType
} from "../source-text";

const DOC_URI = "file:///vault/notes/doc.md";

/** 真跑一遍渲染管线，把产物摊进一个游离容器（不进 document，避免污染别的用例）。 */
function hostOf(text: string): HTMLElement {
  const result = renderMarkdown({
    documentId: DOC_URI,
    documentUri: DOC_URI,
    version: 1,
    text,
    theme: "light"
  });
  const host = document.createElement("div");
  host.innerHTML = result.html;
  return host;
}

interface Measured {
  block: HTMLElement;
  type: EditBlockType;
  rangeKey: string;
  source: string;
  mode: "text" | "source";
}

/** 取第 index 个顶层区块，按接管层同一条路径把「类型 / 源 / 形态」算出来。 */
function measure(text: string, index = 0): Measured {
  const host = hostOf(text);
  const block = host.children[index] as HTMLElement | undefined;
  if (!block) {
    throw new Error(`block ${index} missing`);
  }
  const type = blockTypeOf(block);
  const rangeKey = block.getAttribute(SOURCE_RANGE_ATTRIBUTE);
  if (!type || rangeKey === null) {
    throw new Error(`block ${index} is not claimed (${block.tagName})`);
  }
  const source = sliceBlockSource(text, rangeKey);
  if (source === null) {
    throw new Error(`source slice missing for ${rangeKey}`);
  }
  return { block, type, rangeKey, source, mode: editModeFor(source, type, block) };
}

describe("认领表（§6.1）", () => {
  const MIXED = [
    "# 标题",
    "",
    "一个段落。",
    "",
    "> 引用",
    "",
    "- 列表项",
    "",
    "| a | b |",
    "| - | - |",
    "| 1 | 2 |",
    "",
    "```js",
    "let a = 1",
    "```",
    "",
    "---",
    "",
    "$$\n\\frac{1}{2}\n$$"
  ].join("\n");

  test("四类顶层区块被认领，类型取自标签名 + class", () => {
    const host = hostOf(MIXED);
    const claimed = Array.from(host.children).map((block) => [
      block.tagName,
      blockTypeOf(block)
    ]);
    expect(claimed[0]).toEqual(["H1", "heading"]);
    expect(claimed[1]).toEqual(["P", "paragraph"]);
    expect(claimed[2]).toEqual(["BLOCKQUOTE", "blockquote"]);
    expect(claimed[3]).toEqual(["UL", "list"]);
  });

  test("表格 / 代码 / 分隔线 / 公式一律不认领（§15-5）", () => {
    const host = hostOf(MIXED);
    const unclaimed = Array.from(host.children)
      .slice(4)
      .map((block) => `${block.tagName}:${blockTypeOf(block) ?? "null"}`);
    expect(unclaimed.every((entry) => entry.endsWith(":null"))).toBe(true);
  });

  test("嵌套的同类型区块不算认领对象：只认顶层那一层", () => {
    const host = hostOf("> 段落\n>\n> - 项\n");
    const inner = host.querySelector(".readora-paragraph") as HTMLElement;
    // 它自己是 .readora-paragraph，但父节点不是正文容器 —— 接管层按 parentElement 挡掉。
    expect(blockTypeOf(inner)).toBe("paragraph");
    expect(inner.parentElement).not.toBe(host);
  });
});

describe("parseRangeKey / sliceBlockSource（与 E0 同口径）", () => {
  test("形状合法才解析：0 基闭区间，倒挂与非数字直接作废", () => {
    expect(parseRangeKey("0:0")).toEqual({ startLine: 0, endLine: 0 });
    expect(parseRangeKey("3:5")).toEqual({ startLine: 3, endLine: 5 });
    expect(parseRangeKey("5:3")).toBeNull();
    expect(parseRangeKey("3")).toBeNull();
    expect(parseRangeKey("a:b")).toBeNull();
    expect(parseRangeKey("")).toBeNull();
  });

  test("按行区间切片，endLine 已含在内、不多吃尾随空行", () => {
    const text = "零\n一\n二\n三\n";
    expect(sliceBlockSource(text, "1:2")).toBe("一\n二");
    expect(sliceBlockSource(text, "0:0")).toBe("零");
    // 越界不猜：宁可不给编辑入口，也不能切出一段错位的源。
    expect(sliceBlockSource(text, "3:9")).toBeNull();
  });

  test("CRLF 文档切出来的行尾带 \\r，交给 parseBlockSource 归进 marker", () => {
    expect(sliceBlockSource("一\r\n二\r\n", "0:1")).toBe("一\r\n二\r");
  });
});

describe("parseBlockSource：逐行剥前缀，前缀原串进 markers", () => {
  test("段落不剥行首空白（缩进是内容的一部分）", () => {
    const parsed = parseBlockSource("普通\n第二行", "paragraph");
    expect(parsed.lines).toEqual(["普通", "第二行"]);
    expect(parsed.markers).toEqual(["", ""]);
    expect(parsed.orderedStart).toBeNull();
  });

  test("ATX 标题保留 # 与其后的空白原样", () => {
    expect(parseBlockSource("## 标题", "heading").markers).toEqual(["## "]);
    expect(parseBlockSource("###  两个空格", "heading").markers).toEqual(["###  "]);
    // setext 的 `====` 不是前缀，剥不掉 —— 于是它注定落形态 B（见回落清单）。
    expect(parseBlockSource("标题\n====", "heading").markers).toEqual(["", ""]);
  });

  test("引用前缀认 `> ` 也认 `>`，只有 `>` 的分行算空内容行", () => {
    const parsed = parseBlockSource("> 段一\n>\n>段二", "blockquote");
    expect(parsed.lines).toEqual(["段一", "", "段二"]);
    expect(parsed.markers).toEqual(["> ", ">", ">"]);
  });

  test("列表 marker 含缩进与 `1)` 这种形状，有序首行数字进 orderedStart", () => {
    const ul = parseBlockSource("- 一\n* 二\n  + 三", "list");
    expect(ul.markers).toEqual(["- ", "* ", "  + "]);
    const ol = parseBlockSource("3. 甲\n4. 乙", "list");
    expect(ol.lines).toEqual(["甲", "乙"]);
    expect(ol.orderedStart).toBe(3);
    expect(parseBlockSource("1) 甲", "list").markers).toEqual(["1) "]);
  });

  test("CRLF 的 `\\r` 不进 lines、也不掺进 marker，另记一个 crlf", () => {
    const parsed = parseBlockSource("1. 甲\r\n2. 乙\r", "list");
    // 判据两边都不带 `\r`（渲染器的输入已被 CommonMark 归一化成 `\n`）。
    expect(parsed.lines).toEqual(["甲", "乙"]);
    expect(parsed.markers).toEqual(["1. ", "2. "]);
    expect(parsed.crlf).toBe(true);
    expect(parseBlockSource("一", "paragraph").crlf).toBe(false);
  });
});

describe("判据清单 · 形态 A（改字，提交补前缀）", () => {
  const CASES: Array<[string, string]> = [
    ["纯文本段落", "纯文本段落。\n"],
    ["多行段落（软换行留在文本节点里）", "第一行\n第二行\n"],
    ["ATX 标题", "## 二级标题\n"],
    ["`###` 后两个空格", "###  两个空格\n"],
    ["单段引用（`> ` 有空格）", "> 引用一行\n"],
    ["多段引用（`>` 空行分段）", "> 段一\n>\n> 段二\n"],
    ["tight 无序列表", "- 一\n- 二\n"],
    ["tight 有序列表", "1. 甲\n2. 乙\n"],
    ["CRLF 段落", "纯文本段落。\r\n"]
  ];

  for (const [label, text] of CASES) {
    test(label, () => {
      const measured = measure(text);
      expect(measured.mode).toBe("text");
      // 形态 A 的初值就是渲染文本，且判据等式两边逐字符相等。
      expect(renderedTextOf(measured.block, measured.type)).toBe(
        parseBlockSource(measured.source, measured.type).lines.join("\n")
      );
    });
  }

  test("`>` 无空格的引用同样走形态 A —— 本轮推翻的口径", () => {
    // 立项口径（ARC-009 §6.2 的预测）把它列进「天然回落形态 B」的清单，实测不成立：
    // marker 判据 `>\s?` 把 `>` 整串原样收进 markers，lines 里剩下的就是渲染看到的那几个字。
    // 没有信息丢失就没有回落的理由 —— 硬把它推到形态 B 反而让用户多改一个 `>`。
    // 这条差异记进 ARC-009 §16.5，代码里不为此加特判分支。
    expect(measure(">无空格的引用\n").mode).toBe("text");
  });
});

describe("判据清单 · 回落形态 B（改源，提交原样写回）", () => {
  const CASES: Array<[string, string]> = [
    ["行内标记 **粗**", "普通 **粗** 文本\n"],
    ["行内标记 *斜*", "普通 *斜* 文本\n"],
    ["反斜杠转义 \\*", "字面 \\* 星号\n"],
    ["setext 标题", "标题\n====\n"],
    ["任务列表（textContent 混进 ☐）", "- [x] 已完成\n- [ ] 未完成\n"],
    ["嵌套列表", "- 一\n  - 嵌套\n"],
    ["loose 列表（项间空行）", "- 一\n\n- 二\n"],
    ["行内链接", "看 [文字](https://example.com) 这里\n"],
    ["行内代码", "用 `code` 表示\n"],
    ["行内图片", "看 ![图](./a.png) 这里\n"],
    ["行首缩进的段落（CommonMark 已剥）", "  缩进段落\n"],
    ["硬换行（两个尾随空格）", "换行  \n第二行\n"],
    ["引用里嵌列表", "> 段落\n>\n> - 列表项\n"]
  ];

  for (const [label, text] of CASES) {
    test(label, () => {
      const measured = measure(text);
      expect(measured.mode).toBe("source");
      // 回落必须是「渲染抹掉了东西」，不是判据写错：两边确实不等。
      expect(renderedTextOf(measured.block, measured.type)).not.toBe(
        parseBlockSource(measured.source, measured.type).lines.join("\n")
      );
    });
  }
});

describe("读回 DOM 时的浏览器写法还原（写回不得带不可见字符）", () => {
  test("U+00A0 与 U+200B 换回普通写法：它们在 Markdown 里没有对应字节", () => {
    const block = document.createElement("p");
    block.append("甲", "\u00a0乙", "\u200b丙");
    expect(renderedTextOf(block, "paragraph")).toBe("甲 乙丙");
    // 列表分支同样过这道手（它读的是 li.textContent，不走 walkChildren）
    const list = document.createElement("ul");
    const item = document.createElement("li");
    item.append("一\u00a0二");
    list.appendChild(item);
    expect(renderedTextOf(list, "list")).toBe("一 二");
  });

  test("清空一个区块后那个占位 <br> 不算内容：读成空串而不是一个换行", () => {
    // 不特判就会把空区块写成一行的换行，§15-3 的「其余字节不变」当场被破。
    const emptied = document.createElement("p");
    emptied.appendChild(document.createElement("br"));
    expect(renderedTextOf(emptied, "paragraph")).toBe("");
    // 而中间的 <br> 仍是换行（硬换行与多行段落的判据靠它）
    const middle = document.createElement("p");
    middle.append("甲");
    middle.appendChild(document.createElement("br"));
    middle.append("乙");
    expect(renderedTextOf(middle, "paragraph")).toBe("甲\n乙");
  });
});

describe("composeNewText：marker 复用规则（§6.2）", () => {
  test("行数不变 → 第 i 行复用 markers[i] 原串，字面差异全部保留", () => {
    const src = parseBlockSource("- 一\n* 二\n  + 三", "list");
    expect(composeNewText("甲\n乙\n丙", src)).toBe("- 甲\n* 乙\n  + 丙");
  });

  test("行数变多 → 新增行复用最后一行的 marker", () => {
    const src = parseBlockSource("> 段一\n> 段二", "blockquote");
    expect(composeNewText("甲\n乙\n丙", src)).toBe("> 甲\n> 乙\n> 丙");
    const ul = parseBlockSource("  - 一", "list");
    expect(composeNewText("甲\n乙", ul)).toBe("  - 甲\n  - 乙");
  });

  test("行数变少时 marker 按**位置**复用，不按内容配对（已知代价）", () => {
    // 三段引用（第二段是 `>` 空行）被压成两行时，第二行拿到的是那个空行的 marker `>`，
    // 于是两段引用合成一段。规则本身是 §6.2 的「第 i 行复用 markers[i]」，
    // 这里把它拍成用例而不是留给运气：想「按段落语义重排 marker」就得反解析 DOM，
    // 那是 §9.4 禁止的事。README 的已知限制同条。
    const src = parseBlockSource("> 段一\n>\n> 段二", "blockquote");
    expect(composeNewText("改过\n再来一行", src)).toBe("> 改过\n>再来一行");
  });

  test("有序列表新增行续号，但**不重排**既有编号", () => {
    const src = parseBlockSource("3. 甲\n4. 乙", "list");
    // 第三行接 5（orderedStart + index），前两行的 `3.` / `4.` 一个字节都不动。
    expect(composeNewText("甲\n乙\n丙", src)).toBe("3. 甲\n4. 乙\n5. 丙");
  });

  test("行数变少 → 多余 marker 丢弃，不补空行", () => {
    const src = parseBlockSource("- 一\n- 二\n- 三", "list");
    expect(composeNewText("甲", src)).toBe("- 甲");
  });

  test("`>` 无空格的 marker 原样，CRLF 的回车补在行尾而不是行首", () => {
    expect(composeNewText("新内容", parseBlockSource(">旧内容", "blockquote"))).toBe(
      ">新内容"
    );
    expect(composeNewText("甲", parseBlockSource("一\r", "paragraph"))).toBe("甲\r");
    expect(composeNewText("甲\n乙", parseBlockSource("一\r\n二\r", "list"))).toBe(
      "甲\r\n乙\r"
    );
  });

  test("段落 marker 为空 → 补前缀这一步不引入任何缩进", () => {
    const src = parseBlockSource("第一行\n第二行", "paragraph");
    expect(composeNewText("改后", src)).toBe("改后");
  });
});

describe("形态 A 提交 = 原文件按行替换，其余行逐字符不变（§15-3）", () => {
  const FILE = [
    "# 章节",
    "",
    "缩进前的段落第一行",
    "段落第二行",
    "",
    "> 引用一",
    ">",
    "> 引用二",
    "",
    "1. 甲",
    "2. 乙",
    "",
    "结尾段落。"
  ].join("\n");

  test("改段落：只有那一行变了字节，其余行原样", () => {
    const measured = measure(FILE, 1);
    expect(measured.rangeKey).toBe("2:3");
    expect(measured.mode).toBe("text");
    const newText = composeNewText("改过的第一行\n段落第二行", parseBlockSource(measured.source, "paragraph"));
    const lines = FILE.split("\n");
    const { startLine, endLine } = parseRangeKey(measured.rangeKey) as {
      startLine: number;
      endLine: number;
    };
    const next = [
      ...lines.slice(0, startLine),
      ...newText.split("\n"),
      ...lines.slice(endLine + 1)
    ];
    // 未编辑的行逐条全等（不是「集合相同」，是同一个下标上同一个字符串）。
    expect(next.slice(0, startLine)).toEqual(lines.slice(0, startLine));
    expect(next.slice(next.length - (lines.length - endLine - 1))).toEqual(
      lines.slice(endLine + 1)
    );
    expect(next[0]).toBe("# 章节");
    expect(next[5]).toBe("> 引用一");
    expect(next[9]).toBe("1. 甲");
    expect(next[12]).toBe("结尾段落。");
  });

  test("列表末尾加一项：新行拿到续号，旧行一字未改", () => {
    const host = hostOf(FILE);
    const list = host.children[3] as HTMLElement;
    expect(list.tagName).toBe("OL");
    const rangeKey = list.getAttribute(SOURCE_RANGE_ATTRIBUTE) as string;
    expect(rangeKey).toBe("9:10");
    const source = sliceBlockSource(FILE, rangeKey) as string;
    const parsed = parseBlockSource(source, "list");
    expect(editModeFor(source, "list", list)).toBe("text");
    const newText = composeNewText(`${parsed.lines.join("\n")}\n丙`, parsed);
    expect(newText).toBe("1. 甲\n2. 乙\n3. 丙");
    const lines = FILE.split("\n");
    const next = [...lines.slice(0, 9), ...newText.split("\n"), ...lines.slice(11)];
    expect(next.join("\n")).toBe(
      FILE.replace("1. 甲\n2. 乙", "1. 甲\n2. 乙\n3. 丙")
    );
  });
});

describe("markerLengthOf（E3 逐行包裹的插入点）", () => {
  test("四类区块各自的前缀长度；段落恒为 0（行首空白是内容）", () => {
    expect(markerLengthOf("普通段落", "paragraph")).toBe(0);
    expect(markerLengthOf("  缩进段落", "paragraph")).toBe(0);
    expect(markerLengthOf("###  两个空格", "heading")).toBe(5);
    expect(markerLengthOf("> 引用", "blockquote")).toBe(2);
    expect(markerLengthOf(">", "blockquote")).toBe(1);
    expect(markerLengthOf("  - 缩进项", "list")).toBe(4);
    expect(markerLengthOf("10) 甲", "list")).toBe(4);
    // 解析不出前缀的行（setext 的下划线、列表续行）长度就是 0：插入点退到行首，不猜。
    expect(markerLengthOf("====", "heading")).toBe(0);
    expect(markerLengthOf("续行内容", "list")).toBe(0);
  });
});

describe("E3 的地基：形态 A 下「在渲染文本上动刀」等价于「在源串上同偏移动刀」", () => {
  /** 在某一行的某个下标处插一段字面量（工具条的包裹就是两次这样的插入）。 */
  function spliceAt(text: string, line: number, offset: number, insert: string): string {
    const lines = text.split("\n");
    const target = lines[line] ?? "";
    lines[line] = `${target.slice(0, offset)}${insert}${target.slice(offset)}`;
    return lines.join("\n");
  }

  /**
   * ARC-009 §6.3 说「格式化操作永远作用在编辑单元的文本模型（源串）上」，而 E3
   * 的实现是把标记插进**屏上那段文本**（形态 A 显示的是渲染文本，不是源）。
   * 这两条要能同时成立，靠的就是下面这个等式：形态 A 的判据保证「渲染文本 == 逐行
   * 剥掉 marker 的源」，而 `composeNewText` 只做「逐行把 markers[i] 补回行首」这一件事
   * —— 于是在文本空间的下标 k 插一串字符，等价于在源空间的下标 k + markers[i].length
   * 插同一串。不成立就说明判据或 marker 复用有缺陷，那必须先修那一层，E3 不许绕过。
   */
  const CASES: Array<{ label: string; text: string; line: number; from: number; to: number }> = [
    { label: "纯文本段落（四类之一）", text: "Alpha paragraph one.\n", line: 0, from: 6, to: 15 },
    { label: "多行段落的第二行", text: "第一行\n第二行内容\n", line: 1, from: 3, to: 5 },
    { label: "ATX 标题（四类之二）", text: "## 二级标题\n", line: 0, from: 0, to: 4 },
    { label: "`>` 无空格的引用（四类之三）", text: ">无空格的引用\n", line: 0, from: 0, to: 3 },
    { label: "多段引用里带 `>` 空行的那一段", text: "> 段一\n>\n> 段二\n", line: 2, from: 0, to: 2 },
    { label: "无序列表第二项（四类之四）", text: "- 一\n- 二\n", line: 1, from: 0, to: 1 },
    { label: "缩进列表项：marker 是 `  - `", text: "  - 缩进列表项\n", line: 0, from: 2, to: 5 },
    { label: "有序列表首行", text: "3. 甲\n4. 乙\n", line: 0, from: 0, to: 1 },
    { label: "整段选中（两端都贴边界）", text: "Tail paragraph.\n", line: 0, from: 0, to: 15 }
  ];

  for (const entry of CASES) {
    test(entry.label, () => {
      const measured = measure(entry.text);
      // 前提：这一条真的落在形态 A，否则它压根不在本等式的适用范围内。
      expect(measured.mode).toBe("text");
      const parsed = parseBlockSource(measured.source, measured.type);
      const rendered = renderedTextOf(measured.block, measured.type);
      expect(rendered).toBe(parsed.lines.join("\n"));
      const marker = parsed.markers[entry.line] ?? "";
      // 左边：工具条实际做的事 —— 往屏上那段文本的两端插标记，提交时补前缀。
      const viaText = composeNewText(
        spliceAt(spliceAt(rendered, entry.line, entry.to, "**"), entry.line, entry.from, "**"),
        parsed
      );
      // 右边：字面理解「作用在源串上」—— 在同一行的源空间下标插同一对标记。
      const viaSource = spliceAt(
        spliceAt(measured.source, entry.line, entry.to + marker.length, "**"),
        entry.line,
        entry.from + marker.length,
        "**"
      );
      expect(viaText).toBe(viaSource);
    });
  }
});

describe("isFileSchemeUri（§7.2 的 UX 判据）", () => {
  test("只认 file:，其余 scheme 一律不给编辑入口", () => {
    expect(isFileSchemeUri("file:///vault/notes/doc.md")).toBe(true);
    // Windows 盘符 URI 的 authority 段是机器名或空，两者都还是 file: scheme。
    expect(isFileSchemeUri("file:///c:/Users/me/doc.md")).toBe(true);
    expect(isFileSchemeUri("file://server/share/doc.md")).toBe(true);
    expect(isFileSchemeUri("FILE:///c:/x.md")).toBe(true);
    expect(isFileSchemeUri("untitled:Untitled-1")).toBe(false);
    expect(isFileSchemeUri("vscode-webview://1a2b/index.md")).toBe(false);
    expect(isFileSchemeUri("https://example.com/doc.md")).toBe(false);
    expect(isFileSchemeUri("c:\\Users\\me\\doc.md")).toBe(false);
    expect(isFileSchemeUri("")).toBe(false);
  });
});
