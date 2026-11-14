/**
 * 导出装配（M11 · 三条入口汇合后的那一段）。
 *
 * 全部外部效果都是注入的端口，因此这里能确定性断言计划锁定的那几条硬口径：
 * 取消零写盘且不取帧、先问路径再取帧、陈旧帧丢弃、体积不过关不出文件、
 * 临时件 `finally` 必删、没有 Chrome 时 HTML 仍然可用。
 */
import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  READORA_ERROR_CODES,
  type ExportCapturePayload,
  type ExportDataPayload,
  type ExportFormat
} from "@readora/contracts";
import {
  EXPORT_BROWSER_TIMEOUT_MS,
  EXPORT_CANCELLED_DIAGNOSTIC,
  EXPORT_CAPTURE_TIMEOUT_MS,
  EXPORT_DIAGNOSTIC,
  EXPORT_MAX_TOTAL_BYTES,
  EXPORT_PNG_MAX_HEIGHT_PX
} from "../constants";
import {
  ExportService,
  exportDefaultPath,
  type ExportServicePorts,
  type ExportSessionInfo,
  type SaveDialogRequest
} from "../export/export-service";

const DOCUMENT_URI = "file:///docs/read.md";

interface Harness {
  ports: ExportServicePorts;
  service: ExportService;
  captured: { payload: ExportCapturePayload; sessionId: string }[];
  written: Map<string, string>;
  notices: { kind: "info" | "error"; message: string; actions: readonly string[] }[];
  logged: { level: "info" | "warn" | "error"; code: string; message: string }[];
  tempWrites: { requestId: string; html: string }[];
  tempRemovals: string[];
  spawned: { exe: string; args: readonly string[] }[];
  opened: string[];
  dialogs: SaveDialogRequest[];
  session: ExportSessionInfo;
  setSaveDialog(path: string | null): void;
  setChrome(available: boolean): void;
  setBrowser(result: { exitCode: number | null; stderr?: string; produces?: boolean }): void;
  setAsset(css: string | null): void;
  setImage(payload: { mimeType: string; base64: string } | null): void;
  replyWith(action: string | undefined): void;
  messages(level: Harness["logged"][number]["level"], code?: string): string[];
}

function createHarness(): Harness {
  const session: ExportSessionInfo = {
    sessionId: "s1",
    documentUri: DOCUMENT_URI,
    documentVersion: 3,
    hasPanel: true
  };
  const sessionValue: ExportSessionInfo | null = session;
  let saveDialogPath: string | null = "/tmp/out.html";
  let chromeAvailable = true;
  let browser = { exitCode: 0 as number | null, stderr: "", produces: true };
  let assetCss: string | null = ":root{color:red}";
  let imagePayload: { mimeType: string; base64: string } | null = null;
  let infoReply: string | undefined;

  const captured: Harness["captured"] = [];
  const written = new Map<string, string>();
  const notices: Harness["notices"] = [];
  const logged: Harness["logged"] = [];
  const tempWrites: Harness["tempWrites"] = [];
  const tempRemovals: Harness["tempRemovals"] = [];
  const spawned: Harness["spawned"] = [];
  const opened: Harness["opened"] = [];
  const dialogs: Harness["dialogs"] = [];

  const ports: ExportServicePorts = {
    sessionOf: () => sessionValue,
    postCapture: (payload, sessionId) => {
      captured.push({ payload, sessionId });
    },
    showSaveDialog: async (request) => {
      dialogs.push(request);
      return saveDialogPath;
    },
    showMessage: async (kind, message, actions) => {
      notices.push({ kind, message, actions });
      return kind === "info" ? infoReply : undefined;
    },
    openPath: async (path) => {
      opened.push(path);
    },
    writeFile: async (path, content) => {
      written.set(path, Buffer.from(content).toString("utf8"));
    },
    readAsset: async () =>
      assetCss === null ? null : { bytes: new Uint8Array(Buffer.from(assetCss)), size: assetCss.length, mtimeMs: 1 },
    readImage: async () => imagePayload,
    writeTempHtml: async (requestId, html) => {
      tempWrites.push({ requestId, html });
      return `file:///tmp/readora-export-${requestId}.html`;
    },
    removeTempHtml: async (fileUri) => {
      tempRemovals.push(fileUri);
    },
    exists: (path) => {
      if (path === "/chrome") {
        return chromeAvailable;
      }
      // 浏览器的产物不经过 writeFile 端口（它自己写盘），所以下载到位只能由对话框
      // 选定那个路径来表征：produces=false 就是「退出码 0 但文件不在」。
      return browser.produces && path === saveDialogPath;
    },
    styleContext: () => ({
      palette: "dark",
      scheme: "dark",
      typography: "newsreader",
      preset: "default",
      customCss: ""
    }),
    getChromePath: () => "/chrome",
    environment: { PATH: "" },
    platform: "linux",
    spawn: (exe, args) => {
      spawned.push({ exe, args });
      return {
        exited: Promise.resolve(browser.exitCode),
        kill: () => undefined,
        stderrText: () => browser.stderr
      };
    },
    diagnostics: {
      info: (code, message) => logged.push({ level: "info", code, message }),
      warn: (code, message) => logged.push({ level: "warn", code, message }),
      error: (code, message) => logged.push({ level: "error", code, message })
    }
  };

  return {
    ports,
    service: new ExportService(ports),
    captured,
    written,
    notices,
    logged,
    tempWrites,
    tempRemovals,
    spawned,
    opened,
    dialogs,
    session,
    setSaveDialog: (path) => {
      saveDialogPath = path;
    },
    setChrome: (available) => {
      chromeAvailable = available;
    },
    setBrowser: (result) => {
      browser = { exitCode: result.exitCode, stderr: result.stderr ?? "", produces: result.produces ?? true };
    },
    setAsset: (css) => {
      assetCss = css;
    },
    setImage: (payload) => {
      imagePayload = payload;
    },
    replyWith: (action) => {
      infoReply = action;
    },
    messages: (level, code) =>
      logged
        .filter((entry) => entry.level === level && (code === undefined || entry.code === code))
        .map((entry) => `${entry.code} ${entry.message}`)
  };
}

