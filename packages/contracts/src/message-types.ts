/**
 * 权威消息类型表（ARC-004 §8.3 的 11 条 + M4 补设 1 条 + M6 补设 2 条）。
 *
 * 早期草案命名（document.request / navigation.change /
 * configuration.update / asset.resolve / host.error）已废弃，
 * 不得重新引入（ARC-005 §8.4 注记）。
 *
 * `reader.viewState` 是 M4 补设的 Host → View 视图状态通道：
 * ARC-004 §6.2 把 focusMode / leftPanelVisible / rightPanelVisible 归入
 * ReaderSessionState，§4.1 又要求 focusMode / toggleOutline 两条 P0 命令，
 * 但 §8.3 消息表没有任何把命令切换送达 Webview 的条目 —— 属规范缺口，
 * 依 §6.2 推导补设并登记偏差（README「能力边界」M4 小节）。
 *
 * `config.patch` 与 `metrics.report` 是 M6 补设的两条 View → Host 通道：
 * 前者是 Reader Settings 弹层写回偏好的唯一出路（§10.5 要求弹层能改字号/行高/
 * 字族，而 §8.3 没有任何 View→Host 的配置通道），后者承载 F11-014 的渲染指标
 * （复用 `reader.error` 会把正常指标记成错误）。两条都登记为规范缺口。
 *
 * `export.*` 三条是 M11 补设的导出通道：ARC-004 §8.3 的消息表里没有任何
 * 「把已经渲染好的正文交给 Host 写盘」的条目，而 PRD-003 §10.5 要求顶栏有导出
 * 入口、MPE 借鉴 P1 档又把导出定为单文件 HTML/PDF/PNG —— 渲染只跑在 Webview
 * （IMP-001 §4.2），Host 既不能重跑一遍管线（DOMPurify 需要 DOM，且会造出两套
 * 渲染口径）也无法主动读页面 DOM（VS Code Webview API 没有脚本求值入口），
 * 因此导出必然是一来一回：View 序列化、Host 写盘。三条都登记为规范缺口
 * （README「能力边界」M11 小节）。方向刻意为 request/data 进、capture 出：
 * 保存对话框是唯一授权边界，Host 只有在用户选定路径之后才向 View 取帧。
 */

export const MESSAGE_TYPES = {
  READER_READY: "reader.ready",
  DOCUMENT_LOAD: "document.load",
  DOCUMENT_UPDATE: "document.update",
  DOCUMENT_OPEN: "document.open",
  DOCUMENT_NAVIGATE: "document.navigate",
  RESOURCE_RESOLVE: "resource.resolve",
  THEME_UPDATE: "theme.update",
  CONFIG_UPDATE: "config.update",
  CONFIG_PATCH: "config.patch",
  METRICS_REPORT: "metrics.report",
  STATE_SAVE: "state.save",
  STATE_RESTORE: "state.restore",
  READER_ERROR: "reader.error",
  READER_VIEW_STATE: "reader.viewState",
  EXPORT_REQUEST: "export.request",
  EXPORT_CAPTURE: "export.capture",
  EXPORT_DATA: "export.data"
} as const;

export type MessageType = (typeof MESSAGE_TYPES)[keyof typeof MESSAGE_TYPES];

export type MessageDirection = "host-to-view" | "view-to-host";

/** 每条消息的方向登记（ARC-004 §8.3）。 */
export const MESSAGE_DIRECTIONS: Record<MessageType, MessageDirection> = {
  "reader.ready": "view-to-host",
  "document.load": "host-to-view",
  "document.update": "host-to-view",
  "document.open": "view-to-host",
  "document.navigate": "view-to-host",
  "resource.resolve": "view-to-host",
  "theme.update": "host-to-view",
  "config.update": "host-to-view",
  "config.patch": "view-to-host",
  "metrics.report": "view-to-host",
  "state.save": "view-to-host",
  "state.restore": "host-to-view",
  "reader.error": "view-to-host",
  "reader.viewState": "host-to-view",
  // M11 导出：用户点菜单（进）→ Host 弹完对话框索取正文（出）→ View 交回正文（进）。
  "export.request": "view-to-host",
  "export.capture": "host-to-view",
  "export.data": "view-to-host"
};

export function isMessageType(value: string): value is MessageType {
  return Object.prototype.hasOwnProperty.call(MESSAGE_DIRECTIONS, value);
}
