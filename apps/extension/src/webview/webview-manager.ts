/**
 * Webview 面板管理（ARC-004 §7 / §8.7 / §10）。
 *
 * 关键顺序（首屏空白事故的结构性防线）：
 * 1. payload 预校验在创建面板之前，超限/非法早报；
 * 2. 面板创建后 document.load 只暂存（PendingDeliveries），不发送；
 * 3. 收到 reader.ready 后才投递 document.load + theme.update；
 * 4. postMessage 返回 true 不代表 Webview 已接收，不做成功假设。
 *
 * M4 起 reader.viewState 同守这一门控：ready 之前的切换只更新会话状态，
 * 由 deliverPending 随首帧一起补投，避免「命令早于页面」的状态丢失。
 */
import * as vscode from "vscode";
import { randomBytes } from "node:crypto";
import { basename } from "node:path";
import {
  createEnvelope,
  parsePayload,
  themePalette,
  type ExportCapturePayload,
  type ThemeState,
  type DocumentLoadPayload,
  type DocumentSnapshot,
  type ReaderPreferences,
  type ViewStatePayload
} from "@readora/contracts";
import type { CustomCssResult } from "@readora/design-tokens";
import { READORA_ACTIVE_CONTEXT, READORA_VIEW_TYPE } from "../constants";
import { ReaderError } from "../errors";
import type { MessageDispatcher } from "../messaging/dispatcher";
import { authorizedRoots } from "../resources/boundary";
import type { ReaderSession, SessionManager } from "../session/session-manager";
import { renderWebviewHtml } from "./html-template";
import { PendingDeliveries } from "./pending-delivery";

export interface WebviewManagerDependencies {
  extensionUri: vscode.Uri;
  dispatcher: MessageDispatcher;
  sessions: SessionManager;
  getPreferences(): ReaderPreferences;
  resolveTheme(preferences?: ReaderPreferences): ThemeState;
  /**
   * 自定义 CSS 的净化结果（F08-011）。
   *
   * 每次开面板都重算一次：配置改完立刻重开面板就能看到效果，
   * 而把「原文 → 净化」放在 Host 侧，Webview 永远拿不到不可信样式文本。
   */
  resolveCustomCss(): CustomCssResult;
  /** 工作区 folder 路径（用于计算 localResourceRoots 的第二授权根）。 */
  workspaceFolders(): readonly string[];
  onSessionDisposed(session: ReaderSession): void;
}

export class WebviewManager implements vscode.Disposable {
  private readonly pending = new PendingDeliveries<DocumentLoadPayload>();
  /** 每个会话最后一次投递的 theme.update，用于去重（见 postTheme）。 */
  private readonly lastThemeSent = new Map<string, ThemeState>();
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor(private readonly deps: WebviewManagerDependencies) {}

  /** 打开面板并暂存首帧载荷；调用前 snapshot 必须已通过读取校验。 */
  open(
    session: ReaderSession,
    snapshot: DocumentSnapshot,
    preferences: ReaderPreferences,
    column: vscode.ViewColumn
  ): vscode.WebviewPanel {
    const payload: DocumentLoadPayload = { ...snapshot, preferences };
    const validated = parsePayload<DocumentLoadPayload>("document.load", payload);
    if (!validated.ok) {
      throw new ReaderError(validated.error.code as ReaderError["code"], validated.error.message);
    }

    const panel = vscode.window.createWebviewPanel(
      READORA_VIEW_TYPE,
      `Readora — ${basename(vscode.Uri.parse(snapshot.documentUri).fsPath)}`,
      column,
      {
        enableScripts: true,
        // ADR-004-004：隐藏时保留上下文，避免切回重复加载。
        retainContextWhenHidden: true,
        localResourceRoots: this.panelResourceRoots(snapshot.documentUri)
      }
    );
    session.panel = panel;
    session.documentVersion = snapshot.version;

    const webview = panel.webview;
    const nonce = randomBytes(16).toString("hex");
    const assetUri = (file: string): string =>
      webview
        .asWebviewUri(
          vscode.Uri.joinPath(this.deps.extensionUri, "dist", "webview", "assets", file)
        )
        .toString();
    const themeState = this.deps.resolveTheme(preferences);
    const customCss = this.deps.resolveCustomCss();
    webview.html = renderWebviewHtml({
      nonce,
      cspSource: webview.cspSource,
      scriptUri: assetUri("main.js"),
      styleUri: assetUri("main.css"),
      // 首帧就把主题写进 <html>：等 theme.update 回来再上色会闪一次白（PRD-003 §11.3）。
      palette: themePalette(themeState),
      scheme: themeState.mode,
      // 字族与预设同理：三者都是「paint 之前必须到位」的取色/排版维度。
      typography: preferences.typography,
      preset: preferences.themePreset,
      customCss: customCss.ok ? customCss.css : ""
    });

    // 只暂存、不发送：等待 reader.ready（ARC-004 §8.7）。
    this.pending.stage(session.id, validated.value);
    // 视图状态与首帧同批：初值取偏好，命令切换只在会话内生效（ARC-004 §6.2）。
    this.deps.sessions.initializeViewState(session.id, preferences);
    this.setReaderActive(true);

    this.subscriptions.push(
      webview.onDidReceiveMessage((raw: unknown) => {
        void this.deps.dispatcher
          .dispatch(raw, { sessionId: session.id, messageId: "" })
          .then((response) => {
            void webview.postMessage(response);
          });
      }),
      // 键位 when 的上下文来源：只要有任一阅读器面板可见，readora.readerActive 为真。
      panel.onDidChangeViewState(() => {
        this.setReaderActive(this.hasVisiblePanel());
      }),
      panel.onDidDispose(() => {
        this.pending.discard(session.id);
        this.lastThemeSent.delete(session.id);
        this.deps.onSessionDisposed(session);
        this.setReaderActive(this.hasVisiblePanel());
      })
    );
    return panel;
  }

