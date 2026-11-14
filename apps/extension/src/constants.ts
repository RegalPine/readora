/**
 * 产品常量（BRAND-001 §3：readora 命名空间）。
 *
 * 命令 ID 以 ARC-004 §4.1 / BRAND-001 为准；
 * 早期草案 readora.open / readora.toggle / readora.resetLayout 已废弃。
 * ADJUST_CONTENT_WIDTH 不在 §4.1 的五命令表内：它只服务 §4.5 的宽度键位，
 * 因此不进命令面板（contributes.menus.commandPalette 置 when:false）。
 */

export const READORA_PRODUCT_NAME = "Readora";

export const READORA_COMMANDS = {
  OPEN_READER: "readora.openReader",
  OPEN_TO_SIDE: "readora.openToSide",
  FOCUS_MODE: "readora.focusMode",
  TOGGLE_OUTLINE: "readora.toggleOutline",
  ADJUST_CONTENT_WIDTH: "readora.adjustContentWidth",
  REFRESH: "readora.refresh",
  // M11 导出三级：三档各一条命令，与顶栏菜单同汇于 ExportService.requestExport。
  // 它们与 openReader/refresh 一样要目标文档，所以不进「无面板即 no-op」那一组。
  EXPORT_HTML: "readora.exportHtml",
  EXPORT_PDF: "readora.exportPdf",
  EXPORT_PNG: "readora.exportPng"
} as const;

/** 键位 when 条件用的上下文键（ARC-004 §4.5）；由面板可见性驱动。 */
export const READORA_ACTIVE_CONTEXT = "readora.readerActive";

/** WebviewPanel viewType（ARC-004 §7.2）。 */
export const READORA_VIEW_TYPE = "readora";

/** 支持的文件扩展名（ARC-004 §4.4 when 口径必须覆盖此表）。 */
export const MARKDOWN_EXTENSIONS = [".md", ".markdown"] as const;

export const MARKDOWN_LANGUAGE_ID = "markdown";

/** 配置键（ARC-004 §11 配置表）。 */
export const CONFIG_SECTION = "readora";

/** 文件事件防抖（ARC-004 §9.3：文件变化必须防抖）。 */
export const FILE_EVENT_DEBOUNCE_MS = 300;

/**
 * 导出链路（M11）的四个闸门。
 *
 * 分开讲三件不同的事，不拿一个超时兜全部：
 * - capture 超时是「View 还在不在」的问题（10 秒与 `resource.resolve` 同一量级）；
 * - browser 超时是「本机 Chrome 能不能跑完」的问题，排版与字体加载都要时间；
 * - 体积上限是「交付物能不能给人」的问题：一张 40 MB 的图能内联出 53 MB 的 base64，
 *   这种文件开着就卡，不如早报错（口径：不降级、不截断、不旁置 assets 目录）。
 */
export const EXPORT_CAPTURE_TIMEOUT_MS = 10_000;
export const EXPORT_BROWSER_TIMEOUT_MS = 30_000;
export const EXPORT_MAX_TOTAL_BYTES = 64 * 1024 * 1024;
/** PNG 单次截图的高度上限：Chrome 自绘到此为硬顶，超过就剪（并向用户明说）。 */
export const EXPORT_PNG_MAX_HEIGHT_PX = 16_384;
/** 量高的安全余量：字体换版与异步落位都会让实际高度比导出一帧时略高。 */
export const EXPORT_PNG_HEIGHT_FACTOR = 1.08;
/**
 * 「用户在保存对话框里按了取消」的诊断标签。
 *
 * 它不是错误码（取消不是错误，不占 `READORA_ERROR_CODES`），但也不能不留下痕迹：
 * 否则「导出没反应」与「导出被取消」在输出通道里长得一模一样。
 */
export const EXPORT_CANCELLED_DIAGNOSTIC = "readora.export.cancelled";
/**
 * 导出链路上「不算失败但要看得到」的诊断标签：写完一行、图片保持占位形态几行。
 * 与上一行同一理由：它们是结果而不是错误，不占错误码。
 */
export const EXPORT_DIAGNOSTIC = "readora.export";
