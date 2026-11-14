/**
 * 协议契约回归（IMP-002 STORY-01-02 验收：
 * 同一套协议定义、非法消息可被拒绝、消息类型具有明确版本）。
 */
import { describe, expect, it } from "vitest";
import {
  DOCUMENT_TEXT_MAX_LENGTH,
  EXPORT_HTML_MAX_CHARS,
  EXPORT_REQUEST_ID_MAX_LENGTH,
  EXPORT_ROOT_STYLE_MAX_CHARS,
  EXPORT_SIZE_MAX_PX,
  MESSAGE_DIRECTIONS,
  MESSAGE_REGISTRY,
  MESSAGE_TYPES,
  PROTOCOL_VERSION,
  READORA_ERROR_CODES,
  createEnvelope,
  createErrorResponse,
  createSuccessResponse,
  isExportFormat,
  isMessageType,
  parsePayload,
  validateEnvelope,
  type DocumentLoadPayload,
  type ReaderPreferences
} from "../index";

const PREFERENCES: ReaderPreferences = {
  theme: "auto",
  fontSize: 16,
  lineHeight: 1.75,
  contentWidth: 820,
  showOutline: true,
  typography: "newsreader",
  themePreset: "default"
};

const LOAD_PAYLOAD: DocumentLoadPayload = {
  documentUri: "file:///workspace/doc.md",
  languageId: "markdown",
  version: 3,
  text: "# Hello",
  preferences: PREFERENCES
};

describe("权威消息表（ARC-004 §8.3）", () => {
  it("注册表覆盖 11 条权威消息 + M4 补设 1 条 + M6 补设 2 条 + M11 补设 3 条", () => {
    const types = Object.values(MESSAGE_TYPES);
    expect(types).toHaveLength(17);
    expect(Object.keys(MESSAGE_REGISTRY).sort()).toEqual([...types].sort());
  });

  it("每条消息的方向与 ARC-004 §8.3 一致", () => {
    expect(MESSAGE_DIRECTIONS["reader.ready"]).toBe("view-to-host");
    expect(MESSAGE_DIRECTIONS["document.load"]).toBe("host-to-view");
    expect(MESSAGE_DIRECTIONS["document.update"]).toBe("host-to-view");
    expect(MESSAGE_DIRECTIONS["document.open"]).toBe("view-to-host");
    expect(MESSAGE_DIRECTIONS["document.navigate"]).toBe("view-to-host");
    expect(MESSAGE_DIRECTIONS["resource.resolve"]).toBe("view-to-host");
    expect(MESSAGE_DIRECTIONS["theme.update"]).toBe("host-to-view");
    expect(MESSAGE_DIRECTIONS["config.update"]).toBe("host-to-view");
    expect(MESSAGE_DIRECTIONS["state.save"]).toBe("view-to-host");
    expect(MESSAGE_DIRECTIONS["state.restore"]).toBe("host-to-view");
    expect(MESSAGE_DIRECTIONS["reader.error"]).toBe("view-to-host");
    // M4 补设通道：命令切换只能由 Host 下发（ARC-004 §6.2 ReaderSessionState）。
    expect(MESSAGE_DIRECTIONS["reader.viewState"]).toBe("host-to-view");
    // M6 补设通道：两条都是 View → Host，方向反过来就等于让 Host 听凭页面改设置。
    expect(MESSAGE_DIRECTIONS["config.patch"]).toBe("view-to-host");
    expect(MESSAGE_DIRECTIONS["metrics.report"]).toBe("view-to-host");
    // M11 导出：capture 是唯一一条由 Host 主动发的取帧请求，它只能在用户
    // 选定路径之后出现；request/data 都是 View 向 Host 递东西。
    expect(MESSAGE_DIRECTIONS["export.request"]).toBe("view-to-host");
    expect(MESSAGE_DIRECTIONS["export.capture"]).toBe("host-to-view");
    expect(MESSAGE_DIRECTIONS["export.data"]).toBe("view-to-host");
  });

  it("废弃草案命名不在注册表中", () => {
    for (const deprecated of [
      "document.request",
      "navigation.change",
      "configuration.update",
      "asset.resolve",
      "host.error"
    ]) {
      expect(isMessageType(deprecated)).toBe(false);
    }
  });
});

