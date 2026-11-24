/**
 * 目录面板测试（ARC-007 §6.1 / §6.2、PRD-002 §5.1 / §5.2 + PRD-003 §10.7，
 * STORY-07-01）。
 *
 * §6.1 的七条展示要求逐条对应：层级缩进、折叠/展开、活动高亮、长目录滚动、
 * 溢出省略、无标题空态、点击定位。省略是 CSS 职责，这里只断言
 * 结构可读（可滚容器存在 + title 兜底文案）；滚动里的「焦点跟随」靠假几何
 * 验算术（见文件末尾），真实像素行为由 `tests/e2e/outline.spec.ts` 取证。
 *
 * §10.7 在文件后半段的是「头部动作与过滤、行内标签」两块（进度块、源行号标签与
 * 底部统计已按用户要求撤下），逐条都是「数据源拿得到才显示」：
 * 没有 `position` 就没有行内标签，折叠态不参与过滤视图就不摆折叠按钮。
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import type { OutlineItem } from "@readora/markdown-core";
import {
  OutlinePanel,
  COLLAPSED_CLASS,
  OUTLINE_ACTIVE_ATTRIBUTE,
  OUTLINE_ACTIVE_VALUE,
  OUTLINE_FILTER_INPUT_ID,
  OUTLINE_PANEL_CLASS
} from "../OutlinePanel";
import type { SectionOpAction, SectionOpPlan } from "../outline-section-ops";

/** jsdom 的默认 rect（恒为全 0）：用例收尾时要把它装回去。 */
const REAL_RECT = Element.prototype.getBoundingClientRect;

function item(title: string, level: number, anchor: string): OutlineItem {
  return { id: `n-${anchor}`, title, level, anchor };
}

const ITEMS = [
  item("Overview", 1, "overview"),
  item("Architecture", 2, "architecture"),
  item("Application Layer", 3, "application-layer"),
  item("Implementation", 2, "implementation")
];

interface Props {
  items?: readonly OutlineItem[];
  activeHeadingId?: string | null;
  collapsedIds?: ReadonlySet<string>;
  text?: string;
  sectionOpsEnabled?: boolean | undefined;
  onSectionOp?: SectionOpHandler | undefined;
}

function panel(options: Props = {}) {
  const onToggleCollapse = vi.fn();
  const onCollapsedChange = vi.fn();
  const onSelect = vi.fn();
  const elementOf = (next: Props) => (
    <OutlinePanel
      items={next.items ?? ITEMS}
      activeHeadingId={next.activeHeadingId ?? null}
      collapsedIds={next.collapsedIds ?? new Set<string>()}
      text={next.text ?? ""}
      onToggleCollapse={onToggleCollapse}
      onCollapsedChange={onCollapsedChange}
      onSelect={onSelect}
      sectionOpsEnabled={next.sectionOpsEnabled ?? false}
      onSectionOp={next.onSectionOp}
    />
  );
  const view = render(elementOf(options));
  return {
    view,
    onToggleCollapse,
    onCollapsedChange,
    onSelect,
    /**
     * 换活动标题：焦点跟随的唯一触发条件就是它。
     * 条目按 key 复用，同一行 DOM 节点不会重建，装好的几何桩跟着走。
     */
    setActive: (activeHeadingId: string | null) => {
      view.rerender(elementOf({ ...options, activeHeadingId }));
    }
  };
}

function labels(container: HTMLElement): string[] {
  return [...container.querySelectorAll(".readora-outline-link")].map(
    (node) => node.textContent ?? ""
  );
}

function indents(container: HTMLElement): number[] {
  return [...container.querySelectorAll<HTMLLIElement>(".readora-outline-item")].map((node) =>
    Number.parseInt(node.style.paddingLeft || "0px", 10)
  );
}

afterEach(() => {
  cleanup();
  Element.prototype.getBoundingClientRect = REAL_RECT;
});

