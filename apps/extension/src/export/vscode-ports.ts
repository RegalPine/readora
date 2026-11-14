/**
 * ExportServicePorts 的 VS Code / Node 实现（ARC-004 §3.1 装配边界）。
 *
 * 与 `resources/vscode-port.ts` 同口径：**单测不覆盖本文件**，它只做转译，
 * 判断一律留在可测的模块里（探测顺序、argv、体积闸门、陈旧帧丢弃都在别处）。
 * 因此本文件也不出现在覆盖率分母里（vitest 配置与 vscode-port 同一处理）。
 *
 * 一处值得说明的取舍：`showSaveDialog` 交回 `fsPath` 而不是 URI。导出链路里所有
 * 后续使用者（写盘、Chrome 的 `--print-to-pdf=`、`Open` 按钮）要的都是本地路径，
 * 把 URI 传下去会让每一处都再解一次盘符；唯一需要 URI 的是临时件，那里由
 * `writeTempHtml` 自己 `Uri.file(...).toString()` 交回。
 *
 * 宿主 API 返回的是 `Thenable`，端口签名要的是 `Promise`：每一处都包一层
 * `Promise.resolve`，不指望测试 stub 与真实宿主同构。
 */
import * as vscode from "vscode";
import { spawn as nodeSpawn } from "node:child_process";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExportCapturePayload } from "@readora/contracts";
import type { ResourceService } from "../resources/resource-service";
import type { AssetBytes, InlinePayload } from "./asset-inliner";
import type { BrowserChild } from "./browser-runner";
import {
  EXPORT_TEMP_PREFIX,
  type ExportDiagnostics,
  type ExportServicePorts,
  type ExportSessionInfo,
  type ExportStyleContext,
  type SaveDialogRequest
} from "./export-service";

/** 绝对路径判据：Windows 盘符、POSIX 根与 UNC 都算，裸文件名不算。 */
const ABSOLUTE_PATH = /^(?:\/|[A-Za-z]:[\\/]|\\\\)/u;

export interface ExportPortsDependencies {
  extensionUri: vscode.Uri;
  resources: ResourceService;
  /** 会话事实：装配层用 SessionManager 提供，本文件不认识 panel。 */
  sessionOf(sessionId: string): ExportSessionInfo | null;
  /** `export.capture` 的投递：装配层走 WebviewManager 所在的那条 postMessage 通道。 */
  postCapture(payload: ExportCapturePayload, sessionId: string): void;
  /** `<html>` 四属性与自定义 CSS 由装配层从配置算出（与面板 open() 同源）。 */
  styleContext(): ExportStyleContext;
  getChromePath(): string;
  diagnostics: ExportDiagnostics;
}

export function createExportPorts(deps: ExportPortsDependencies): ExportServicePorts {
  const assetDirectory = vscode.Uri.joinPath(deps.extensionUri, "dist", "webview", "assets");
  const tempFile = (requestId: string): vscode.Uri =>
    vscode.Uri.file(join(tmpdir(), `${EXPORT_TEMP_PREFIX}-${requestId}.html`));

  return {
    sessionOf: deps.sessionOf,
    postCapture: deps.postCapture,
    showSaveDialog: async (request: SaveDialogRequest) => {
      // 覆盖确认不在这里做：`SaveDialogOptions` 没有 overwrite 这一项，
      // 原生保存面板自己会问「已存在，是否替换」，而 `workspace.fs.writeFile`
      // 本来就覆盖写。扩展自己再加一层「文件存在就报错」反而是倒退。
      const options: vscode.SaveDialogOptions = {
        filters: { [request.filterName]: [...request.extensions] }
      };
      // 拿不到目录（非 file: 文档、根目录文档）就不给 defaultUri：猜一个起点
      // 比留空更容易把文件写到用户没打算放的地方。
      if (ABSOLUTE_PATH.test(request.defaultPath)) {
        options.defaultUri = vscode.Uri.file(request.defaultPath);
      }
      const picked = await Promise.resolve(vscode.window.showSaveDialog(options));
      return picked ? picked.fsPath : null;
    },
    showMessage: (kind, message, actions) =>
      Promise.resolve(
        kind === "info"
          ? vscode.window.showInformationMessage(message, ...actions)
          : vscode.window.showErrorMessage(message, ...actions)
      ),
    openPath: (path) =>
      Promise.resolve(vscode.env.openExternal(vscode.Uri.file(path))).then(() => undefined),
    writeFile: (path, content) =>
      Promise.resolve(vscode.workspace.fs.writeFile(vscode.Uri.file(path), content)),
    async readAsset(name) {
      const uri = vscode.Uri.joinPath(assetDirectory, name);
      let bytes: Uint8Array;
      try {
        bytes = await Promise.resolve(vscode.workspace.fs.readFile(uri));
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code === "FileNotFound" || code === "EntryNotFound") {
          return null;
        }
        throw error;
      }
      let mtimeMs: number;
      try {
        mtimeMs = (await Promise.resolve(vscode.workspace.fs.stat(uri))).mtime;
      } catch {
        // 刚读成功却 stat 失败：mtime 缺失只会让缓存少命中一次，不影响正确性。
        mtimeMs = 0;
      }
      const asset: AssetBytes = { bytes, size: bytes.byteLength, mtimeMs };
      return asset;
    },
    async readImage(documentUri, reference): Promise<InlinePayload | null> {
      // 走 ResourceService.readInline：与屏上同一套策略与同一个 maxImageSizeMb。
      const outcome = await deps.resources.readInline({ documentUri, reference, kind: "image" });
      return outcome.ok ? { mimeType: outcome.mimeType, base64: outcome.base64 } : null;
    },
    async writeTempHtml(requestId, html) {
      const uri = tempFile(requestId);
      await Promise.resolve(
        vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(html))
      );
      return uri.toString();
    },
    async removeTempHtml(fileUri) {
      try {
        await Promise.resolve(
          vscode.workspace.fs.delete(vscode.Uri.parse(fileUri), { useTrash: false })
        );
      } catch {
        // 临时件已经不在（被系统清理 / 重复调用）不是导出失败，不值得升级成错误。
      }
    },
    exists: (path) => existsSync(path),
    styleContext: deps.styleContext,
    getChromePath: deps.getChromePath,
    environment: process.env,
    diagnostics: deps.diagnostics,
    spawn(exe, args): BrowserChild {
      const child = nodeSpawn(exe, [...args]);
      let stderr = "";
      let resolveExit: (code: number | null) => void = () => undefined;
      const exited = new Promise<number | null>((resolve) => {
        resolveExit = resolve;
      });
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => {
        stderr += chunk;
      });
      // stdout 必须有人接着：Chrome 往里面写进度时管道塞满会把进程挂住。
      child.stdout?.resume();
      child.once("close", (code) => resolveExit(code));
      child.once("error", (error) => {
        stderr += `${error.message}\n`;
        // spawn 失败（ENOENT / 权限）在 close 之前发生：给一个非零码，
        // 让上层「退出码 + stderr 尾部」那一条出口把它说出来。
        resolveExit(-1);
      });
      return {
        exited,
        kill: () => {
          child.kill("SIGKILL");
        },
        stderrText: () => stderr
      };
    }
  };
}
