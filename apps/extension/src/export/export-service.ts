/**
 * 导出装配（M11 · 导出链路）。
 *
 * 两条入口（顶栏菜单的 `export.request`、命令面板/右键的三条命令）在这里汇成同一个
 * `requestExport`，因此「命令导出的字节」与「菜单导出的字节」不可能漂移。
 *
 * 三条不可让的口径（计划锁定）：
 * 1. **保存对话框是唯一写盘授权边界。** 取消 ⇒ 零写盘、零临时件，而且**不向 View 取帧**
 *    （整篇序列化是无谓的开销）；取消不是错误，不占错误码，只在输出通道留一行。
 * 2. **先问路径再取帧，取帧回来还要校验版本。** 与 `state.save` 同一护栏范式：
 *    `documentUri` 与 `version` 任一不符就按陈旧丢弃并提示重按，绝不把旧帧写到
 *    用户刚选的新位置。
 * 3. **体积不过关就不产出文件。** 不降级成旁置 assets 目录，也不截断 ——
 *    「半交付物」比「这次没成功」更难解释。
 *
 * 本模块不 import vscode：一切外部效果（对话框、写盘、临时件、spawn、通知）经端口注入，
 * 真机实现在 `vscode-ports.ts`。
 */
import { randomUUID } from "node:crypto";
import {
  READORA_ERROR_CODES,
  type ExportCapturePayload,
  type ExportDataPayload,
  type ExportFormat,
  type ReadoraErrorCode,
  type ReaderTypography,
  type ResolvedTheme,
  type ThemePalette,
  type ThemePreset
} from "@readora/contracts";
import {
  EXPORT_BROWSER_TIMEOUT_MS,
  EXPORT_CANCELLED_DIAGNOSTIC,
  EXPORT_CAPTURE_TIMEOUT_MS,
  EXPORT_DIAGNOSTIC,
  EXPORT_MAX_TOTAL_BYTES,
  EXPORT_PNG_MAX_HEIGHT_PX
} from "../constants";
import { ReaderError, toErrorMessage } from "../errors";
import {
  inlineCssAssets,
  inlineImages,
  type AssetReader,
  type InlinePayload
} from "./asset-inliner";
import { buildPdfArgs, buildPngArgs, isPngHeightTruncated, pngViewportHeight, runBrowser, type BrowserSpawner } from "./browser-runner";
import { findChromium, type Environment } from "./chrome-locator";
import { composeExportHtml, type ExportHtmlInput } from "./html-builder";

/** 样式表在归档里的文件名：内联字体要读的就是它。 */
export const EXPORT_STYLESHEET_ASSET = "main.css";
/** 成功通知里唯一附带的动作：把刚写完的文件交给 OS 打开。 */
export const EXPORT_OPEN_ACTION = "Open";
/** 临时 HTML 的文件名前缀：`readora-export-<requestId>.html`，`finally` 必删。 */
export const EXPORT_TEMP_PREFIX = "readora-export";

const EXTENSION_BY_FORMAT: Readonly<Record<ExportFormat, string>> = {
  html: "html",
  pdf: "pdf",
  png: "png"
};

const FILTER_NAME_BY_FORMAT: Readonly<Record<ExportFormat, string>> = {
  html: "HTML",
  pdf: "PDF",
  png: "PNG image"
};

/** 会话的可导出性事实：本模块不认识 WebviewPanel，只认「有没有面板」。 */
export interface ExportSessionInfo {
  readonly sessionId: string;
  readonly documentUri: string;
  readonly documentVersion: number;
  readonly hasPanel: boolean;
}

/** `<html>` 上的四个主题属性与自定义 CSS：装配层从配置算好后交进来。 */
export interface ExportStyleContext {
  readonly palette: ThemePalette;
  readonly scheme: ResolvedTheme;
  readonly typography: ReaderTypography;
  readonly preset: ThemePreset;
  readonly customCss: string;
}

export interface SaveDialogRequest {
  readonly defaultPath: string;
  readonly filterName: string;
  readonly extensions: readonly string[];
}

export interface ExportDiagnostics {
  info(code: string, message: string): void;
  warn(code: string, message: string): void;
  error(code: string, message: string): void;
}

