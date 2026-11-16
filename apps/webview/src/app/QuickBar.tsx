/**
 * 顶部章节条（PRD-003 §10.5「快速条」，位置按产品反馈从底部浮动改到顶部）。
 *
 * `position: sticky; top`，贴在顶栏下方：滚到文档中段时，用户不用先滚回顶部
 * 才能确认「我在哪一节、读了多少」。两个字段都有真实数据源 ——
 * 活动标题来自 `useActiveHeading` 的判定结果（按 anchor 回查 outline 拿标题文本），
 * 百分比来自 `useReadingProgress`。
 *
 * 「回到顶部」已按产品反馈下掉：它把两个不相干的动作（读与导航）挤在同一行里，
 * 而窗口滚动本身随时可用，键盘与滚轮都不需要这个入口。
 *
 * 长标题不撑破这一行：`readora-quickbar-heading` 靠 ellipsis 自动截断，
 * 完整文本走 `title` 属性（与目录行同一口径），否则一条长标题就能把进度
 * 顶出窗口。
 *
 * 专注模式下多两枚按钮，且这一条就是全部的 chrome：顶栏整段不出现（产品反馈：
 * 隐藏后不许留透明占位），退出入口搬到本条右侧。§11.2 把顶栏收成只剩退出入口，
 * 此时大纲是唯一的导航手段，不能让用户为了跳一节先退出专注模式。展开大纲翻的是
 * `App` 里那份专注模式临时展开，不是用户的 `outlineVisible` —— 写后者会让退出专注
 * 后目录回不来；而 `outlineExpanded` 传的是**当前真的展开了没有**，否则
 * `aria-pressed` 就成了一个自说自话的状态（§4.6 的诚实性同样适用于属性）。
 *
 * 退出入口默认不显示，鼠标移到本条或键盘聚焦到本条才浮现。触发区是快速条自己
 * （33px 高、整屏宽），浮现后按钮原地不动，于是「想点它」和「触发它出现」落在
 * 同一块区域，不存在两者抢命中的问题 —— 顶栏整条浮层那版就是栽在这里：4px
 * 触发沿按不到，44px 空带还压着唯一的导航退路。
 */
import { useCompactLayout } from "./ReaderShell";
import { FocusIcon, OutlineIcon } from "./Icon";
import { formatProgress } from "./use-reading-progress";

export const QUICKBAR_CLASS = "readora-quickbar";

export interface QuickBarProps {
  /** 活动标题文本；没有标题或尚未判定时传 null，此时该槽位留空而不是写占位文案。 */
  activeHeadingTitle: string | null;
  progress: number;
  focusMode: boolean;
  /** 大纲此刻是否真的可见（决定 `aria-pressed`）。 */
  outlineExpanded: boolean;
  onToggleOutline(): void;
  /** 退出专注模式。只在专注档渲染，因此常规档不会为它传值也不会有入口。 */
  onToggleFocusMode(): void;
}

export function QuickBar({
  activeHeadingTitle,
  progress,
  focusMode,
  outlineExpanded,
  onToggleOutline,
  onToggleFocusMode
}: QuickBarProps) {
  /* 窄窗口塞不下两列，`ReaderShell` 会连这份临时展开一起收掉。此时把按钮禁用并
   * 说明原因，比让它按下去没反应诚实（§4.6：不给做不到的 affordance）。 */
  const compact = useCompactLayout();
  return (
    <div className={QUICKBAR_CLASS} role="toolbar" aria-label="Quick navigation">
      <span
        className="readora-quickbar-heading"
        data-readora-quickbar="heading"
        title={activeHeadingTitle ?? undefined}
      >
        {activeHeadingTitle ?? ""}
      </span>
      {focusMode ? (
        <button
          type="button"
          className="readora-quickbar-button readora-quickbar-exit"
          data-readora-quickbar="exit"
          aria-label="Exit focus mode"
          title="Exit full screen reading mode"
          onClick={onToggleFocusMode}
        >
          <FocusIcon />
          Exit focus mode
        </button>
      ) : null}
      <span
        className="readora-quickbar-progress"
        data-readora-quickbar="progress"
        role="progressbar"
        aria-label="Document reading progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(Math.min(1, Math.max(0, progress)) * 100)}
        aria-valuetext={`${formatProgress(progress)} through document`}
      >
        {formatProgress(progress)}
      </span>
      {focusMode ? (
        <div className="readora-quickbar-actions">
          <button
            type="button"
            className="readora-quickbar-button"
            aria-pressed={outlineExpanded}
            aria-label="Expand outline"
            disabled={compact}
            title={compact ? "窗口太窄，放不下大纲栏" : undefined}
            onClick={onToggleOutline}
          >
            <OutlineIcon />
            Outline
          </button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * 按 anchor 回查标题文本：找不到（标题被删、锚点漂移）就返回 null，
 * 快速条留空槽位，不把上一个标题继续挂在新位置上。
 */
export function activeHeadingTitleOf(
  outline: readonly { anchor: string; title: string }[],
  activeHeadingId: string | null
): string | null {
  if (!activeHeadingId) {
    return null;
  }
  return outline.find((item) => item.anchor === activeHeadingId)?.title ?? null;
}
