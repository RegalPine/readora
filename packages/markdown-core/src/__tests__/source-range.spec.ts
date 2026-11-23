/**
 * 源位置锚定门禁（ARC-002 §12.3 六条 / ARC-009 §4.4，F12 编辑模式 E0）。
 *
 * E0 只往 DOM 里**增加**一个属性，不改变任何既有产物结构，所以这里既有正向断言
 * （锚点存在且指对行），也把「只增加」本身当成一条门禁。
 *
 * 为什么门禁 1 用「切出来单独再渲染一次」而不是逐块手写期望 HTML：ARC-002 §12.3
 * 承诺的是「这段行范围就是该区块参与渲染的源」，能证明这句话的只有幂等性本身 ——
 * 手写期望只能证明「我以为的行号」与「我以为的产物」互相一致，两个可能同时错。
 * 注意别在夹具里放重复标题：锚点注册表会给同名 id 加后缀，那样单独渲染必然不等。
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SANITIZATION_POLICY,
  RENDER_DIAGNOSTIC_CODES,
  SOURCE_RANGE_ATTRIBUTE,
  blankLineTester,
  decorateFragment,
  sanitizeHtml,
  sourceRangeValue,
  trimToContentEnd,
  type SourcePosition
} from "../index";
import { render } from "./helpers";

interface Anchor {
  tag: string;
  start: number;
  end: number;
  raw: string;
  outerHtml: string;
}

/**
 * 覆盖 12 类顶层区块。行号就是数组下标，改动这里必须同步改 ANCHORED_BLOCKS。
 * 行 11 / 34 这类分隔空行是最容易被 endLine 圈进来的地方（列表块的 `token.map` 就会）。
 */
const BLOCKS = [
  "# 标题", // 0
  "",
  "一段正文 with **bold**。", // 2
  "",
  "> 引用第一行", // 4
  ">",
  "> 引用第二行", // 6
  "",
  "- 项目一", // 8
  "  - 嵌套项",
  "- 项目二", // 10
  "", // 11 分隔空行
  "---", // 12
  "",
  "```ts", // 14
  "const a = 1;",
  "```", // 16
  "",
  "| 列 A | 列 B |", // 18
  "| --- | --- |",
  "| 1 | 2 |", // 20
  "",
  "$$", // 22
  "a > b",
  "$$", // 24
  "",
  "```mermaid", // 26
  "graph TD; a-->b;",
  "```", // 28
  "",
  "```csv", // 30
  "a,b",
  "1,2",
  "```", // 33
  "", // 34 分隔空行
  "尾段 {align=center}", // 35
  "",
  "![图](pic.png) {width=640px}" // 37
];

const BLOCK_SOURCE = BLOCKS.join("\n");
const BLOCK_LINES = BLOCK_SOURCE.split("\n");

/** 探针实测的真相表：12 个顶层区块，`endLine` 一律落在自己的最后一行非空行。 */
const ANCHORED_BLOCKS: [string, string][] = [
  ["H1", "0:0"],
  ["P", "2:2"],
  ["BLOCKQUOTE", "4:6"],
  ["UL", "8:10"],
  ["HR", "12:12"],
  ["DIV", "14:16"],
  ["DIV", "18:20"],
  ["SPAN", "22:24"],
  ["DIV", "26:28"],
  ["DIV", "30:33"],
  ["P", "35:35"],
  ["P", "37:37"]
];

/** 只按属性名取值：DOM 已经是解析好的树，这里不需要标签扫描。 */
function anchorsOf(html: string): Anchor[] {
  const doc = new DOMParser().parseFromString(html, "text/html");
  return Array.from(doc.querySelectorAll(`[${SOURCE_RANGE_ATTRIBUTE}]`)).map((element) => {
    const raw = element.getAttribute(SOURCE_RANGE_ATTRIBUTE) ?? "";
    const [start, end] = raw.split(":").map(Number);
    return {
      tag: element.tagName,
      start: start ?? Number.NaN,
      end: end ?? Number.NaN,
      raw,
      outerHtml: element.outerHTML
    };
  });
}

function anchoredPairs(html: string): [string, string][] {
  return anchorsOf(html).map((anchor) => [anchor.tag, anchor.raw]);
}

