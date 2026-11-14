/**
 * Outline 树构建（ARC-007 §4，ADR-007-01：数据只来自 ARC-002 的渲染结果）。
 *
 * 输入是 `renderMarkdown().outline`（`OutlineItem[]`，文档顺序），导航层
 * 不重新解析 Markdown、不自行推断层级（§4.1）。层级关系由 `level` 决定，
 * 但必须先序展开成「与文档一致的顺序」（§4.4），于是：
 * - 没有 H1 的文档从 H2 起（§4.5）；
 * - 级别跳跃（H1 → H3）挂到最近的有效上级，不留空档；
 * - 连续同级标题互为兄弟；
 * - 空标题与重复标题不影响构建（重复锚点用序号兜底保证 key 唯一）。
 *
 * 纯函数、不触碰 DOM，折叠与高亮等 UI 态由 OutlinePanel 自己持有（§6.2）。
 */
import type { OutlineItem } from "@readora/markdown-core";

export interface OutlineNode {
  /** React key 与折叠状态的字键：锚点唯一时用锚点，撞车时追加序号。 */
  key: string;
  item: OutlineItem;
  /** 原始标题级别（1-6，§4.3 约束）。 */
  level: number;
  /** 展示缩进层级：根为 0，级别跳跃不会撑出空档。 */
  depth: number;
  /** 祖先 key 链（由外到内）：折叠隐藏判定与祖先自动展开都用它。 */
  ancestors: string[];
  children: OutlineNode[];
}

const MIN_LEVEL = 1;
const MAX_LEVEL = 6;

function clampLevel(level: number): number {
  if (!Number.isFinite(level)) {
    return MIN_LEVEL;
  }
  return Math.min(Math.max(Math.trunc(level), MIN_LEVEL), MAX_LEVEL);
}

/** 空标题也要占一个可点击的条目（§4.5「空标题不应导致导航构建失败」）。 */
export function outlineLabelOf(item: OutlineItem): string {
  const title = item.title.trim();
  return title.length > 0 ? title : "(Untitled)";
}

export function buildOutlineTree(items: readonly OutlineItem[]): OutlineNode[] {
  const roots: OutlineNode[] = [];
  // 栈里始终是「当前节点的祖先链」，因此入栈前先弹掉所有不比它更高级的节点。
  const stack: OutlineNode[] = [];
  const usedKeys = new Set<string>();

  for (const item of items) {
    const level = clampLevel(item.level);
    while (stack.length > 0 && (stack.at(-1)?.level ?? 0) >= level) {
      stack.pop();
    }
    const parent = stack.at(-1) ?? null;
    const key = uniqueKey(item.anchor, usedKeys);
    const node: OutlineNode = {
      key,
      item,
      level,
      depth: stack.length,
      ancestors: stack.map((entry) => entry.key),
      children: []
    };
    if (parent) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
    stack.push(node);
  }
  return roots;
}

function uniqueKey(anchor: string, used: Set<string>): string {
  const base = anchor.length > 0 ? anchor : "section";
  let key = base;
  let counter = 1;
  while (used.has(key)) {
    key = `${base}-${counter}`;
    counter += 1;
  }
  used.add(key);
  return key;
}

/** 前序展开：顺序与文档一致（§4.4），渲染与「隐藏后代」都在这个列表上做。 */
export function flattenOutline(nodes: readonly OutlineNode[]): OutlineNode[] {
  const out: OutlineNode[] = [];
  const walk = (list: readonly OutlineNode[]): void => {
    for (const node of list) {
      out.push(node);
      if (node.children.length > 0) {
        walk(node.children);
      }
    }
  };
  walk(nodes);
  return out;
}

/** 折叠父节点即隐藏其后代，但不删除标题数据（§6.2 第 1、2 条）。 */
export function visibleOutline(
  nodes: readonly OutlineNode[],
  collapsedIds: ReadonlySet<string>
): OutlineNode[] {
  if (collapsedIds.size === 0) {
    return flattenOutline(nodes);
  }
  return flattenOutline(nodes).filter(
    (node) => !node.ancestors.some((ancestor) => collapsedIds.has(ancestor))
  );
}

/** 有后代的节点才配折叠按钮。 */
export function collapsibleKeys(nodes: readonly OutlineNode[]): Set<string> {
  const keys = new Set<string>();
  for (const node of flattenOutline(nodes)) {
    if (node.children.length > 0) {
      keys.add(node.key);
    }
  }
  return keys;
}

/**
 * 标题子串筛选（PRD-003 §10.7 过滤框）。
 *
 * 三条口径：大小写不敏感、只看 `title`（不含锚点，命中「看起来像 URL 片段」的
 * 锚点不是用户要找的东西）、**不执行折叠** —— 命中项一律可见就是「自动展开命中」
 * 的实现方式，折叠状态本身不改写，清空过滤即回到原样。顺序仍是文档顺序。
 */
export function matchOutline(nodes: readonly OutlineNode[], needle: string): OutlineNode[] {
  const lower = needle.toLowerCase();
  return flattenOutline(nodes).filter((node) => node.item.title.toLowerCase().includes(lower));
}

/**
 * 活动标题的祖先链（§6.2 第 3 条：活动项变化时自动展开祖先）。
 * 锚点即 key 的常见情形直接查表，撞车后的序号 key 回退到前序列表里找。
 */
export function ancestorKeysOf(
  nodes: readonly OutlineNode[],
  anchor: string
): string[] {
  const flat = flattenOutline(nodes);
  const exact = flat.find((node) => node.key === anchor);
  if (exact) {
    return exact.ancestors;
  }
  return flat.find((node) => node.item.anchor === anchor)?.ancestors ?? [];
}

/** 活动项的展示 key：目录高亮与 aria-current 都按它判定。 */
export function activeKeyOf(
  nodes: readonly OutlineNode[],
  activeHeadingId: string | null
): string | null {
  if (!activeHeadingId) {
    return null;
  }
  const flat = flattenOutline(nodes);
  const exact = flat.find((node) => node.key === activeHeadingId);
  if (exact) {
    return exact.key;
  }
  return flat.find((node) => node.item.anchor === activeHeadingId)?.key ?? null;
}
