/**
 * 目录面板（ARC-007 §6.1 / PRD-002 §5.1 + PRD-003 §10.7 四块扩展）。
 *
 * 六条展示要求在这里逐条落地：层级缩进（padding-left 按 depth）、活动高亮
 * （aria-current="location"）、父级折叠（aria-expanded + 隐藏后代而不删数据）、
 * 长目录滚动（CSS overflow-y + 焦点跟随：高亮项落到可见区外时列表滚到它身上）、
 * 标题溢出省略（CSS ellipsis + title 兜底）、无标题空态（empty 文案）。
 *
 * 折叠与活动状态都是 UI 态，由上层持有（§6.2 OutlineViewState），面板不改
 * Outline 原始数据；点击只上报锚点，定位交给 HeadingLocator（§5.3）。
 *
 * §10.7 的区块按「全部有真实数据源」取舍，进度块、源行号标签与底部统计已按用户要求撤下：
 * - 头部（展开全部 / 过滤）+ 过滤输入：过滤是面板内的临时视图态，不进上层，
 *   也不写 Host —— 一次检索不该污染恢复出来的会话状态；
 * - 行内标签：只给 H1 显示分节字数，`position` 缺失就不显示 —— 没有源行就没有
 *   区间，猜出来的字数比不写更误导。更深层级原先显示源行号（`L28`），行号是编辑
 *   器坐标而不是阅读信息，于是整条链路一并去掉，
 *   进度只在快速条一处出现，不再在两栏各读一遍；
 * - 底部的 `N Sections` + `Depth: H1–H{max}` 不再输出：节数在状态条已有（同一份
 *   outline 数出来的数），层级跨度读者用不上。
 *
 * 「自动展开命中」的实现口径：过滤时命中项一律可见，即折叠状态不参与过滤视图，
 * 这一行的折叠按钮也一并收掉（改了状态却看不出变化的开关就是 §4.6 要剔除的假
 * affordance），头部「展开全部」同步禁用并说明原因。清空过滤即回到原样。
 */
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent
} from "react";
import type { OutlineItem } from "@readora/markdown-core";
import { formatSectionUnits } from "../app/text-metrics";
import { ChevronDownIcon, ChevronRightIcon, ExpandIcon, FilterIcon } from "../app/Icon";
import { useSectionMetrics, type SectionMetricsMap } from "./section-metrics";
import {
  activeKeyOf,
  buildOutlineTree,
  collapsibleKeys,
  matchOutline,
  outlineLabelOf,
  visibleOutline,
  type OutlineNode
} from "./outline-tree";

export const OUTLINE_PANEL_CLASS = "readora-outline-panel";
export const COLLAPSED_CLASS = "readora-outline-item--collapsed";
/** 头部纯图标动作的修饰类：左右内边距改成与图标等宽的定量（点击区 22×18，细节见 shell.css）。 */
export const OUTLINE_ACTION_ICON_CLASS = "readora-outline-action--icon";
export const OUTLINE_FILTER_INPUT_ID = "readora-outline-filter-input";
/** 活动条目标记的属性与值：焦点跟随靠它找到要滚到哪个条目，不靠高亮样式反推。*/
export const OUTLINE_ACTIVE_ATTRIBUTE = "data-readora-outline";
export const OUTLINE_ACTIVE_VALUE = "active";

export interface OutlinePanelProps {
  items: readonly OutlineItem[];
  activeHeadingId: string | null;
  collapsedIds: ReadonlySet<string>;
  /** Markdown 源文：分节字数按相邻标题的源行区间计数（§10.7）。 */
  text: string;
  onToggleCollapse(key: string): void;
  /** 展开全部 / 折叠全部：整串 key 交回上层，折叠态仍由上层持有（§6.2）。 */
  onCollapsedChange(keys: readonly string[]): void;
  onSelect(anchor: string): void;
}

/** 缩进按层级递增，超过 4 层不再加深（视觉上够用了，也避免窄栏里没地方放文字）。 */
const MAX_INDENT_DEPTH = 4;

function itemStyle(node: OutlineNode): CSSProperties {
  return {
    paddingLeft: `${Math.min(node.depth, MAX_INDENT_DEPTH) * 12}px`
  };
}

/**
 * 行内标签：只有 H1 给分节字数 → `840w`（§10.7）。
 * 拿不到分节度量（条目没有 `position`）就返回 null，不编一个 0w。
 */