  /** 是否还有可见的阅读器面板（决定 readora.readerActive 上下文键）。 */
  private hasVisiblePanel(): boolean {
    return this.deps.sessions.all().some((session) => session.panel?.visible === true);
  }

  /**
   * 写 VS Code 上下文键（ARC-004 §4.5 键位 when 条件）。
   * setContext 是命令表之外的内部命令，注册失败不得影响面板本身。
   */
  private setReaderActive(active: boolean): void {
    void vscode.commands
      .executeCommand("setContext", READORA_ACTIVE_CONTEXT, active)
      .then(undefined, () => undefined);
  }

  /**
   * 面板可读根 = 构建产物目录 + 文档所在目录 + 包含该文档的 workspace folder
   * （ARC-008 §5.1 要求 `../assets/logo.png` 可解析，只给 docDir 会误拒）。
   * 可读面扩大由两道闸门收敛：resource-policy 的 MIME/大小白名单、
   * boundary 的按段包含判断与 realpath 二次校验；Webview 永远拿不到本地绝对路径。
   */
  private panelResourceRoots(documentUri: string): vscode.Uri[] {
    const roots = new Map<string, vscode.Uri>();
    const add = (uri: vscode.Uri): void => {
      roots.set(uri.toString(), uri);
    };
    add(vscode.Uri.joinPath(this.deps.extensionUri, "dist", "webview"));
    add(vscode.Uri.joinPath(this.deps.extensionUri, "resources"));
    const parsed = vscode.Uri.parse(documentUri);
    if (parsed.scheme === "file") {
      for (const path of authorizedRoots(documentUri, this.deps.workspaceFolders())) {
        add(parsed.with({ path, query: "", fragment: "" }));
      }
    }
    return [...roots.values()];
  }

  /**
   * resource.resolve 出口：按会话面板转换，保证 URI 只在该面板内可解析。
   * 面板已释放返回 null，由调用方映射为 unreadable。
   */
  asWebviewUri(sessionId: string, uri: vscode.Uri): vscode.Uri | null {
    const panel = this.deps.sessions.getById(sessionId)?.panel;
    return panel ? panel.webview.asWebviewUri(uri) : null;
  }

  /** reader.ready 门控投递：取出即删，重复 ready 不会重复投递。 */
  deliverPending(sessionId: string): void {
    const payload = this.pending.deliver(sessionId);
    if (!payload) {
      return;
    }
    const session = this.deps.sessions.getById(sessionId);
    const panel = session?.panel;
    if (!session || session.isDisposed || !panel) {
      return;
    }
    void panel.webview.postMessage(createEnvelope("document.load", payload));
    this.postTheme(sessionId, this.deps.resolveTheme(payload.preferences));
    // 视图状态随首帧下发：Webview 先知道「该不该有左栏」，再渲染正文。
    this.postViewState(sessionId);
    if (session.readingState) {
      void panel.webview.postMessage(
        createEnvelope("state.restore", { state: session.readingState })
      );
    }
  }

