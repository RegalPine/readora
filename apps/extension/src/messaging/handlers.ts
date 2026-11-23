/**
 * 消息处理器注册（ARC-004 §8.3 中 view-to-host 的 6 条 + M6 补设 2 条 +
 * M11 补设 2 条 + F12 补设 1 条）。
 *
 * M1 注册：reader.ready / document.open / document.navigate /
 * state.save / reader.error。M3 补注册 resource.resolve（ARC-008 §7），
 * M6 补注册 config.patch（Reader Settings 写回）与 metrics.report（F11-014），
 * M11 补注册 export.request / export.data（导出链路，依 PRD-003 §10.5 推导补设，
 * 登记见 contracts 的 message-types 头注释与 README 偏差表），
 * F12 补注册 document.edit（写回链路，ARC-009 §5；判断全在 EditService 的决策阶梯里）。
 * 其余未交付类型继续由路由返回统一 unsupported，诚实声明能力边界。
 *
 * 依赖全部注入，本模块不 import vscode，可独立单测。
 */
import {
  READORA_ERROR_CODES,
  type ConfigPatchKey,
  type ConfigPatchPayload,
  type DocumentEditPayload,
  type DocumentEditResult,
  type DocumentNavigatePayload,
  type DocumentOpenPayload,
  type ExportDataPayload,
  type ExportFormat,
  type ExportRequestPayload,
  type MetricsReportPayload,
  type ReaderErrorPayload,
  type ReaderPreferences,
  type ReadingState,
  type ResourceResolvePayload,
  type ResourceResolveResult,
  type StateSavePayload
} from "@readora/contracts";
import { ReaderError } from "../errors";
import { decideLinkOpen } from "../security/link-policy";
import type { MessageDispatcher } from "./dispatcher";

export interface HandlerDependencies {
  /** reader.ready：投递暂存的 document.load（门控见 ARC-004 §8.7）。 */
  deliverPending(sessionId: string): void;
  /** state.save：会话内保存阅读状态；会话/文档不匹配必须拒绝。 */
  saveReadingState(sessionId: string, documentUri: string, state: ReadingState): void;
  /** document.open：通过策略检查后交给 OS 打开。 */
  openExternal(uri: string): Promise<boolean>;
  /**
   * document.navigate：在阅读器中打开目标文档。
   * 绝对 file: URI 与相对引用两条通道由调用方区分（M3 补相对通道）。
   */
  navigate(uri: string, sessionId: string): Promise<void>;
  /** resource.resolve：把文档内相对引用解析为该会话可用的 webview URI。 */
  resolveResource(payload: ResourceResolvePayload, sessionId: string): Promise<ResourceResolveResult>;
  /** reader.error：Webview 侧错误上报（记录，不回传）。 */
  reportError(payload: ReaderErrorPayload): void;
  /**
   * config.patch：写回单项偏好（M6 补设，PRD-003 §10.5 Reader Settings 弹层）。
   *
   * 值域校验在 ConfigurationService 里完成（唯一权威是 ReaderPreferencesSchema），
   * 这里只负责把非法值翻译成统一错误结构。成功时返回合并后的完整偏好，
   * 让弹层立刻知道自己那次点击落到了哪个值上。
   */
  patchConfig(key: ConfigPatchKey, value: unknown): Promise<ReaderPreferences>;
  /** metrics.report：只读渲染指标上报（F11-014），Host 记录但不回复业务数据。 */
  reportMetrics(payload: MetricsReportPayload, sessionId: string): void;
  /**
   * export.request（M11 补设）：顶栏菜单的一次点击。
   *
   * 本层不决定写哪儿、也不决定要不要写：保存对话框是唯一写盘授权边界，
   * 那些都在 ExportService 里。这里只把会话归属交给它。
   */
  requestExport(sessionId: string, format: ExportFormat): Promise<void>;
  /** export.data（M11 补设）：View 交回的那一帧，组装与写盘都在 ExportService。 */
  onExportData(payload: ExportDataPayload, sessionId: string): Promise<void>;
  /**
   * document.edit（F12 补设）：把一段源行范围替换回宿主文档模型。
   *
   * 本层不判范围合法性、不判版本、不碰 `WorkspaceEdit`：那些都在 EditService。
   * 返回的新版本要让 View 拿去替换自己手里的 `baseVersion`，否则紧接的第二笔
   * 编辑会被自己刚造成的版本变化判成陈旧 —— 于是它是继 resource.resolve 之后
   * 第二个带结构化成功载荷的 view-to-host 通道（出口复判见契约的
   * `RESPONSE_PAYLOAD_SCHEMAS`）。
   */
  editDocument(payload: DocumentEditPayload, sessionId: string): Promise<DocumentEditResult>;
}

