/**
 * 跨运行时消息的 Zod 运行时校验（IMP-001 §11.4）。
 *
 * 不得仅依靠 TypeScript 类型判断外部消息是否可信；
 * 所有 payload 均为 strict 对象，拒绝未知字段。
 */
import { z } from "zod";
import {
  DOCUMENT_TEXT_MAX_LENGTH,
  ENVELOPE_ID_MAX_LENGTH,
  ENVELOPE_TYPE_MAX_LENGTH,
  PROTOCOL_VERSION
} from "./envelope";

export const MessageEnvelopeSchema = z.strictObject({
  id: z.string().min(1).max(ENVELOPE_ID_MAX_LENGTH),
  type: z.string().min(1).max(ENVELOPE_TYPE_MAX_LENGTH),
  version: z.literal(PROTOCOL_VERSION),
  payload: z.unknown()
});

export const MessageErrorSchema = z.strictObject({
  code: z.string().min(1).max(128),
  message: z.string().min(1).max(2048)
});

export const MessageResponseSchema = z.strictObject({
  id: z.string().min(1).max(ENVELOPE_ID_MAX_LENGTH),
  success: z.boolean(),
  payload: z.unknown().optional(),
  error: MessageErrorSchema.optional()
});

/** 阅读内容宽度边界（PRD-001 F07-003 最大内容宽度；Host 宽度增减命令与偏好共用同一区间）。 */
export const CONTENT_WIDTH_MIN = 480;
export const CONTENT_WIDTH_MAX = 1600;

/** 字号与行高边界（PRD-003 §11.4：缩放后的实际字号同样落在这个区间内）。 */
export const FONT_SIZE_MIN = 8;
export const FONT_SIZE_MAX = 32;
export const LINE_HEIGHT_MIN = 1;
export const LINE_HEIGHT_MAX = 3;

/**
 * 主题模式（ARC-006 §5.1 / §5.2 ThemeMode）。
 *
 * `auto` 是 `system` 的兼容别名：M2 起 `readora.theme` 的默认值即 auto，
 * 直接删掉会让既有用户配置读成非法值。`vscode` 表示语义 Token 映射宿主
 * `--vscode-*` 变量（ARC-006 §6.2），`system` 只从宿主明暗挑产品主题。
 */
export const THEME_MODES = ["auto", "light", "dark", "vscode", "system"] as const;
export type ThemeMode = (typeof THEME_MODES)[number];

/** 配置值守卫：VS Code 允许用户往 string 配置项里写任何东西，Host 侧必须先过这一关。 */
export function isThemeMode(value: unknown): value is ThemeMode {
  return typeof value === "string" && (THEME_MODES as readonly string[]).includes(value);
}

/**
 * 正文字族偏好（PRD-003 §5.2 + §10.4：用户可在 Newsreader / Geist / Inter 之间切换）。
 *
 * 取值直接映射 `html[data-readora-typography]`，字族栈在 tokens.css 里覆盖
 * display 与 body 两个 token。`inter` 与 CJK 字形都不随扩展打包（M5 偏差登记），
 * 因此它是「优先使用系统 Inter，否则回退 body 栈」而非承诺分发。
 */
export const READER_TYPOGRAPHIES = ["newsreader", "geist", "inter"] as const;
export type ReaderTypography = (typeof READER_TYPOGRAPHIES)[number];

/** 主题预设（F08-010；ARC-006 未定义该维度，本批定案并登记偏差）。 */
export const THEME_PRESETS = ["default", "high-contrast"] as const;
export type ThemePreset = (typeof THEME_PRESETS)[number];