/**
 * 抹掉锚点属性以便比较两份 HTML。
 *
 * 取值形状是 `^\d+:\d+$`（本包自己生成），所以按模式串删除是安全的：这里不解析
 * 语义，只是把「本轮新增的那一个属性」从两份产物里同时去掉。
 */
function withoutAnchors(html: string): string {
  return html.replace(new RegExp(` ${SOURCE_RANGE_ATTRIBUTE}="\\d+:\\d+"`, "gu"), "");
}

function sourceLinesOf(anchor: Anchor): string {
  return BLOCK_LINES.slice(anchor.start, anchor.end + 1).join("\n");
}

describe("门禁 1：锚点指回的源就是该区块的渲染源", () => {
  it("12 类顶层区块各自带一个形状合法的范围", () => {
    expect(anchoredPairs(render(BLOCK_SOURCE).html)).toEqual(ANCHORED_BLOCKS);
  });

  it("每个区块按范围切出的源单独再渲染一次，产物与在文中的片段逐字节相同", () => {
    for (const anchor of anchorsOf(render(BLOCK_SOURCE).html)) {
      const slice = sourceLinesOf(anchor);
      const standalone = render(slice).html;
      // 单独渲染只出一个顶层元素：多了说明范围多切了内容，少了说明切少了。
      expect(anchorsOf(standalone).length, slice).toBe(1);
      expect(withoutAnchors(anchor.outerHtml), `范围 ${anchor.raw}`).toBe(
        withoutAnchors(standalone)
      );
    }
  });

  it("正常渲染不产生 source-range-stripped 诊断（生成侧自己没写错形状）", () => {
    const codes = render(BLOCK_SOURCE).diagnostics.map((item) => item.code);
    expect(codes).not.toContain(RENDER_DIAGNOSTIC_CODES.SOURCE_RANGE_STRIPPED);
  });
});

describe("门禁 2：范围互不重叠且不吃分隔空行", () => {
  it("按文档顺序严格递增、两两不相交", () => {
    const anchors = anchorsOf(render(BLOCK_SOURCE).html);
    expect(anchors.length).toBeGreaterThan(8);
    let previous: Anchor | undefined;
    for (const anchor of anchors) {
      expect(Number.isInteger(anchor.start), anchor.raw).toBe(true);
      expect(Number.isInteger(anchor.end), anchor.raw).toBe(true);
      expect(anchor.end >= anchor.start, anchor.raw).toBe(true);
      if (previous) {
        expect(
          anchor.start > previous.end,
          `${previous.tag} ${previous.raw} 与 ${anchor.tag} ${anchor.raw} 相交或相接`
        ).toBe(true);
      }
      previous = anchor;
    }
  });

  it("相邻区块之间的间隙只允许是空行", () => {
    const anchors = anchorsOf(render(BLOCK_SOURCE).html);
    let previous: Anchor | undefined;
    for (const anchor of anchors) {
      if (previous) {
        for (let line = previous.end + 1; line < anchor.start; line += 1) {
          expect((BLOCK_LINES[line] ?? "x").trim(), `行 ${line} 夹在区块间却不是空行`).toBe("");
        }
      }
      previous = anchor;
    }
  });

  it("endLine 一律落在非空行上：列表尾随空行与文档结尾的空行都被收回", () => {
    for (const anchor of anchorsOf(render(BLOCK_SOURCE).html)) {
      const line = BLOCK_LINES[anchor.end] ?? "";
      expect(line.trim().length, `${anchor.tag} ${anchor.raw} 的 endLine 指向空行`).toBeGreaterThan(
        0
      );
    }
    expect(anchorsOf(render("- a\n- b\n\n\n").html)[0]?.raw).toBe("0:1");
    expect(anchorsOf(render("段落\n\n\n").html)[0]?.raw).toBe("0:0");
  });
});

