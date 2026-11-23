/**
 * 目录面板（ARC-007 §6.1 / PRD-002 §5.1 + PRD-003 §10.7）。
 *
 * 六条展示要求在这里逐条落地：层级缩进（padding-left 按 depth）、活动高亮
 * （aria-current="location"）、父级折叠（aria-expanded + 隐藏后代而不删数据）、
 * 长目录滚动（CSS overflow-y + 焦点跟随：高亮项落到可见区外时列表滚到它身上）、
 * 标题溢出省略（CSS ellipsis + title 兜底）、无标题空态（empty 文案）。
 *
 * 折叠与活动状态都是 UI 态，由上层持有（§6.2 OutlineViewState），面板不改
 * Outline 原始数据；点击只上报锚点，定位交给 HeadingLocator（§5.3）。
 *
 * §10.7 的区块按「全部有真实数据源」取舍，进度块、源行号标签、分节字数标签
 * 与底部统计已按用户要求撤下：
 * - 头部（展开全部 / 折叠全部 / 过滤）+ 过滤输入：展开与折叠拆成两枚图标，
 *   各自只干一件事 —— 一枚靠状态换标签的双向箭头点了看不出变化（用户反馈）；
 *   过滤是面板内的临时视图态，不进上层，也不写 Host —— 一次检索不该污染恢复
 *   出来的会话状态；
 * - 行内标签全部下掉：H1 的分节字数（`93w`）与更深层级的源行号（`L28`）同理，
 *   前者是估读的体量、后者是编辑器坐标，都不是阅读信息，进度只在快速条一处出现，
 *   不再在两栏各读一遍；
 * - 底部的 `N Sections` + `Depth: H1–H{max}` 不再输出：节数在状态条已有（同一份
 *   outline 数出来的数），层级跨度读者用不上。
 *
 * 「自动展开命中」的实现口径：过滤时命中项一律可见，即折叠状态不参与过滤视图，
 * 这一行的折叠按钮也一并收掉（改了状态却看不出变化的开关就是 §4.6 要剔除的假
 * affordance），头部两枚展开/折叠按钮同步禁用并说明原因。清空过滤即回到原样。
 *
 * E7 新增：行尾的「⋯」章节结构菜单（在其后新增 / 新增子节 / 删除本节）。
 * 三条形态规矩：
 * - **入口门槛在 App**（编辑模式开 + `file:` 文档），面板只看 `sectionOpsEnabled`；
 *   未启用时零 affordance，与把手侧 §15-5 同一条门禁口径；
 * - 菜单**开在行内**而不是浮层：左栏是 `position: sticky` 窄列，绝对定位的
 *   popover 要么被列表的 overflow 裁掉要么跨栏悬浮，行内展开没有这两层问题；
 * - 删除是破坏性写回，两步确认：第一步把菜单换成「删 N 行（含 M 个子节）？」
 *   的报数（数字来自纯函数预览，不是估的），确认才发写回；写错了可回宿主撤销
 * （模型归宿主 `TextDocument`，Ctrl+Z 就能拉回），所以不再叠第三层确认。
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
import {
  ChevronDownIcon,
  ChevronRightIcon,
  CollapseIcon,
  ExpandIcon,
  FilterIcon,
  MoreIcon
} from "../app/Icon";
import {
  sectionOpPreview,
  type SectionOpAction,
  type SectionOpPlan
} from "./outline-section-ops";
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
/** 头部纯图标动作的修饰类：四周留 4px 定量内边距（16px 图标 → 点击区 26×26，细节见 shell.css）。 */
export const OUTLINE_ACTION_ICON_CLASS = "readora-outline-action--icon";
export const OUTLINE_FILTER_INPUT_ID = "readora-outline-filter-input";
/** 活动条目标记的属性与值：焦点跟随靠它找到要滚到哪个条目，不靠高亮样式反推。*/
export const OUTLINE_ACTIVE_ATTRIBUTE = "data-readora-outline";
export const OUTLINE_ACTIVE_VALUE = "active";
/** 行尾「⋯」与行内菜单的类名：导出给单测与样式，不两处各写字面量。 */
export const OUTLINE_MORE_CLASS = "readora-outline-more";
export const OUTLINE_MENU_CLASS = "readora-outline-menu";

export interface OutlinePanelProps {
  items: readonly OutlineItem[];
  activeHeadingId: string | null;
  collapsedIds: ReadonlySet<string>;
  /** Markdown 源文：章节结构菜单按源行区间算写回预览（E7）。 */
  text: string;
  onToggleCollapse(key: string): void;
  /** 展开全部交空集合 / 折叠全部交整串 key：折叠态仍由上层持有（§6.2）。 */
  onCollapsedChange(keys: readonly string[]): void;
  onSelect(anchor: string): void;
  /** 章节结构菜单的总开关（E7）：App 按「编辑模式 × `file:` 文档」门控。 */
  sectionOpsEnabled?: boolean;
  /**
   * 执行一次结构写回：成功返回 `null`，失败回一句可读文案（面板显示为提示）。
   * 乐观锁、版本记账与错误码到文案的映射都在 App，面板不持 bridge。
   * 显式 `| undefined`：`exactOptionalPropertyTypes` 下调用方要能透传可空的选项。
   */
  onSectionOp?:
    | ((action: SectionOpAction, plan: SectionOpPlan) => Promise<string | null>)
    | undefined;
}