function frame(overrides: Partial<ExportDataPayload> = {}): ExportDataPayload {
  return {
    requestId: "req-1",
    format: "html",
    documentUri: DOCUMENT_URI,
    version: 3,
    bodyHtml: '<p class="readora-paragraph">Hi</p>',
    rootStyleText: "--readora-font-size: 18px;",
    canvasWidthPx: 900,
    contentHeightPx: 2_000,
    ...overrides
  };
}

/** 走完「对话框已确认 → 已取帧」的第一步，返回 View 会带回的 requestId。 */
async function confirmAndCapture(harness: Harness, format: ExportFormat): Promise<string> {
  await harness.service.requestExport("s1", format);
  return lastRequestId(harness);
}

function lastRequestId(harness: Harness): string {
  return harness.captured[harness.captured.length - 1]?.payload.requestId ?? "";
}

beforeEach(() => {
  vi.useRealTimers();
});

describe("exportDefaultPath", () => {
  test("默认落盘是同名同目录换扩展名", () => {
    expect(exportDefaultPath(DOCUMENT_URI, "html")).toBe("/docs/read.html");
    expect(exportDefaultPath(DOCUMENT_URI, "pdf")).toBe("/docs/read.pdf");
    expect(exportDefaultPath(DOCUMENT_URI, "png")).toBe("/docs/read.png");
  });

  test("根目录与非 file 协议不猜目录，只给文件名", () => {
    expect(exportDefaultPath("file:///read.md", "pdf")).toBe("read.pdf");
    expect(exportDefaultPath("untitled:Untitled-1", "pdf")).toBe("Untitled-1.pdf");
  });

  test("文件名里的百分号编码还原成真实字符", () => {
    expect(exportDefaultPath("file:///docs/my%20doc.md", "html")).toBe("/docs/my doc.html");
  });
});