describe("结构与可读性", () => {
  test("面板是可命名地标，长目录自带滚动容器", () => {
    const { view } = panel();
    const nav = view.container.querySelector<HTMLElement>(`.${OUTLINE_PANEL_CLASS}`);
    expect(nav?.getAttribute("aria-label")).toBe("Document outline");
    const list = view.container.querySelector<HTMLElement>(".readora-outline-list");
    expect(list?.tagName).toBe("UL");
  });

  test("层级按 depth 缩进，越深越靠右", () => {
    const { view } = panel();
    expect(labels(view.container)).toEqual([
      "Overview",
      "Architecture",
      "Application Layer",
      "Implementation"
    ]);
    expect(indents(view.container)).toEqual([0, 12, 24, 12]);
  });

  test("超过四层的缩进封顶，窄栏里仍留得下标题", () => {
    const deep = [
      item("L1", 1, "l1"),
      item("L2", 2, "l2"),
      item("L3", 3, "l3"),
      item("L4", 4, "l4"),
      item("L5", 5, "l5"),
      item("L6", 6, "l6")
    ];
    const { view } = panel({ items: deep });
    expect(indents(view.container)).toEqual([0, 12, 24, 36, 48, 48]);
  });

  test("长标题用 title 兜底（CSS ellipsis 之外仍可读到全文）", () => {
    const long = item("A very long heading that will certainly overflow the outline column", 2, "long");
    const { view } = panel({ items: [long] });
    const link = view.container.querySelector<HTMLAnchorElement>(".readora-outline-link");
    expect(link?.title).toBe(long.title);
    expect(link?.textContent).toBe(long.title);
  });

  test("空标题显示占位文案，不给出一条空白项", () => {
    const { view } = panel({ items: [item("", 2, "blank")] });
    expect(labels(view.container)).toEqual(["(Untitled)"]);
  });

  test("没有标题时给明确空态（§6.1 第 7 条）", () => {
    const { view } = panel({ items: [] });
    expect(view.container.querySelector(".readora-outline-empty")?.textContent).toBe(
      "No headings in this document."
    );
    expect(view.container.querySelector("ul")).toBeNull();
  });
});

describe("点击定位（§5.3 / PRD-002 §5.2）", () => {
  test("点击条目上报锚点并阻止原生 hash 跳转", () => {
    const { view, onSelect } = panel();
    const link = view.getAllByText("Architecture")[0] as HTMLElement;
    const click = fireEvent.click(link);
    expect(click).toBe(false);
    expect(onSelect).toHaveBeenCalledWith("architecture");
  });

  test("链接仍是可跳转的 href（读屏与中键打开都可用）", () => {
    const { view } = panel();
    const link = view.container.querySelector<HTMLAnchorElement>(".readora-outline-link");
    expect(link?.getAttribute("href")).toBe("#overview");
  });

  test("重复锚点的两条目都能各自上报", () => {
    const dup = [item("Dup", 1, "dup"), item("Dup", 1, "dup")];
    const { view, onSelect } = panel({ items: dup });
    for (const node of view.getAllByText("Dup")) {
      fireEvent.click(node);
    }
    expect(onSelect).toHaveBeenCalledTimes(2);
    expect(onSelect).toHaveBeenNthCalledWith(2, "dup");
  });
});

describe("活动高亮与折叠（§6.2）", () => {
  test("活动项带 aria-current=\"location\"，其余不带", () => {
    const { view } = panel({ activeHeadingId: "architecture" });
    const current = view.container.querySelectorAll('[aria-current="location"]');
    expect(current).toHaveLength(1);
    expect(current[0]?.textContent).toBe("Architecture");
  });

  test("未知锚点不会把高亮错挂到别的条目上", () => {
    const { view } = panel({ activeHeadingId: "gone" });
    expect(view.container.querySelectorAll('[aria-current="location"]')).toHaveLength(0);
  });

  test("只有带后代的条目有折叠按钮，aria-expanded 表达当前状态", () => {
    const { view } = panel();
    const toggles = view.container.querySelectorAll<HTMLButtonElement>(".readora-outline-toggle");
    expect(toggles).toHaveLength(2);
    expect([...toggles].map((node) => node.getAttribute("aria-expanded"))).toEqual([
      "true",
      "true"
    ]);
    expect(toggles[0]?.getAttribute("aria-label")).toBe("Collapse Overview");
  });

  test("折叠父节点只隐藏后代，兄弟与祖先仍在（数据不删）", () => {
    const { view } = panel({ collapsedIds: new Set(["architecture"]) });
    expect(labels(view.container)).toEqual([
      "Overview",
      "Architecture",
      "Implementation"
    ]);
    const collapsed = view.container.querySelector(`.${COLLAPSED_CLASS}`);
    expect(collapsed?.textContent).toContain("Architecture");
    const toggle = view.container.querySelector<HTMLButtonElement>(".readora-outline-toggle");
    expect(toggle?.getAttribute("aria-expanded")).toBe("true");
  });

  test("折叠根节点收起整棵子树", () => {
    const { view } = panel({ collapsedIds: new Set(["overview"]) });
    expect(labels(view.container)).toEqual(["Overview"]);
  });

  test("点击折叠按钮上报 key，由上层持有折叠状态", () => {
    const { view, onToggleCollapse } = panel();
    const toggles = view.container.querySelectorAll<HTMLButtonElement>(".readora-outline-toggle");
    fireEvent.click(toggles[1] as HTMLButtonElement);
    expect(onToggleCollapse).toHaveBeenCalledWith("architecture");
  });

  test("折叠状态不影响点击定位", () => {
    const { view, onSelect } = panel({ collapsedIds: new Set(["overview"]) });
    fireEvent.click(view.getByText("Overview"));
    expect(onSelect).toHaveBeenCalledWith("overview");
  });
});