describe("信封校验（IMP-001 §11.4）", () => {
  it("接受合法信封", () => {
    const envelope = createEnvelope("document.load", LOAD_PAYLOAD);
    const validated = validateEnvelope(envelope);
    expect(validated).not.toBeNull();
    expect(validated?.type).toBe("document.load");
    expect(validated?.version).toBe(PROTOCOL_VERSION);
  });

  it("拒绝错误协议版本", () => {
    const envelope = { ...createEnvelope("reader.ready", {}), version: 2 };
    expect(validateEnvelope(envelope)).toBeNull();
  });

  it("拒绝未注册消息类型", () => {
    const envelope = createEnvelope("reader.ready", {});
    expect(validateEnvelope({ ...envelope, type: "shell.execute" })).toBeNull();
  });

  it("拒绝空 id 与超长 id", () => {
    const envelope = createEnvelope("reader.ready", {});
    expect(validateEnvelope({ ...envelope, id: "" })).toBeNull();
    expect(validateEnvelope({ ...envelope, id: "x".repeat(129) })).toBeNull();
  });

  it("拒绝未知顶层字段（strict）", () => {
    const envelope = createEnvelope("reader.ready", {});
    expect(validateEnvelope({ ...envelope, extra: true })).toBeNull();
  });

  it("拒绝非对象输入", () => {
    for (const raw of [null, undefined, 42, "message", []]) {
      expect(validateEnvelope(raw)).toBeNull();
    }
  });
});