  /**
   * 下发会话视图状态（reader.viewState）。
   *
   * 首帧尚未投递（面板未 ready）时静默返回：状态已在会话里，
   * 由 deliverPending 补投，于是命令与页面初始化谁先到都不影响最终一致。
   */
  postViewState(sessionId: string): void {
    const session = this.deps.sessions.getById(sessionId);
    const panel = session?.panel;
    const viewState = session?.viewState;
    if (!session || session.isDisposed || !panel || !viewState) {
      return;
    }
    if (this.pending.peek(sessionId)) {
      return;
    }
    const validated = parsePayload<ViewStatePayload>("reader.viewState", viewState);
    if (!validated.ok) {
      return;
    }
    void panel.webview.postMessage(createEnvelope("reader.viewState", validated.value));
  }

  /**
   * 投递 export.capture（M11）。
   *
   * 与 postViewState 同一门控：ready 之前不投 —— 面板还没有 DOM，取到的帧必然是空的。
   * 但这里不像 postViewState 那样「等补投」：导出是一次用户点击换来的瞬时请求，
   * 错过那一帧就应该让 Host 侧的 10 秒超时说出「页面没回答」，而不是在几分钟后
   * 突然弹出一个「已导出」。
   */
  postExportCapture(sessionId: string, payload: ExportCapturePayload): void {
    const session = this.deps.sessions.getById(sessionId);
    const panel = session?.panel;
    if (!session || session.isDisposed || !panel) {
      return;
    }
    if (this.pending.peek(sessionId)) {
      return;
    }
    const validated = parsePayload<ExportCapturePayload>("export.capture", payload);
    if (!validated.ok) {
      return;
    }
    void panel.webview.postMessage(createEnvelope("export.capture", validated.value));
  }

  /** 增量更新：版本防旧覆盖（迟到的旧快照不得覆盖新内容）。 */
  pushUpdate(
    session: ReaderSession,
    snapshot: DocumentSnapshot,
    preferences: ReaderPreferences
  ): void {
    const panel = session.panel;
    if (!panel || session.isDisposed) {
      return;
    }
    if (snapshot.version < session.documentVersion) {
      return;
    }
    const payload: DocumentLoadPayload = { ...snapshot, preferences };
    const validated = parsePayload<DocumentLoadPayload>("document.update", payload);
    if (!validated.ok) {
      return;
    }
    session.documentVersion = snapshot.version;
    void panel.webview.postMessage(createEnvelope("document.update", validated.value));
  }

  /**
   * 广播归一后的主题（ARC-006 §11 生命周期）。
   *
   * 解析结果与上次相同就不发：product 模式下换宿主主题、vscode 模式下
   * 从一个暗色主题切到另一个暗色主题，取色层都没变，多余的 message
   * 只会让 Webview 走一遍无谓的状态更新（§11.1「不重建 Reader Shell」）。
   */
  broadcastTheme(state: ThemeState): void {
    for (const session of this.deps.sessions.all()) {
      if (session.panel) {
        this.postTheme(session.id, state);
      }
    }
  }

  /** 只在状态真的变化时投递，并记住已投递的值。 */
  private postTheme(sessionId: string, state: ThemeState): void {
    const panel = this.deps.sessions.getById(sessionId)?.panel;
    if (!panel) {
      return;
    }
    const last = this.lastThemeSent.get(sessionId);
    if (last && last.mode === state.mode && last.source === state.source) {
      return;
    }
    this.lastThemeSent.set(sessionId, state);
    void panel.webview.postMessage(
      createEnvelope("theme.update", { theme: state.mode, source: state.source })
    );
  }

  /**
   * 配置变更广播。
   *
   * `showOutline` 是用户设置，因此以配置为准覆盖会话的 `outlineVisible`；
   * `focusMode` 与命令改过的宽度属会话状态，不随配置回滚（ARC-007 §10.1）。
   */
  broadcastConfig(preferences: ReaderPreferences): void {
    for (const session of this.deps.sessions.all()) {
      if (session.panel) {
        void session.panel.webview.postMessage(
          createEnvelope("config.update", { preferences })
        );
        this.deps.sessions.patchViewState(session.id, {
          outlineVisible: preferences.showOutline
        });
        this.postViewState(session.id);
      }
    }
  }

  dispose(): void {
    this.pending.clear();
    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }
    this.subscriptions.length = 0;
  }
}