describe("requestExport：对话框是唯一授权边界", () => {
  test("会话不存在或面板已关：只提示，不弹对话框", async () => {
    const harness = createHarness();
    const closed = { ...harness.session, hasPanel: false };
    harness.ports.sessionOf = () => closed;
    await harness.service.requestExport("s1", "html");
    expect(harness.dialogs).toHaveLength(0);
    expect(harness.captured).toHaveLength(0);
    expect(harness.written.size).toBe(0);
    expect(harness.notices[0]?.kind).toBe("error");
    expect(harness.notices[0]?.message).toContain("panel is closed");
  });

  test("确认对话框后才索取那一帧，且带 requestId 与格式", async () => {
    const harness = createHarness();
    await harness.service.requestExport("s1", "pdf");
    expect(harness.dialogs).toHaveLength(1);
    expect(harness.captured).toHaveLength(1);
    expect(harness.captured[0]?.payload.format).toBe("pdf");
    expect(harness.captured[0]?.payload.requestId.length).toBeGreaterThan(0);
    expect(harness.captured[0]?.sessionId).toBe("s1");
  });

  test("取消：零写盘、零临时件、不取帧，只在通道里留一行且不算错误", async () => {
    const harness = createHarness();
    harness.setSaveDialog(null);
    await harness.service.requestExport("s1", "html");
    expect(harness.captured).toHaveLength(0);
    expect(harness.written.size).toBe(0);
    expect(harness.tempWrites).toHaveLength(0);
    expect(harness.notices).toHaveLength(0);
    expect(harness.messages("error")).toHaveLength(0);
    expect(harness.messages("info", EXPORT_CANCELLED_DIAGNOSTIC)).toHaveLength(1);
    expect(harness.logged[0]?.message).toContain("dismissed");
  });

  test("默认落盘按格式换扩展名并原样交给对话框", async () => {
    const harness = createHarness();
    await harness.service.requestExport("s1", "png");
    expect(harness.dialogs[0]).toEqual({
      defaultPath: "/docs/read.png",
      filterName: "PNG image",
      extensions: ["png"]
    });
  });

  test("同一会话第二个导出：只提示不排队，也不弹第二个对话框", async () => {
    const harness = createHarness();
    await harness.service.requestExport("s1", "html");
    await harness.service.requestExport("s1", "pdf");
    expect(harness.dialogs).toHaveLength(1);
    expect(harness.captured).toHaveLength(1);
    expect(harness.notices[0]?.message).toContain("already running");
    expect(harness.notices[0]?.kind).toBe("info");
  });

  test("不同会话互不阻塞", async () => {
    const harness = createHarness();
    await harness.service.requestExport("s1", "html");
    harness.ports.sessionOf = () => ({ ...harness.session, sessionId: "s2", documentUri: "file:///docs/b.md" });
    await harness.service.requestExport("s2", "html");
    expect(harness.dialogs).toHaveLength(2);
    expect(harness.captured).toHaveLength(2);
  });

  test("View 十秒不回答：报超时并清掉在途登记", async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    await harness.service.requestExport("s1", "html");
    expect(harness.service.pendingCount).toBe(1);
    await vi.advanceTimersByTimeAsync(EXPORT_CAPTURE_TIMEOUT_MS + 1);
    expect(harness.service.pendingCount).toBe(0);
    expect(harness.written.size).toBe(0);
    expect(harness.notices[0]?.message).toContain("did not answer");
    expect(harness.logged[0]?.code).toBe(READORA_ERROR_CODES.EXPORT_FAILED);
  });

  test("会话释放即丢弃在途登记", async () => {
    const harness = createHarness();
    await harness.service.requestExport("s1", "html");
    harness.service.forget("s1");
    expect(harness.service.pendingCount).toBe(0);
    await harness.service.onExportData(frame({ requestId: lastRequestId(harness) }), "s1");
    expect(harness.written.size).toBe(0);
    expect(harness.messages("warn")).toHaveLength(1);
  });
});