describe("门禁 3：行号相对文件而非相对 body", () => {
  const WITH_FM = ["---", "title: 偏移", "---", "", "# 首个标题", "", "正文"].join("\n");
  const WITHOUT_FM = ["", "# 首个标题", "", "正文"].join("\n");

  it("带 frontmatter 的文档标的是文件绝对行号", () => {
    expect(anchorsOf(render(WITH_FM).html).map((anchor) => anchor.raw)).toEqual(["4:4", "6:6"]);
  });

  it("两份文档的差值正好是被剥掉的 frontmatter 行数", () => {
    const withFm = anchorsOf(render(WITH_FM).html);
    const withoutFm = anchorsOf(render(WITHOUT_FM).html);
    expect(withFm.length).toBe(withoutFm.length);
    for (let index = 0; index < withFm.length; index += 1) {
      const anchored = withFm[index];
      const plain = withoutFm[index];
      if (!anchored || !plain) {
        continue;
      }
      expect(anchored.start - plain.start).toBe(3);
    }
  });

  it("未闭合的 frontmatter 整段进正文，偏移为 0（与提取层的早退口径一致）", () => {
    const source = ["---", "title: 没关", "", "# 正文"].join("\n");
    const anchors = anchorsOf(render(source).html);
    expect(anchors.length).toBeGreaterThan(0);
    expect(anchors[0]?.start).toBe(0);
  });
});

describe("门禁 4：只标顶层，合成节点不标", () => {
  it("被标注元素的后代里不再出现同名属性（嵌套容器随所属顶层区块整体定位）", () => {
    const html = render(BLOCK_SOURCE).html;
    const doc = new DOMParser().parseFromString(html, "text/html");
    expect(
      doc.querySelectorAll(`[${SOURCE_RANGE_ATTRIBUTE}] [${SOURCE_RANGE_ATTRIBUTE}]`).length
    ).toBe(0);
    // 夹具里的嵌套段落确实存在（引用块两段 + 列表项），只是不各自带范围。
    expect(doc.querySelectorAll(".readora-blockquote .readora-paragraph").length).toBe(2);
    expect(anchorsOf(html).length).toBe(
      doc.querySelectorAll(`body > [${SOURCE_RANGE_ATTRIBUTE}]`).length
    );
  });

  it("合成的脚注区不带属性（它没有可靠的源行范围）", () => {
    const source = ["# 顶层", "", "正文 [^a]", "", "[^a]: 脚注定义"].join("\n");
    const result = render(source);
    const doc = new DOMParser().parseFromString(result.html, "text/html");
    const section = doc.querySelector(".readora-footnotes");
    expect(section, result.html).not.toBeNull();
    expect(section?.hasAttribute(SOURCE_RANGE_ATTRIBUTE)).toBe(false);
    // 顶层锚点只有标题与那段正文；脚注区是第三个顶层节点，被跳过。
    expect(anchorsOf(result.html).map((anchor) => anchor.raw)).toEqual(["0:0", "2:2"]);
  });

  it("夹具里每个顶层元素都被锚定：不增不减，也没有区块被静默跳过", () => {
    const html = render(BLOCK_SOURCE).html;
    const doc = new DOMParser().parseFromString(html, "text/html");
    // 这份夹具没有合成节点（脚注区在下一条用例里单独验），所以顶层元素数 == 锚点数
    // 就是「每个参与渲染的顶层区块恰好一个锚点」。
    expect(anchorsOf(html).length).toBe(ANCHORED_BLOCKS.length);
    expect(doc.body.children.length).toBe(ANCHORED_BLOCKS.length);
  });

  it("position 缺失或形状非法时不输出属性，也不输出 -1:-1 / NaN", () => {
    expect(sourceRangeValue(undefined, 3)).toBeUndefined();
    expect(sourceRangeValue({ startLine: -1, endLine: 2 }, 0)).toBeUndefined();
    expect(sourceRangeValue({ startLine: 5, endLine: 2 }, 0)).toBeUndefined();
    expect(sourceRangeValue({ startLine: Number.NaN, endLine: 2 }, 0)).toBeUndefined();
    expect(sourceRangeValue({ startLine: 1.5, endLine: 2 }, 0)).toBeUndefined();
    expect(sourceRangeValue({ startLine: 0, endLine: 0 }, 0)).toBe("0:0");
  });
});

