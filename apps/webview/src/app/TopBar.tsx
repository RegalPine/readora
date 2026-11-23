/**
 * 顶栏（PRD-003 §10.5 外壳第一段，UX-001 / UX-003 / UX-006）。
 *
 * 顶栏只留动作控件，分两坨摆：大纲开合**靠左**（紧邻左侧通顶的大纲列），其余
 * 控件（编辑、专注、搜索、缩放组、导出、Reader Settings）成组**靠右**
 * （`.readora-toolbar-actions` 的 `margin-left: auto` 撑起中间空白）。
 * 数据源都在组件外部真实存在：
 *
 *  缩放组        会话内 `useZoom`，50%–200% 步长 10%，点百分号复位。
 *  Settings      弹层触发器不是路由：`aria-haspopup="dialog"` + `aria-expanded`。
 *
 * 面包屑不在这里：readora 以自定义编辑器形态接管 Markdown（ARC-004 §7.2），
 * 宿主会在编辑器上方画出**原生面包屑**（路径链 + 同级文件切换）。自绘一条就是
 * 第二层冗余导航，违背「用 VS Code 的，不用自己实现」，故顶栏不再画面包屑。
 *
 * 阅读时长 pill 与模式标签也不在这里：产品反馈要它们退到底部右侧（状态条右端），
 * 归 `StatusBar`（口径不变：空文档不出时长 pill，§5.6）。
 *
 * 三个常驻按钮继续用 `aria-pressed` 表达开合（§4.3 状态可见性）。
 */
import type { ExportFormat } from "@readora/contracts";
import type { ZoomApi } from "./zoom";
import { EDIT_UNAVAILABLE_TITLE } from "../content/edit/limits";
import { ExportMenu } from "./ExportMenu";
import { EditIcon, ExportIcon, FocusIcon, MinusIcon, OutlineToggleIcon, PlusIcon, SearchIcon, SettingsIcon } from "./Icon";

export const TOOLBAR_CLASS = "readora-toolbar";
export const TOOLBAR_ACTIONS_CLASS = "readora-toolbar-actions";
export const ZOOM_GROUP_CLASS = "readora-zoom";
/** M11：导出触发器与它的下拉菜单需要一个定位上下文，菜单是触发器的绝对定位子层。 */
export const EXPORT_GROUP_CLASS = "readora-toolbar-export-group";

export interface TopBarProps {
  outlineVisible: boolean;
  searchOpen: boolean;
  /** 编辑模式开关（ARC-009 §7.2，E2）：与专注互斥，因此相邻摆放。 */
  editMode: boolean;
  /** 只读判据：非 `file:` 文档上这枚按钮禁用（不隐藏）。 */
  editAvailable: boolean;
  /** Reader Settings 弹层的开合，落到触发器的 `aria-expanded`。 */
  settingsOpen: boolean;
  /** Export 下拉菜单的开合（M11）：状态在 App，触发器只报告图。 */
  exportOpen: boolean;
  zoom: ZoomApi;
  onToggleOutline(): void;
  onToggleFocusMode(): void;
  onToggleEditMode(): void;
  onToggleSearch(): void;
  onToggleSettings(): void;
  onToggleExport(): void;
  /** 菜单自己关闭（Esc / 点外面 / 选完一项）：不走 toggle，免得两次 toggle 抵消。 */
  onCloseExport(): void;
  onExport(format: ExportFormat): void;
}