describe("onExportData：陈旧帧一律不写盘", () => {
  test("requestId 对不上（超时后又迟到的帧）：丢弃并记 warn", async () => {
    const harness = createHarness();
    await harness.service.requestExport("s1", "html");
    await harness.service.onExportData(frame({ requestId: "other" }), "s1");
    expect(harness.written.size).toBe(0);
    expect(harness.messages("warn")).toHaveLength(1);
    expect(harness.notices).toHaveLength(0);
  });

  test("无主帧（从没发过请求）同样丢弃", async () => {
    const harness = createHarness();
    await harness.service.onExportData(frame(), "s1");
    expect(harness.written.size).toBe(0);
    expect(harness.messages("warn")).toHaveLength(1);
  });

  test("documentUri 与会话不符：提示文档已变，绝不写到新位置", async () => {
    const harness = createHarness();
    const requestId = await confirmAndCapture(harness, "html");
    await harness.service.onExportData(frame({ requestId, documentUri: "file:///docs/other.md" }), "s1");
    expect(harness.written.size).toBe(0);
    expect(harness.notices[0]?.message).toContain("changed while exporting");
  });

  test("version 与会话不符：同上", async () => {
    const harness = createHarness();
    const requestId = await confirmAndCapture(harness, "html");
    await harness.service.onExportData(frame({ requestId, version: 4 }), "s1");
    expect(harness.written.size).toBe(0);
    expect(harness.notices[0]?.message).toContain("changed while exporting");
  });

  test("格式与请求不符：说明 View 认错了单，不写盘", async () => {
    const harness = createHarness();
    const requestId = await confirmAndCapture(harness, "html");
    await harness.service.onExportData(frame({ requestId, format: "png" }), "s1");
    expect(harness.written.size).toBe(0);
  });

  test("会话在取帧期间消失：按陈旧处理", async () => {
    const harness = createHarness();
    const requestId = await confirmAndCapture(harness, "html");
    harness.ports.sessionOf = () => null;
    await harness.service.onExportData(frame({ requestId }), "s1");
    expect(harness.written.size).toBe(0);
  });

  test("在途登记只允许被消费一次", async () => {
    const harness = createHarness();
    const requestId = await confirmAndCapture(harness, "html");
    await harness.service.onExportData(frame({ requestId }), "s1");
    await harness.service.onExportData(frame({ requestId }), "s1");
    expect(harness.written.size).toBe(1);
    expect(harness.messages("warn")).toHaveLength(1);
  });
});

describe("HTML 通道", () => {
  test("写盘内容是自包含文档，成功后通知带 Open", async () => {
    const harness = createHarness();
    const requestId = await confirmAndCapture(harness, "html");
    await harness.service.onExportData(frame({ requestId }), "s1");
    const html = harness.written.get("/tmp/out.html") ?? "";
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain(":root{color:red}");
    expect(html).toContain('data-readora-document-version="3"');
    expect(html).toContain('<p class="readora-paragraph">Hi</p>');
    expect(html).toContain('style="--readora-font-size: 18px;"');
    expect(harness.notices[0]?.message).toContain("/tmp/out.html");
    expect(harness.notices[0]?.actions).toEqual(["Open"]);
    expect(harness.messages("info", EXPORT_DIAGNOSTIC)).toHaveLength(1);
    // HTML 通道不碰浏览器也不留临时件：这是「没装 Chrome 也能导」的承诺。
    expect(harness.spawned).toHaveLength(0);
    expect(harness.tempWrites).toHaveLength(0);
  });

  test("按下 Open 才把文件交给系统打开", async () => {
    const harness = createHarness();
    harness.replyWith("Open");
    const requestId = await confirmAndCapture(harness, "html");
    await harness.service.onExportData(frame({ requestId }), "s1");
    expect(harness.opened).toEqual(["/tmp/out.html"]);
  });

  test("没按 Open 就不打开任何东西", async () => {
    const harness = createHarness();
    const requestId = await confirmAndCapture(harness, "html");
    await harness.service.onExportData(frame({ requestId }), "s1");
    expect(harness.opened).toEqual([]);
  });

  test("样式表读不到：fail-closed，不出半内联交付物", async () => {
    const harness = createHarness();
    harness.setAsset(null);
    const requestId = await confirmAndCapture(harness, "html");
    await harness.service.onExportData(frame({ requestId }), "s1");
    expect(harness.written.size).toBe(0);
    expect(harness.logged[0]?.code).toBe(READORA_ERROR_CODES.EXPORT_FAILED);
    expect(harness.notices[0]?.message).toContain("self-contained");
  });

  test("体积超过 64 MB 就不产出文件（不降级、不截断）", async () => {
    const harness = createHarness();
    harness.setAsset("A".repeat(EXPORT_MAX_TOTAL_BYTES + 8));
    const requestId = await confirmAndCapture(harness, "html");
    await harness.service.onExportData(frame({ requestId }), "s1");
    expect(harness.written.size).toBe(0);
    expect(harness.logged.some((entry) => entry.code === READORA_ERROR_CODES.EXPORT_TOO_LARGE)).toBe(true);
    expect(harness.notices[0]?.message).toContain("limit");
  });

  test("图片读不到时保持占位形态，并在通道里明说", async () => {
    const harness = createHarness();
    harness.setImage(null);
    const requestId = await confirmAndCapture(harness, "html");
    await harness.service.onExportData(
      frame({ requestId, bodyHtml: '<span data-readora-image="./a.png" data-readora-image-state="ready"><img></span>' }),
      "s1"
    );
    const html = harness.written.get("/tmp/out.html") ?? "";
    expect(html).not.toContain("src=");
    expect(harness.messages("info", EXPORT_DIAGNOSTIC).join("\n")).toContain("placeholder");
  });

  test("读得到的图按同一套资源策略换成 data:", async () => {
    const harness = createHarness();
    harness.setImage({ mimeType: "image/png", base64: "QUlE" });
    const requestId = await confirmAndCapture(harness, "html");
    await harness.service.onExportData(
      frame({ requestId, bodyHtml: '<span data-readora-image="./a.png" data-readora-image-state="ready"><img></span>' }),
      "s1"
    );
    expect(harness.written.get("/tmp/out.html")).toContain("src=\"data:image/png;base64,QUlE\"");
  });

  test("命令与顶栏两条入口产出同样的字节（后半段共用同一条链路）", async () => {
    const harness = createHarness();
    const first = await confirmAndCapture(harness, "html");
    await harness.service.onExportData(frame({ requestId: first }), "s1");
    const a = harness.written.get("/tmp/out.html");
    harness.service.forget("s1");
    const second = await confirmAndCapture(harness, "html");
    await harness.service.onExportData(frame({ requestId: second }), "s1");
    expect(harness.written.get("/tmp/out.html")).toBe(a);
  });
});