/**
 * 行内标签与底部统计的夹具：源行区间与源文一一对应（0 基，同 markdown-core）。
 *
 * 0  # Overview            → 第 0–1 行，5 个单元 → `5w`
 * 1  one two three four
 * 2  ## Architecture       → 第 2–3 行（更深层级不配标签）
 * 3  five six
 * 4  ### Application Layer → 第 4–5 行
 * 5  seven
 * 6  ## Implementation     → 第 6–7 行
 * 7  eight
 */
const SOURCE = [
  "# Overview",
  "one two three four",
  "## Architecture",
  "five six",
  "### Application Layer",
  "seven",
  "## Implementation",
  "eight"
].join("\n");

function placed(title: string, level: number, anchor: string, startLine: number): OutlineItem {
  return {
    id: `n-${anchor}`,
    title,
    level,
    anchor,
    position: { startLine, endLine: startLine }
  };
}

const PLACED = [
  placed("Overview", 1, "overview", 0),
  placed("Architecture", 2, "architecture", 2),
  placed("Application Layer", 3, "application-layer", 4),
  placed("Implementation", 2, "implementation", 6)
];

function action(view: ReturnType<typeof panel>["view"], name: string): HTMLButtonElement {
  // 走 container 而不是 view.getByRole：role 查询的默认底是 document.body，
  // 一条用例里挂两个面板就会撞车。
  return within(view.container).getByRole<HTMLButtonElement>("button", { name });
}

/** 只有「有后代的节点」才配折叠：这一篇里是 overview 与 architecture。 */
const FULLY_COLLAPSED = new Set(["overview", "architecture"]);

describe("头部动作：展开全部 / 折叠全部 / 过滤（§10.7）", () => {
  test("展开与折叠是两枚常驻图标，按下态跟着当前折叠情况走", () => {
    const { view } = panel({ items: PLACED });
    // 没有任何条目被折叠时：展开那枚点了也没东西可展开，所以禁用；
    // 折叠那枚有事可做，按下态（淡底）就挂在它身上。
    expect(action(view, "Expand all").disabled).toBe(true);
    expect(action(view, "Expand all").getAttribute("aria-pressed")).toBe("false");
    expect(action(view, "Collapse all").disabled).toBe(false);
    expect(action(view, "Collapse all").getAttribute("aria-pressed")).toBe("true");
    expect(action(view, "Filter").getAttribute("aria-expanded")).toBe("false");

    // 全折叠：底色从折叠那枚换到展开那枚 —— 这就是用户要的「点了有变化」。
    const folded = panel({ items: PLACED, collapsedIds: FULLY_COLLAPSED });
    expect(action(folded.view, "Expand all").disabled).toBe(false);
    expect(action(folded.view, "Expand all").getAttribute("aria-pressed")).toBe("true");
    expect(action(folded.view, "Collapse all").disabled).toBe(true);
    expect(action(folded.view, "Collapse all").getAttribute("aria-pressed")).toBe("false");

    // 部分折叠：两枚都可用，也都还有事可做，按下态同时在两枚上。
    const partial = panel({ items: PLACED, collapsedIds: new Set(["overview"]) });
    expect(action(partial.view, "Expand all").disabled).toBe(false);
    expect(action(partial.view, "Expand all").getAttribute("aria-pressed")).toBe("true");
    expect(action(partial.view, "Collapse all").disabled).toBe(false);
    expect(action(partial.view, "Collapse all").getAttribute("aria-pressed")).toBe("true");
  });

  test("两枚图标形状不同：展开箭头朝外、折叠箭头朝内，都有水平参考线", () => {
    const { view } = panel({ items: PLACED });
    const shape = (name: string): string =>
      action(view, name).querySelector("path")?.getAttribute("d") ?? "";
    expect(shape("Expand all")).not.toBe(shape("Collapse all"));
    // 两枚都包含水平线 h12，与漏斗图标形成结构性差异
    expect(shape("Expand all")).toContain("h12");
    expect(shape("Collapse all")).toContain("h12");
    // 展开枚：箭头在 y=7 向上（l3-3）= 远离中心线
    expect(shape("Expand all")).toContain("7l3-3");
    // 折叠枚：箭头在 y=5 向下（l3 3）= 朝向中心线
    expect(shape("Collapse all")).toContain("5l3 3");
  });

  test("展开全部交回空集合，折叠全部交回所有可折叠 key 的名单", () => {
    const folded = panel({ items: PLACED, collapsedIds: FULLY_COLLAPSED });
    fireEvent.click(action(folded.view, "Expand all"));
    expect(folded.onCollapsedChange).toHaveBeenCalledWith([]);

    const fresh = panel({ items: PLACED });
    fireEvent.click(action(fresh.view, "Collapse all"));
    const keys = fresh.onCollapsedChange.mock.calls[0]?.[0] as readonly string[];
    // 名单而不是数字：叶子条目（application-layer、implementation）不进折叠集合。
    expect([...keys].sort()).toEqual(["architecture", "overview"]);
  });

  test("过滤 disclosure 点开才出现输入框，aria-controls 指得到它", () => {
    const { view } = panel({ items: PLACED });
    expect(view.container.querySelector(`#${OUTLINE_FILTER_INPUT_ID}`)).toBeNull();
    fireEvent.click(action(view, "Filter"));
    const input = view.container.querySelector<HTMLInputElement>(`#${OUTLINE_FILTER_INPUT_ID}`);
    expect(input?.getAttribute("aria-label")).toBe("Filter headings");
    expect(action(view, "Filter").getAttribute("aria-expanded")).toBe("true");
  });

  test("收起过滤就把查询一起清掉：不留看不见却仍在生效的过滤条件", () => {
    const { view } = panel({ items: PLACED });
    fireEvent.click(action(view, "Filter"));
    const input = view.container.querySelector<HTMLInputElement>(`#${OUTLINE_FILTER_INPUT_ID}`);
    fireEvent.change(input as HTMLInputElement, { target: { value: "arch" } });
    expect(labels(view.container)).toEqual(["Architecture"]);

    fireEvent.click(action(view, "Filter"));
    expect(view.container.querySelector(`#${OUTLINE_FILTER_INPUT_ID}`)).toBeNull();
    expect(labels(view.container)).toEqual([
      "Overview",
      "Architecture",
      "Application Layer",
      "Implementation"
    ]);
  });
});

