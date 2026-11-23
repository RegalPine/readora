/**
 * 应用装配（ARC-004 §3.1）：组合配置/文档/会话/面板/消息模块，
 * 注册命令与事件监听。所有 Disposable 在此统一管理与释放。
 *
 * 文件监听从 M1 即实现（防抖 + 版本检查 + 删除处理），
 * 避免 AUD-001 F06-008（P0）watcher 缺口复发。
 */
import * as vscode from "vscode";
import {
  READORA_ERROR_CODES,
  themePalette,
  type ExportFormat,
  type MetricsReportPayload,
  type ReaderErrorPayload,
  type ResourceResolvePayload,
  type ResourceResolveResult
} from "@readora/contracts";
import { sanitizeCustomCss } from "@readora/design-tokens";
import { registerCommands } from "./commands";
import { isMarkdownDocument, isMarkdownPath } from "./commands/target";
import { FILE_EVENT_DEBOUNCE_MS, READORA_VIEW_TYPE } from "./constants";
import {
  CUSTOM_CSS_MAX_LENGTH,
  ConfigurationService
} from "./configuration/configuration-service";
import { createDiagnostics } from "./diagnostics";
import { DocumentService } from "./document/document-service";
import { EditService } from "./edit/edit-service";
import { createEditPorts } from "./edit/vscode-port";
import { ReaderError, toErrorMessage } from "./errors";
import { createExportPorts } from "./export/vscode-ports";
import { ExportService, type ExportSessionInfo, type ExportStyleContext } from "./export/export-service";
import { MessageDispatcher } from "./messaging/dispatcher";
import { registerMessageHandlers } from "./messaging/handlers";
import { createResourcePorts } from "./resources/vscode-port";
import { ResourceService } from "./resources/resource-service";
import { isAbsoluteReference } from "./resources/path-resolver";
import { SessionManager } from "./session/session-manager";
import { ReadoraCustomEditorProvider } from "./webview/custom-editor-provider";
import { WebviewManager } from "./webview/webview-manager";

export interface ReaderApplication {
  activate(): void;
  dispose(): void;
}