export function TopBar({
  outlineVisible,
  searchOpen,
  settingsOpen,
  exportOpen,
  editMode,
  editAvailable,
  zoom,
  onToggleOutline,
  onToggleFocusMode,
  onToggleEditMode,
  onToggleSearch,
  onToggleSettings,
  onToggleExport,
  onCloseExport,
  onExport
}: TopBarProps) {
  // 专注模式不在这里分支：那一段由 `ReaderShell` 整段不渲染，退出入口住在快速条
  // 右侧。留一个 `focusMode` 在这里只会供出一个选不中的退出按钮（旧版就是这么
  // 把退出入口藏到 4px 触发沿里的）。
  return (
    <div className={TOOLBAR_CLASS} role="toolbar" aria-label="Reading controls">
      {/* 大纲开合靠左：它紧邻左侧通顶的大纲列，开关与它控制的面板在同一侧，
          视线不用横穿整条顶栏找按钮。其余动作仍成组靠右。
          只给图标不给文字（产品反馈）：常驻且就在栏位边上的开关不需要标签自证，
          可读名称仍由 `aria-label` 承担，`title` 补鼠标悬停的解释（§10.6：图标是装饰）。 */}
      <button
        type="button"
        className={`readora-toolbar-button ${TOOLBAR_CLASS}-button--icon ${TOOLBAR_CLASS}-outline`}
        aria-pressed={outlineVisible}
        aria-label="Toggle outline"
        title={outlineVisible ? "Hide outline" : "Show outline"}
        onClick={onToggleOutline}
      >
        <OutlineToggleIcon visible={outlineVisible} />
      </button>
      <div className={TOOLBAR_ACTIONS_CLASS}>
        {/* Edit 排在 Focus 之前：两个互斥的模式开关相邻摆放，看一眼就知道不能同开
            （ARC-009 §7.3）。禁用而非隐藏：隐藏会让功能看起来坏了。 */}
        <button
          type="button"
          className="readora-toolbar-button readora-toolbar-edit"
          aria-pressed={editMode}
          aria-label="Edit mode"
          title={editAvailable ? "Edit paragraphs in place" : EDIT_UNAVAILABLE_TITLE}
          disabled={!editAvailable}
          onClick={onToggleEditMode}
        >
          <EditIcon />
          Edit
        </button>
        <button
          type="button"
          className="readora-toolbar-button"
          aria-pressed={false}
          aria-label="Enter focus mode"
          onClick={onToggleFocusMode}
        >
          <FocusIcon />
          Focus
        </button>
        <button
          type="button"
          className="readora-toolbar-button"
          aria-pressed={searchOpen}
          aria-label="Search in document"
          onClick={onToggleSearch}
        >
          <SearchIcon />
          Search
        </button>
        <ZoomGroup zoom={zoom} />
        <div className={EXPORT_GROUP_CLASS}>
          <button
            type="button"
            className={`readora-toolbar-button ${TOOLBAR_CLASS}-export`}
            data-readora-export-menu="true"
            aria-haspopup="menu"
            aria-expanded={exportOpen}
            aria-label="Export document"
            onClick={onToggleExport}
          >
            <ExportIcon />
            Export
          </button>
          {/* 菜单只在非专注模式下可达（§11.2，也是导出那轮的锁定口径：不新增第二条
              入口）：专注模式下 `ReaderShell` 不渲染顶栏段，本段连同触发器一起不在 DOM。 */}
          <ExportMenu open={exportOpen} onSelect={onExport} onClose={onCloseExport} />
        </div>
        <button
          type="button"
          className={`readora-toolbar-button ${TOOLBAR_CLASS}-settings`}
          aria-haspopup="dialog"
          aria-expanded={settingsOpen}
          aria-label="Reader settings"
          onClick={onToggleSettings}
        >
          <SettingsIcon />
          Settings
        </button>
      </div>
    </div>
  );
}

function ZoomGroup({ zoom }: { zoom: ZoomApi }) {
  return (
    <div className={ZOOM_GROUP_CLASS} role="group" aria-label="Zoom">
      <button
        type="button"
        className="readora-zoom-button readora-zoom-step"
        aria-label="Zoom out"
        disabled={!zoom.canZoomOut}
        onClick={zoom.zoomOut}
      >
        <MinusIcon size={12} />
      </button>
      <button
        type="button"
        className="readora-zoom-button readora-zoom-value"
        aria-label="Reset zoom"
        onClick={zoom.reset}
      >
        {zoom.display}
      </button>
      <button
        type="button"
        className="readora-zoom-button readora-zoom-step"
        aria-label="Zoom in"
        disabled={!zoom.canZoomIn}
        onClick={zoom.zoomIn}
      >
        <PlusIcon size={12} />
      </button>
    </div>
  );
}
