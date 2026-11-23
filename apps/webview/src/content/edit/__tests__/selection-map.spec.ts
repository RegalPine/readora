/**
 * DOM 选区端点 ↔ 单元文本下标取证（ARC-009 §6.3，E3）。
 *
 * 这一层的错不是「显示不对」而是「把文件写坏」：`**` 插错一个下标，提交出去的
 * 就是一行损坏的 Markdown。所以每条断言都要问「这个下标真的指向那个字吗」，
 * 而回答它最诚实的方式不是拿同一套遍历自证，是**把那个点之后的内容真删掉，
 * 再看剩下的读出来是不是正好前 i 个字符**（`assertPrefixOracle`）。
 *
 * 另一条同等重要的是**同一条路径**：`charOffsetOf` 与 `readEditableText` 必须
 * 是同一份遍历的两个视图 —— 上面那条删内容断言就是在证这件事，它是本轮唯一
 * 能同时约束两侧的交叉断言（各自的单测都只能自证）。
 *
 * 节点一律 `appendChild` 进 `document`：`offsetOf` 里那道 `isConnected` 判据
 * 会把游离树整个拒掉，而 jsdom 里游离容器才是常态 —— 这一层反过来证明了那道
 * 判据在起作用（见最后一条用例）。
 */
import { afterEach, describe, expect, test } from "vitest";
import { SOURCE_RANGE_ATTRIBUTE, renderMarkdown } from "@readora/markdown-core";
import {
  blockTypeOf,
  markerLengthOf,
  readEditableText,
  sliceBlockSource,
  type EditBlockType,
  type EditMode
} from "../source-text";
import {
  charOffsetOf,
  createSelectionMapper,
  isPointInsideBlock,
  pointAtOffset,
  readUnitSelection,
  selectionFromRange
} from "../selection-map";

const DOC_URI = "file:///vault/notes/doc.md";

const MIXED = [
  "# Alpha heading",
  "",
  "Alpha paragraph one.",
  "",
  "> quote line one",
  ">",
  "> quote line two",
  "",
  "- first item",
  "- second item"
].join("\n");

const mounted: HTMLElement[] = [];

afterEach(() => {
  for (const host of mounted.splice(0)) {
    host.remove();
  }
});

/** 真渲染一份产物并把容器挂进 document，返回第 index 个顶层区块。 */
function mount(text: string, index = 0): HTMLElement {
  const html = renderMarkdown({
    documentId: DOC_URI,
    documentUri: DOC_URI,
    version: 1,
    text,
    theme: "light"
  }).html;
  const host = document.createElement("div");
  host.innerHTML = html;
  document.body.appendChild(host);
  mounted.push(host);
  const block = host.children[index] as HTMLElement | undefined;
  if (!block) {
    throw new Error(`block ${index} missing`);
  }
  return block;
}

function typeOf(block: HTMLElement): EditBlockType {
  const type = blockTypeOf(block);
  if (!type) {
    throw new Error(`unclaimed block ${block.tagName}`);
  }
  return type;
}

/** 按 `edit-unit.ts` 进入形态 B 时同一条写法把区块换成源文本。 */
function asSourceMode(block: HTMLElement, source: string): void {
  block.replaceChildren(block.ownerDocument.createTextNode(source));
}

/** 文档顺序下的所有文本点（含每个节点内部每个 UTF-16 单元）。 */
function textPoints(root: Node): Array<{ node: Text; offset: number }> {
  const walker = root.ownerDocument!.createTreeWalker(root, 4 /* SHOW_TEXT */);
  const points: Array<{ node: Text; offset: number }> = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text;
    const length = text.data.length;
    for (let offset = 0; offset <= length; offset += 1) {
      points.push({ node: text, offset });
    }
  }
  return points;
}

function pathOf(root: Node, target: Node): number[] {
  const path: number[] = [];
  let node: Node | null = target;
  while (node && node !== root) {
    const parent: Node | null = node.parentNode;
    if (!parent) {
      throw new Error("node is not inside root");
    }
    path.unshift(Array.prototype.indexOf.call(parent.childNodes, node));
    node = parent;
  }
  return path;
}