function inSet<T extends readonly string[]>(values: T, value: unknown): value is T[number] {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

export function isReaderTypography(value: unknown): value is ReaderTypography {
  return inSet(READER_TYPOGRAPHIES, value);
}

export function isThemePreset(value: unknown): value is ThemePreset {
  return inSet(THEME_PRESETS, value);
}

/**
 * 阅读偏好（配置键见 ARC-004 §11 + M6 新增 readora.typography / readora.themePreset）。
 *
 * `themePreset` 对应的配置键必须保持扁平：宿主会把点号键展开成树，与字符串叶
 * `readora.theme` 同前缀的子键会被整条丢掉。理由记在 configuration-service 的键表。
 */
export const ReaderPreferencesSchema = z.strictObject({
  theme: z.enum(THEME_MODES),
  fontSize: z.number().min(FONT_SIZE_MIN).max(FONT_SIZE_MAX),
  lineHeight: z.number().min(LINE_HEIGHT_MIN).max(LINE_HEIGHT_MAX),
  contentWidth: z.number().min(CONTENT_WIDTH_MIN).max(CONTENT_WIDTH_MAX),
  showOutline: z.boolean(),
  typography: z.enum(READER_TYPOGRAPHIES),
  themePreset: z.enum(THEME_PRESETS)
});
export type ReaderPreferences = z.infer<typeof ReaderPreferencesSchema>;

/**
 * 偏好的默认值（ARC-004 §11 配置表的 default 列）。
 *
 * 三个消费方共用这一份：manifest 的 `contributes.configuration.*.default`、
 * Host 读到非法值时的回退、测试夹具的基础偏好。`manifest.spec.ts` 断言
 * manifest 与它们逐键相等 —— 否则「用户没改设置」和「用户改回默认」会走出两套 Token。
 */
export const DEFAULT_THEME_MODE: ThemeMode = "auto";
export const DEFAULT_FONT_SIZE = 16;
export const DEFAULT_LINE_HEIGHT = 1.75;
export const DEFAULT_CONTENT_WIDTH = 820;
export const DEFAULT_SHOW_OUTLINE = true;
export const DEFAULT_TYPOGRAPHY: ReaderTypography = "newsreader";
export const DEFAULT_THEME_PRESET: ThemePreset = "default";

export const DEFAULT_READER_PREFERENCES: ReaderPreferences = {
  theme: DEFAULT_THEME_MODE,
  fontSize: DEFAULT_FONT_SIZE,
  lineHeight: DEFAULT_LINE_HEIGHT,
  contentWidth: DEFAULT_CONTENT_WIDTH,
  showOutline: DEFAULT_SHOW_OUTLINE,
  typography: DEFAULT_TYPOGRAPHY,
  themePreset: DEFAULT_THEME_PRESET
};

/** 解析后的明暗（theme.update 只携带解析结果，auto/vscode/system 由 Host 归一）。 */
export const ResolvedThemeSchema = z.enum(["light", "dark"]);
export type ResolvedTheme = z.infer<typeof ResolvedThemeSchema>;

/** 生效主题的取值来源（ARC-006 §7.3 ResolvedTheme.source）。 */
export const ThemeSourceSchema = z.enum(["product", "vscode", "system"]);
export type ThemeSource = z.infer<typeof ThemeSourceSchema>;

/** `html[data-readora-theme]` 的三个取值（PRD-003 §13.2、ARC-006 §4.2）。 */
export const THEME_PALETTES = ["light", "dark", "vscode"] as const;
export type ThemePalette = (typeof THEME_PALETTES)[number];

/**
 * 归一后的主题状态（ARC-006 §7.3 ResolvedTheme 的 `mode` + `source` 两轴）。
 *
 * 字段名与 theme.update 载荷不同是刻意的：`mode` 是 Host 内部对「明暗」的
 * 称呼（对齐 §7.3 接口），载荷字段沿用既有的 `theme`，避免一次改两条契约。
 */
export interface ThemeState {
  mode: ResolvedTheme;
  source: ThemeSource;
}

/**
 * 把「明暗 + 来源」两轴压成 CSS 取色层，唯一的一处映射。
 *
 * Host 首帧预置（html-template）与 Webview 运行时切换（applyTheme）都必须
 * 走这个函数，否则会出现「首帧一个主题、切换后另一个主题」的半主题态。
 */
export function themePalette(state: ThemeState): ThemePalette {
  return state.source === "vscode" ? "vscode" : state.mode;
}

/**
 * 文档快照（AUD-001 §13.5 核实的契约形态：
 * documentUri / languageId / version / text 四字段）。
 */
export const DocumentSnapshotSchema = z.strictObject({
  documentUri: z.string().min(1).max(2048),
  languageId: z.string().min(1).max(64),
  version: z.number().int().nonnegative(),
  text: z.string().max(DOCUMENT_TEXT_MAX_LENGTH)
});
export type DocumentSnapshot = z.infer<typeof DocumentSnapshotSchema>;

/** document.load / document.update 载荷：快照 + 偏好（strict，第五字段 preferences）。 */
export const DocumentLoadPayloadSchema = DocumentSnapshotSchema.extend({
  preferences: ReaderPreferencesSchema
});
export type DocumentLoadPayload = z.infer<typeof DocumentLoadPayloadSchema>;

export const DocumentUpdatePayloadSchema = DocumentLoadPayloadSchema;
export type DocumentUpdatePayload = DocumentLoadPayload;

/** reader.ready：空载荷。 */
export const ReaderReadyPayloadSchema = z.strictObject({});
export type ReaderReadyPayload = z.infer<typeof ReaderReadyPayloadSchema>;

/** document.open：交给 OS 打开的外部目标（权限边界见 ARC-004 §8.7 护栏）。 */
export const DocumentOpenPayloadSchema = z.strictObject({
  uri: z.string().min(1).max(2048)
});
export type DocumentOpenPayload = z.infer<typeof DocumentOpenPayloadSchema>;

/**
 * document.navigate：在阅读器中跳转的目标文档。
 *
 * uri 既可以是绝对 file: URI，也可以是相对当前会话文档的引用；
 * 相对形态由 Host 侧 ResourceResolver 按 kind=document 解析（ARC-008 §10.4），
 * Webview 不做路径拼接，因此不存在越界风险外溢到渲染层。
 */
export const DocumentNavigatePayloadSchema = z.strictObject({
  uri: z.string().min(1).max(2048)
});
export type DocumentNavigatePayload = z.infer<
  typeof DocumentNavigatePayloadSchema
>;

/**
 * resource.resolve：资源解析请求（ARC-008 §7.1，M3 起 Host 侧有真实处理器）。
 *
 * kind 决定策略通道：image 走图片 MIME 白名单，document 只允许 .md/.markdown
 * （跨文档最小跳转）。缺省 image，保证 M2 之前发出的请求形态继续可用。
 */
export const ResourceKindSchema = z.enum(["image", "document"]);
export type ResourceKind = z.infer<typeof ResourceKindSchema>;

export const ResourceResolvePayloadSchema = z.strictObject({
  documentUri: z.string().min(1).max(2048),
  reference: z.string().min(1).max(2048),
  kind: ResourceKindSchema.default("image")
});
export type ResourceResolvePayload = z.infer<typeof ResourceResolvePayloadSchema>;

/**
 * resource.resolve 成功响应载荷（ARC-008 §7.3）。
 *
 * 只回 webview 可寻址 URI：本地绝对路径不得出 Host；version 由
 * mtime + size 组成，参与 URI query 以避开 Webview 图像缓存。
 */
export const ResourceResolveResultSchema = z.strictObject({
  resourceId: z.string().min(1).max(256),
  webviewUri: z.string().min(1).max(4096),
  mimeType: z.string().min(1).max(128),
  kind: ResourceKindSchema,
  byteSize: z.number().int().nonnegative(),
  version: z.string().min(1).max(128)
});
export type ResourceResolveResult = z.infer<typeof ResourceResolveResultSchema>;

/**
 * theme.update 载荷。
 *
 * 两个字段各自表达一个轴，不能合并成一个枚举：`theme` 是最终明暗（决定
 * 图表、语法配色与阴影形态），`source` 是取值来源（决定 CSS 走产品调色板
 * 还是宿主 `--vscode-*`）。ARC-006 §13.1 要求「System 模式能解析系统偏好」
 * 与「VS Code 模式能读取当前主题变量」同时可验证，缺一个轴就分不开。
 */
export const ThemeUpdatePayloadSchema = z.strictObject({
  theme: ResolvedThemeSchema,
  source: ThemeSourceSchema
});
export type ThemeUpdatePayload = z.infer<typeof ThemeUpdatePayloadSchema>;

export const ConfigUpdatePayloadSchema = z.strictObject({
  preferences: ReaderPreferencesSchema
});
export type ConfigUpdatePayload = z.infer<typeof ConfigUpdatePayloadSchema>;

/**
 * config.patch：Reader Settings 弹层写回用户偏好（M6 补设，view→host）。
 *
 * ARC-004 §8.3 的 11 条消息里没有任何把 Webview 内的偏好改动送回 Host 的通道，
 * 而 PRD-003 §10.5 的 Reader Settings 弹层必须能改字号/行高/字族 —— 属规范缺口，
 * 依 M4 `reader.viewState` 的先例补设（README 偏差登记）。
 *
 * 载荷只带 key/value 是刻意的：Webview 不持有完整偏好的权威副本，
 * Host 收到后与当前配置合并再整体过 `ReaderPreferencesSchema`（区间与枚举
 * 的唯一权威仍是那张 Schema，此处不复制第二套边界）。
 */
export const CONFIG_PATCH_KEYS = [
  "theme",
  "fontSize",
  "lineHeight",
  "contentWidth",
  "showOutline",
  "typography",
  "themePreset"
] as const;
export type ConfigPatchKey = (typeof CONFIG_PATCH_KEYS)[number];

export const ConfigPatchPayloadSchema = z.strictObject({
  key: z.enum(CONFIG_PATCH_KEYS),
  value: z.union([z.number(), z.boolean(), z.string().max(32)])
});
export type ConfigPatchPayload = z.infer<typeof ConfigPatchPayloadSchema>;

/**
 * metrics.report：Webview 上报一次渲染的耗时与规模（F11-014，M6 补设）。
 *
 * 只读上报，Host 侧不回复；时长上限 600 秒是防止把 NaN/异常大值写进 OutputChannel。
 */
export const MetricsReportPayloadSchema = z.strictObject({
  documentUri: z.string().min(1).max(2048),
  version: z.number().int().nonnegative(),
  renderDurationMs: z.number().nonnegative().max(600_000),
  firstPaintDurationMs: z.number().nonnegative().max(600_000),
  charCount: z.number().int().nonnegative(),
  blockCount: z.number().int().nonnegative(),
  diagramCount: z.number().int().nonnegative(),
  mathCount: z.number().int().nonnegative()
});
export type MetricsReportPayload = z.infer<typeof MetricsReportPayloadSchema>;

/** 阅读状态（会话内保持，ARC-007 §8；跨会话记忆属 F05-008 P1，不在 M1）。 */
export const ReadingStateSchema = z.strictObject({
  scrollTop: z.number().nonnegative(),
  activeHeadingId: z.string().max(256).nullable()
});
export type ReadingState = z.infer<typeof ReadingStateSchema>;

export const StateSavePayloadSchema = z.strictObject({
  documentUri: z.string().min(1).max(2048),
  state: ReadingStateSchema
});
export type StateSavePayload = z.infer<typeof StateSavePayloadSchema>;

export const StateRestorePayloadSchema = z.strictObject({
  state: ReadingStateSchema.nullable()
});
export type StateRestorePayload = z.infer<typeof StateRestorePayloadSchema>;

/**
 * 会话视图状态（ARC-004 §6.2 ReaderSessionState 的可下发子集）。
 *
 * 与 ReaderPreferences 的分工：偏好是用户设置（跨会话、由配置键驱动），
 * viewState 是会话内的显示状态（命令切换、退出即弃，ARC-007 §10.1）。
 * `outlineVisible` 初值取 `showOutline`，`contentWidth` 初值取同名偏好。
 */
export const ViewStatePayloadSchema = z.strictObject({
  focusMode: z.boolean(),
  outlineVisible: z.boolean(),
  contentWidth: z.number().min(CONTENT_WIDTH_MIN).max(CONTENT_WIDTH_MAX)
});
export type ViewStatePayload = z.infer<typeof ViewStatePayloadSchema>;

export const ReaderErrorPayloadSchema = z.strictObject({
  code: z.string().min(1).max(128),
  message: z.string().min(1).max(2048),
  stack: z.string().max(8192).nullable()
});
export type ReaderErrorPayload = z.infer<typeof ReaderErrorPayloadSchema>;

/**
 * 导出链路（M11，三条补设消息的载荷）。
 *
 * `bodyHtml` 的上限不是「文档能有多大」而是「正片段落能有多大」：HTML 已经经过
 * 净化、属性已转义，真正会把数字推高的是内联图片 base64 之后的形态，而内联是
 * Host 做的，不经过这条通道。2 百万字节的文档上限（`DOCUMENT_TEXT_MAX_LENGTH`）
 * 渲染成带高亮 span 的 HTML 会明显变长，因此这里给到 8 百万字符，并在 Host 侧
 * 另有一个包含字体与图片的总字节闸门（`EXPORT_MAX_TOTAL_BYTES`）。两道闸门
 * 分工不同：前者只挡异常载荷，后者才是对用户可读的「导出太大」终态。
 */
export const EXPORT_FORMATS = ["html", "pdf", "png"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];
export const EXPORT_HTML_MAX_CHARS = 8_000_000;
export const EXPORT_ROOT_STYLE_MAX_CHARS = 4096;
/**
 * `requestId` 的上界。不拿 `ENVELOPE_ID_MAX_LENGTH`（128）那个信封 id 的公共常量：
 * 这里的值由 Host 侧 `randomUUID()` 生成（36 个字符），64 已留了一倍余量，
 * 而把它夹紧才能把「迟到的帧」挡在合理长度里而不是任意长的串。
 */
export const EXPORT_REQUEST_ID_MAX_LENGTH = 64;
/** 尺寸上限：像素值参与 Chrome `--window-size`，真正可用的上限由 Host 侧再夹一次。 */
export const EXPORT_SIZE_MAX_PX = 200_000;

export function isExportFormat(value: unknown): value is ExportFormat {
  return (
    typeof value === "string" &&
    (EXPORT_FORMATS as readonly string[]).includes(value)
  );
}

/** export.request：顶栏菜单的一次点击，只说「导哪个格式」。 */
export const ExportRequestPayloadSchema = z.strictObject({
  format: z.enum(EXPORT_FORMATS)
});
export type ExportRequestPayload = z.infer<typeof ExportRequestPayloadSchema>;

/**
 * export.capture：Host 向 View 索取当前那一帧正文。
 *
 * `requestId` 必需：没有它就无法把迟到的 `export.data` 与已经关掉的会话/对话框对上。
 */
export const ExportCapturePayloadSchema = z.strictObject({
  requestId: z.string().min(1).max(EXPORT_REQUEST_ID_MAX_LENGTH),
  format: z.enum(EXPORT_FORMATS)
});
export type ExportCapturePayload = z.infer<typeof ExportCapturePayloadSchema>;

/**
 * export.data：View 侧序列化器的产物。
 *
 * `documentUri` 与 `version` 只用于「陈旧帧丢弃」，**不参与任何授权判定**；
 * 路径由用户在保存对话框里选定（ARC-008 导出小节）。`rootStyleText` 是
 * 从屏上采集的三个运行时 CSS 变量声明（字号/行高/内容宽），没有它导出件会
 * 回到默认排版，即「与屏上不一致」。两个尺寸只喂 Chrome 的 `--window-size`。
 */
export const ExportDataPayloadSchema = z.strictObject({
  requestId: z.string().min(1).max(EXPORT_REQUEST_ID_MAX_LENGTH),
  format: z.enum(EXPORT_FORMATS),
  documentUri: z.string().min(1).max(2048),
  version: z.number().int().nonnegative(),
  bodyHtml: z.string().max(EXPORT_HTML_MAX_CHARS),
  rootStyleText: z.string().max(EXPORT_ROOT_STYLE_MAX_CHARS),
  canvasWidthPx: z.number().int().nonnegative().max(EXPORT_SIZE_MAX_PX),
  contentHeightPx: z.number().int().nonnegative().max(EXPORT_SIZE_MAX_PX)
});
export type ExportDataPayload = z.infer<typeof ExportDataPayloadSchema>;