describe("门禁 5：Sanitizer 按值形状剥离", () => {
  it("形状非法的值被剥掉并给出 warning 诊断", () => {
    const outcome = sanitizeHtml(
      `<p ${SOURCE_RANGE_ATTRIBUTE}="a:b">正文</p>`,
      DEFAULT_SANITIZATION_POLICY
    );
    expect(outcome.html).not.toContain(SOURCE_RANGE_ATTRIBUTE);
    expect(outcome.diagnostics.map((item) => item.code)).toContain(
      RENDER_DIAGNOSTIC_CODES.SOURCE_RANGE_STRIPPED
    );
  });

  it("形状对但区间倒挂（15:12）同样剥掉", () => {
    const outcome = sanitizeHtml(
      `<p ${SOURCE_RANGE_ATTRIBUTE}="15:12">正文</p>`,
      DEFAULT_SANITIZATION_POLICY
    );
    expect(outcome.html).not.toContain(SOURCE_RANGE_ATTRIBUTE);
  });

  it("合法值原样保留且不产生诊断：data-* 由 ALLOW_DATA_ATTR 放行，白名单不需要动", () => {
    const outcome = sanitizeHtml(
      `<p ${SOURCE_RANGE_ATTRIBUTE}="1:2">正文</p>`,
      DEFAULT_SANITIZATION_POLICY
    );
    expect(outcome.html).toContain(`${SOURCE_RANGE_ATTRIBUTE}="1:2"`);
    expect(outcome.diagnostics).toEqual([]);
  });

  it("嵌套层的属性同样在扫描范围内", () => {
    const outcome = sanitizeHtml(
      `<blockquote><p ${SOURCE_RANGE_ATTRIBUTE}="9:9">正文</p></blockquote>`,
      DEFAULT_SANITIZATION_POLICY
    );
    expect(outcome.html).toContain(SOURCE_RANGE_ATTRIBUTE);
    expect(outcome.diagnostics).toEqual([]);
  });
});

describe("decorateFragment：把属性写进第一个开始标签", () => {
  const ATTRIBUTE = ` ${SOURCE_RANGE_ATTRIBUTE}="3:5"`;

  it("普通标签写在闭合 > 之前", () => {
    expect(decorateFragment('<p class="a">正文</p>', "3:5")).toBe(
      `<p class="a"${ATTRIBUTE}>正文</p>`
    );
  });

  it("自闭合标签写在斜杠之前，保留 /> 形状", () => {
    expect(decorateFragment('<hr class="a" />', "3:5")).toBe(`<hr class="a"${ATTRIBUTE} />`);
  });

  it("裸文本片段无处可挂，原样返回（降级路径不产畸形标签）", () => {
    expect(decorateFragment("纯文本", "3:5")).toBe("纯文本");
    expect(decorateFragment("", "3:5")).toBe("");
    expect(decorateFragment("<p 未闭合", "3:5")).toBe("<p 未闭合");
  });

  it("只改第一个开始标签，嵌套元素一律不动", () => {
    expect(decorateFragment('<div class="a"><p>内层</p></div>', "3:5")).toBe(
      `<div class="a"${ATTRIBUTE}><p>内层</p></div>`
    );
  });

  it("值里带裸 > 与引号时按引号感知跳过，不吃进属性值", () => {
    expect(decorateFragment('<p title="a > b">正文</p>', "3:5")).toBe(
      `<p title="a > b"${ATTRIBUTE}>正文</p>`
    );
  });

  it("幂等：已经标过就不再叠一个", () => {
    const once = decorateFragment('<p class="a">正文</p>', "3:5");
    expect(decorateFragment(once, "9:9")).toBe(once);
  });
});