describe("payload 校验", () => {
  it("document.load 接受快照 + preferences 五字段", () => {
    const result = parsePayload<DocumentLoadPayload>(
      "document.load",
      LOAD_PAYLOAD
    );
    expect(result.ok).toBe(true);
  });

  it("document.load 拒绝未知字段", () => {
    const result = parsePayload("document.load", {
      ...LOAD_PAYLOAD,
      injected: "<script>"
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(READORA_ERROR_CODES.INVALID_PAYLOAD);
    }
  });

  it("document.load 拒绝超限文本（Host 预校验同源）", () => {
    const result = parsePayload("document.load", {
      ...LOAD_PAYLOAD,
      text: "x".repeat(DOCUMENT_TEXT_MAX_LENGTH + 1)
    });
    expect(result.ok).toBe(false);
  });

  it("document.load 拒绝负版本号与非整数版本号", () => {
    expect(
      parsePayload("document.load", { ...LOAD_PAYLOAD, version: -1 }).ok
    ).toBe(false);
    expect(
      parsePayload("document.load", { ...LOAD_PAYLOAD, version: 1.5 }).ok
    ).toBe(false);
  });

  it("preferences 拒绝越界字号与非法主题", () => {
    expect(
      parsePayload("document.load", {
        ...LOAD_PAYLOAD,
        preferences: { ...PREFERENCES, fontSize: 99 }
      }).ok
    ).toBe(false);
    expect(
      parsePayload("document.load", {
        ...LOAD_PAYLOAD,
        preferences: { ...PREFERENCES, theme: "solarized" }
      }).ok
    ).toBe(false);
  });

  it("preferences 接受 ARC-006 §5.1 的四种主题模式与 auto 别名", () => {
    for (const theme of ["auto", "light", "dark", "vscode", "system"]) {
      expect(
        parsePayload("document.load", {
          ...LOAD_PAYLOAD,
          preferences: { ...PREFERENCES, theme }
        }).ok
      ).toBe(true);
    }
  });

  it("theme.update 需要明暗与来源两个轴", () => {
    expect(
      parsePayload("theme.update", { theme: "light", source: "product" }).ok
    ).toBe(true);
    expect(
      parsePayload("theme.update", { theme: "dark", source: "vscode" }).ok
    ).toBe(true);
    expect(
      parsePayload("theme.update", { theme: "dark", source: "system" }).ok
    ).toBe(true);
    expect(parsePayload("theme.update", { theme: "auto" }).ok).toBe(false);
    // source 缺失即拒绝：只带明暗无法区分产品主题与宿主映射（ARC-006 §7.3）。
    expect(parsePayload("theme.update", { theme: "light" }).ok).toBe(false);
    // 模式名不得漏进解析结果：宿主必须先归一为 light / dark。
    expect(
      parsePayload("theme.update", { theme: "vscode", source: "vscode" }).ok
    ).toBe(false);
    expect(
      parsePayload("theme.update", { theme: "high-contrast", source: "system" })
        .ok
    ).toBe(false);
    expect(
      parsePayload("theme.update", { theme: "light", source: "auto" }).ok
    ).toBe(false);
  });

  it("state.save 拒绝负 scrollTop", () => {
    expect(
      parsePayload("state.save", {
        documentUri: "file:///workspace/doc.md",
        state: { scrollTop: -1, activeHeadingId: null }
      }).ok
    ).toBe(false);
  });

  it("reader.ready 拒绝携带额外字段的载荷", () => {
    expect(parsePayload("reader.ready", { extra: 1 }).ok).toBe(false);
    expect(parsePayload("reader.ready", {}).ok).toBe(true);
  });

  it("reader.viewState 三字段齐备才接受", () => {
    expect(
      parsePayload("reader.viewState", {
        focusMode: true,
        outlineVisible: false,
        contentWidth: 900
      }).ok
    ).toBe(true);
    expect(
      parsePayload("reader.viewState", {
        outlineVisible: false,
        contentWidth: 900
      }).ok
    ).toBe(false);
  });

  it("reader.viewState 宽度边界与偏好同区间（F07-003）", () => {
    const base = { focusMode: false, outlineVisible: true };
    expect(
      parsePayload("reader.viewState", { ...base, contentWidth: 480 }).ok
    ).toBe(true);
    expect(
      parsePayload("reader.viewState", { ...base, contentWidth: 1600 }).ok
    ).toBe(true);
    expect(
      parsePayload("reader.viewState", { ...base, contentWidth: 479 }).ok
    ).toBe(false);
    expect(
      parsePayload("reader.viewState", { ...base, contentWidth: 1601 }).ok
    ).toBe(false);
  });
});

describe("响应工厂（ARC-004 §8.2：payload 口径）", () => {
  it("成功响应携带 payload 且 id 关联", () => {
    const response = createSuccessResponse("req-1", { uri: "https://x" });
    expect(response).toEqual({
      id: "req-1",
      success: true,
      payload: { uri: "https://x" }
    });
  });

  it("无载荷成功响应不携带 payload 键", () => {
    const response = createSuccessResponse("req-2");
    expect(response).toEqual({ id: "req-2", success: true });
    expect("payload" in response).toBe(false);
  });

  it("错误响应携带统一错误结构", () => {
    const response = createErrorResponse(
      "req-3",
      READORA_ERROR_CODES.UNSUPPORTED_MESSAGE,
      "not registered"
    );
    expect(response.success).toBe(false);
    expect(response.error?.code).toBe("readora.message.unsupported");
  });
});

describe("config.patch（M6 补设的偏好写回通道）", () => {
  it("白名单键 + 合法值才接受", () => {
    expect(parsePayload("config.patch", { key: "fontSize", value: 18 }).ok).toBe(true);
    expect(parsePayload("config.patch", { key: "theme", value: "dark" }).ok).toBe(true);
    expect(
      parsePayload("config.patch", { key: "themePreset", value: "high-contrast" }).ok
    ).toBe(true);
    expect(parsePayload("config.patch", { key: "showOutline", value: false }).ok).toBe(true);
  });

  it("白名单外的键一律拒绝：Webview 不能改 readora.* 的任何其他设置", () => {
    for (const key of [
      "customCss",
      "resources.maxImageSizeMb",
      "resources.allowExternalImages",
      "editorFontSize"
    ]) {
      const result = parsePayload("config.patch", { key, value: 1 });
      expect(result.ok, key).toBe(false);
    }
  });

  it("值类型与长度受限：字符串 32 字符封顶，对象/null 不接受", () => {
    expect(
      parsePayload("config.patch", { key: "theme", value: "x".repeat(33) }).ok
    ).toBe(false);
    expect(
      parsePayload("config.patch", { key: "theme", value: { mode: "dark" } }).ok
    ).toBe(false);
    expect(parsePayload("config.patch", { key: "fontSize", value: null }).ok).toBe(false);
  });

  it("未知字段被 strictObject 拒（不允许借道 patch 塞额外指令）", () => {
    expect(
      parsePayload("config.patch", {
        key: "fontSize",
        value: 18,
        alsoDelete: "readora.customCss"
      }).ok
    ).toBe(false);
  });

  it("值域由 ReaderPreferencesSchema 决定：payload 层放行越界数字，交由 Host 拒绝", () => {
    // 契约刻意不在这里夹区间：区间只有一处权威（那张偏好 Schema），
    // 复制第二套边界会在下次扩面时漏掉一个。
    expect(parsePayload("config.patch", { key: "fontSize", value: 400 }).ok).toBe(true);
  });
});

describe("metrics.report（M6 补设的只读指标通道）", () => {
  const metric = {
    documentUri: "file:///tmp/doc.md",
    version: 3,
    renderDurationMs: 42,
    firstPaintDurationMs: 118,
    charCount: 4096,
    blockCount: 87,
    diagramCount: 2,
    mathCount: 5
  };

  it("八项指标齐备才接受", () => {
    expect(parsePayload("metrics.report", metric).ok).toBe(true);
  });

  it("负值与异常大值被拒：不把 NaN 级别的脏数据写进输出通道", () => {
    expect(parsePayload("metrics.report", { ...metric, version: -1 }).ok).toBe(false);
    expect(
      parsePayload("metrics.report", { ...metric, renderDurationMs: -1 }).ok
    ).toBe(false);
    expect(
      parsePayload("metrics.report", { ...metric, renderDurationMs: 600_001 }).ok
    ).toBe(false);
    expect(parsePayload("metrics.report", { ...metric, charCount: 1.5 }).ok).toBe(false);
  });

  it("多带字段即拒：指标载荷不留可扩展的私货口子", () => {
    expect(parsePayload("metrics.report", { ...metric, html: "<b>" }).ok).toBe(false);
  });
});

describe("export.*（M11 补设的导出通道）", () => {
  const DATA = {
    requestId: "exp-1",
    format: "html",
    documentUri: "file:///workspace/doc.md",
    version: 3,
    bodyHtml: '<h1 id="x">Hello</h1>',
    rootStyleText: "--readora-font-size: 16px; --readora-line-height: 1.75",
    canvasWidthPx: 820,
    contentHeightPx: 2400
  };

  it("三条消息的合法载荷都被接受", () => {
    expect(parsePayload("export.request", { format: "pdf" }).ok).toBe(true);
    expect(parsePayload("export.capture", DATA).ok).toBe(false); // requestId 以外的键在 capture 上是私货
    expect(
      parsePayload("export.capture", { requestId: "exp-1", format: "png" }).ok
    ).toBe(true);
    expect(parsePayload("export.data", DATA).ok).toBe(true);
  });

  it("format 只认三档：html/pdf/png 之外的任何字符串都拒", () => {
    for (const format of ["docx", "md", "PDF", "", "svg"]) {
      expect(parsePayload("export.request", { format }).ok, format).toBe(false);
    }
  });

  it("export.data 拒收未知字段：不能借导出通道夹带指令", () => {
    expect(
      parsePayload("export.data", { ...DATA, outputPath: "/tmp/evil.html" }).ok
    ).toBe(false);
    expect(parsePayload("export.data", { ...DATA, script: "alert(1)" }).ok).toBe(false);
  });

  it("bodyHtml 超上限即拒（第一道闸门只挡异常载荷）", () => {
    expect(
      parsePayload("export.data", {
        ...DATA,
        bodyHtml: "x".repeat(EXPORT_HTML_MAX_CHARS + 1)
      }).ok
    ).toBe(false);
    expect(
      parsePayload("export.data", { ...DATA, bodyHtml: "x".repeat(EXPORT_HTML_MAX_CHARS) })
        .ok
    ).toBe(true);
  });

  it("rootStyleText 有独立上限：它是三个变量声明，不是一个样式表", () => {
    expect(
      parsePayload("export.data", {
        ...DATA,
        rootStyleText: "x".repeat(EXPORT_ROOT_STYLE_MAX_CHARS + 1)
      }).ok
    ).toBe(false);
  });

  it("尺寸与版本：负数、小数、超出 EXPORT_SIZE_MAX_PX 一律拒", () => {
    expect(parsePayload("export.data", { ...DATA, version: -1 }).ok).toBe(false);
    expect(parsePayload("export.data", { ...DATA, version: 1.5 }).ok).toBe(false);
    expect(parsePayload("export.data", { ...DATA, contentHeightPx: -1 }).ok).toBe(false);
    expect(
      parsePayload("export.data", { ...DATA, canvasWidthPx: EXPORT_SIZE_MAX_PX + 1 }).ok
    ).toBe(false);
  });

  it("requestId 缺失或空串即拒：没有它就无法把迟到的帧归给已关的会话", () => {
    expect(
      parsePayload("export.data", { ...DATA, requestId: "" }).ok
    ).toBe(false);
    const { requestId: _unused, ...rest } = DATA;
    expect(parsePayload("export.data", rest).ok).toBe(false);
  });

  it("requestId 上界是 64：恰好卡住 Host 侧 randomUUID() 的 36 字符，且不拿信封 id 的 128 当量口", () => {
    expect(EXPORT_REQUEST_ID_MAX_LENGTH).toBe(64);
    // Host 真实生成的就是 UUID 文本，必须落在上界内，否则导出会在自己机器上坏掉。
    const uuidLike = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
    expect(uuidLike.length).toBeLessThanOrEqual(EXPORT_REQUEST_ID_MAX_LENGTH);
    expect(parsePayload("export.data", { ...DATA, requestId: uuidLike }).ok).toBe(true);
    expect(
      parsePayload("export.data", { ...DATA, requestId: "x".repeat(EXPORT_REQUEST_ID_MAX_LENGTH) }).ok
    ).toBe(true);
    expect(
      parsePayload("export.data", {
        ...DATA,
        requestId: "x".repeat(EXPORT_REQUEST_ID_MAX_LENGTH + 1)
      }).ok
    ).toBe(false);
    // capture 方向同一个上界，两条通道不能各自一套。
    expect(
      parsePayload("export.capture", {
        requestId: "x".repeat(EXPORT_REQUEST_ID_MAX_LENGTH + 1),
        format: "pdf"
      }).ok
    ).toBe(false);
  });

  it("isExportFormat 与 Schema 同源：Host 侧白名单判定不另开一套", () => {
    expect(isExportFormat("png")).toBe(true);
    expect(isExportFormat("html")).toBe(true);
    for (const value of ["pdf ", "PDF", undefined, 1, ["pdf"]]) {
      expect(isExportFormat(value)).toBe(false);
    }
  });

  it("三条导出错误码各自唯一且互不等于已有码", () => {
    const codes = Object.values(READORA_ERROR_CODES);
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes).toContain("readora.export.failed");
    expect(codes).toContain("readora.export.browserNotFound");
    expect(codes).toContain("readora.export.tooLarge");
  });
});