function nodeByPath(root: Node, path: readonly number[]): Node {
  let node: Node = root;
  for (const index of path) {
    const child = node.childNodes[index];
    if (!child) {
      throw new Error("path does not resolve");
    }
    node = child;
  }
  return node;
}

/** 落不出来就是缺陷，不让「断言没跑」伪装成「断言过了」。 */
function required<T>(value: T | null, label: string): T {
  if (value === null) {
    throw new Error(`${label} is missing`);
  }
  return value;
}

/**
 * 交叉断言本体：对每个能映射的文本点，**在一份干净的同构 DOM 上把该点之后的内容
 * 删净**，剩下的读出来必须恰好等于 `readEditableText(...).slice(0, mapped)`。
 *
 * 这个 oracle 不重复实现任何遍历规则（删内容用的是 `Range#deleteContents`，
 * 读内容用的是被测对象自己的 `readEditableText`），所以它约束的是「下标的语义」
 * 而不是「下标的算法」—— 后者由两侧各自的用例覆盖。
 */
function assertPrefixOracle(
  block: HTMLElement,
  type: EditBlockType,
  mode: EditMode,
  render: () => HTMLElement
): void {
  const full = readEditableText(block, mode === "text" ? type : "paragraph");
  const mapper = createSelectionMapper(block, type, mode);
  for (const point of textPoints(block)) {
    const mapped = mapper.offsetOf(point);
    expect(mapped, `offset of ${JSON.stringify(point.node.nodeValue)}@${point.offset}`).not.toBeNull();
    const fresh = render();
    const same = nodeByPath(fresh, pathOf(block, point.node));
    if (!(same instanceof Text)) {
      throw new Error("structural drift between two renders");
    }
    const range = fresh.ownerDocument!.createRange();
    range.setStart(same, point.offset);
    range.setEnd(fresh, fresh.childNodes.length);
    range.deleteContents();
    expect(readEditableText(fresh, mode === "text" ? type : "paragraph")).toBe(
      full.slice(0, mapped as number)
    );
  }
}

describe("四类顶层区块的双向映射（形态 A）", () => {
  const CASES: Array<{ label: string; index: number; text: string; expected: string }> = [
    { label: "heading", index: 0, text: MIXED, expected: "Alpha heading" },
    { label: "paragraph", index: 1, text: MIXED, expected: "Alpha paragraph one." },
    {
      label: "blockquote（两段之间那条空行）",
      index: 2,
      text: MIXED,
      expected: "quote line one\n\nquote line two"
    },
    { label: "list（每个 li 一行）", index: 3, text: MIXED, expected: "first item\nsecond item" }
  ];

  for (const entry of CASES) {
    test(`${entry.label}：每个文本点的下标 = 前缀串长度`, () => {
      const block = mount(entry.text, entry.index);
      const type = typeOf(block);
      expect(readEditableText(block, type)).toBe(entry.expected);
      assertPrefixOracle(block, type, "text", () => mount(entry.text, entry.index));
    });
  }

  test("下标 → 点 → 下标 往返：文本位置全量可达，可达集恰好等于文本点集", () => {
    const block = mount(MIXED, 2);
    const type = typeOf(block);
    const mapper = createSelectionMapper(block, type, "text");
    const full = "quote line one\n\nquote line two";
    expect(mapper.length).toBe(full.length);
    // 可达集从**反方向**取（所有文本点映射出的下标），不用 pointAt 自证；
    // 两者相等就同时证了两件事：文本位置一个不漏，结构位置一个不多。
    const reachable = new Set<number>();
    for (const point of textPoints(block)) {
      const mapped = mapper.offsetOf(point);
      if (mapped !== null) {
        reachable.add(mapped);
      }
    }
    for (let index = 0; index <= mapper.length; index += 1) {
      const point = mapper.pointAt(index);
      if (point === null) {
        // 唯一允许的情形：合成换行内部（那条 `"\n\n"` 的中间一格）。
        expect(index).toBe(full.indexOf("\n\n") + 1);
        continue;
      }
      expect(reachable.has(index), `index ${index} is a text position`).toBe(true);
      expect(mapper.offsetOf(point)).toBe(index);
    }
    expect(reachable.size).toBe(mapper.length); // length + 1 个位置里恰好少一个
  });

  test("落不中时的语义是 null 而不是猜一个：合成换行中间那一格", () => {
    const block = mount(MIXED, 2);
    const mapper = createSelectionMapper(block, "blockquote", "text");
    expect(mapper.pointAt("quote line one".length)).not.toBeNull();
    expect(mapper.pointAt("quote line one".length + 2)).not.toBeNull();
    expect(mapper.pointAt("quote line one".length + 1)).toBeNull();
  });
});