export interface ExportServicePorts {
  sessionOf(sessionId: string): ExportSessionInfo | null;
  postCapture(payload: ExportCapturePayload, sessionId: string): void;
  showSaveDialog(request: SaveDialogRequest): Promise<string | null>;
  /**
   * 用户通知：成功走 info（附 `Open`），失败走 error。
   * 返回被按下的按钮标题（没按为 `undefined`）—— 它不是错误码，也不参与任何判断。
   */
  showMessage(
    kind: "info" | "error",
    message: string,
    actions: readonly string[]
  ): Promise<string | undefined>;
  openPath(path: string): Promise<void>;
  writeFile(path: string, content: Uint8Array): Promise<void>;
  readAsset: AssetReader;
  readImage(documentUri: string, reference: string): Promise<InlinePayload | null>;
  writeTempHtml(requestId: string, html: string): Promise<string>;
  removeTempHtml(fileUri: string): Promise<void>;
  exists(path: string): boolean;
  /** `<html>` 上的四个主题属性与自定义 CSS：装配层从配置算好后交进来。 */
  styleContext(): ExportStyleContext;
  getChromePath(): string;
  environment: Environment;
  spawn: BrowserSpawner;
  /** 测试注入点：三种系统的探测分支都靠它走到。 */
  platform?: string;
  diagnostics: ExportDiagnostics;
}

interface PendingExport {
  readonly requestId: string;
  readonly format: ExportFormat;
  readonly sessionId: string;
  readonly targetPath: string;
  timer: ReturnType<typeof setTimeout>;
}

function decodeSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * scheme 与 authority：`untitled:Untitled-1`、`file:///docs/read.md`、
 * `vscode-vfs://github/owner/repo/x.md` 里都不是文件名的一部分。
 */
const WITHOUT_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:(\/\/[^/]*)?/u;

/** `file:///docs/src/read.md` → 目录部分（非 file 协议返回空串，只给文件名）。 */
function directoryOf(documentUri: string): string {
  const withoutScheme = /^file:\/\//u.test(documentUri)
    ? decodeSegment(documentUri.slice("file://".length))
    : "";
  const cut = withoutScheme.lastIndexOf("/");
  return cut <= 0 ? "" : withoutScheme.slice(0, cut);
}