describe("过滤命中（§10.7：按 title 子串并自动展开命中项）", () => {
  function filtered(query: string, collapsedIds: ReadonlySet<string> = new Set()) {
    const options = panel({ items: PLACED, collapsedIds });
    fireEvent.click(action(options.view, "Filter"));
    const input = options.view.container.querySelector<HTMLInputElement>(
      `#${OUTLINE_FILTER_INPUT_ID}`
    );
    fireEvent.change(input as HTMLInputElement, { target: { value: query } });
    return options;
  }

  test("大小写不敏感的子串命中，顺序仍是文档顺序", () => {
    expect(labels(filtered("ARCH").view.container)).toEqual(["Architecture"]);
    expect(labels(filtered("ation").view.container)).toEqual([
      "Application Layer",
      "Implementation"
    ]);
  });

  test("祖先被折叠也拦不住命中项：过滤视图不执行折叠", () => {
    // 折叠 Overview 后正常视图只剩 3 项，Architecture 是它的后代。
    const plain = panel({ items: PLACED, collapsedIds: new Set(["overview"]) });
    expect(labels(plain.view.container)).toHaveLength(1);
    expect(labels(filtered("arch", new Set(["overview"])).view.container)).toEqual([
      "Architecture"
    ]);
  });

  test("过滤视图里不摆折叠按钮，展开/折叠两枚都禁用并说明原因", () => {
    const { view } = filtered("a");
    expect(view.container.querySelectorAll(".readora-outline-toggle")).toHaveLength(0);
    for (const name of ["Expand all", "Collapse all"]) {
      const button = action(view, name);
      expect(button.disabled).toBe(true);
      expect(button.getAttribute("title")).toContain("过滤中");
    }
  });

  test("命中计数如实报「N of M」，零命中带上查询词而不是「没有内容」", () => {
    const note = (query: string): string =>
      filtered(query).view.container.querySelector('[data-readora-outline="filter-note"]')
        ?.textContent ?? "";
    expect(note("arch")).toBe("1 of 4 headings match");
    expect(note("zzz")).toContain("zzz");
    expect(note("zzz")).not.toMatch(/no headings in this document/iu);
  });

  test("Escape 先清空查询，再按一次才收起输入框", () => {
    const { view } = filtered("arch");
    const input = view.container.querySelector<HTMLInputElement>(`#${OUTLINE_FILTER_INPUT_ID}`);
    fireEvent.keyDown(input as HTMLInputElement, { key: "Escape" });
    expect((input as HTMLInputElement).value).toBe("");
    expect(labels(view.container)).toHaveLength(4);
    expect(view.container.querySelector(`#${OUTLINE_FILTER_INPUT_ID}`)).toBeTruthy();

    fireEvent.keyDown(input as HTMLInputElement, { key: "Escape" });
    expect(view.container.querySelector(`#${OUTLINE_FILTER_INPUT_ID}`)).toBeNull();
  });

  test("过滤输入的 Escape 不外溢：宿主的「退出专注」不该被同一次按键连带触发", () => {
    const outer = vi.fn();
    const view = render(
      <div onKeyDown={outer}>
        <OutlinePanel
          items={PLACED}
          activeHeadingId={null}
          collapsedIds={new Set<string>()}
          text={SOURCE}
          onToggleCollapse={() => undefined}
          onCollapsedChange={() => undefined}
          onSelect={() => undefined}
        />
      </div>
    );
    fireEvent.click(view.getByRole("button", { name: "Filter" }));
    const input = view.container.querySelector<HTMLInputElement>(`#${OUTLINE_FILTER_INPUT_ID}`);
    fireEvent.keyDown(input as HTMLInputElement, { key: "Escape" });
    expect(outer).not.toHaveBeenCalled();
  });
});