describe("遍历里的每一条特殊规则都要能反着走", () => {
  test("软换行：跨 <br> 的下标连续，且换行本身占一格", () => {
    const block = document.createElement("p");
    block.append("甲");
    block.appendChild(document.createElement("br"));
    block.append("乙");
    document.body.appendChild(block);
    mounted.push(block);
    const mapper = createSelectionMapper(block, "paragraph", "text");
    expect(readEditableText(block, "paragraph")).toBe("甲\n乙");
    // 「乙」之前那个点（<br> 之后）必须落在下标 2 上，少一格就会把标记插进换行里
    const second = block.childNodes[2] as Text;
    expect(mapper.offsetOf({ node: second, offset: 0 })).toBe(2);
    expect(mapper.offsetOf({ node: second, offset: 1 })).toBe(3);
  });

  test("U+00A0 计一格（等长替换），U+200B 计零格（剔除）", () => {
    const block = document.createElement("p");
    block.append("甲", "\u00a0", "\u200b", "乙");
    document.body.appendChild(block);
    mounted.push(block);
    const mapper = createSelectionMapper(block, "paragraph", "text");
    const nodes = Array.from(block.childNodes) as Text[];
    expect(mapper.offsetOf({ node: nodes[0] as Text, offset: 1 })).toBe(1);
    expect(mapper.offsetOf({ node: nodes[1] as Text, offset: 1 })).toBe(2);
    // 零宽节点整段贡献 0：它的 0 偏移与 1 偏移是同一个下标
    expect(mapper.offsetOf({ node: nodes[2] as Text, offset: 0 })).toBe(2);
    expect(mapper.offsetOf({ node: nodes[2] as Text, offset: 1 })).toBe(2);
    expect(mapper.offsetOf({ node: nodes[3] as Text, offset: 1 })).toBe(3);
    expect(mapper.length).toBe(3);
    expect(readEditableText(block, "paragraph")).toBe("甲 乙");
  });

  test("尾部那个占位 <br> 不算内容：它之后那个点仍落在 length 上", () => {
    const block = document.createElement("p");
    block.append("内容");
    block.appendChild(document.createElement("br"));
    document.body.appendChild(block);
    mounted.push(block);
    const mapper = createSelectionMapper(block, "paragraph", "text");
    expect(mapper.length).toBe(2);
    expect(mapper.offsetOf({ node: block, offset: block.childNodes.length })).toBe(2);
    expect(mapper.offsetOf({ node: block, offset: 0 })).toBe(0);
  });

  test("blockquote：直接子 p 之间那条 \"\\n\\n\" 在两个方向上都算两格", () => {
    const block = mount(MIXED, 2);
    const paragraphs = Array.from(block.children) as HTMLElement[];
    expect(paragraphs.length).toBe(2);
    const mapper = createSelectionMapper(block, "blockquote", "text");
    const firstLength = "quote line one".length;
    expect(mapper.offsetOf({ node: paragraphs[1] as HTMLElement, offset: 0 })).toBe(
      firstLength + 2
    );
    expect(mapper.offsetOf(required(mapper.pointAt(firstLength + 2), "pointAt"))).toBe(
      firstLength + 2
    );
  });

  test("list：li 边界算一行，项内元素点与项间下标都对得上", () => {
    const block = mount(MIXED, 3);
    const items = Array.from(block.children) as HTMLElement[];
    const mapper = createSelectionMapper(block, "list", "text");
    expect(mapper.offsetOf({ node: items[0] as HTMLElement, offset: 0 })).toBe(0);
    expect(mapper.offsetOf({ node: items[1] as HTMLElement, offset: 0 })).toBe(
      "first item".length + 1
    );
    expect(mapper.offsetOf({ node: block, offset: block.children.length })).toBe(
      mapper.length
    );
  });
});

