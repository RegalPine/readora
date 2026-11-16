/**
 * 阅读器根组件（ARC-005 §4；M4 起承担 Reader Shell 的视图状态）。
 *
 * 关键顺序不变：同一 effect 内先注册全部订阅，再 notify reader.ready，
 * 保证 Host 门控投递的首帧不丢（ARC-004 §8.7）；versionRef 防旧快照覆盖新内容。
 *
 * M4 新增的四条不变量：
 * 1. `reader.viewState` 是 Host 下发的权威视图状态；工具栏按钮改的是本地覆写
 *    （ARC-004 §8.3 没有 View→Host 的视图状态通道，本批不新增，见 README 偏差登记），
 *    下一次 Host 下发即清覆写，于是快捷键与按钮不会互相打架；
 * 2. `state.restore` 不在消息到达时滚动，等渲染完成后再按 §8.2 六步执行；
 * 3. `state.save` 带真实 activeHeadingId（ARC-007 §8.1），防抖 800ms（§8.3）；
 * 4. 折叠状态与搜索状态都不进 `state.save`（§10.1 生命周期不同、§10.3 不留副本）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ConfigPatchKey,
  DocumentLoadPayload,
  ExportCapturePayload,
  ExportFormat,
  ReaderPreferences,
  ReadingState,
  ResolvedTheme,
  ThemeSource,
  ThemeState,
  ViewStatePayload
} from "@readora/contracts";
import { READORA_ERROR_CODES } from "@readora/contracts";
import type { OutlineItem } from "@readora/markdown-core";
import type { HostBridge } from "../bridge/host-bridge";
import { useSearchShortcuts } from "../content/interactions";
import { documentRoot } from "../content/heading-query";
import { exportDocumentRoot, serializeExportDocument } from "../content/export-document";
import { createHeadingLocator, type HeadingLocator } from "../content/heading-locator";
import { ancestorKeysOf, buildOutlineTree } from "../content/outline-tree";
import { OutlinePanel } from "../content/OutlinePanel";
import { SearchPanel } from "../content/SearchPanel";
import { useActiveHeading } from "../content/use-active-heading";
import { QuickBar, activeHeadingTitleOf } from "./QuickBar";
import { ReadingCanvas } from "./ReadingCanvas";
import { ReaderSettingsDialog } from "./ReaderSettingsDialog";
import { ReaderShell } from "./ReaderShell";
import { StatusBar } from "./StatusBar";
import { TopBar } from "./TopBar";
import { ThemeProvider, type ThemeContextValue } from "./theme-context";
import { applyTheme } from "./theme";
import { measureText } from "./text-metrics";
import {
  arrivalKey,
  countRenderedBlocks,
  monotonicNow,
  recordArrival,
  toMetricsReport,
  type SnapshotArrival
} from "./render-metrics";
import { useReadingProgress } from "./use-reading-progress";
import { useZoom } from "./zoom";

interface AppProps {
  bridge: HostBridge;
}

/** 滚动保存防抖（ARC-007 §8.3 注记：与 800ms 对齐）。 */
export const STATE_SAVE_DEBOUNCE_MS = 800;

/** Host 未下发前的兜底：目录显隐与宽度都退回用户偏好（ARC-004 §6.2）。 */
function viewStateFromPreferences(preferences: ReaderPreferences): ViewStatePayload {
  return {
    focusMode: false,
    outlineVisible: preferences.showOutline,
    contentWidth: preferences.contentWidth
  };
}

/**
 * §8.2 六步：有 headingId 且仍在 DOM → 定位标题；否则回退 scrollTop；
 * 两者都不可用 → 文档顶部。恢复用即时滚动（它不是用户发起的导航，不该有动画）。
 *
 * 导航层抛错也只当作「定位失败」降级到 scrollTop，绝不让恢复异常冒到渲染上（§12）。
 */
export function applyRestoredState(state: ReadingState, locator: HeadingLocator): void {
  const headingId = state.activeHeadingId;
  let located = false;
  if (headingId) {
    try {
      located = locator.navigateTo(headingId, { behavior: "auto", block: "start" });
    } catch {
      located = false;
    }
  }
  if (located) {
    return;
  }
  if (Number.isFinite(state.scrollTop) && state.scrollTop > 0) {
    window.scrollTo({ top: state.scrollTop, behavior: "auto" });
    return;
  }
  window.scrollTo({ top: 0, behavior: "auto" });
}