describe("行内标签（§10.7）", () => {
  test("进度不在大纲里：面板不再出 progressbar，也不接 progress 入参", () => {
    const { view } = panel({ items: PLACED });
    expect(view.container.querySelector('[data-readora-outline="progress"]')).toBeNull();
    expect(view.container.querySelectorAll('[role="progressbar"]')).toHaveLength(0);
  });

  test("行内标签全部下掉：不报分节字数，也不报源行号", () => {
    const { view } = panel({ items: PLACED, text: SOURCE });
    expect(view.container.querySelectorAll(".readora-outline-meta")).toHaveLength(0);
    expect(view.container.textContent).not.toMatch(/\d+w/u);
    expect(view.container.textContent).not.toMatch(/L\d+/u);
  });

  // 底部统计已按产品要求下掉：节数在状态条已有（同一份 outline 数出来的），
  // 层级跨度读者用不上。反向断言，避免以后又把它当「顺手能加」的块贴回来。
  test("不再输出底部统计：没有 footer，也没有 Sections / Depth 两个口子", () => {
    const { view } = panel({ items: PLACED });
    expect(view.container.querySelector(".readora-outline-footer")).toBeNull();
    expect(view.container.querySelector(`[data-readora-outline="sections"]`)).toBeNull();
    expect(view.container.querySelector(`[data-readora-outline="depth"]`)).toBeNull();
  });

  test("无标题文档仍是空态：各块都不摆空壳", () => {
    const { view } = panel({ items: [] });
    expect(view.container.querySelector(".readora-outline-empty")?.textContent).toBe(
      "No headings in this document."
    );
    expect(view.container.querySelector(".readora-outline-header")).toBeNull();
    expect(view.container.querySelector(".readora-outline-list")).toBeNull();
  });
});