export function createReaderApplication(
  context: vscode.ExtensionContext
): ReaderApplication {
  const configuration = new ConfigurationService();
  const documents = new DocumentService();
  const sessions = new SessionManager();
  const dispatcher = new MessageDispatcher();
  // F11-013：Host 侧所有异常与诊断进同一个输出通道，用户可自行打开查看。
  const diagnostics = createDiagnostics();
  const resources = new ResourceService(
    createResourcePorts(() => configuration.getResourcePolicy())
  );
  const webviews = new WebviewManager({
    extensionUri: context.extensionUri,
    dispatcher,
    sessions,
    getPreferences: () => configuration.getPreferences(),
    // 必须透传 preferences：open() 用随文档快照带出的那份偏好算首帧主题，
    // 丢弃参数会让首帧读到「当前配置」而不是「这一帧的配置」。
    resolveTheme: (preferences) => configuration.resolveTheme(preferences),
    // F08-011：不可信配置文本 → AST 净化 → 只在通过时注入。
    // 拒绝时整段丢弃并记诊断：半采纳（留好规则、丢坏规则）会让用户以为
    // 自己的 CSS 生效了，属于最难排查的一类错误。
    resolveCustomCss: () => {
      const outcome = sanitizeCustomCss(configuration.getCustomCss(), {
        maxChars: CUSTOM_CSS_MAX_LENGTH
      });
      if (!outcome.ok) {
        diagnostics.warn(READORA_ERROR_CODES.CUSTOM_CSS_REJECTED, outcome.reason);
      }
      return outcome;
    },
    workspaceFolders: () =>
      (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.path),
    onSessionDisposed: (session) => {
      sessions.disposeSession(session);
      // 会话释放即丢弃解析结果：不保留任何跨会话的资源授权记录。
      resources.clearCache();
      // 在途导出同时作废：面板都没了，迟到的那一帧不能写到用户刚选定的路径上。
      exportService.forget(session.id);
    }
  });

  /**
   * 导出（M11）的会话事实翻译。
   *
   * `ExportService` 不 import vscode，也不认识 ReaderSession / WebviewPanel ——
   * 它只问「这个会话还在吗、有没有面板、文档到哪一版了」。把这三件事翻译过来
   * 是装配层的活，于是导出的判断（对话框、版本护栏、体积闸门）能整体单测。
   */
  function exportSessionOf(sessionId: string): ExportSessionInfo | null {
    const session = sessions.getById(sessionId);
    if (!session || session.isDisposed) {
      return null;
    }
    return {
      sessionId: session.id,
      documentUri: session.documentUri,
      documentVersion: session.documentVersion,
      hasPanel: session.panel !== null
    };
  }

  /**
   * 导出件的取色与排版上下文：与面板 `open()` 逐字段同源。
   *
   * 自定义 CSS 在这里重新读一次而不是复用面板那一份：面板 HTML 是「打开那一刻」
   * 渲染的，导出这一刻的配置可能已经变了；用户改了 CSS 却导出到旧配置，与
   * 「导出比屏幕小一号」是同一类说谎。拒绝时整段丢弃并记诊断，与注入面板同口径。
   */
  function exportStyleContext(): ExportStyleContext {
    const preferences = configuration.getPreferences();
    const themeState = configuration.resolveTheme(preferences);
    const outcome = sanitizeCustomCss(configuration.getCustomCss(), {
      maxChars: CUSTOM_CSS_MAX_LENGTH
    });
    if (!outcome.ok) {
      diagnostics.warn(READORA_ERROR_CODES.CUSTOM_CSS_REJECTED, outcome.reason);
    }
    return {
      palette: themePalette(themeState),
      scheme: themeState.mode,
      typography: preferences.typography,
      preset: preferences.themePreset,
      customCss: outcome.ok ? outcome.css : ""
    };
  }

  const exportService = new ExportService(
    createExportPorts({
      extensionUri: context.extensionUri,
      resources,
      sessionOf: exportSessionOf,
      postCapture: (payload, sessionId) => webviews.postExportCapture(sessionId, payload),
      styleContext: exportStyleContext,
      getChromePath: () => configuration.getExportChromePath(),
      diagnostics
    })
  );

  /**
   * 编辑写回（F12 · ARC-009 §5.2）。
   *
   * 会话事实直接复用 `exportSessionOf` 那一条翻译（结构上兼容 `EditSessionInfo`）：
   * 「这个会话还在吗、有没有面板、文档是哪一篇」对导出与写回是同一个问题。
   *
   * 这里**不新增任何监听器、也不碰 `pushDocumentUpdate`**：写回之后宿主模型自己
   * 发变更事件，走的还是下面那条 `onDidChangeTextDocument` → 防抖 →
   * `document.update` 链（ARC-009 §5.2 的关键点：编辑模式不自己发明刷新）。
   */
  const edits = new EditService(
    createEditPorts({
      sessionOf: exportSessionOf,
      diagnostics
    })
  );

  const disposables: vscode.Disposable[] = [];
  const updateTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /**
   * 自定义只读编辑器 provider（ARC-004 §7 的自定义编辑器形态）。
   *
   * 注册成自定义编辑器是「用 VS Code 原生面包屑」的前提：宿主只在编辑器（含自定义
   * 编辑器）上方画面包屑栏，普通 webview 面板没有。装配主体复用 WebviewManager.configure，
   * 与历史 createWebviewPanel 路径同源。
   */
  const customEditor = new ReadoraCustomEditorProvider({
    readSnapshot: (uri) => documents.readSnapshot(uri),
    sessions,
    webviews,
    getPreferences: () => configuration.getPreferences()
  });

  async function openDocument(uri: vscode.Uri, column: vscode.ViewColumn): Promise<void> {
    // 交给宿主的自定义编辑器通道：openWith 触发 resolveCustomEditor 读快照并装配面板，
    // 于是宿主在其上方画出原生面包屑（点目录段列同级文件）。文档已在阅读器中打开时，
    // 宿主复用/聚焦该编辑器（supportsMultipleEditorsPerDocument:false），不重复装配。
    await vscode.commands.executeCommand("vscode.openWith", uri, READORA_VIEW_TYPE, {
      viewColumn: column
    });
  }

  /**
   * 会话绑定的文档 URI。
   * payload 自带的 documentUri 一律不可用于授权：否则 Webview 可以用
   * `documentUri: "file:///"` 把授权根换成文件系统根（ARC-008 §16.1）。
   */
  function sessionDocumentUri(sessionId: string): string {
    const session = sessions.getById(sessionId);
    if (!session || session.isDisposed || !session.panel) {
      throw new ReaderError(
        READORA_ERROR_CODES.RESOURCE_DENIED,
        "The requesting reader session is no longer active."
      );
    }
    return session.documentUri;
  }

  registerMessageHandlers(dispatcher, {
    deliverPending: (sessionId) => webviews.deliverPending(sessionId),
    saveReadingState: (sessionId, documentUri, state) => {
      const session = sessions.getById(sessionId);
      if (!session || session.documentUri !== documentUri) {
        throw new ReaderError(
          READORA_ERROR_CODES.TARGET_INVALID,
          "state.save does not match the session document."
        );
      }
      session.readingState = state;
    },
    openExternal: (uri) =>
      Promise.resolve(vscode.env.openExternal(vscode.Uri.parse(uri))),
    navigate: async (uri, sessionId) => {
      if (isAbsoluteReference(uri)) {
        const target = vscode.Uri.parse(uri);
        if (target.scheme !== "file" || !isMarkdownPath(target.fsPath)) {
          throw new ReaderError(
            READORA_ERROR_CODES.TARGET_INVALID,
            `Not a readable Markdown file: ${uri}`
          );
        }
        await openDocument(target, vscode.ViewColumn.Active);
        return;
      }
      // 相对引用：以会话文档为基准解析（STORY-08-04 最小跨文档跳转）。
      const outcome = await resources.resolveDocument({
        documentUri: sessionDocumentUri(sessionId),
        reference: uri
      });
      if (!outcome.ok) {
        throw new ReaderError(outcome.code, outcome.message);
      }
      await openDocument(outcome.uri, vscode.ViewColumn.Active);
    },
    resolveResource: async (
      payload: ResourceResolvePayload,
      sessionId: string
    ): Promise<ResourceResolveResult> => {
      const documentUri = sessionDocumentUri(sessionId);
      if (payload.documentUri !== documentUri) {
        throw new ReaderError(
          READORA_ERROR_CODES.RESOURCE_DENIED,
          "resource.resolve refers to a document other than the session's."
        );
      }
      const outcome = await resources.resolve({
        documentUri,
        reference: payload.reference,
        kind: payload.kind,
        asWebviewUri: (uri) => {
          const webviewUri = webviews.asWebviewUri(sessionId, uri);
          if (!webviewUri) {
            throw new ReaderError(
              READORA_ERROR_CODES.RESOURCE_UNREADABLE,
              "The reader panel is no longer available."
            );
          }
          return webviewUri.toString();
        }
      });
      if (!outcome.ok) {
        throw new ReaderError(outcome.code, outcome.message);
      }
      return outcome.result;
    },
    reportError: (payload: ReaderErrorPayload) => {
      // F11-013：Webview 上报的错误进输出通道，不再只落 console（用户在宿主里看不见）。
      diagnostics.error(payload.code, payload.message);
    },
    patchConfig: (key, value) => configuration.patchPreference(key, value),
    reportMetrics: (payload: MetricsReportPayload, sessionId: string) => {
      // F11-014：指标只做记录，不参与任何业务判断，也不回传（响应体刻意留空）。
      // 会话归属仍然要校验：否则任意已释放面板都能往日志里灌数据。
      const session = sessions.getById(sessionId);
      if (!session || session.isDisposed) {
        return;
      }
      diagnostics.metric("readora.render", {
        documentUri: payload.documentUri,
        version: payload.version,
        renderDurationMs: payload.renderDurationMs,
        firstPaintDurationMs: payload.firstPaintDurationMs,
        charCount: payload.charCount,
        blockCount: payload.blockCount,
        diagramCount: payload.diagramCount,
        mathCount: payload.mathCount
      });
    },
    // M11：顶栏菜单与三条命令在 ExportService 里汇成同一条链路，
    // 因此这里只转接，不再加一层判断（护栏全在那一边）。
    requestExport: (sessionId, format) => exportService.requestExport(sessionId, format),
    onExportData: (payload, sessionId) => exportService.onExportData(payload, sessionId),
    // F12：同样只转接，护栏（版本、scheme、范围、宿主拒绝）全在 EditService 那边。
    editDocument: (payload, sessionId) => edits.editDocument(payload, sessionId)
  });

  /**
   * 三条导出命令的落点：没有阅读会话就直接提示，绝不弹对话框、绝不 spawn Chrome。
   *
   * 「先开阅读器再导出」是本轮的锁定口径 —— 导出源是屏幕上那一帧 DOM，
   * 面板不在就没有源。激活冒烟会逐条 invoke 所有命令，空窗口恰好命中这条早退。
   */
  async function exportDocument(documentUri: string, format: ExportFormat): Promise<void> {
    const session = sessions.get(documentUri);
    if (!session || !session.panel) {
      void vscode.window.showErrorMessage(
        "Readora: open the document in the reader before exporting."
      );
      return;
    }
    await exportService.requestExport(session.id, format);
  }

  async function refresh(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    let uri: vscode.Uri | undefined;
    if (editor && isMarkdownDocument(editor.document)) {
      uri = editor.document.uri;
    } else {
      const recent = sessions.mostRecent();
      uri = recent ? vscode.Uri.parse(recent.documentUri) : undefined;
    }
    if (!uri) {
      void vscode.window.showErrorMessage("Readora: no Markdown document to refresh.");
      return;
    }
    // 已在阅读器里：openWith 只会复用/聚焦编辑器而不重读，所以显式再推一帧最新快照。
    // 还没打开：走自定义编辑器通道打开（resolveCustomEditor 首帧即读最新内容）。
    const session = sessions.get(uri.toString());
    if (session && session.panel) {
      await pushDocumentUpdate(uri);
    } else {
      await openDocument(uri, vscode.ViewColumn.Active);
    }
  }

  async function pushDocumentUpdate(uri: vscode.Uri): Promise<void> {
    const session = sessions.get(uri.toString());
    if (!session || !session.panel) {
      return;
    }
    try {
      const snapshot = await documents.readSnapshot(uri);
      webviews.pushUpdate(session, snapshot, configuration.getPreferences());
    } catch (error) {
      // 读取失败（如文件已删除）由删除事件负责关闭会话，这里仅记录。
      diagnostics.warn(READORA_ERROR_CODES.DOCUMENT_UNREADABLE, toErrorMessage(error));
    }
  }

  /** 文件事件防抖（ARC-004 §9.3），按 URI 独立计时。 */
  function scheduleUpdate(uri: vscode.Uri): void {
    const key = uri.toString();
    const existing = updateTimers.get(key);
    if (existing) {
      clearTimeout(existing);
    }
    updateTimers.set(
      key,
      setTimeout(() => {
        updateTimers.delete(key);
        void pushDocumentUpdate(uri);
      }, FILE_EVENT_DEBOUNCE_MS)
    );
  }

  function handleDelete(uri: vscode.Uri): void {
    const session = sessions.get(uri.toString());
    if (!session) {
      return;
    }
    void vscode.window.showWarningMessage(
      `Readora: "${uri.fsPath}" was deleted; the reader panel was closed.`
    );
    sessions.disposeSession(session);
  }

  /**
   * 视图状态命令的公共骨架（ARC-004 §4.1 focusMode / toggleOutline、§4.5 宽度键位）：
   * 只改会话状态，然后立刻下发 reader.viewState；没有面板时静默返回，
   * 于是命令在「还没有打开阅读器」的空档里不会留下任何通知或状态残留。
   */
  function withViewState(patch: (sessionId: string) => void): void {
    const session = sessions.activeSession();
    if (!session || !session.panel) {
      return;
    }
    patch(session.id);
    webviews.postViewState(session.id);
  }

  function toggleInPlace(key: "focusMode" | "outlineVisible"): void {
    withViewState((sessionId) => {
      const current = sessions.viewStateOf(sessionId);
      if (!current) {
        return;
      }
      // 分支写补丁而不是计算键：Patch 的形状必须是 ViewStatePayload 的子集。
      sessions.patchViewState(
        sessionId,
        key === "focusMode"
          ? { focusMode: !current.focusMode }
          : { outlineVisible: !current.outlineVisible }
      );
    });
  }

  /**
   * 激活期装配（ARC-004 §9 事件监听、§4.1 命令注册、§11 配置变更）。
   * 单独成函数只为了让 `activate()` 能把它整体包进 try —— F11-013 要求
   * 「激活异常可见」，而散在 return 字面量里的注册代码没法整体捕获。
   */
  function registerActivationListeners(): void {
    /**
     * 配置宽度的基准：与上次事件相比真的变了才同步会话（syncContentWidth）。
     *
     * 会话宽度是命令的领地（adjustContentWidth 只改会话不写配置），改字号、
     * 换主题这类事件不得拿配置值覆盖它；而弹层滑杆与设置 UI 改的正是配置值，
     * 变了就必须落到已打开的面板上 —— 否则用户看到的就是「设置宽度不即时生效」
     * （重开面板才变）。基准在激活期读一次，首个事件比较的就是那份初值。
     */
    let lastConfiguredWidth = configuration.getPreferences().contentWidth;
    disposables.push(
      // 自定义只读编辑器：宿主据此在 readora 打开的 Markdown 上方画出原生面包屑。
      // supportsMultipleEditorsPerDocument:false —— 一篇文档一个编辑器，与「一会话一面板」同口径。
      vscode.window.registerCustomEditorProvider(READORA_VIEW_TYPE, customEditor, {
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: false
      }),
      ...registerCommands({
        openDocument,
        refresh,
        toggleFocusMode: () => toggleInPlace("focusMode"),
        toggleOutline: () => toggleInPlace("outlineVisible"),
        exportDocument,
        adjustContentWidth: (direction: number) => {
          withViewState((sessionId) => {
            sessions.stepContentWidth(sessionId, direction);
          });
        }
      }),
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (isMarkdownDocument(event.document)) {
          scheduleUpdate(event.document.uri);
        }
      }),
      vscode.workspace.onDidSaveTextDocument((document) => {
        if (isMarkdownDocument(document)) {
          scheduleUpdate(document.uri);
        }
      }),
      configuration.onDidChange(() => {
        const preferences = configuration.getPreferences();
        webviews.broadcastTheme(configuration.resolveTheme(preferences));
        webviews.broadcastConfig(preferences, {
          syncContentWidth: preferences.contentWidth !== lastConfiguredWidth
        });
        lastConfiguredWidth = preferences.contentWidth;
      })
    );

    const watcher = vscode.workspace.createFileSystemWatcher("**/*.{md,markdown}");
    disposables.push(
      watcher,
      watcher.onDidChange((uri) => scheduleUpdate(uri)),
      watcher.onDidCreate((uri) => scheduleUpdate(uri)),
      watcher.onDidDelete((uri) => handleDelete(uri))
    );
  }

  return {
    activate(): void {
      // F11-013：激活期异常必须留痕再抛回宿主 —— VS Code 会弹「扩展激活失败」，
      // 但只有输出通道里的这一行能告诉用户是哪一步炸的。
      try {
        registerActivationListeners();
      } catch (error) {
        diagnostics.error(READORA_ERROR_CODES.INTERNAL, `activate: ${toErrorMessage(error)}`);
        throw error;
      }
    },
    dispose(): void {
      for (const timer of updateTimers.values()) {
        clearTimeout(timer);
      }
      updateTimers.clear();
      // 在途导出先作废再拆会话：`sessions.dispose()` 会触发 onSessionDisposed，
      // 但那一路只认已经拿不到的面板；把 pending 定时器在这里清干净，
      // 宿主重载后才不会留下一条「定时到一半发现会话没了」的噪声。
      for (const session of sessions.all()) {
        exportService.forget(session.id);
      }
      for (const disposable of disposables) {
        disposable.dispose();
      }
      disposables.length = 0;
      sessions.dispose();
      webviews.dispose();
      configuration.dispose();
      diagnostics.dispose();
      resources.clearCache();
    }
  };
}