/**
 * Reader Shell 外壳四段（PRD-003 §10.5，ARC-005 §5.1 / §5.2，STORY-09-01）。
 *
 * M4/M5 是「工具栏在 main 里 + 两列 grid」。§10.5 要的是纵向四段：
 *
 *  `.readora-topbar`    44px（`--readora-topbar-height`），装 TopBar
 *  `.readora-searchbar` 随内容，装文档内搜索面板；没打开搜索时整段不输出 DOM
 *  `.readora-body`      flex row：大纲（`--readora-outline-width`）+ 阅读区
 *  `.readora-statusbar` 24px（`--readora-statusbar-height`），装 StatusBar
 *
 * 布局约束（沿用 ARC-005 §5.3）：
 * - 大纲与主体仍是 grid 两列，目录收起、专注模式、窄窗口三种情形退成单列；
 * - 顶栏与状态条都 `position: sticky`（上/下），因为滚动容器是 window：段落本身
 *   在流内，粘住的只是这两条带，正文照常整页滚；
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

/**
 * 顶栏浮层门控（产品反馈：类浏览器全屏）。
 *
 * 专注模式下退出入口默认淡出，鼠标移到顶栏这条带或键盘聚焦到它才浮现。门控只能
 * 挂在外壳而不是 `TopBar`：浮现靠的是 `.readora-topbar` 这条带自己的 `:hover`，
 * 而带的尺寸归外壳（工具栏只占带内一行），写在 `TopBar` 里选不到那个祖先。
 * 属性名 `data-readora-topbar-reveal`（即 `TOPBAR_REVEAL_ATTR`）是 CSS 与 e2e
 * 共同的锚点，改名等于改契约。
 */
export const TOPBAR_REVEAL_ATTR = "data-readora-topbar-reveal";
export const TOPBAR_REVEAL_HOVER = "hover";

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
      {/* 常规档不输出这个属性（`undefined` 让 React 直接不写）：顶栏该一直看得见，
          淡出只属于专注模式。 */}
      <div
        className={TOPBAR_CLASS}
        data-readora-band="topbar"
        data-readora-topbar-reveal={focusMode ? TOPBAR_REVEAL_HOVER : undefined}
      >
        {toolbar}
      </div>
      {searchbar ? (
        <div className={SEARCHBAR_CLASS} data-readora-band="searchbar">
          {searchbar}
        </div>
      ) : null}
      <div className={BODY_CLASS} data-readora-band="body">
        {showOutline ? <aside className="readora-shell-nav">{outline}</aside> : null}
        <div className="readora-shell-main">
          {children}
          {/* 右栏 AuxiliaryPanel（属性 / 反向链接）槽位：无数据源，不输出 DOM。 */}
        </div>
      </div>
      <div className={STATUSBAR_CLASS} data-readora-band="statusbar">
        {statusbar}
      </div>
    </div>
  );
}