function inlineLabelOf(node: OutlineNode, metrics: SectionMetricsMap): string | null {
  if (node.level !== 1) {
    return null;
  }
  const section = metrics.get(node.item);
  return section ? formatSectionUnits(section.units) : null;
}

export function OutlinePanel({
  items,
  activeHeadingId,
  collapsedIds,
  text,
  onToggleCollapse,
  onCollapsedChange,
  onSelect
}: OutlinePanelProps) {
  const tree = useMemo(() => buildOutlineTree(items), [items]);
  const foldable = useMemo(() => collapsibleKeys(tree), [tree]);
  const activeKey = useMemo(() => activeKeyOf(tree, activeHeadingId), [tree, activeHeadingId]);
  const metrics = useSectionMetrics(text, items);

  const listRef = useRef<HTMLUListElement | null>(null);

  const [query, setQuery] = useState("");
  const [filterOpen, setFilterOpen] = useState(false);
  const needle = query.trim();
  const filtering = filterOpen && needle.length > 0;

  // 折叠隐藏与过滤命中是两条互斥的可见性规则：过滤时命中项一律可见（见头注）。
  const visible = useMemo(
    () => (filtering ? matchOutline(tree, needle) : visibleOutline(tree, collapsedIds)),
    [tree, collapsedIds, filtering, needle]
  );
  const total = items.length;

  /**
   * 焦点跟随（用户报「高亮会跟着走，但活动项在窗口外时目录不跟着滚」）。
   *
   * 只改列表自己的 `scrollTop`：不用 `scrollIntoView`，它会沿着祖先链把 window
   * 也一起滚 —— 读者只是在读正文，正文却被目录拽走一屏（本仓唯一的滚动容器是
   * window，见 `use-reading-progress` 头注）。
   *
   * 用 rect 差值而不是 `offsetTop`：`offsetTop` 相对最近的定位祖先，而左栏本身就是
   * `position: sticky`，条目那一行并没有 `position: relative`，拿它当列表内坐标使不得。
   *
   * 即时而不是平滑：正文每滚过一节就换一个活动项，动画会让列表一直在追上一个
   * 目标。依赖除了 `activeKey` 还有 `visible`：折叠与过滤会把活动项移出 / 移回
   * 可见区，那两次都得重算一次位置。
   */
  useEffect(() => {
    const list = listRef.current;
    if (!list) {
      return;
    }
    const item = list.querySelector<HTMLElement>(
      `[${OUTLINE_ACTIVE_ATTRIBUTE}="${OUTLINE_ACTIVE_VALUE}"]`
    );
    if (!item) {
      return;
    }
    const listBox = list.getBoundingClientRect();
    const itemBox = item.getBoundingClientRect();
    // 几何不可信就不动：栏被收起来（专注模式 / 窄窗口）时两处高都是 0，
    // 此时写 scrollTop 会把「上次滚到哪」的读数当成 0，回来时位置丢了。
    if (listBox.height === 0 || itemBox.height === 0) {
      return;
    }
    if (itemBox.top < listBox.top) {
      list.scrollTop -= listBox.top - itemBox.top;
    } else if (itemBox.bottom > listBox.bottom) {
      list.scrollTop += itemBox.bottom - listBox.bottom;
    }
  }, [activeKey, visible]);

  const closeFilter = (): void => {
    setFilterOpen(false);
    // 收起 disclosure 必须同时清掉查询：留一个「看不见但仍在生效」的过滤条件是幽灵状态。
    setQuery("");
  };

  const onFilterKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key !== "Escape") {
      return;
    }
    // §10.7：Escape 清空。清空后输入框留着，用户可以接着打别的词；
    // 想彻底退出就再按一次 Escape（外层会把它交给宿主，面板不再拦截）。
    event.stopPropagation();
    if (needle.length > 0) {
      setQuery("");
      return;
    }
    closeFilter();
  };

  const allCollapsed =
    foldable.size > 0 && [...foldable].every((key) => collapsedIds.has(key));
  const expandLabel = allCollapsed ? "Expand all" : "Collapse all";

  if (items.length === 0) {
    return (
      <nav className={OUTLINE_PANEL_CLASS} aria-label="Document outline">
        <p className="readora-outline-empty">No headings in this document.</p>
      </nav>
    );
  }

  return (
    <nav className={OUTLINE_PANEL_CLASS} aria-label="Document outline">
      {/* 头部两枚只给图标（产品反馈）：这一栏本身就是窄列，「Collapse all / Filter」
          两串英文会把头部撑到换行，而图标位置常驻就不需要文字复述。可读名称全部
          留在 `aria-label`，`title` 给悬停解释（§10.6：图标只是控件的装饰）。 */}
      <div className="readora-outline-header">
        <button
          type="button"
          className={`readora-outline-action ${OUTLINE_ACTION_ICON_CLASS}`}
          data-readora-outline-action="expand-all"
          aria-label={expandLabel}
          // 过滤中折叠态看不见效果，按钮就该说它做不到的话别说（§4.6 诚实性）。
          disabled={filtering}
          title={filtering ? "过滤中：命中项始终展开" : expandLabel}
          onClick={() => {
            onCollapsedChange(allCollapsed ? [] : [...foldable]);
          }}
        >
          <ExpandIcon size={12} />
        </button>
        <button
          type="button"
          className={`readora-outline-action ${OUTLINE_ACTION_ICON_CLASS}`}
          data-readora-outline-action="filter"
          aria-label="Filter"
          title="Filter"
          aria-expanded={filterOpen}
          aria-controls={OUTLINE_FILTER_INPUT_ID}
          onClick={() => {
            if (filterOpen) {
              closeFilter();
            } else {
              setFilterOpen(true);
            }
          }}
        >
          <FilterIcon size={12} />
        </button>
      </div>

      {filterOpen ? (
        <input
          id={OUTLINE_FILTER_INPUT_ID}
          className="readora-outline-filter-input"
          type="text"
          // 这是标题子串筛选，不是文档内搜索：不抢 `Ctrl+F` 那条通道，也不高亮正文。
          placeholder="Filter headings"
          aria-label="Filter headings"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
          }}
          onKeyDown={onFilterKeyDown}
        />
      ) : null}

      {filtering ? (
        <p className="readora-outline-filter-note" data-readora-outline="filter-note">
          {visible.length === 0
            ? `No headings match “${needle}”`
            : `${visible.length} of ${total} headings match`}
        </p>
      ) : null}

      <ul className="readora-outline-list" ref={listRef}>
        {visible.map((node) => {
          // 过滤视图不执行折叠：命中项必须看得见（§10.7「自动展开命中」）。
          // 既然折叠不生效，这一行就不摆折叠按钮 —— 留一个改了状态却看不出
          // 任何变化的开关，正是 §4.6 要剔除的那类假 affordance。
          const collapsible = foldable.has(node.key) && !filtering;
          const collapsed = collapsedIds.has(node.key);
          const label = outlineLabelOf(node.item);
          const inline = inlineLabelOf(node, metrics);
          return (
            <li
              key={node.key}
              className={`readora-outline-item${collapsed && !filtering ? ` ${COLLAPSED_CLASS}` : ""}`}
              style={itemStyle(node)}
              data-readora-outline={node.key === activeKey ? OUTLINE_ACTIVE_VALUE : undefined}
            >
              <div className="readora-outline-row">
                {collapsible ? (
                  <button
                    type="button"
                    className="readora-outline-toggle"
                    aria-expanded={!collapsed}
                    aria-label={`${collapsed ? "Expand" : "Collapse"} ${label}`}
                    onClick={() => {
                      onToggleCollapse(node.key);
                    }}
                  >
                    {collapsed ? <ChevronRightIcon size={12} /> : <ChevronDownIcon size={12} />}
                  </button>
                ) : (
                  <span className="readora-outline-toggle-spacer" aria-hidden="true" />
                )}
                <a
                  href={`#${node.item.anchor}`}
                  className="readora-outline-link"
                  title={label}
                  aria-label={label}
                  aria-current={node.key === activeKey ? "location" : undefined}
                  onClick={(event) => {
                    // 阻止原生 hash 跳转：定位必须由 locator 统一执行（§5.3），
                    // 否则 reduced-motion 偏好与顶部预留都会绕过导航层。
                    event.preventDefault();
                    onSelect(node.item.anchor);
                  }}
                >
                  {label}
                </a>
                {inline ? (
                  <span
                    className="readora-outline-meta"
                    // 行内标签是补充信息，读屏器不该把它念成标题的一部分。
                    aria-hidden="true"
                  >
                    {inline}
                  </span>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
