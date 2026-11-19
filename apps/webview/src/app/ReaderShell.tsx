/**
 * Reader Shell 外壳（PRD-003 §10.5，ARC-005 §5.1 / §5.2，STORY-09-01）。
 *
 * 面包屑删除后定的形态：**大纲列通顶**，顶栏只在右侧内容列让位。外壳纵向两大段，
 * 主体段内部是「大纲列 | 内容列」的 grid：
 *
 *  `.readora-body`      grid 两列：大纲（`--readora-outline-width`，通顶）+ 内容列
 *    `.readora-shell-nav`   左列，`position: sticky; top: 0`，从视口顶贯到状态条上沿
 *    `.readora-shell-main`  右列（flex 纵向）：顶栏 → 搜索行 → 正文（快速条 + 画布）
 *      `.readora-topbar`    44px（`--readora-topbar-height`），装 TopBar；只占右列宽
 *      `.readora-searchbar` 随内容，装文档内搜索面板；没打开搜索时整段不输出 DOM
 *  `.readora-statusbar` 24px（`--readora-statusbar-height`），横贯整窗，装 StatusBar
 *
 * 布局约束（沿用 ARC-005 §5.3）：
 * - 大纲与主体仍是 grid 两列，目录收起、专注模式、窄窗口三种情形退成单列；单列时
 *   顶栏随内容列铺满整窗（没有大纲可让位），两列时顶栏 left 落在大纲右缘；
 * - 顶栏、搜索行、状态条都 `position: sticky`（上/下），因为滚动容器仍是 window：
 *   段落本身在流内，粘住的只是带子，正文照常整页滚；大纲列 sticky top:0 实现通顶；
 * - 窄窗口（≤900px）自动收起左栏用 matchMedia 而不是只靠 CSS 媒体查询：收起与否
 *   是可读状态，组件测试要能断言，也避免「DOM 里有一栏但看不见」这种对读屏器
 *   不诚实的隐藏；
 * - 右栏 AuxiliaryPanel 仍无数据源（ARC-005 §5.2 / PRD-003 §4.6 剔除项），
 *   留注释槽位、不输出 DOM，不得伪装已完成。
 *
 * 目录区的地标由 OutlinePanel 自己的 `<nav aria-label="Document outline">` 承担，
 * 外层 aside 不再叠 role="navigation"，免得同一区域出现两个 navigation 地标。
 */
import { useEffect, useState, type ReactNode } from "react";

/** 窄窗口断点（ARC-005 §5.3 自适应）。 */
export const COMPACT_LAYOUT_QUERY = "(max-width: 900px)";
export const SHELL_CLASS = "readora-shell";

/** 四段的稳定类名：视觉基线与 e2e 按它们取 rect，改名等于改契约。 */
export const TOPBAR_CLASS = "readora-topbar";
export const SEARCHBAR_CLASS = "readora-searchbar";
export const BODY_CLASS = "readora-body";
export const STATUSBAR_CLASS = "readora-statusbar";

export function useCompactLayout(query: string = COMPACT_LAYOUT_QUERY): boolean {
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") {
      return;
    }
    const list = window.matchMedia(query);
    const sync = (): void => {
      setCompact(list.matches === true);
    };
    sync();
    list.addEventListener?.("change", sync);
    return () => {
      list.removeEventListener?.("change", sync);
    };
  }, [query]);
  return compact;
}

export interface ReaderShellProps {
  outlineVisible: boolean;
  focusMode: boolean;
  /**
   * 专注模式下由快速条临时展开的大纲（PRD-003 §10.5）。
   *
   * 与 `outlineVisible` 分开是必须的：§11.2 说专注模式收起大纲但不改写用户偏好，
   * 所以「收起」不能落在 `outlineVisible` 上；而快速条那枚「展开大纲」又必须真的
   * 展开，于是需要第二个输入。窄窗口仍然压过它 —— 900px 以下两列会挤到不可读，
   * 因此 `QuickBar` 在窄窗口里把那枚按钮禁用，而不是让它按下去什么都不发生。
   */
  outlineExpandedInFocus?: boolean;
  /** 目录区内容（OutlinePanel）。 */
  outline: ReactNode;
  /** 顶栏内容（TopBar）。 */
  toolbar: ReactNode;
  /** 搜索行内容（SearchPanel）。null / undefined 时整段不出现。 */
  searchbar?: ReactNode;
  /** 状态条内容（StatusBar）。 */
  statusbar: ReactNode;
  /** 阅读区内容（顶部章节条 + ReadingCanvas）。 */
  children: ReactNode;
}

/**
 * 专注模式不输出顶栏段（产品反馈：隐藏了就不许留透明占位）。
 *
 * 曾经是「整段抬出视口、只留 4px 触发沿」的浮层，两个后果都是实的：4px 在真实
 * 面板里根本命中不到（用户报告“没法退出专注模式”），而段从栅格里拿出去后顶部
 * 空出一条 44px 的透明带，还把文档标题切掉半截。退出入口现在住在 `QuickBar`
 * 右侧，靠快速条自己的 hover 浮现；顶栏在专注模式下没有其余内容，就不渲染，
 * 而不是渲染一条选不到的 toolbar。四段栅格的几何只在常规档约束（e2e
 * 「四段栅格」与视觉基线都采常规档），这里少一段不越界。
 */
export function ReaderShell({
  outlineVisible,
  focusMode,
  outlineExpandedInFocus = false,
  outline,
  toolbar,
  searchbar,
  statusbar,
  children
}: ReaderShellProps) {
  const compact = useCompactLayout();
  // 专注模式与窄窗口都收左栏；窄窗口只收渲染，不改写用户的 outlineVisible 状态，
  // 于是把窗口拉宽后目录自己回来了，用户不需要再按一次快捷键。
  const showOutline =
    !compact && (outlineExpandedInFocus || (outlineVisible && !focusMode));
  const columns = showOutline ? "two" : "one";

  return (
    <div
      className={`${SHELL_CLASS} ${SHELL_CLASS}--columns-${columns}`}
      data-readora-columns={columns}
      data-readora-compact={compact ? "true" : undefined}
      data-readora-focus-mode={focusMode ? "true" : undefined}
    >
      {/* 主体段是外层栅格：左列大纲通顶，右列内容栈（顶栏 + 搜索行 + 正文）。
          顶栏/搜索行移进右列，才让得出左侧整高大纲——它们仍是 `position: sticky`
          的上/中带，只是横向不再压过大纲（面包屑删除后的两层导航整改由此定型）。 */}
      <div className={BODY_CLASS} data-readora-band="body">
        {showOutline ? <aside className="readora-shell-nav">{outline}</aside> : null}
        <div className="readora-shell-main">
          {/* 专注模式下整段不输出顶栏：只剩退出入口，而它已搬到快速条右侧，留下一个
              空段就是那条被投诉的透明占位。常规档不写多余属性，行为与旧版一致。 */}
          {focusMode ? null : (
            <div className={TOPBAR_CLASS} data-readora-band="topbar">
              {toolbar}
            </div>
          )}
          {searchbar ? (
            <div className={SEARCHBAR_CLASS} data-readora-band="searchbar">
              {searchbar}
            </div>
          ) : null}
          {children}
          {/* 右栏 AuxiliaryPanel（属性 / 反向链接）槽位：无数据源，不输出 DOM。 */}
        </div>
      </div>
      {/* 状态条仍是外壳最后一段，横贯整窗（大纲列止于其上沿）。 */}
      <div className={STATUSBAR_CLASS} data-readora-band="statusbar">
        {statusbar}
      </div>
    </div>
  );
}