describe("焦点跟随：活动项落在可见区外时列表自己滚", () => {
  /** 六条一排：够排出一条落在可见区之外的活动项。 */
  const TALL = [
    item("One", 1, "one"),
    item("Two", 2, "two"),
    item("Three", 3, "three"),
    item("Four", 4, "four"),
    item("Five", 5, "five"),
    item("Six", 6, "six")
  ];

  /** 给指定元素喂假几何（其他元素一律全 0，与 jsdom 默认一致）。 */
  function fakeRects(): Map<Element, { top: number; height: number }> {
    const boxes = new Map<Element, { top: number; height: number }>();
    Element.prototype.getBoundingClientRect = function rect(this: Element): DOMRect {
      const box = boxes.get(this);
      // DOMRect 的 top / bottom / height 都由 y 与 height 推出来，不手拼字段。
      return new DOMRect(0, box?.top ?? 0, 0, box?.height ?? 0);
    };
    return boxes;
  }

  /** 记录每一笔 scrollTop 写入：断言「没动」与「动了多少」都靠这份流水。 */
  function trackScroll(list: HTMLElement): { writes: number[]; value(): number } {
    const writes: number[] = [];
    let value = 0;
    Object.defineProperty(list, "scrollTop", {
      configurable: true,
      get: () => value,
      set: (next: number) => {
        writes.push(next);
        value = next;
      }
    });
    return { writes, value: () => value };
  }

  /**
   * 可见区 200–300（100px 高），六条各 20px 从列表顶部排下去：
   * 没滚动时第 1–5 条在内，第 6 条（300–320）恰好超出下沿。
   */
  function laidOut(activeHeadingId = "one") {
    const h = panel({ items: TALL, activeHeadingId });
    const list = h.view.container.querySelector<HTMLElement>(".readora-outline-list");
    const rows = [...h.view.container.querySelectorAll<HTMLElement>(".readora-outline-item")];
    if (!list || rows.length !== TALL.length) {
      throw new Error("outline list or rows missing");
    }
    const boxes = fakeRects();
    const scroll = trackScroll(list);
    boxes.set(list, { top: 200, height: 100 });
    rows.forEach((row, index) => {
      boxes.set(row, { top: 200 + index * 20, height: 20 });
    });
    return { ...h, list, rows, boxes, scroll };
  }

  test("活动条目带可定位的标记，全列表只有一条", () => {
    const { view } = panel({ items: TALL, activeHeadingId: "three" });
    const marks = view.container.querySelectorAll<HTMLElement>(
      `[${OUTLINE_ACTIVE_ATTRIBUTE}="${OUTLINE_ACTIVE_VALUE}"]`
    );
    expect(marks).toHaveLength(1);
    expect(marks[0]?.classList.contains("readora-outline-item")).toBe(true);
    // 高亮样式不是定位依据：带 aria-current 的是链接，滚动要的是整行。
    expect(marks[0]?.querySelector(".readora-outline-link")?.getAttribute("aria-current")).toBe(
      "location"
    );
  });

  test("超出下沿：列表向下滚刚好把它带到下沿", () => {
    const h = laidOut();
    h.setActive("six");
    expect(h.scroll.writes).toEqual([20]);
  });

  test("超出上沿：列表向上滚把它拉回可见区", () => {
    const h = laidOut("six");
    const first = h.rows[0];
    if (!first) {
      throw new Error("first outline row missing");
    }
    // 整行都在上沿之外（150–170 vs 可见区从 200 起），要补 50px；
    // 真浏览器会把负值夹到 0，这里记的是代码写进去的那一笔。
    h.boxes.set(first, { top: 150, height: 20 });
    h.setActive("one");
    expect(h.scroll.writes).toEqual([-50]);
  });

  test("已在可见区内就不动：跟随只在出界那一次写 scrollTop", () => {
    const h = laidOut();
    h.setActive("three");
    expect(h.scroll.writes).toEqual([]);
    expect(h.scroll.value()).toBe(0);
  });

  // 专注模式 / 窄窗口下左栏不渲染高度，两处高都是 0：按差值算会得到
  // `scrollTop = 0 - 0`，看着无害，实则把「上次滚到哪」的读数清成 0，栏打开后位置丢了。
  test("几何不可信（rect 全 0）时一笔都不写", () => {
    const h = panel({ items: TALL, activeHeadingId: "one" });
    const list = h.view.container.querySelector<HTMLElement>(".readora-outline-list");
    if (!list) {
      throw new Error("outline list missing");
    }
    const scroll = trackScroll(list);
    h.setActive("six");
    expect(scroll.writes).toEqual([]);
    expect(scroll.value()).toBe(0);
  });
});

// ---------- 章节结构菜单（E7）----------
// 夹具与 outline-section-ops.spec.ts 同一份（frontmatter 3 行 + 正文 19 行，
// 文件绝对行 0 基）：4 `# Guide`、8 `## Alpha`、12 `### Alpha child`、16 `## Beta`。
// 这里断言的是面板行为（门槛 / 开合 / 回传 / 确认 / 提示）；区间数值的权威
// 判据在纯函数测试里钉，这里只引用其期望值。
const SECTION_DOC_LINES = [
  "---",
  "title: Sections",
  "---",
  "",
  "# Guide",
  "",
  "Intro paragraph.",
  "",
  "## Alpha",
  "",
  "Alpha body.",
  "",
  "### Alpha child",
  "",
  "Child body.",
  "",
  "## Beta",
  "",
  "Beta body."
];
const SECTION_DOC = SECTION_DOC_LINES.join("\n");

function sectionHeading(title: string, level: number, bodyLine: number): OutlineItem {
  return {
    id: `n-${title}`,
    title,
    level,
    anchor: title.toLowerCase().replace(/\s+/g, "-"),
    position: { startLine: bodyLine, endLine: bodyLine }
  };
}