describe("形态 B（改源）：整块是一个带字面换行的文本节点", () => {
  const SOURCE = "> - [ ] 甲\n>   乙";

  test("按 paragraph 平铺读就是源串本身（含 marker），下标即源串下标", () => {
    const block = mount(MIXED, 2);
    asSourceMode(block, SOURCE);
    const mapper = createSelectionMapper(block, "blockquote", "source");
    expect(mapper.length).toBe(SOURCE.length);
    expect(readEditableText(block, "paragraph")).toBe(SOURCE);
    const first = block.firstChild as Text;
    expect(mapper.offsetOf({ node: first, offset: 1 })).toBe(1);
    // 进入形态 B 时写的是**一个**带字面 `\n` 的文本节点（不是拆成 `<br>`），
    // 于是 DOM 偏移与源串偏移逐格相同 —— 这是「不新增行内锚点」能成立的第一条事实。
    expect(first.data).toBe(SOURCE);
    expect(mapper.offsetOf({ node: first, offset: first.data.length })).toBe(SOURCE.length);
    // 逐行包裹的插入点就取这一句（决策 2 第 3 条）：不新增行内锚点，也不另数 `#`
    expect(SOURCE.slice(markerLengthOf(SOURCE, "blockquote"))).toBe("- [ ] 甲\n>   乙");
  });

  test("按区块自己的类型读会把内容读空 —— 这就是 `textOf` 那句三元存在的理由", () => {
    const block = mount(MIXED, 3);
    asSourceMode(block, "- first item\n- second item");
    // 源串里没有 `<li>` 了，按 `list` 分派→ 直接子 LI 一个也没有 → 空串；
    // 选区映射若跟了这条路径，两个端点都会算成 0，包裹会插在整块开头。
    expect(readEditableText(block, "list")).toBe("");
    expect(readEditableText(block, "paragraph")).toBe("- first item\n- second item");
    const mapper = createSelectionMapper(block, "list", "source");
    expect(mapper.length).toBe("- first item\n- second item".length);
    expect(
      mapper.offsetOf({ node: block.firstChild as Text, offset: "- first item".length + 1 })
    ).toBe("- first item\n".length);
  });

  test("逐点交叉断言（删内容 oracle）", () => {
    const build = () => {
      const block = mount(MIXED, 2);
      asSourceMode(block, SOURCE);
      return block;
    };
    assertPrefixOracle(build(), "blockquote", "source", build);
  });
});

describe("映射不出来的点一律返回 null（§6.3 降级入口）", () => {
  test("端点不在本单元的遍历里：兄弟区块的文本节点", () => {
    const host = document.createElement("div");
    const left = document.createElement("p");
    const right = document.createElement("p");
    left.append("左");
    right.append("右");
    host.append(left, right);
    document.body.appendChild(host);
    mounted.push(host);
    expect(charOffsetOf(left, "paragraph", "text", { node: right.firstChild as Text, offset: 0 })).toBeNull();
    expect(isPointInsideBlock(left, { node: right, offset: 0 })).toBe(false);
    expect(isPointInsideBlock(left, { node: left, offset: 0 })).toBe(true);
  });

  test("端点所在节点已脱离文档：正文重写之后的旧节点", () => {
    const block = mount(MIXED, 1);
    const stale = block.firstChild as Text;
    block.replaceChildren(block.ownerDocument.createTextNode("换过了"));
    expect(stale.isConnected).toBe(false);
    expect(charOffsetOf(block, "paragraph", "text", { node: stale, offset: 0 })).toBeNull();
  });

  test("端点是注释 / 文本节点之外的第三种节点：不算文本点", () => {
    const block = document.createElement("p");
    block.append("甲");
    block.appendChild(document.createComment("注"));
    document.body.appendChild(block);
    mounted.push(block);
    const comment = block.childNodes[1] as Comment;
    expect(charOffsetOf(block, "paragraph", "text", { node: comment, offset: 0 })).toBeNull();
  });

  test("形态 A 的区块里，未被遍历覆盖的元素点返回 null：列表嵌套之外的 UL", () => {
    const block = mount(MIXED, 3);
    const items = Array.from(block.children) as HTMLElement[];
    const mapper = createSelectionMapper(block, "list", "text");
    // 直接子 LI 有边界表；LI 之下的 UL 元素点也必须有（walkTextContentSlots 走过它），
    // 而一个从没走过的元素（LI 里的 B？）不该有 —— 用 LI 的父级 UL 之外的节点验证。
    expect(mapper.offsetOf({ node: items[0] as HTMLElement, offset: 0 })).toBe(0);
    const outside = document.createElement("span");
    document.body.appendChild(outside);
    mounted.push(outside);
    expect(mapper.offsetOf({ node: outside, offset: 0 })).toBeNull();
  });
});

