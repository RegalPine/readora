/**
 * 扩展入口（ARC-004 §3.1）：只负责生命周期初始化和模块装配。
 * 所有 Disposable 由 ReaderApplication 统一管理。
 */
import * as vscode from "vscode";
import { createReaderApplication, type ReaderApplication } from "./application";

let application: ReaderApplication | undefined;

export function activate(context: vscode.ExtensionContext): void {
  application = createReaderApplication(context);
  application.activate();
}

export function deactivate(): void {
  application?.dispose();
  application = undefined;
}