describe("sourceRangeValue / trimToContentEnd：偏移与收缩的坐标空间", () => {
  const position: SourcePosition = { startLine: 1, endLine: 4 };

  it("先收缩再加偏移", () => {
    // 行号：0 a / 1 b / 2 c / 3 d / 4 空 / 5 空。位置 1:4 的尾随空行收回后停在 3。
    const isBlank = blankLineTester("a\nb\nc\nd\n\n");
    expect(sourceRangeValue(position, 0, isBlank)).toBe("1:3");
    expect(sourceRangeValue(position, 10, isBlank)).toBe("11:13");
  });

  it("收缩永不跨过 startLine", () => {
    const allBlank = blankLineTester("a\n\n\n");
    expect(trimToContentEnd(2, 2, allBlank)).toBe(2);
    expect(sourceRangeValue({ startLine: 2, endLine: 2 }, 1, allBlank)).toBe("3:3");
  });

  it("越界的 endLine 按空行收回，不标到文件之外", () => {
    const isBlank = blankLineTester("a\nb");
    expect(sourceRangeValue({ startLine: 0, endLine: 9 }, 0, isBlank)).toBe("0:1");
  });

  it("不交判定器就保持原范围（判定器是可选能力，不是隐藏前提）", () => {
    expect(sourceRangeValue(position, 0)).toBe("1:4");
  });

  it("非法偏移不平移整篇，按 0 处理", () => {
    expect(sourceRangeValue(position, Number.NaN)).toBe("1:4");
    expect(sourceRangeValue(position, -5)).toBe("1:4");
  });
});

describe("门禁 6：只增加属性，不改既有产物结构", () => {
  it("去掉锚点属性后，产物里一个锚点字节都不剩", () => {
    const plain = withoutAnchors(render(BLOCK_SOURCE).html);
    expect(plain).not.toContain(SOURCE_RANGE_ATTRIBUTE);
    expect(anchorsOf(plain).length).toBe(0);
  });

  it("既有结构选择器的命中数与锚点无关（本轮没动结构与 class）", () => {
    const html = render(BLOCK_SOURCE).html;
    const doc = new DOMParser().parseFromString(html, "text/html");
    const plain = new DOMParser().parseFromString(withoutAnchors(html), "text/html");
    for (const selector of [
      ".readora-heading",
      ".readora-paragraph",
      ".readora-blockquote",
      ".readora-list",
      ".readora-thematic-break",
      ".readora-code-block",
      ".readora-diagram",
      ".readora-math",
      "table",
      "*"
    ]) {
      expect(doc.querySelectorAll(selector).length, selector).toBe(
        plain.querySelectorAll(selector).length
      );
    }
  });
});

describe("门禁 6 附：注入健壮性（降级公式里带 > 与引号）", () => {
  // `\sqrt{` 未闭合→ KaTeX 产 `katex-error`，`math.ts` 据此走失败分支，区块降级成
  // `data-readora-math-status="error"` + `data-readora-math-source` 形态（探针实测）。
  // 这条夹具同时把 `>` 与 `"` 放进源码：标签扫描不引号感知就会把属性插到别人体内。
  const source = ['$$', '\\sqrt{a > "b"', '$$'].join("\n");

  it("锚点恰好一处、形状合法，且确实走的是降级分支", () => {
    const html = render(source).html;
    // 不断言这一条的话，公式哪天变得能正常渲染，本用例就会静默不再覆盖降级路径。
    expect(html).toContain('data-readora-math-status="error"');
    const anchors = anchorsOf(html);
    expect(anchors.length, html).toBe(1);
    expect(anchors[0]?.raw).toBe("0:2");
    expect(html.split(SOURCE_RANGE_ATTRIBUTE).length - 1).toBe(1);
  });

  it("标签结构完好：属性落在开始标签末尾，源码原文仍在可见文本里", () => {
    const html = render(source).html;
    const doc = new DOMParser().parseFromString(html, "text/html");
    expect(doc.body.children.length).toBe(1);
    const anchored = doc.body.children[0];
    expect(anchored?.tagName).toBe("SPAN");
    expect(anchored?.getAttribute(SOURCE_RANGE_ATTRIBUTE)).toBe("0:2");
    // 源码里的 `>` 与 `"` 既没被当成标签边界，也没把后面的内容吸进属性值。
    expect(anchored?.textContent).toContain('a > "b"');
    expect(anchored?.getAttribute("data-readora-math-source")).toBe('\\sqrt{a > "b"');
  });

  it("降级路径不产生 source-range-stripped 诊断", () => {
    const codes = render(source).diagnostics.map((item) => item.code);
    expect(codes).not.toContain(RENDER_DIAGNOSTIC_CODES.SOURCE_RANGE_STRIPPED);
  });
});
