/**
 * 自定义只读编辑器 provider（ARC-004 §7 面板生命周期的自定义编辑器形态）。
 *
 * 为什么要注册成 CustomEditorProvider 而不是 createWebviewPanel：
 * 宿主只在「编辑器」（文本编辑器或自定义编辑器）上方画原生面包屑栏，普通 webview
 * 面板没有这条 chrome。注册后 Markdown 以 readora 打开时，宿主自动给出面包屑 +
 * 原生 Quick Pick（点目录段列同级文件、带 git 装饰、Ctrl+Click 等），我们不再自绘
 * 那套目录切换 UI —— 「用 VS Code 的，不用自己实现」。
 *
 * priority 取 "option"：文本编辑器仍是 .md 的默认打开方式，readora 作为「打开方式」
 * 候选，行为最保守，不改变用户既有习惯。
 *
 * 面板装配（HTML、首帧暂存、reader.ready 门控、消息接线、释放清理）全部复用
 * WebviewManager.configure，与历史 createWebviewPanel 路径逐字段同源；本文件只负责
 * 「宿主把面板交给我们 → 我们读快照并装配」这一段编排。
 */
import * as vscode from "vscode";
import type { DocumentSnapshot, ReaderPreferences } from "@readora/contracts";
import type { WebviewManager } from "./webview-manager";
import type { SessionManager } from "../session/session-manager";

interface ReadoraCustomDocument extends vscode.CustomDocument {
  readonly uri: vscode.Uri;
}

export interface CustomEditorDependencies {
  /** 读文档快照（含超限预校验）；失败即 reject，宿主显示打开失败。 */
  readSnapshot(uri: vscode.Uri): Promise<DocumentSnapshot>;
  sessions: SessionManager;
  webviews: WebviewManager;
  getPreferences(): ReaderPreferences;
}

export class ReadoraCustomEditorProvider
  implements vscode.CustomReadonlyEditorProvider<ReadoraCustomDocument>
{
  constructor(private readonly deps: CustomEditorDependencies) {}

  openCustomDocument(uri: vscode.Uri): ReadoraCustomDocument {
    // 只读编辑器：没有编辑模型、没有撤销栈，dispose 无事可做（面板释放由会话负责）。
    // openContext / token 在本形态下用不到，按 TS 允许的实现签名省略尾部参数。
    return { uri, dispose: () => {} };
  }

  async resolveCustomEditor(
    document: ReadoraCustomDocument,
    webviewPanel: vscode.WebviewPanel
  ): Promise<void> {
    const snapshot = await this.deps.readSnapshot(document.uri);
    const { session } = this.deps.sessions.getOrCreate(document.uri.toString());
    const preferences = this.deps.getPreferences();
    // 授权根与 createWebviewPanel 路径同源：dist/webview + resources + 文档目录链。
    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: this.deps.webviews.panelResourceRoots(snapshot.documentUri)
    };
    this.deps.webviews.configure(session, snapshot, preferences, webviewPanel);
  }
}