const SECTION_ITEMS: OutlineItem[] = [
  sectionHeading("Guide", 1, 1),
  sectionHeading("Alpha", 2, 5),
  sectionHeading("Alpha child", 3, 9),
  sectionHeading("Beta", 2, 13)
];

type SectionOpHandler = (action: SectionOpAction, plan: SectionOpPlan) => Promise<string | null>;

function sectionPanel(options: { onSectionOp?: SectionOpHandler; enabled?: boolean } = {}) {
  return panel({
    items: SECTION_ITEMS,
    text: SECTION_DOC,
    sectionOpsEnabled: options.enabled ?? true,
    onSectionOp: options.onSectionOp ?? (async () => null)
  });
}

function moreButton(container: HTMLElement, label: string): HTMLButtonElement {
  return within(container).getByRole("button", { name: `Section actions for ${label}` });
}

describe("章节结构菜单：门槛与形态", () => {
  test("未启用时零 affordance：有 position 的行也不摆 ⋯", () => {
    const { view } = sectionPanel({ enabled: false });
    expect(view.queryAllByRole("button", { name: /Section actions for/ })).toEqual([]);
  });

  test("启用但条目没有 position（旧快照的大纲）：同样不摆 ⋯", () => {
    const { view } = panel({ text: SECTION_DOC, sectionOpsEnabled: true });
    expect(view.queryAllByRole("button", { name: /Section actions for/ })).toEqual([]);
  });

  test("启用后每个有 position 的行各有一枚 ⋯", () => {
    const { view } = sectionPanel();
    expect(view.queryAllByRole("button", { name: /Section actions for/ })).toHaveLength(4);
  });

  test("点 ⋯ 展开三动作，aria-expanded 跟随；全栏同时只开一个", () => {
    const { view } = sectionPanel();
    const more = moreButton(view.container, "Alpha");
    fireEvent.click(more);
    expect(more.getAttribute("aria-expanded")).toBe("true");
    expect(within(view.container).getByRole("button", { name: "Add section after" })).toBeTruthy();
    expect(within(view.container).getByRole("button", { name: "Add sub-section" })).toBeTruthy();
    expect(within(view.container).getByRole("button", { name: "Delete section" })).toBeTruthy();
    fireEvent.click(moreButton(view.container, "Beta"));
    expect(more.getAttribute("aria-expanded")).toBe("false");
  });

  test("Escape 只收菜单，不收面板本身", () => {
    const { view } = sectionPanel();
    fireEvent.click(moreButton(view.container, "Alpha"));
    const menu = view.container.querySelector<HTMLElement>(".readora-outline-menu");
    if (!menu) {
      throw new Error("menu missing");
    }
    fireEvent.keyDown(menu, { key: "Escape" });
    expect(view.container.querySelector(".readora-outline-menu")).toBeNull();
    expect(view.container.querySelector(".readora-outline-link")).toBeTruthy();
  });

  test("点菜单外任意处即收", () => {
    const { view } = sectionPanel();
    fireEvent.click(moreButton(view.container, "Alpha"));
    expect(view.container.querySelector(".readora-outline-menu")).toBeTruthy();
    fireEvent.pointerDown(document.body);
    expect(view.container.querySelector(".readora-outline-menu")).toBeNull();
  });

  test("回声到达（items 换实例）作废菜单：不拿着旧行号的计划待续", () => {
    const element = (items: readonly OutlineItem[]) => (
      <OutlinePanel
        items={items}
        activeHeadingId={null}
        collapsedIds={new Set<string>()}
        text={SECTION_DOC}
        onToggleCollapse={() => undefined}
        onCollapsedChange={() => undefined}
        onSelect={() => undefined}
        sectionOpsEnabled
        onSectionOp={async () => null}
      />
    );
    const view = render(element(SECTION_ITEMS));
    fireEvent.click(moreButton(view.container, "Alpha"));
    expect(view.container.querySelector(".readora-outline-menu")).toBeTruthy();
    view.rerender(element([...SECTION_ITEMS]));
    expect(view.container.querySelector(".readora-outline-menu")).toBeNull();
    // 面板本身照常：作废的只是菜单，不是整栏。
    expect(view.container.querySelector(".readora-outline-link")).toBeTruthy();
  });
});