/** 缩进按层级递增，超过 4 层不再加深（视觉上够用了，也避免窄栏里没地方放文字）。 */
const MAX_INDENT_DEPTH = 4;

function itemStyle(node: OutlineNode): CSSProperties {
  return {
    paddingLeft: `${Math.min(node.depth, MAX_INDENT_DEPTH) * 12}px`
  };
}

export function OutlinePanel({
  items,
  activeHeadingId,
  collapsedIds,
  text,
  onToggleCollapse,
  onCollapsedChange,
  onSelect,
  sectionOpsEnabled = false,
  onSectionOp
}: OutlinePanelProps) {
  const tree = useMemo(() => buildOutlineTree(items), [items]);
  const foldable = useMemo(() => collapsibleKeys(tree), [tree]);
  const activeKey = useMemo(() => activeKeyOf(tree, activeHeadingId), [tree, activeHeadingId]);

  const listRef = useRef<HTMLUListElement | null>(null);

  const [query, setQuery] = useState("");
  const [filterOpen, setFilterOpen] = useState(false);
  const needle = query.trim();
  const filtering = filterOpen && needle.length > 0;

  // 章节结构菜单的一次性状态（E7）：全栏同时只开一个菜单。
  const [menuKey, setMenuKey] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [opBusy, setOpBusy] = useState(false);
  const [opNote, setOpNote] = useState<string | null>(null);

  const closeMenu = (): void => {
    setMenuKey(null);
    setConfirmingDelete(false);
  };

  // 快照回声到达（items 换实例）：菜单里的写回计划按旧行号算好了，必须作废；
  // 提示不清 —— 用户可能正盯着那句失败原因。
  useEffect(() => {
    setMenuKey(null);
    setConfirmingDelete(false);
  }, [items]);

  // 点菜单外任意处即收：与过滤 disclosure 的「不收就一直是打开态」同理，
  // 留一个看不见归属的行内菜单在列表里比收掉更误导。
  useEffect(() => {
    if (menuKey === null) {
      return;
    }
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (target instanceof Element && target.closest(`.${OUTLINE_MENU_CLASS}, .${OUTLINE_MORE_CLASS}`)) {
        return;
      }
      closeMenu();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [menuKey]);

  /**
   * 算预览、发写回、收尾。失败文案进 `opNote`；成功只收菜单 ——
   * 新大纲由 `document.update` 回声重建，面板不自己摸本地副本（§6.2）。
   */
  const runSectionOp = async (item: OutlineItem, action: SectionOpAction): Promise<void> => {
    if (!onSectionOp) {
      return;
    }
    const preview = sectionOpPreview({ text, items, index: items.indexOf(item), action });
    if (preview === null) {
      // 预览算不出（越界 / 丢 position）：等回声重建大纲，不在这里猜区间。
      setOpNote("Section position is stale, the outline is refreshing.");
      closeMenu();
      return;
    }
    setOpBusy(true);
    try {
      const failure = await onSectionOp(action, preview.plan);
      if (failure === null) {
        closeMenu();
        setOpNote(null);
      } else {
        setOpNote(failure);
      }
    } finally {
      setOpBusy(false);
    }
  };

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
  const anyCollapsed = [...foldable].some((key) => collapsedIds.has(key));
  // 按下态读法：各自回答「这一枚现在有没有事可做」—— 展开枚看有没有折叠项，
  // 折叠枚看还有没有什么可折。点一下至少有一枚的底色跟着换，不会再出现
  // 「点了看不出变化」（用户反馈）。禁用那枚不上底色，交给 muted 前景色。
  const canCollapse = foldable.size > 0 && !allCollapsed;
  // 过滤中折叠态看不见效果，两枚按钮就该说它做不到的话别说（§4.6 诚实性）。
  const filterNote = "过滤中：命中项始终展开";

  /** 菜单内的 Escape 只关菜单：不顺手把搜索浮层/过滤 disclosure 一起关掉。 */
  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== "Escape") {
      return;
    }
    event.stopPropagation();
    closeMenu();
  };

  if (items.length === 0) {
    return (
      <nav className={OUTLINE_PANEL_CLASS} aria-label="Document outline">
        <p className="readora-outline-empty">No headings in this document.</p>
      </nav>
    );
  }

  return (
    <nav className={OUTLINE_PANEL_CLASS} aria-label="Document outline">
      {/* 头部三枚只给图标（产品反馈）：这一栏本身就是窄列，「Expand all / Collapse all /
          Filter」三串英文会把头部撑到换行，而图标位置常驻就不需要文字复述。可读名称
          全部留在 `aria-label`，`title` 给悬停解释（§10.6：图标只是控件的装饰）。
          展开与折叠拆成两枚而不是一枚靠状态换标签：双向箭头静止时读不出这一次点下去
          是展开还是折叠（用户实测「点了样式没变化」）；两枚各自常驻，淡底落在「现在
          有事可做」那一枚上 —— 全展开时底色在折叠枚，点下去折叠后就换到展开枚。 */}
      <div className="readora-outline-header">
        <button
          type="button"
          className={`readora-outline-action ${OUTLINE_ACTION_ICON_CLASS}`}
          data-readora-outline-action="expand-all"
          aria-label="Expand all"
          aria-pressed={anyCollapsed}
          disabled={filtering || !anyCollapsed}
          title={filtering ? filterNote : "展开全部折叠的章节"}
          onClick={() => {
            onCollapsedChange([]);
          }}
        >
          <ExpandIcon size={16} />
        </button>
        <button
          type="button"
          className={`readora-outline-action ${OUTLINE_ACTION_ICON_CLASS}`}
          data-readora-outline-action="collapse-all"
          aria-label="Collapse all"
          aria-pressed={canCollapse}
          disabled={filtering || !canCollapse}
          title={
            filtering ? filterNote : foldable.size === 0 ? "没有可折叠的章节" : "折叠全部章节"
          }
          onClick={() => {
            onCollapsedChange([...foldable]);
          }}
        >
          <CollapseIcon size={16} />
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
          <FilterIcon size={16} />
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

      {opNote !== null ? (
        // 写回失败的唯一可见出口（乐观锁拒收 / 区间过期 / 宿主写不进）：
        // role=status 让读屏器播报，不弹对话框 —— 一次结构操作的失败
        // 不该把用户从阅读流里踢出来，面板内一行字就够。
        <p className="readora-outline-note" data-readora-outline="section-note" role="status">
          {opNote}
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
          // 没有 `position` 的行不给菜单：拿不到源行就没有区间，编出来的写回计划更误导。
          const actionable = sectionOpsEnabled && node.item.position !== undefined;
          const menuOpen = actionable && menuKey === node.key;
          // 确认文案里的行数与子节数现场从纯函数预览拿：菜单开着的那几帧里
          // 源文若被回声换了，预览会一起重算，报出来的永远是「点确认会发生的数」。
          const deletePreview = menuOpen
            ? sectionOpPreview({ text, items, index: items.indexOf(node.item), action: "delete-section" })
            : null;
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
                {actionable ? (
                  <button
                    type="button"
                    className={OUTLINE_MORE_CLASS}
                    aria-label={`Section actions for ${label}`}
                    aria-expanded={menuOpen}
                    title="Section actions"
                    onClick={() => {
                      if (menuOpen) {
                        closeMenu();
                      } else {
                        setMenuKey(node.key);
                        setConfirmingDelete(false);
                        setOpNote(null);
                      }
                    }}
                  >
                    <MoreIcon size={12} />
                  </button>
                ) : null}
              </div>
              {menuOpen ? (
                <div className={OUTLINE_MENU_CLASS} onKeyDown={onMenuKeyDown}>
                  {confirmingDelete ? (
                    <>
                      <p className="readora-outline-menu-confirm">
                        {deletePreview === null
                          ? "Delete this section?"
                          : `Delete ${deletePreview.affectedLines} line${deletePreview.affectedLines === 1 ? "" : "s"}${deletePreview.childCount > 0 ? ` including ${deletePreview.childCount} sub-section${deletePreview.childCount === 1 ? "" : "s"}` : ""}?`}
                      </p>
                      <div className="readora-outline-menu-actions">
                        <button
                          type="button"
                          className="readora-outline-menu-item readora-outline-menu-item--danger"
                          disabled={opBusy || deletePreview === null}
                          onClick={() => {
                            void runSectionOp(node.item, "delete-section");
                          }}
                        >
                          Confirm delete
                        </button>
                        <button
                          type="button"
                          className="readora-outline-menu-item"
                          disabled={opBusy}
                          onClick={() => {
                            setConfirmingDelete(false);
                          }}
                        >
                          Cancel
                        </button>
                      </div>
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="readora-outline-menu-item"
                        disabled={opBusy}
                        onClick={() => {
                          void runSectionOp(node.item, "add-sibling-after");
                        }}
                      >
                        Add section after
                      </button>
                      <button
                        type="button"
                        className="readora-outline-menu-item"
                        disabled={opBusy}
                        onClick={() => {
                          void runSectionOp(node.item, "add-child");
                        }}
                      >
                        Add sub-section
                      </button>
                      <button
                        type="button"
                        className="readora-outline-menu-item readora-outline-menu-item--danger"
                        disabled={opBusy}
                        onClick={() => {
                          setConfirmingDelete(true);
                        }}
                      >
                        Delete section
                      </button>
                    </>
                  )}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
