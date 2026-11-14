/**
 * Outline 树构建测试（ARC-007 §4.4 / §4.5，STORY-07-01）。
 *
 * 逐条对着 §4.5 的特殊标题处理断言，外加 §14.1 的「标题顺序与文档一致」。
 */
import { describe, expect, test } from "vitest";
import type { OutlineItem } from "@readora/markdown-core";
import {
  ancestorKeysOf,
  activeKeyOf,
  buildOutlineTree,
  collapsibleKeys,
  flattenOutline,
  outlineLabelOf,
  visibleOutline
} from "../outline-tree";

function item(title: string, level: number, anchor = title): OutlineItem {
  return { id: `n-${anchor}`, title, level, anchor };
}

describe("层级构建", () => {
  test("H1 下的 H2 / H3 形成父子链，depth 逐级加一", () => {
    const tree = buildOutlineTree([
      item("Overview", 1, "overview"),
      item("Architecture", 2, "architecture"),
      item("Application Layer", 3, "application-layer"),
      item("Rendering Layer", 3, "rendering-layer"),
      item("Implementation", 2, "implementation")
    ]);
    expect(tree.map((node) => node.key)).toEqual(["overview"]);
    const flat = flattenOutline(tree);
    expect(flat.map((node) => [node.key, node.depth])).toEqual([
      ["overview", 0],
      ["architecture", 1],
      ["application-layer", 2],
      ["rendering-layer", 2],
      ["implementation", 1]
    ]);
  });

  test("前序展开的顺序与文档一致（§4.4）", () => {
    const items = [
      item("A", 1),
      item("B", 3),
      item("C", 2),
      item("D", 4),
      item("E", 1)
    ];
    expect(flattenOutline(buildOutlineTree(items)).map((node) => node.item.title)).toEqual(
      items.map((entry) => entry.title)
    );
  });

  test("没有 H1 的文档从 H2 起（§4.5）", () => {
    const tree = buildOutlineTree([item("Intro", 2, "intro"), item("Detail", 3, "detail")]);
    expect(tree.map((node) => node.key)).toEqual(["intro"]);
    expect(tree[0]?.children.map((node) => node.key)).toEqual(["detail"]);
  });

  test("级别跳跃挂到最近的有效上级，不留空档（§4.5）", () => {
    const tree = buildOutlineTree([
      item("H1", 1, "h1"),
      item("H4", 4, "h4"),
      item("H6", 6, "h6")
    ]);
    const flat = flattenOutline(tree);
    expect(flat.map((node) => node.ancestors)).toEqual([
      [],
      ["h1"],
      ["h1", "h4"]
    ]);
  });

  test("连续同级标题互为兄弟（§4.5）", () => {
    const tree = buildOutlineTree([item("a", 2, "a"), item("b", 2, "b"), item("c", 2, "c")]);
    expect(tree).toHaveLength(3);
    expect(tree.every((node) => node.depth === 0)).toBe(true);
  });

  test("子节点先于父节点出现在更高级标题之后（H3 出现在 H1 之前时按根处理）", () => {
    const tree = buildOutlineTree([item("deep", 3, "deep"), item("top", 1, "top")]);
    expect(tree.map((node) => node.key)).toEqual(["deep", "top"]);
  });

  test("level 越界与非有限值都被收进 1-6（§4.3 约束）", () => {
    const tree = buildOutlineTree([
      { id: "1", title: "zero", level: 0, anchor: "zero" },
      { id: "2", title: "nine", level: 9, anchor: "nine" },
      { id: "3", title: "nan", level: Number.NaN, anchor: "nan" }
    ]);
    expect(flattenOutline(tree).map((node) => node.level)).toEqual([1, 6, 1]);
  });

  test("重复锚点不撞 key，祖先链仍按锚点语义工作（§4.5）", () => {
    const tree = buildOutlineTree([
      item("Dup", 1, "dup"),
      item("Child", 2, "child"),
      item("Dup", 1, "dup")
    ]);
    expect(flattenOutline(tree).map((node) => node.key)).toEqual([
      "dup",
      "child",
      "dup-1"
    ]);
  });

  test("空标题与空锚点都不影响构建（§4.5）", () => {
    const tree = buildOutlineTree([item("", 2, ""), item("ok", 2, "ok")]);
    const flat = flattenOutline(tree);
    expect(flat.map((node) => node.key)).toEqual(["section", "ok"]);
    expect(outlineLabelOf(flat[0]?.item as OutlineItem)).toBe("(Untitled)");
  });
});

describe("折叠与活动态辅助", () => {
  const items = [
    item("Root", 1, "root"),
    item("Branch", 2, "branch"),
    item("Leaf", 3, "leaf"),
    item("Other", 2, "other")
  ];
  const tree = buildOutlineTree(items);

  test("折叠父节点只隐藏后代，数据不删（§6.2 第 1、2 条）", () => {
    const visible = visibleOutline(tree, new Set(["branch"]));
    expect(visible.map((node) => node.key)).toEqual(["root", "branch", "other"]);
    expect(flattenOutline(tree)).toHaveLength(4);
  });

  test("折叠根节点收起整棵子树，根自己仍在", () => {
    expect(visibleOutline(tree, new Set(["root"])).map((node) => node.key)).toEqual(["root"]);
  });

  test("只有带后代的节点可折叠", () => {
    expect([...collapsibleKeys(tree)].sort()).toEqual(["branch", "root"]);
  });

  test("祖先链可按锚点或 key 查（§6.2 第 3 条）", () => {
    expect(ancestorKeysOf(tree, "leaf")).toEqual(["root", "branch"]);
    expect(ancestorKeysOf(tree, "missing")).toEqual([]);
  });

  test("活动锚点解析成展示 key，未知锚点返回 null", () => {
    expect(activeKeyOf(tree, "leaf")).toBe("leaf");
    expect(activeKeyOf(tree, "missing")).toBeNull();
    expect(activeKeyOf(tree, null)).toBeNull();
  });
});