describe("章节结构菜单：动作与提示", () => {
  test("Add section after 回传文件绝对行的精确计划，成功后收菜单", async () => {
    const onSectionOp = vi.fn(async () => null as string | null);
    const { view } = sectionPanel({ onSectionOp });
    fireEvent.click(moreButton(view.container, "Alpha"));
    fireEvent.click(within(view.container).getByRole("button", { name: "Add section after" }));
    await waitFor(() => {
      expect(view.container.querySelector(".readora-outline-menu")).toBeNull();
    });
    expect(onSectionOp).toHaveBeenCalledWith("add-sibling-after", {
      range: { startLine: 15, endLine: 15 },
      newText: "\n## 新章节"
    });
  });

  test("Add sub-section 级别钳到下一档，落点在子树末行", async () => {
    const ok: SectionOpHandler = async () => null;
    const onSectionOp = vi.fn(ok);
    const { view } = sectionPanel({ onSectionOp });
    fireEvent.click(moreButton(view.container, "Alpha"));
    fireEvent.click(within(view.container).getByRole("button", { name: "Add sub-section" }));
    await waitFor(() => {
      expect(onSectionOp).toHaveBeenCalledTimes(1);
    });
    expect(onSectionOp.mock.calls[0]?.[1]).toEqual({
      range: { startLine: 15, endLine: 15 },
      newText: "\n### 新章节"
    });
  });

  test("删除两步确认：第一步报数不发写回，第二步确认才发", async () => {
    const ok: SectionOpHandler = async () => null;
    const onSectionOp = vi.fn(ok);
    const { view } = sectionPanel({ onSectionOp });
    fireEvent.click(moreButton(view.container, "Alpha"));
    fireEvent.click(within(view.container).getByRole("button", { name: "Delete section" }));
    expect(
      within(view.container).getByText("Delete 8 lines including 1 sub-section?")
    ).toBeTruthy();
    expect(onSectionOp).not.toHaveBeenCalled();
    fireEvent.click(within(view.container).getByRole("button", { name: "Confirm delete" }));
    await waitFor(() => {
      expect(onSectionOp).toHaveBeenCalledTimes(1);
    });
    expect(onSectionOp.mock.calls[0]?.[0]).toBe("delete-section");
    expect(onSectionOp.mock.calls[0]?.[1]).toEqual({
      range: { startLine: 8, endLine: 15 },
      newText: ""
    });
  });

  test("确认可退：Cancel 回到三动作，不发生写回", () => {
    const onSectionOp = vi.fn(async () => null as string | null);
    const { view } = sectionPanel({ onSectionOp });
    fireEvent.click(moreButton(view.container, "Alpha"));
    fireEvent.click(within(view.container).getByRole("button", { name: "Delete section" }));
    fireEvent.click(within(view.container).getByRole("button", { name: "Cancel" }));
    expect(within(view.container).getByRole("button", { name: "Add section after" })).toBeTruthy();
    expect(onSectionOp).not.toHaveBeenCalled();
  });

  test("末节的删除报数到文档末行（Beta：3 行、无子节）", () => {
    const { view } = sectionPanel();
    fireEvent.click(moreButton(view.container, "Beta"));
    fireEvent.click(within(view.container).getByRole("button", { name: "Delete section" }));
    expect(within(view.container).getByText("Delete 3 lines?")).toBeTruthy();
  });

  test("写回失败只留一行 role=status 提示，菜单保留可重试", async () => {
    const onSectionOp = vi.fn(
      async () => "The document changed outside the outline; open the menu again to retry."
    );
    const { view } = sectionPanel({ onSectionOp });
    fireEvent.click(moreButton(view.container, "Alpha"));
    fireEvent.click(within(view.container).getByRole("button", { name: "Add section after" }));
    const note = await waitFor(() => {
      const node = view.container.querySelector<HTMLElement>(
        '[data-readora-outline="section-note"]'
      );
      if (!node) {
        throw new Error("note missing");
      }
      return node;
    });
    expect(note.getAttribute("role")).toBe("status");
    expect(note.textContent).toContain("The document changed outside the outline");
    // 菜单不收：用户可以直接换动作重试，不必再点一次 ⋯。
    expect(view.container.querySelector(".readora-outline-menu")).toBeTruthy();
  });

  test("下一次成功把提示清掉", async () => {
    let fail = true;
    const onSectionOp = vi.fn(async () => {
      if (fail) {
        fail = false;
        return "boom";
      }
      return null;
    });
    const { view } = sectionPanel({ onSectionOp });
    fireEvent.click(moreButton(view.container, "Alpha"));
    fireEvent.click(within(view.container).getByRole("button", { name: "Add section after" }));
    await waitFor(() => {
      expect(
        view.container.querySelector('[data-readora-outline="section-note"]')
      ).toBeTruthy();
    });
    fireEvent.click(within(view.container).getByRole("button", { name: "Add section after" }));
    await waitFor(() => {
      expect(view.container.querySelector('[data-readora-outline="section-note"]')).toBeNull();
    });
  });
});