describe("浏览器侧取端点", () => {
  test("selectionFromRange 只搬端点，不改文档顺序", () => {
    const block = mount(MIXED, 1);
    const range = block.ownerDocument.createRange();
    range.setStart(block.firstChild as Text, 6);
    range.setEnd(block.firstChild as Text, 15);
    const selection = required(selectionFromRange(range), "selectionFromRange");
    const mapper = createSelectionMapper(block, "paragraph", "text");
    expect(mapper.offsetOf(selection.start)).toBe(6);
    expect(mapper.offsetOf(selection.end)).toBe(15);
  });

  test("没有选区时 readUnitSelection 返回 null（真实选区读取归 e2e）", () => {
    const block = mount(MIXED, 1);
    // jsdom 的 Selection 对端点维护不可依赖，本轮只断言「读不出来就别猜」这一支；
    // 选区真的产生标记的完整链路在 tests/e2e/edit-inline.spec.ts 里取证。
    const view = block.ownerDocument.defaultView;
    if (!view || typeof view.getSelection !== "function") {
      expect(readUnitSelection(block)).toBeNull();
      return;
    }
    view.getSelection()?.removeAllRanges();
    expect(readUnitSelection(block)).toBeNull();
  });

  test("sliceBlockSource 的源文本与形态 A 的下标不在同一坐标上（本轮不新增行内锚点）", () => {
    const block = mount(MIXED, 1);
    const rangeKey = block.getAttribute(SOURCE_RANGE_ATTRIBUTE) as string;
    // 段落 marker 为空时两者恰好重合；引用块就会差一个前缀长度 —— 这条断言
    // 记下「决策 1：不新增行内锚点」成立所依赖的那个前提，改动 marker 规则时它会响。
    expect(sliceBlockSource(MIXED, rangeKey)).toBe("Alpha paragraph one.");
    const quoted = mount(MIXED, 2);
    const quotedKey = quoted.getAttribute(SOURCE_RANGE_ATTRIBUTE) as string;
    expect(sliceBlockSource(MIXED, quotedKey)).toBe("> quote line one\n>\n> quote line two");
    expect(readEditableText(quoted, "blockquote")).toBe("quote line one\n\nquote line two");
  });

  test("两个自由函数与 mapper 同一条路径（导出面不能是第二套口径）", () => {
    const block = mount(MIXED, 2);
    const paragraph = required(block.querySelector("p"), "blockquote > p");
    const point = { node: paragraph.firstChild as Text, offset: 5 };
    // `charOffsetOf` / `pointAtOffset` 是 §6.3 交给接管层的门面，mapper 是内部形态：
    // 两条必须给出同一个答案，否则将来改了遍历只修一处也照样绿。
    expect(charOffsetOf(block, "blockquote", "text", point)).toBe(
      createSelectionMapper(block, "blockquote", "text").offsetOf(point)
    );
    const back = required(pointAtOffset(block, "blockquote", "text", 5), "pointAtOffset");
    expect(charOffsetOf(block, "blockquote", "text", back)).toBe(5);
  });
});