describe("PDF / PNG 通道", () => {
  test("PDF：临时件 → Chrome → 删临时件，argv 带 print-to-pdf", async () => {
    const harness = createHarness();
    harness.setSaveDialog("/tmp/out.pdf");
    const requestId = await confirmAndCapture(harness, "pdf");
    await harness.service.onExportData(frame({ requestId, format: "pdf" }), "s1");
    expect(harness.tempWrites).toHaveLength(1);
    expect(harness.spawned).toHaveLength(1);
    expect(harness.spawned[0]?.exe).toBe("/chrome");
    expect(harness.spawned[0]?.args).toContain("--print-to-pdf=/tmp/out.pdf");
    expect(harness.tempRemovals).toEqual([`file:///tmp/readora-export-${requestId}.html`]);
    // 写盘只发生在临时 HTML 那一步：PDF 本体由 Chrome 自己落盘。
    expect(harness.written.size).toBe(0);
  });

  test("PNG：视口尺寸取 View 上报的画布宽与量高加余量", async () => {
    const harness = createHarness();
    harness.setSaveDialog("/tmp/out.png");
    const requestId = await confirmAndCapture(harness, "png");
    await harness.service.onExportData(frame({ requestId, format: "png", contentHeightPx: 1_000 }), "s1");
    const args = harness.spawned[0]?.args ?? [];
    expect(args).toContain("--window-size=900,1080");
    expect(args[args.length - 1]).toBe(`file:///tmp/readora-export-${requestId}.html`);
    expect(harness.tempRemovals).toHaveLength(1);
  });

  test("PNG 触顶：通知里明说截到 16384 px", async () => {
    const harness = createHarness();
    harness.setSaveDialog("/tmp/out.png");
    const requestId = await confirmAndCapture(harness, "png");
    await harness.service.onExportData(frame({ requestId, format: "png", contentHeightPx: 30_000 }), "s1");
    expect(harness.spawned[0]?.args).toContain(`--window-size=900,${EXPORT_PNG_MAX_HEIGHT_PX}`);
    expect(harness.notices[0]?.message).toContain(`capped at ${EXPORT_PNG_MAX_HEIGHT_PX} px`);
  });

  test("浏览器超时：30 秒后失败，临时件仍然被删", async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    harness.setSaveDialog("/tmp/out.pdf");
    harness.ports.spawn = () => ({
      exited: new Promise<number | null>(() => undefined),
      kill: () => undefined,
      stderrText: () => "still rendering"
    });
    const requestId = await confirmAndCapture(harness, "pdf");
    const pending = harness.service.onExportData(frame({ requestId, format: "pdf" }), "s1");
    await vi.advanceTimersByTimeAsync(EXPORT_BROWSER_TIMEOUT_MS + EXPORT_CAPTURE_TIMEOUT_MS);
    await pending;
    expect(harness.notices.some((entry) => entry.message.includes("did not finish in time"))).toBe(true);
    expect(harness.tempRemovals).toEqual([`file:///tmp/readora-export-${requestId}.html`]);
  });

  test("浏览器非零退出：stderr 尾部进输出通道，临时件仍被删", async () => {
    const harness = createHarness();
    harness.setSaveDialog("/tmp/out.pdf");
    harness.setBrowser({ exitCode: 1, stderr: "No usable sandbox!" });
    const requestId = await confirmAndCapture(harness, "pdf");
    await harness.service.onExportData(frame({ requestId, format: "pdf" }), "s1");
    expect(harness.messages("error").join("\n")).toContain("No usable sandbox!");
    expect(harness.notices.at(-1)?.message).toContain("failed to render");
    expect(harness.tempRemovals).toEqual([`file:///tmp/readora-export-${requestId}.html`]);
  });

  test("退出码 0 但产物不存在：也算失败，不说「已导出」", async () => {
    const harness = createHarness();
    harness.setSaveDialog("/tmp/out.pdf");
    harness.setBrowser({ exitCode: 0, produces: false });
    const requestId = await confirmAndCapture(harness, "pdf");
    await harness.service.onExportData(frame({ requestId, format: "pdf" }), "s1");
    expect(harness.notices.at(-1)?.kind).toBe("error");
    expect(harness.notices.at(-1)?.message).toContain("failed to render");
  });

  test("本机没有 Chrome：PDF 报 browserNotFound，HTML 不受影响", async () => {
    const harness = createHarness();
    harness.setSaveDialog("/tmp/out.pdf");
    harness.setChrome(false);
    // 没配 chromePath 才是“本机没装”的真实形态：配了却没命中是另一条消息（见下一例）。
    harness.ports.getChromePath = () => "";
    const requestId = await confirmAndCapture(harness, "pdf");
    await harness.service.onExportData(frame({ requestId, format: "pdf" }), "s1");
    expect(harness.logged.some((entry) => entry.code === READORA_ERROR_CODES.EXPORT_BROWSER_NOT_FOUND)).toBe(true);
    expect(harness.notices.at(-1)?.message).toContain("Export as HTML still works");
    expect(harness.tempWrites).toHaveLength(0);

    const htmlHarness = createHarness();
    htmlHarness.setChrome(false);
    const htmlRequestId = await confirmAndCapture(htmlHarness, "html");
    await htmlHarness.service.onExportData(frame({ requestId: htmlRequestId }), "s1");
    expect(htmlHarness.written.size).toBe(1);
  });

  test("配置给了 chromePath 却哪儿都没命中：错误要说那条配置", async () => {
    const harness = createHarness();
    harness.setSaveDialog("/tmp/out.pdf");
    harness.setChrome(false);
    harness.ports.getChromePath = () => "/nope/chrome";
    const requestId = await confirmAndCapture(harness, "pdf");
    await harness.service.onExportData(frame({ requestId, format: "pdf" }), "s1");
    expect(harness.notices.at(-1)?.message).toContain("readora.export.chromePath");
    expect(harness.spawned).toHaveLength(0);
  });

  test("临时件写在 os 临时目录并按 requestId 命名", async () => {
    const harness = createHarness();
    harness.setSaveDialog("/tmp/out.pdf");
    const requestId = await confirmAndCapture(harness, "pdf");
    await harness.service.onExportData(frame({ requestId, format: "pdf" }), "s1");
    expect(harness.tempWrites[0]?.requestId).toBe(requestId);
    expect(harness.tempWrites[0]?.html).toContain("<!DOCTYPE html>");
  });
});
