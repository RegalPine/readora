/**
 * 命令注册（ARC-004 §4.1）。
 *
 * M4 起补齐 §4.1 表内的 focusMode / toggleOutline，并增加只服务键位的
 * adjustContentWidth（§4.5「内容宽度增减」，不进命令面板）。
 * 三者都只改会话视图状态，随后由 WebviewManager 下发 reader.viewState；
 * 菜单护栏不变：菜单不得引用未注册命令。
 *
 * M11 的三条导出命令与 openReader / refresh 同一入口：都先过
 * `resolveCommandTarget`（explorer 右键传 Uri 优先，否则回退活动编辑器）。
 * 区别在失败面：解析不出目标时必须说出来 —— 用户按下的是「导出」，
 * 静默 no-op 会被读成「这个文件导不出」而不是「当前没有 Markdown 文件」。
 */
import * as vscode from "vscode";
import type { ExportFormat } from "@readora/contracts";
import { READORA_COMMANDS } from "../constants";
import { toErrorMessage } from "../errors";
import { resolveCommandTarget } from "./target";

export interface CommandDependencies {
  openDocument(uri: vscode.Uri, column: vscode.ViewColumn): Promise<void>;
  refresh(): Promise<void>;
  /** 无活动阅读会话时以下三个动作都是 no-op，不打扰用户。 */
  toggleFocusMode(): void;
  toggleOutline(): void;
  adjustContentWidth(direction: number): void;
  /**
   * 导出（M11）。命令面板 / 编辑器右键 / 资源管理器右键三条入口都汇到这里，
   * 与顶栏菜单在 Host 侧再汇成同一个 `ExportService.requestExport`；
   * 「没有阅读会话」的判断留在装配层，本层只管把 URI 交出去。
   */
  exportDocument(documentUri: string, format: ExportFormat): Promise<void>;
}

/**
 * 宽度参数只认方向：键位传 -1 / 1，命令面板或异常输入按「减档」处理，
 * 于是空参数不会莫名放大。
 */
export function toWidthDirection(raw: unknown): number {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return -1;
  }
  return value < 0 ? -1 : 1;
}

export function registerCommands(deps: CommandDependencies): vscode.Disposable[] {
  const open = async (arg: unknown, column: vscode.ViewColumn): Promise<void> => {
    const target = resolveCommandTarget(arg);
    if (!target) {
      void vscode.window.showErrorMessage(
        "Readora: open a Markdown file to use the reader."
      );
      return;
    }
    try {
      await deps.openDocument(target.uri, column);
    } catch (error) {
      void vscode.window.showErrorMessage(toErrorMessage(error));
    }
  };

  // 视图切换类命令不该弹错误通知：没有阅读器面板时按不动作即可。
  const viewAction =
    (action: (...args: unknown[]) => void): ((...args: unknown[]) => void) =>
    (...args: unknown[]): void => {
      try {
        action(...args);
      } catch (error) {
        void vscode.window.showWarningMessage(toErrorMessage(error));
      }
    };

  /**
   * 导出命令骨架：目标解析不出来就早退，连会话都不查。
   *
   * 这条早退分支同时是激活冒烟（`host-activation-smoke.mjs` 会逐条 invoke
   * manifest 里的所有命令体）的安全垫：空窗口里按导出只会得到一句提示，
   * 不会弹保存对话框、不会 spawn 浏览器、也不会写任何文件。
   */
  const exportAction =
    (format: ExportFormat): ((arg: unknown) => Promise<void>) =>
    async (arg: unknown): Promise<void> => {
      const target = resolveCommandTarget(arg);
      if (!target) {
        void vscode.window.showErrorMessage(
          "Readora: open a Markdown file to use the reader."
        );
        return;
      }
      try {
        await deps.exportDocument(target.uri.toString(), format);
      } catch (error) {
        void vscode.window.showErrorMessage(toErrorMessage(error));
      }
    };

  return [
    vscode.commands.registerCommand(READORA_COMMANDS.OPEN_READER, (arg: unknown) =>
      open(arg, vscode.ViewColumn.Active)
    ),
    vscode.commands.registerCommand(READORA_COMMANDS.OPEN_TO_SIDE, (arg: unknown) =>
      open(arg, vscode.ViewColumn.Beside)
    ),
    vscode.commands.registerCommand(
      READORA_COMMANDS.FOCUS_MODE,
      viewAction(() => {
        deps.toggleFocusMode();
      })
    ),
    vscode.commands.registerCommand(
      READORA_COMMANDS.TOGGLE_OUTLINE,
      viewAction(() => {
        deps.toggleOutline();
      })
    ),
    vscode.commands.registerCommand(
      READORA_COMMANDS.ADJUST_CONTENT_WIDTH,
      viewAction((arg: unknown) => {
        deps.adjustContentWidth(toWidthDirection(arg));
      })
    ),
    vscode.commands.registerCommand(READORA_COMMANDS.REFRESH, async () => {
      try {
        await deps.refresh();
      } catch (error) {
        void vscode.window.showErrorMessage(toErrorMessage(error));
      }
    }),
    vscode.commands.registerCommand(READORA_COMMANDS.EXPORT_HTML, exportAction("html")),
    vscode.commands.registerCommand(READORA_COMMANDS.EXPORT_PDF, exportAction("pdf")),
    vscode.commands.registerCommand(READORA_COMMANDS.EXPORT_PNG, exportAction("png"))
  ];
}
