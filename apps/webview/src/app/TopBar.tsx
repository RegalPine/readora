/**
 * 顶栏（PRD-003 §10.5 外壳第一段，UX-001 / UX-003 / UX-006）。
 *
 * M6 之前只有三枚按钮。§10.5 要求的是「大纲开合、面包屑、阅读时长 pill、
 * 模式标签、Reader Settings、缩放组、搜索、专注模式」，本节补齐剩下五样，
 * 每样的数据源都在组件外部真实存在：
 *
 *  面包屑        `DocumentSnapshot.documentUri` 去 scheme 取末 3 段，
 *                目录段 muted、文件名 primary，**纯文本不可点** ——
 *                §4.6 明确剔除「可点击目录段」，因为没有 reveal-in-explorer 能力，
 *                给了就是假 affordance。
 *  缩放组        会话内 `useZoom`，50%–200% 步长 10%，点百分号复位。
 *  Settings      弹层触发器不是路由：`aria-haspopup="dialog"` + `aria-expanded`。
 *
 * 阅读时长 pill 与模式标签不在这里：产品反馈要它们退到底部右侧（状态条右端），
 * 顶栏只留动作控件，归 `StatusBar`（口径不变：空文档不出时长 pill，§5.6）。
 *
 * 三个常驻按钮继续用 `aria-pressed` 表达开合（§4.3 状态可见性）。
 */
import type { ExportFormat } from "@readora/contracts";
import type { ZoomApi } from "./zoom";
import { ExportMenu } from "./ExportMenu";
import { ExportIcon, FocusIcon, MinusIcon, OutlineIcon, PlusIcon, SearchIcon, SettingsIcon } from "./Icon";

export const TOOLBAR_CLASS = "readora-toolbar";
export const TOOLBAR_ACTIONS_CLASS = "readora-toolbar-actions";
export const BREADCRUMB_CLASS = "readora-breadcrumb";
export const ZOOM_GROUP_CLASS = "readora-zoom";
/** M11：导出触发器与它的下拉菜单需要一个定位上下文，菜单是触发器的绝对定位子层。 */
export const EXPORT_GROUP_CLASS = "readora-toolbar-export-group";

/** 面包屑段数上限（§10.5：取末 3 段，再长就只是噪声）。 */
export const BREADCRUMB_MAX_SEGMENTS = 3;

/** scheme 与 authority：`file:///a/b.md`、`vscode-file://vscode-app/a/b.md` 都要剥掉。 */
const SCHEME_PREFIX = /^[a-z][a-z0-9+.-]*:\/\/[^/]*/iu;

export interface BreadcrumbSegment {
  readonly name: string;
  /** 末段是文件名（primary），其余是目录段（muted）。 */
  readonly directory: boolean;
}

/**
 * `documentUri` → 末 3 段。
 *
 * 先剥 scheme 与 authority 再切分；百分号编码要还原成人读的目录名（工作区路径
 * 里的空格在 URI 里是 `%20`，直接显示会把用户绕晕），解码失败按原文显示 ——
 * 一个显示用的字符串不值得为此抛穿渲染。
 */
export function breadcrumbOf(documentUri: string | undefined): BreadcrumbSegment[] {
  if (!documentUri) {
    return [];
  }
  const path = documentUri.replace(SCHEME_PREFIX, "");
  const parts = path.split("/").filter((segment) => segment.length > 0);
  const tail = parts.slice(-BREADCRUMB_MAX_SEGMENTS);
  return tail.map((segment, index) => ({
    name: decodeSegment(segment),
    directory: index < tail.length - 1
  }));
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export interface TopBarProps {
  outlineVisible: boolean;
  searchOpen: boolean;
  /** Reader Settings 弹层的开合，落到触发器的 `aria-expanded`。 */
  settingsOpen: boolean;
  /** Export 下拉菜单的开合（M11）：状态在 App，触发器只报告图。 */
  exportOpen: boolean;
  documentUri: string | undefined;
  zoom: ZoomApi;
  onToggleOutline(): void;
  onToggleFocusMode(): void;
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
  documentUri,
  zoom,
  onToggleOutline,
  onToggleFocusMode,
  onToggleSearch,
  onToggleSettings,
  onToggleExport,
  onCloseExport,
  onExport
}: TopBarProps) {
  const breadcrumb = breadcrumbOf(documentUri);

  // 专注模式不在这里分支：那一段由 `ReaderShell` 整段不渲染，退出入口住在快速条
  // 右侧。留一个 `focusMode` 在这里只会供出一个选不中的退出按钮（旧版就是这么
  // 把退出入口藏到 4px 触发沿里的）。
  return (
    <div className={TOOLBAR_CLASS} role="toolbar" aria-label="Reading controls">
      <Breadcrumb segments={breadcrumb} documentUri={documentUri} />
      <div className={TOOLBAR_ACTIONS_CLASS}>
        <button
          type="button"
          className="readora-toolbar-button"
          aria-pressed={outlineVisible}
          aria-label="Toggle outline"
          onClick={onToggleOutline}
        >
          <OutlineIcon />
          Outline
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

function Breadcrumb({
  segments,
  documentUri
}: {
  segments: readonly BreadcrumbSegment[];
  documentUri: string | undefined;
}) {
  if (segments.length === 0) {
    return null;
  }
  return (
    <div className={BREADCRUMB_CLASS} title={documentUri} aria-label="Document path">
      {segments.map((segment, index) => (
        <span
          key={`${segment.name}-${String(index)}`}
          className={
            segment.directory
              ? `${BREADCRUMB_CLASS}-segment ${BREADCRUMB_CLASS}-segment--directory`
              : `${BREADCRUMB_CLASS}-segment ${BREADCRUMB_CLASS}-segment--file`
          }
          data-readora-breadcrumb={segment.directory ? "directory" : "filename"}
        >
          {index > 0 ? <span aria-hidden="true">/</span> : null}
          {segment.name}
        </span>
      ))}
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