export function registerMessageHandlers(
  dispatcher: MessageDispatcher,
  deps: HandlerDependencies
): void {
  dispatcher.register("reader.ready", (_payload, context) => {
    deps.deliverPending(context.sessionId);
  });

  dispatcher.register("document.open", async (payload) => {
    const { uri } = payload as DocumentOpenPayload;
    const decision = decideLinkOpen(uri);
    if (!decision.allowed) {
      throw new ReaderError(READORA_ERROR_CODES.LINK_REJECTED, decision.reason);
    }
    return deps.openExternal(decision.uri);
  });

  dispatcher.register("document.navigate", async (payload, context) => {
    const { uri } = payload as DocumentNavigatePayload;
    await deps.navigate(uri, context.sessionId);
  });

  // payload.documentUri 不可信：会话归属校验在 deps.resolveResource 内完成，
  // 越界授权风险（用伪造 documentUri 换根目录读权限）在那里挡下。
  dispatcher.register("resource.resolve", async (payload, context) => {
    const parsed = payload as ResourceResolvePayload;
    return deps.resolveResource(parsed, context.sessionId);
  });

  dispatcher.register("state.save", (payload, context) => {
    const { documentUri, state } = payload as StateSavePayload;
    deps.saveReadingState(context.sessionId, documentUri, state);
  });

  dispatcher.register("reader.error", (payload) => {
    deps.reportError(payload as ReaderErrorPayload);
  });

  // config.patch：键由契约的 CONFIG_PATCH_KEYS 白名单限定（z.enum 在 payload
  // 校验阶段就拒掉未知键），值再经 ReaderPreferencesSchema 整份合并校验。
  // 于是「Webview 能改哪些设置」完全由契约决定，这里不存在第二份可漂移的清单。
  dispatcher.register("config.patch", async (payload) => {
    const { key, value } = payload as ConfigPatchPayload;
    return deps.patchConfig(key as ConfigPatchKey, value);
  });

  // metrics.report：只读通道，返回值刻意留空 —— 指标上报不参与任何业务判断，
  // 让它能失败得无声无息，而不是变成 Webview 必须处理的另一条响应。
  dispatcher.register("metrics.report", (payload, context) => {
    deps.reportMetrics(payload as MetricsReportPayload, context.sessionId);
  });

  // export.request：载荷只有一个格式，会话归属取自 dispatcher 的 context
  // （Webview 报的 documentUri 在这里一律不可用，ARC-008 导出小节）。
  dispatcher.register("export.request", async (payload, context) => {
    const { format } = payload as ExportRequestPayload;
    await deps.requestExport(context.sessionId, format);
  });

  // export.data：与 metrics.report 同一口径，成功响应刻意留空载荷 ——
  // 结果（写到哪、成不成）由 Host 的通知说出来，不让页面去解析响应。
  dispatcher.register("export.data", async (payload, context) => {
    await deps.onExportData(payload as ExportDataPayload, context.sessionId);
  });

  // document.edit：会话归属同样取自 dispatcher 的 context，payload.documentUri
  // 只是「View 以为自己在改哪篇」，它参与陈旧判定而不参与授权（ARC-008 §16.1）。
  dispatcher.register("document.edit", async (payload, context) => {
    const parsed = payload as DocumentEditPayload;
    return deps.editDocument(parsed, context.sessionId);
  });
}