/**
 * §8.4 文档变化：原标题还在就什么都不做（第 1 条）；标题被删则保留当前位置并
 * 钳制到新内容高度（第 2、4 条：宁可守住滚动位置，也不强制跳回旧标题）。
 */
export function recoverAfterDocumentChange(
  previousHeading: string | null,
  locator: HeadingLocator
): void {
  if (previousHeading && locator.has(previousHeading)) {
    return;
  }
  const scrollHeight = Math.max(
    document.documentElement.scrollHeight ?? 0,
    document.body.scrollHeight ?? 0
  );
  if (scrollHeight === 0) {
    // 还没有布局信息（隐藏面板、首帧未测量）：保守起见不动滚动。
    return;
  }
  const maxHeight = Math.max(0, scrollHeight - window.innerHeight);
  if (window.scrollY > maxHeight) {
    window.scrollTo({ top: maxHeight, behavior: "auto" });
  }
}

export function App({ bridge }: AppProps) {
  const [payload, setPayload] = useState<DocumentLoadPayload | null>(null);
  // 主题状态是两轴的（明暗 + 取色来源），Host 的 theme.update 是唯一致源。
  const [theme, setTheme] = useState<ThemeState>({ mode: "light", source: "product" });
  const [viewState, setViewState] = useState<ViewStatePayload | null>(null);
  // 工具栏本地覆写：只覆盖这两个开关，宽度始终由 Host 的会话状态决定。
  const [override, setOverride] = useState<Partial<ViewStatePayload> | null>(null);
  const [outline, setOutline] = useState<readonly OutlineItem[]>([]);
  const [collapsedIds, setCollapsedIds] = useState<ReadonlySet<string>>(() => new Set<string>());
  const [searchOpen, setSearchOpen] = useState(false);
  // Reader Settings 弹层与缩放都是会话内视图状态：前者不写配置（弹层里的每一项
  // 才写），后者连值都不出会话（PRD-003 §11.4）。
  const [settingsOpen, setSettingsOpen] = useState(false);
  /**
   * Export 下拉菜单（M11）：只是顶栏一个弹层的开合，不携任何导出状态。
   *
   * 真正在途的那个 id 记在 `exportRequestIdRef`，菜单选完就关 —— 后续全部经
   * Host：保存对话框、组装、写盘。View 不因为“用户点了菜单”就假定写盘被授权了。
   */
  const [exportOpen, setExportOpen] = useState(false);
  /**
   * 专注模式下的临时展开（PRD-003 §10.5「浮动快速条：专注模式下额外出现展开大纲」）。
   *
   * 它必须是独立的一份状态而不是直接翻 `outlineVisible`：§11.2 的口径是专注模式
   * 收起大纲但**不改写用户偏好**，若这里去写 `outlineVisible`，退出专注后目录就
   * 回不去了。同时它得真的能展开大纲 —— 否则快速条上那枚按钮是一个假 affordance，
   * 正是 §4.6 禁止的形态。退出专注、Host 下发视图状态、换文档三种情形都清掉它。
   */
  const [focusOutline, setFocusOutline] = useState(false);
  // 状态条的 Bridge 字段判据是「收到过 document.load」（PRD-003 §4.6），
  // 不是「组件挂载了」：挂载了但一条消息都没收到时，它得诚实说 Disconnected。
  const [bridgeConnected, setBridgeConnected] = useState(false);

  const versionRef = useRef(-1);
  const renderedVersionRef = useRef(-1);
  const pendingRestoreRef = useRef<ReadingState | null>(null);
  const activeHeadingRef = useRef<string | null>(null);
  const documentUriRef = useRef<string | undefined>(undefined);
  /**
   * 已应答过的 capture id（M11）：陈旧或重投的取帧请求不得触发第二次序列化。
   *
   * View 不自己造 id（requestId 由 Host 生成，它才是待写盘会话的锤），但它是
   * “上一帧我已经交过了”唯一可能的记性：同一 id 再来一次，要么丢弃要么整篇重做。
   */
  const exportRequestIdRef = useRef<string | null>(null);
  /**
   * 指标采集的三份记账（F11-014）：到达时刻、当前快照、已上报的那一次。
   *
   * 都放 ref 不放 state —— 指标不该触发任何一次重渲染，否则「测渲染耗时」这件事
   * 本身会给渲染加一帧，量到的数就被观测污染了。
   */
  const payloadRef = useRef<DocumentLoadPayload | null>(null);
  const arrivalRef = useRef<SnapshotArrival | null>(null);
  const reportedRef = useRef<string | null>(null);
  const locator = useMemo(() => createHeadingLocator(), []);

  useEffect(() => {
    const applySnapshot = (next: DocumentLoadPayload): void => {
      const sameDocument = documentUriRef.current === next.documentUri;
      // 「旧快照不覆盖新内容」只在同一篇文档内成立：换文档时版本号是另一条计数线，
      // 拿上一版的版本号去拦新文档，跨文档跳转就会停在旧内容上（ARC-008 §8.3）。
      if (sameDocument && next.version < versionRef.current) {
        return;
      }
      versionRef.current = next.version;
      setBridgeConnected(true);
      // 指标起点：以「快照被接受」为时刻，旧快照在上面已 return，不参与计时。
      payloadRef.current = next;
      arrivalRef.current = recordArrival(next, monotonicNow());
      if (!sameDocument) {
        // 换文档：与旧文档绑定的临时态一律清空（ARC-007 §10.3 末条）。
        const hadPreviousDocument = documentUriRef.current !== undefined;
        documentUriRef.current = next.documentUri;
        renderedVersionRef.current = -1;
        activeHeadingRef.current = null;
        // 指标的去重键含版本号，但「A v1 → B v1 → 回到 A v1」是同键的两次真实首帧，
        // 所以换文档必须清掉已上报标记，否则第二次跳转就没有任何指标记录。
        reportedRef.current = null;
        setCollapsedIds(new Set<string>());
        setSearchOpen(false);
        setFocusOutline(false);
        setExportOpen(false);
        // 首篇文档不能清掉待恢复位置：Host 的 state.restore 可能先于 document.load 到达。
        if (hadPreviousDocument) {
          pendingRestoreRef.current = null;
        }
      }
      setPayload(next);
    };

    // 先订阅，后 ready：首帧门控投递不丢消息。
    const unsubscribers = [
      bridge.subscribe<DocumentLoadPayload>("document.load", applySnapshot),
      bridge.subscribe<DocumentLoadPayload>("document.update", applySnapshot),
      bridge.subscribe<{ theme: ResolvedTheme; source: ThemeSource }>(
        "theme.update",
        (next) => {
          setTheme({ mode: next.theme, source: next.source });
        }
      ),
      bridge.subscribe<{ preferences: ReaderPreferences }>(
        "config.update",
        (next) => {
          setPayload((current) =>
            current ? { ...current, preferences: next.preferences } : current
          );
        }
      ),
      // Host 是视图状态的权威来源：下发即清掉本地覆写（§6.2 ReaderSessionState）。
      // 专注模式下的临时展开同属本地覆写，一并清掉，否则 Host 说「收起大纲」时
      // 这一份会让它看起来没生效。
      bridge.subscribe<ViewStatePayload>("reader.viewState", (next) => {
        setOverride(null);
        setFocusOutline(false);
        setViewState(next);
      }),
      bridge.subscribe<{ state: ReadingState | null }>("state.restore", (next) => {
        if (!next.state) {
          return;
        }
        // §8.2 第 2 步：等渲染完成。已经渲染过就直接执行，否则挂到渲染回调里。
        if (renderedVersionRef.current >= 0) {
          applyRestoredState(next.state, locator);
        } else {
          pendingRestoreRef.current = next.state;
        }
      }),
      // export.capture（M11）：Host 已在保存对话框里拿到了用户选定的路径，现在来取帧。
      // 这一步不能在命令入口上做：取消对话框的导出不应付整篇序列化的代价。
      bridge.subscribe<ExportCapturePayload>("export.capture", (next) => {
        if (exportRequestIdRef.current === next.requestId) {
          return;
        }
        const container = exportDocumentRoot();
        const documentUri = documentUriRef.current;
        if (container === null || documentUri === undefined) {
          // 面板里没有正文（未加载 / 已卸载）：报一条错误，不交空正文。Host 侧那
          // 道版本与 URI 护栏只能拦“带错东西”，拦不住“什么都没带”。
          bridge.notify("reader.error", {
            code: READORA_ERROR_CODES.EXPORT_FAILED,
            message: "No rendered document to export.",
            stack: null
          });
          return;
        }
        exportRequestIdRef.current = next.requestId;
        try {
          bridge.notify("export.data", {
            requestId: next.requestId,
            format: next.format,
            documentUri,
            ...serializeExportDocument(container)
          });
        } catch (error) {
          // 序列化抛穿：复用现有 reader.error 通道上报，不静默丢一次导出。
          bridge.notify("reader.error", {
            code: READORA_ERROR_CODES.EXPORT_FAILED,
            message: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? (error.stack ?? null) : null
          });
        }
      })
    ];

    bridge.notify("reader.ready", {});

    return () => {
      for (const unsubscribe of unsubscribers) {
        unsubscribe();
      }
    };
  }, [bridge, locator]);

  /**
   * 缩放：会话内状态，键位只在画面有文档时接管（PRD-003 §10.5 / §11.4）。
   * 它不进 `readora.*` 配置，只作为 `applyTheme` 的乘数落到 `--readora-font-size`。
   */
  const zoom = useZoom(payload !== null);

  /**
   * 主题、预设与偏好落到 `<html>`：两个主题属性 + 预设/字族两个属性 + 三个变量
   *（ARC-006 §11.1 / PRD-003 §11.4、F08-010、§10.5 Reader Typography）。
   *
   * 宽度以 Host 下发的会话视图状态为准，偏好只在缺省时兜底——命令、键位、按钮
   * 改的都是视图状态，M4 的这条优先级在这里保持不变，只是载体从内联样式换成变量。
   */
  useEffect(() => {
    const preferences = payload?.preferences;
    if (!preferences) {
      // Host 还没下发偏好：属性照写（与首帧预置一致），变量留给 tokens.css 兜底。
      applyTheme(document.documentElement, theme);
      return;
    }
    applyTheme(
      document.documentElement,
      theme,
      {
        fontSize: preferences.fontSize,
        lineHeight: preferences.lineHeight,
        // 宽度以视图状态为准（命令/键位改的就是它），偏好只在缺省时兜底。
        contentWidth: viewState?.contentWidth ?? preferences.contentWidth,
        themePreset: preferences.themePreset,
        typography: preferences.typography
      },
      zoom.zoom
    );
  }, [theme, payload?.preferences, viewState?.contentWidth, zoom.zoom]);

  const anchors = useMemo(() => outline.map((item) => item.anchor), [outline]);
  const documentVersion = payload?.version ?? -1;
  const navigation = useActiveHeading(anchors, documentVersion);

  useEffect(() => {
    activeHeadingRef.current = navigation.activeHeadingId;
  }, [navigation.activeHeadingId]);

  // §6.2 第 3 条：活动标题变化时把它的祖先并进展开集（折叠状态是 UI 态）。
  useEffect(() => {
    const active = navigation.activeHeadingId;
    if (!active) {
      return;
    }
    const ancestors = ancestorKeysOf(buildOutlineTree(outline), active);
    if (ancestors.length === 0) {
      return;
    }
    setCollapsedIds((current) => {
      const next = new Set([...current].filter((key) => !ancestors.includes(key)));
      return next.size === current.size ? current : next;
    });
  }, [navigation.activeHeadingId, outline]);

  /**
   * 一次渲染的指标上报（F11-014）。
   *
   * 三个约束：
   * 1. **只在 DOM 写入完成后调用**（`handleRendered` 是唯一的调用点），否则数到的
   *    是上一篇的节点，`blockCount` 会跟着版本漂；
   * 2. **同一个 (documentUri, version) 只报一次**：`MarkdownContent` 的写入 effect
   *    依赖 `onRendered` 的身份，父层重渲染可能把同一次渲染回调两次；
   * 3. `firstPaint` 取写入后的下一帧：`requestAnimationFrame` 的回调排在样式与布局
   *    之后、绘制之前，这是浏览器给得到的最早的「这一帧要画这些」的时刻，比
   *    `setTimeout(0)` 靠谱，也比 `PerformanceObserver` 的 first-contentful-paint
   *    合适 —— 后者只报整页的首帧，第二次文档跳转永远拿不到数。
   */
  const reportRender = useCallback((): void => {
    const payload = payloadRef.current;
    const arrival = arrivalRef.current;
    if (!payload || !arrival) {
      return;
    }
    const key = arrivalKey(payload);
    if (arrival.key !== key || reportedRef.current === key) {
      return;
    }
    reportedRef.current = key;
    const renderedAt = monotonicNow();
    const counts = countRenderedBlocks(documentRoot());
    requestAnimationFrame(() => {
      bridge.notify("metrics.report", toMetricsReport({
        payload,
        receivedAt: arrival.at,
        renderedAt,
        paintedAt: monotonicNow(),
        counts
      }));
    });
  }, [bridge]);

  // 渲染完成：待恢复的阅读位置在这里落地（§8.2 六步），否则按 §8.4 处理文档变化。
  const handleRendered = useCallback(
    (version: number): void => {
      const firstPaint = renderedVersionRef.current < 0;
      const previousHeading = activeHeadingRef.current;
      renderedVersionRef.current = version;
      // 指标先记：下面三条出口（待恢复、首帧、越界回缩）都不该让上报有机会被跳过。
      reportRender();
      const pending = pendingRestoreRef.current;
      if (pending) {
        pendingRestoreRef.current = null;
        applyRestoredState(pending, locator);
        return;
      }
      if (firstPaint) {
        // 没有待恢复状态的首帧：位置本就停在顶部，只需声明「无需恢复」。
        return;
      }
      recoverAfterDocumentChange(previousHeading, locator);
    },
    [locator, reportRender]
  );

  const getSearchRoot = useCallback((): HTMLElement | null => documentRoot(), []);

  // 阅读状态保存（会话内；防抖，避免滚动风暴）。
  const documentUri = payload?.documentUri;
  useEffect(() => {
    if (!documentUri) {
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const flush = (): void => {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      bridge.notify("state.save", {
        documentUri,
        state: { scrollTop: window.scrollY, activeHeadingId: activeHeadingRef.current }
      });
    };
    const onScroll = (): void => {
      if (timer) {
        clearTimeout(timer);
      }
      timer = setTimeout(flush, STATE_SAVE_DEBOUNCE_MS);
    };
    const onVisibilityChange = (): void => {
      // 面板隐藏与会话销毁前必须补一次同步（§8.3 第 3 条）。
      if (document.visibilityState !== "visible") {
        flush();
      }
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      if (timer) {
        clearTimeout(timer);
      }
    };
  }, [bridge, documentUri]);

  useSearchShortcuts({
    open: () => {
      setSearchOpen(true);
    },
    close: () => {
      setSearchOpen(false);
    }
  });

  /**
   * 时长 pill、状态条字数与大纲分节字数共用这一份计量（PRD-003 §5.6）：
   * 三处并排显示在同一屏，各数一遍迟早数出三个答案。
   */
  const metrics = useMemo(() => measureText(payload?.text ?? ""), [payload?.text]);
  // 进度只随滚动重测；活动标题沿用 ARC-007 §7 的判定结果，这里不二次算一遍。
  const reading = useReadingProgress(navigation.activeHeadingId, documentVersion);

  /**
   * 弹层改动 → `config.patch`（§1 补设的 view→host 通道）。
   *
   * 区间与枚举的复判权威在 Host（`ReaderPreferencesSchema`），Webview 不做本地
   * 乐观生效：等 `config.update` 回来再更新显示，非法值就不会先在界面上「看起来生效」
   * 然后被 Host 悄悄退回。
   */
  const patchConfig = useCallback(
    (key: ConfigPatchKey, value: number | boolean | string): void => {
      bridge.notify("config.patch", { key, value });
    },
    [bridge]
  );

  /**
   * 顶栏菜单选了一档（M11）：只表达意图，落到哪个路径、最终写不写都由 Host 决定。
   *
   * 不本地弹成功提示也不本地写文件：反馈与写盘必须由同一个授权者给出，否则用户会
   * 看到「已导出」但一个字节都没落盘（取消发生在他看到提示之后）。
   */
  const requestExport = useCallback(
    (format: ExportFormat): void => {
      setExportOpen(false);
      bridge.notify("export.request", { format });
    },
    [bridge]
  );

  if (!payload) {
    return <div className="readora-loading">Loading document…</div>;
  }

  const host = viewState ?? viewStateFromPreferences(payload.preferences);
  const shell: ViewStatePayload = { ...host, ...(override ?? {}) };

  const selectHeading = (anchor: string): void => {
    // 点击目录：立刻钉住高亮，并挂起滚动同步，避开平滑动画期间的抖动窗口。
    locator.navigateTo(anchor);
    navigation.pin(anchor);
  };

  const toggleOutline = (): void => {
    setOverride({ outlineVisible: !shell.outlineVisible });
  };

  /**
   * 快速条上那枚「展开大纲」：专注模式里翻的是临时展开，不是用户的 `outlineVisible`
   * （见 `focusOutline` 的注：写了它，退出专注后目录就回不去了）。
   */
  const toggleFocusOutline = (): void => {
    setFocusOutline((current) => !current);
  };

  const toggleFocusMode = (): void => {
    // 进出专注都收回缺省：大纲在专注模式下默认收起（§11.2）。
    setFocusOutline(false);
    setOverride({ focusMode: !shell.focusMode });
  };

  const themeContext: ThemeContextValue = {
    theme: theme.mode,
    source: theme.source,
    preferences: payload.preferences
  };

  return (
    <ThemeProvider value={themeContext}>
      <ReaderShell
        outlineVisible={shell.outlineVisible}
        focusMode={shell.focusMode}
        outlineExpandedInFocus={focusOutline}
        toolbar={
          <TopBar
            outlineVisible={shell.outlineVisible}
            searchOpen={searchOpen}
            settingsOpen={settingsOpen}
            exportOpen={exportOpen}
            documentUri={payload.documentUri}
            zoom={zoom}
            onToggleOutline={toggleOutline}
            onToggleFocusMode={toggleFocusMode}
            onToggleSearch={() => {
              setSearchOpen((open) => !open);
            }}
            onToggleSettings={() => {
              setSettingsOpen((open) => !open);
            }}
            onToggleExport={() => {
              setExportOpen((open) => !open);
            }}
            onCloseExport={() => {
              setExportOpen(false);
            }}
            onExport={requestExport}
          />
        }
        searchbar={
          searchOpen ? (
            <SearchPanel
              getRoot={getSearchRoot}
              documentId={payload.documentUri}
              documentVersion={payload.version}
              onClose={() => {
                setSearchOpen(false);
              }}
            />
          ) : null
        }
        outline={
          <OutlinePanel
            // 换文档就重挂：过滤词与 disclosure 是这一篇的临时视图态，跟着上一篇
            // 留在这里就是 §10.3「不留副本」的同一条要求。
            key={payload.documentUri}
            items={outline}
            activeHeadingId={navigation.activeHeadingId}
            collapsedIds={collapsedIds}
            text={payload.text}
            onCollapsedChange={(keys) => {
              setCollapsedIds(new Set(keys));
            }}
            onToggleCollapse={(key) => {
              setCollapsedIds((current) => {
                const next = new Set(current);
                if (next.has(key)) {
                  next.delete(key);
                } else {
                  next.add(key);
                }
                return next;
              });
            }}
            onSelect={selectHeading}
          />
        }
        statusbar={
          <StatusBar
            sectionCount={outline.length}
            wordCount={metrics.units}
            metrics={metrics}
            focusMode={shell.focusMode}
            documentVersion={payload.version}
            zoom={zoom.zoom}
            theme={theme.mode}
            bridgeConnected={bridgeConnected}
          />
        }
      >
        {/* 章节条在正文之前：它改成 sticky top 后，DOM 顺序就是视觉顺序，
            排在 ReadingCanvas 后面只会一直待在页尾（贴顶也就无从谈起）。 */}
        <QuickBar
          activeHeadingTitle={activeHeadingTitleOf(outline, reading.activeHeading)}
          progress={reading.progress}
          focusMode={shell.focusMode}
          outlineExpanded={focusOutline}
          onToggleOutline={toggleFocusOutline}
          onToggleFocusMode={toggleFocusMode}
        />
        <ReadingCanvas
          payload={payload}
          bridge={bridge}
          focusMode={shell.focusMode}
          onOutline={setOutline}
          onRendered={handleRendered}
        />
      </ReaderShell>

      {settingsOpen ? (
        <ReaderSettingsDialog
          preferences={payload.preferences}
          onPatch={patchConfig}
          onClose={() => {
            setSettingsOpen(false);
          }}
        />
      ) : null}
    </ThemeProvider>
  );
}