/** 文档名（去扩展名）：默认落盘名与 `<title>` 同源。 */
export function documentBaseName(documentUri: string): string {
  const text = decodeSegment(documentUri.replace(WITHOUT_SCHEME, ""));
  const name = text.slice(text.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

/**
 * 默认落盘位置：`<md 同名同目录>.<ext>`（锁定口径）。
 *
 * 目录拿不到（非 `file:` 文档或根目录文档）时就只给文件名，让对话框自己决定起点 ——
 * 猜一个目录比留空更容易把文件写到用户没打算放的地方。
 */
export function exportDefaultPath(documentUri: string, format: ExportFormat): string {
  const directory = directoryOf(documentUri);
  const name = `${documentBaseName(documentUri) || "document"}.${EXTENSION_BY_FORMAT[format]}`;
  return directory === "" ? name : `${directory}/${name}`;
}

function describeBytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export class ExportService {
  private readonly pending = new Map<string, PendingExport>();

  constructor(private readonly ports: ExportServicePorts) {}

  /** 在途导出数：同一会话同时只允许一个（后来者给提示，不排队）。 */
  get pendingCount(): number {
    return this.pending.size;
  }

  /** 会话释放时调用：丢弃 pending，迟到的 `export.data` 因此无主可归。 */
  forget(sessionId: string): void {
    const entry = this.pending.get(sessionId);
    if (entry) {
      clearTimeout(entry.timer);
      this.pending.delete(sessionId);
    }
  }

  /**
   * 第一步：会话校验 → 保存对话框 → 确认后才向 View 索取那一帧。
   *
   * 顺序不能反：先取帧再问路径，取消的用户也要为整篇序列化付代价，而且取消时
   * 连「要不要导出」都还没决定。
   */
  async requestExport(sessionId: string, format: ExportFormat): Promise<void> {
    const session = this.ports.sessionOf(sessionId);
    if (session === null || !session.hasPanel) {
      await this.fail(
        READORA_ERROR_CODES.EXPORT_FAILED,
        "the reader panel is closed; open the document before exporting."
      );
      return;
    }
    if (this.pending.has(sessionId)) {
      await this.notify(
        "info",
        "Readora: an export for this document is already running.",
        []
      );
      return;
    }
    const defaultPath = exportDefaultPath(session.documentUri, format);
    const targetPath = await this.ports.showSaveDialog({
      defaultPath,
      filterName: FILTER_NAME_BY_FORMAT[format],
      extensions: [EXTENSION_BY_FORMAT[format]]
    });
    if (targetPath === null) {
      // 取消：零写盘、零临时件、不向 View 取帧，只在通道里留一行。
      this.ports.diagnostics.info(
        EXPORT_CANCELLED_DIAGNOSTIC,
        `Save dialog dismissed for ${format.toUpperCase()} export.`
      );
      return;
    }
    const requestId = randomUUID();
    const entry: PendingExport = {
      requestId,
      format,
      sessionId,
      targetPath,
      timer: setTimeout(() => {
        void this.onCaptureTimeout(entry);
      }, EXPORT_CAPTURE_TIMEOUT_MS)
    };
    this.pending.set(sessionId, entry);
    this.ports.postCapture({ requestId, format }, sessionId);
  }

  /** 第三步：收帧、组装、写盘（PDF/PNG 再走本机浏览器）。 */
  async onExportData(payload: ExportDataPayload, sessionId: string): Promise<void> {
    const entry = this.pending.get(sessionId);
    if (entry === undefined || entry.requestId !== payload.requestId) {
      // 无主 / 陈旧：多半是超时已清理后又迟到的帧，绝不能再写一次盘。
      this.ports.diagnostics.warn(
        READORA_ERROR_CODES.EXPORT_FAILED,
        "Dropped export.data without a matching request."
      );
      return;
    }
    clearTimeout(entry.timer);
    this.pending.delete(sessionId);
    const session = this.ports.sessionOf(sessionId);
    if (
      session === null ||
      session.documentUri !== payload.documentUri ||
      session.documentVersion !== payload.version ||
      entry.format !== payload.format
    ) {
      await this.fail(
        READORA_ERROR_CODES.EXPORT_FAILED,
        "the document changed while exporting; please export again."
      );
      return;
    }
    try {
      await this.deliver(entry, payload, session);
    } catch (error) {
      const code = error instanceof ReaderError ? error.code : READORA_ERROR_CODES.EXPORT_FAILED;
      this.ports.diagnostics.error(code, toErrorMessage(error));
      await this.notify("error", toErrorMessage(error), []);
    }
  }

  private async onCaptureTimeout(entry: PendingExport): Promise<void> {
    if (this.pending.get(entry.sessionId)?.requestId !== entry.requestId) {
      return;
    }
    this.pending.delete(entry.sessionId);
    await this.fail(
      READORA_ERROR_CODES.EXPORT_FAILED,
      "the reader did not answer the export request in time."
    );
  }

  /**
   * 正片：样式表内联 → 图片内联 → 组装 → 体积闸门 → 写盘 / 交给浏览器。
   *
   * 每一步的失败都冒到 `onExportData` 的统一出口，因此「字体读不全」与
   * 「Chrome 崩了」在用户侧长得一样：一条错误通知 + 输出通道里的一条诊断。
   */
  private async deliver(
    entry: PendingExport,
    payload: ExportDataPayload,
    session: ExportSessionInfo
  ): Promise<void> {
    const html = await this.buildHtml(payload, session);
    const bytes = Buffer.byteLength(html, "utf8");
    if (bytes > EXPORT_MAX_TOTAL_BYTES) {
      throw new ReaderError(
        READORA_ERROR_CODES.EXPORT_TOO_LARGE,
        `the export would be ${describeBytes(bytes)}, above the ${describeBytes(EXPORT_MAX_TOTAL_BYTES)} limit.`
      );
    }
    if (entry.format === "html") {
      await this.ports.writeFile(entry.targetPath, new Uint8Array(Buffer.from(html, "utf8")));
      await this.succeed(entry, 0);
      return;
    }
    const browser = await this.resolveBrowser();
    // 临时件交回的是 `file:` URI 而不是路径：Windows 的盘符、反斜杆与空格
    // 都只能由知道真实文件系统的那一侧翻译，本层拼 `file://` + path 会出坏 URI。
    const tempUri = await this.ports.writeTempHtml(entry.requestId, html);
    try {
      const heightPx = pngViewportHeight(payload.contentHeightPx);
      const args =
        entry.format === "pdf"
          ? buildPdfArgs(tempUri, entry.targetPath)
          : buildPngArgs(tempUri, entry.targetPath, payload.canvasWidthPx, heightPx);
      const result = await runBrowser(browser, args, EXPORT_BROWSER_TIMEOUT_MS, this.ports.spawn);
      if (result.timedOut) {
        throw new ReaderError(
          READORA_ERROR_CODES.EXPORT_FAILED,
          "the browser did not finish in time."
        );
      }
      if (result.spawnError !== null) {
        throw new ReaderError(
          READORA_ERROR_CODES.EXPORT_FAILED,
          `cannot start the browser (${result.spawnError}).`
        );
      }
      if (result.exitCode !== 0 || !this.ports.exists(entry.targetPath)) {
        const detail = result.stderrTail === "" ? "no stderr output" : result.stderrTail;
        this.ports.diagnostics.error(
          READORA_ERROR_CODES.EXPORT_FAILED,
          `browser exit=${String(result.exitCode)} ${detail}`
        );
        throw new ReaderError(
          READORA_ERROR_CODES.EXPORT_FAILED,
          "the browser failed to render the file."
        );
      }
      await this.succeed(entry, payload.contentHeightPx);
    } finally {
      // 临时件必删：它带着已内联的字体与图片，留在 os.tmpdir 既占地方也泄露内容。
      await this.ports.removeTempHtml(tempUri);
    }
  }

  /** 交付物正文：样式与图片都在这里变成 `data:`，与屏上同一套策略。 */
  private async buildHtml(
    payload: ExportDataPayload,
    session: ExportSessionInfo
  ): Promise<string> {
    const stylesheet = await this.ports.readAsset(EXPORT_STYLESHEET_ASSET);
    if (stylesheet === null) {
      throw new ReaderError(
        READORA_ERROR_CODES.EXPORT_FAILED,
        "the bundled stylesheet is missing; cannot produce a self-contained file."
      );
    }
    const cssText = await inlineCssAssets(
      Buffer.from(stylesheet.bytes).toString("utf8"),
      this.ports.readAsset
    );
    const images = await inlineImages(payload.bodyHtml, (reference) =>
      this.ports.readImage(session.documentUri, reference)
    );
    if (images.skipped > 0) {
      // 「有几张图没带进去」必须可见：静默保留占位卡会让用户以为是导出的 bug。
      this.ports.diagnostics.info(
        EXPORT_DIAGNOSTIC,
        `${images.skipped} image(s) kept their on-screen placeholder in the export.`
      );
    }
    const style = this.ports.styleContext();
    const input: ExportHtmlInput = {
      bodyHtml: images.html,
      cssText,
      rootStyleText: payload.rootStyleText,
      customCss: style.customCss,
      palette: style.palette,
      scheme: style.scheme,
      typography: style.typography,
      preset: style.preset,
      documentVersion: payload.version,
      title: documentBaseName(payload.documentUri)
    };
    return composeExportHtml(input);
  }

  /** 探测本机浏览器：HTML 通道用不到它，PDF/PNG 缺它就是 browserNotFound。 */
  private async resolveBrowser(): Promise<string> {
    const lookup = findChromium(this.ports.getChromePath(), {
      env: this.ports.environment,
      existsSync: this.ports.exists,
      platform: this.ports.platform
    });
    if (lookup.exe === null) {
      throw new ReaderError(
        READORA_ERROR_CODES.EXPORT_BROWSER_NOT_FOUND,
        lookup.configuredMissing
          ? "readora.export.chromePath does not point at a browser."
          : "no local Chrome/Chromium found; PDF and PNG need one. Export as HTML still works."
      );
    }
    return lookup.exe;
  }

  /**
   * 成功出口：一行诊断 + 一条带 `Open` 的通知。
   *
   * PNG 被 16 384 px 上限剪过时必须在通知里明说：否则用户拿到一张短了一截的图，
   * 而唯一的线索是他自己得滚到页面底下才能发现少了一屏。
   */
  private async succeed(entry: PendingExport, contentHeightPx: number): Promise<void> {
    const capped = entry.format === "png" && isPngHeightTruncated(contentHeightPx);
    const note = capped
      ? ` The image was capped at ${EXPORT_PNG_MAX_HEIGHT_PX} px: the document is longer.`
      : "";
    this.ports.diagnostics.info(EXPORT_DIAGNOSTIC, `${entry.format} written to ${entry.targetPath}`);
    await this.notify(
      "info",
      `Readora: exported ${entry.targetPath}.${note}`,
      [EXPORT_OPEN_ACTION],
      entry.targetPath
    );
  }

  /**
   * 通知的唯一出口。
   *
   * `openPath` 只在真正写好了文件的那一条调用里传：错误通知按 `Open` 也开不出东西，
   * 把「哪个路径可以开」这件事交给调用方而不是存在实例字段上，于是不会出现
   * 「上一单的目的地被下一单读到」。
   */
  private async notify(
    kind: "info" | "error",
    message: string,
    actions: readonly string[],
    openPath?: string
  ): Promise<void> {
    const picked = await this.ports.showMessage(kind, message, actions);
    if (picked === EXPORT_OPEN_ACTION && openPath !== undefined) {
      await this.ports.openPath(openPath);
    }
  }

  /** 不写盘的失败：先留诊断，再给用户一条可读的错误通知。 */
  private async fail(code: ReadoraErrorCode, message: string): Promise<void> {
    // 通知文案在这里才加 `Readora: ` 前缀：消息串本身与 ReaderError 同一口径，
    // 否则经 toErrorMessage 的那一条会出双前缀。
    const text = toErrorMessage(new ReaderError(code, message));
    this.ports.diagnostics.error(code, text);
    await this.notify("error", text, []);
  }
}
