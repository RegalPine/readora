/**
 * 端到端夹具：真实 `App` + 页面内脚本化 Host（IMP-003 §7.1，EPIC-11 / EPIC-12）。
 *
 * 为什么不是「手搓 DOM」：`tests/e2e` 要验的是「点目录会滚到对应标题」「搜索计数
 * 与高亮同源」「主题切换不重建 DOM」这类**渲染管线与外壳协同**的行为。手搓的 DOM
 * 只能证明测试自己的选择器写对了，证不了 `renderMarkdown` 的产物真的能被这些交互
 * 消费。所以这里挂的是生产同一个 `App` + 生产同一个 `HostBridge`。
 *
 * 为什么 bridge 不能是假的：`HostBridge` 的入站校验（信封 + 方向 + payload Schema）
 * 本身就是被验对象之一。这里给它的是一枚假 `vscode-api` 与真的 `window`，
 * 消息一律走 `createEnvelope` + `MessageEvent`，与 VS Code 的投递形态同构。
 *
 * 门控时序照抄真 Host（ARC-004 §8.7）：`document.load` 只在收到 `reader.ready`
 * 之后投递，之前的快照缓存在队列里。这样 `tests/integration` 才能验「订阅前到达的
 * 消息不丢」这条不变量在**浏览器里**成立，而不只在单测里成立。
 *
 * 用例通过 `window.__readora` 驱动它（类型见 `E2EHost`）。不开 StrictMode：
 * React 19 的 StrictMode 会把 effect 双跑一次，于是 `reader.ready` 发两条、
 * 指标上报也发两条 —— 那是要在单测里验的行为，放进 e2e 只会让断言变成数重复。
 */
import { createRoot } from "react-dom/client";
import {
  createEnvelope,
  createErrorResponse,
  createSuccessResponse,
  DEFAULT_READER_PREFERENCES,
  ReaderPreferencesSchema,
  type ConfigPatchKey,
  type DocumentLoadPayload,
  type ExportCapturePayload,
  type ExportFormat,
  type MessageType,
  type ReadingState,
  type ReaderPreferences,
  type ResourceKind,
  type ResourceResolveResult,
  type ResolvedTheme,
  type ThemeSource,
  type ViewStatePayload
} from "@readora/contracts";
import { App } from "../src/app/App";
import { ErrorBoundary } from "../src/app/ErrorBoundary";
import { HostBridge } from "../src/bridge/host-bridge";
import type { VsCodeApi } from "../src/bridge/vscode-api";
// 样式层叠顺序与 main.tsx 完全一致（PRD-003 §13.4）：夹具若少一层，e2e 看到的
// 布局与用户看到的就不是同一件东西。
import "katex/dist/katex.min.css";
import "../src/styles/fonts.css";
import "../src/styles/tokens.css";
import "../src/styles/tailwind.css";
import "../src/styles/base.css";
import "../src/styles/markdown.css";
import "../src/styles/components.css";
import "../src/styles/shell.css";
import "../src/styles/lightbox-search.css";

/** View 发来的一条消息（含信封 id，便于用例断言请求-响应确实配对）。 */
export interface ViewMessage {
  id: string;
  type: MessageType;
  payload: unknown;
}

export interface LoadInput {
  text: string;
  documentUri?: string;
  version?: number;
  languageId?: string;
  preferences?: Partial<ReaderPreferences>;
}

/** 资源解析的三种剧本：成功、失败、不回复（用来验超时与降级）。 */
export type ResourceScript =
  | { mode: "ok"; result: Partial<ResourceResolveResult> }
  | { mode: "error"; code: string; message: string }
  | { mode: "silent" };

export type NavigateScript =
  | { mode: "ok"; documentUri: string; text: string }
  | { mode: "error"; code: string; message: string };

/**
 * 排队中的 host→view 快照。
 *
 * `capture` 与 `load` / `update` 走同一道门控：真 Host 在 ready 之前不会 post
 * 任何 host→view 消息（`WebviewManager` 把它们攒到 `deliverPending`），夹具要是
 * 比生产更宽松，「ready 之前的取帧请求不会打空」这条断言就成了自证。
 */
type QueuedMessage =
  | { kind: "load" | "update"; payload: DocumentLoadPayload }
  | { kind: "capture"; payload: ExportCapturePayload };

/**
 * 投递门控。
 *
 * `hold` 让快照**无视 ready 状态**一律排队，用例因此可以确定性地复现
 * 「ready 之前就有快照到达」这条时序 —— 只靠真实时序去赌是不行的：
 * React 的订阅 effect 与本脚本的执行顺序由调度器决定，赌赢了才排队、
 * 赌输了直接投，用例就成了偶发红。
 */
export type HostGate = "open" | "hold";

/** 暴露给用例的控制器。Playwright 只经 `page.evaluate` 调它，不参与页面实现。 */
export interface E2EHost {
  /** 首帧门控：等到 View 发来 `reader.ready`。 */
  ready(): Promise<number>;
  /** 投一份快照：ready 之前到达就先缓存，ready 时一并投出。 */
  load(input: LoadInput): void;
  update(input: LoadInput): void;
  setTheme(theme: ResolvedTheme, source?: ThemeSource): void;
  setViewState(state: Partial<ViewStatePayload>): void;
  /**
   * 投一条 `export.capture`：Host 在保存对话框拿到用户选定路径后来取帧。
   * 与 `load` 同样受门控（未放行只排队），用例因此能确定性复现「取帧早于就绪」。
   */
  exportCapture(requestId: string, format: ExportFormat): void;
  /** 下一次 `load` 之前先回一条 `state.restore`。 */
  restoreState(state: ReadingState | null): void;
  setPreferences(patch: Partial<ReaderPreferences>): void;
  setResourceScript(script: ResourceScript): void;
  setNavigateScript(script: NavigateScript): void;
  /** 切门控：`hold` 期间所有快照只排队不投递，`open` 时一次性放行。 */
  setGate(gate: HostGate): void;
  /** 直接投一条信封（可故意投非法 payload / 未知类型 / 方向不符）。 */
  postRaw(message: unknown): void;
  messages(type?: MessageType): ViewMessage[];
  preferences(): ReaderPreferences;
  clear(): void;
}

declare global {
  interface Window {
    /** 用例控制器：Playwright 经 `page.evaluate` 访问，产品代码不读它。 */
    __readora: E2EHost;
  }
}

const DEFAULT_VIEW_STATE: ViewStatePayload = {
  focusMode: false,
  outlineVisible: true,
  contentWidth: DEFAULT_READER_PREFERENCES.contentWidth
};

function toPayload(input: LoadInput, preferences: ReaderPreferences): DocumentLoadPayload {
  return {
    documentUri: input.documentUri ?? "file:///vault/e2e/reader.md",
    languageId: input.languageId ?? "markdown",
    version: input.version ?? 1,
    text: input.text,
    preferences: { ...preferences, ...input.preferences }
  };
}

/**
 * 页面内 Host。
 *
 * 与真 Host 的四处一致：门控在 ready 之后投递、请求要么回响应要么明确失败、
 * `config.patch` 经同一份偏好 Schema 复判后才广播 `config.update`（Webview 不做
 * 乐观生效，PRD-003 §10.5 的弹层因此必须能观察到「广播回来才变」）、配置变化时
 * **先重发解析后的 `theme.update` 再发偏好**（`application.ts` 的 onDidChange 就
 * 这两条，取色唯一入口是 `theme.update`，漏掉它等于弹层的主题开关在这套夹具里
 * 是个摆设 —— 那会让 e2e 绿灯与生产行为不同形）。
 * 其余业务（文件监听、会话表、资源策略）不在 e2e 的作用域内，故意不做。
 */
class ScriptedHost {
  private readonly posted: ViewMessage[] = [];
  private readyCount = 0;
  private readonly readyWaiters: Array<(count: number) => void> = [];
  private queued: QueuedMessage[] = [];
  private gate: HostGate = "open";
  private pendingRestore: ReadingState | null = null;
  private preferences: ReaderPreferences = { ...DEFAULT_READER_PREFERENCES };
  /**
   * 宿主色板的明暗。夹具没有真宿主，`setTheme` 收到非 product 来源时把它记下来，
   * 于是「宿主暗色 + 用户选 auto」这类组合能被如实复现。
   */
  private hostMode: ResolvedTheme = "light";
  /** 已投递的解析结果：与 `WebviewManager.postTheme` 的去重同一口径。 */
  private lastTheme: { mode: ResolvedTheme; source: ThemeSource } | null = null;
  private viewState: ViewStatePayload = { ...DEFAULT_VIEW_STATE };
  private resourceScript: ResourceScript = {
    mode: "error",
    code: "readora.resource.notFound",
    message: "e2e: no resource script set"
  };
  private navigateScript: NavigateScript = {
    mode: "error",
    code: "readora.wikilink.missing",
    message: "e2e: no navigate script set"
  };
  private readonly api: VsCodeApi;
  /** 交给 App 的那个 bridge 与控制器是同一个实例：夹具不造第二个通道。 */
  readonly bridge: HostBridge;
  private readonly source = {
    addEventListener: (
      _type: "message",
      listener: (event: { data: unknown }) => void
    ): void => {
      // 断言的目标写成 `MessageEvent` 而不是 `Event`：DOM 的重载按事件名挑具体类型，
      // 转成 `EventListener` 在 strictFunctionTypes 下不成立（`Event` 没有 `data`），
      // 那种写法等于要求 TS 别问。这里问得清：夹具收到的就是 `MessageEvent`。
      window.addEventListener("message", listener as (event: MessageEvent) => void);
    },
    removeEventListener: (
      _type: "message",
      listener: (event: { data: unknown }) => void
    ): void => {
      // 与 add 用同一个函数引用（bridge 存的就是 `this.listener`），所以这里能真的退订。
      window.removeEventListener("message", listener as (event: MessageEvent) => void);
    }
  };

  constructor() {
    this.api = {
      postMessage: (message: unknown) => this.onViewMessage(message as ViewMessage),
      getState: () => undefined,
      setState: () => undefined
    };
    this.bridge = new HostBridge(this.api, this.source);
  }

  get controller(): E2EHost {
    return {
      ready: () =>
        this.readyCount > 0
          ? Promise.resolve(this.readyCount)
          : new Promise<number>((resolve) => {
              this.readyWaiters.push(resolve);
            }),
      load: (input) => {
        const payload = toPayload(input, this.preferences);
        if (!this.deliverable) {
          this.queued.push({ kind: "load", payload });
          return;
        }
        this.deliver("document.load", payload);
      },
      update: (input) => {
        const payload = toPayload(input, this.preferences);
        if (!this.deliverable) {
          this.queued.push({ kind: "update", payload });
          return;
        }
        this.deliver("document.update", payload);
      },
      setTheme: (theme, source = "product") => {
        // 宿主明暗是解析 `auto` / `system` 的输入，必须跟着这次投递走；
        // 同时记住已投递值，否则下一次 `config.patch` 的去重会误判「没变」。
        if (source !== "product") {
          this.hostMode = theme;
        }
        this.lastTheme = { mode: theme, source };
        this.deliver("theme.update", { theme, source });
      },
      setViewState: (state) => {
        this.viewState = { ...this.viewState, ...state };
        this.deliver("reader.viewState", this.viewState);
      },
      exportCapture: (requestId, format) => {
        const payload: ExportCapturePayload = { requestId, format };
        if (!this.deliverable) {
          this.queued.push({ kind: "capture", payload });
          return;
        }
        this.deliver("export.capture", payload);
      },
      restoreState: (state) => {
        // ready 之前只能挂着（真 Host 也会在 ready 后才回灌）；之后随时可投，
        // 两条时序都要能造：一条测「恢复早于渲染」，一条测「晚于渲染」。
        if (this.readyCount === 0) {
          this.pendingRestore = state;
          return;
        }
        this.deliver("state.restore", { state });
      },
      setPreferences: (patch) => {
        const previousWidth = this.preferences.contentWidth;
        this.preferences = { ...this.preferences, ...patch };
        // 等价于用户改 settings.json：真 Host 的那条路径同样是先广播主题再广播偏好，
        // 且配置宽度变化时同步会话视图状态并下发 reader.viewState（见 syncWidthIfNeeded）。
        this.broadcastTheme();
        this.deliver("config.update", { preferences: this.preferences });
        this.syncWidthIfNeeded(previousWidth);
      },
      setResourceScript: (script) => {
        this.resourceScript = script;
      },
      setNavigateScript: (script) => {
        this.navigateScript = script;
      },
      setGate: (gate) => {
        this.gate = gate;
        if (gate === "open") {
          this.flushQueued();
        }
      },
      postRaw: (message) => {
        window.dispatchEvent(new MessageEvent("message", { data: message }));
      },
      messages: (type) =>
        type ? this.posted.filter((entry) => entry.type === type) : [...this.posted],
      preferences: () => ({ ...this.preferences }),
      clear: () => {
        this.posted.length = 0;
      }
    };
  }

  /** 只有 ready 之后、且门控开着才投递（`hold` 是用例造的时序，不放宽这条）。 */
  private get deliverable(): boolean {
    return this.readyCount > 0 && this.gate === "open";
  }

  private flushQueued(): void {
    if (!this.deliverable) {
      return;
    }
    for (const entry of this.queued.splice(0)) {
      if (entry.kind === "capture") {
        this.deliver("export.capture", entry.payload);
        continue;
      }
      this.deliver(entry.kind === "load" ? "document.load" : "document.update", entry.payload);
    }
  }

  private deliver(type: MessageType, payload: unknown): void {
    window.dispatchEvent(
      new MessageEvent("message", { data: createEnvelope(type, payload) })
    );
  }

  private respond(id: string, ok: boolean, body: unknown): void {
    const response = ok
      ? createSuccessResponse(id, body)
      : createErrorResponse(id, String((body as { code?: string }).code ?? "readora.internal"), String((body as { message?: string }).message ?? ""));
    window.dispatchEvent(new MessageEvent("message", { data: response }));
  }

  /**
   * 归一主题：照抄 `ConfigurationService.resolveTheme()`（ARC-006 §7.2）。
   *
   * 不复用产品代码是因为它在 Host 侧依赖 `vscode`（读 `activeColorTheme.kind`），
   * 页面里没有那个对象；这里的 `hostMode` 就是它的替身，由 `setTheme` 的投递维护。
   */
  private resolveTheme(): { mode: ResolvedTheme; source: ThemeSource } {
    const mode = this.preferences.theme;
    if (mode === "light" || mode === "dark") {
      return { mode, source: "product" };
    }
    return {
      mode: this.hostMode,
      source: mode === "vscode" ? "vscode" : "system"
    };
  }

  /** 解析结果没变就不投（与 `WebviewManager.postTheme` 同一去重口径）。 */
  private broadcastTheme(): void {
    const state = this.resolveTheme();
    const last = this.lastTheme;
    if (last && last.mode === state.mode && last.source === state.source) {
      return;
    }
    this.lastTheme = state;
    this.deliver("theme.update", { theme: state.mode, source: state.source });
  }

  /**
   * 真 Host 的 `broadcastConfig({ syncContentWidth })`：配置宽度变了才同步会话。
   *
   * Webview 的宽度变量以视图状态优先（`App.tsx`），只发 config.update 改不动
   * 正文 —— 不抄这条，弹层改宽度在这套 e2e 里就是「拖了滑杆、面板纹丝不动」。
   */
  private syncWidthIfNeeded(previousWidth: number): void {
    if (this.preferences.contentWidth === previousWidth) {
      return;
    }
    this.viewState = {
      ...this.viewState,
      contentWidth: this.preferences.contentWidth
    };
    this.deliver("reader.viewState", this.viewState);
  }

  private onViewMessage(message: ViewMessage): void {
    this.posted.push(message);
    switch (message.type) {
      case "reader.ready": {
        this.readyCount += 1;
        for (const resolve of this.readyWaiters.splice(0)) {
          resolve(this.readyCount);
        }
        // 排队的快照在这里一次性投出（门控前不丢首帧，ARC-004 §8.7）。
        this.flushQueued();
        if (this.pendingRestore) {
          this.deliver("state.restore", { state: this.pendingRestore });
        }
        return;
      }
      case "resource.resolve": {
        const script = this.resourceScript;
        if (script.mode === "silent") {
          return;
        }
        if (script.mode === "error") {
          this.respond(message.id, false, { code: script.code, message: script.message });
          return;
        }
        const request = message.payload as { reference: string; kind?: ResourceKind };
        this.respond(message.id, true, {
          resourceId: `e2e:${request.reference}`,
          webviewUri: `https://e2e.invalid/resource/${encodeURIComponent(request.reference)}`,
          mimeType: "image/png",
          kind: request.kind ?? "image",
          byteSize: 1_024,
          version: "e2e-1",
          ...script.result
        } satisfies ResourceResolveResult);
        return;
      }
      case "document.navigate": {
        const script = this.navigateScript;
        if (script.mode === "error") {
          this.respond(message.id, false, { code: script.code, message: script.message });
          return;
        }
        const payload = toPayload({ documentUri: script.documentUri, text: script.text }, this.preferences);
        this.deliver("document.load", payload);
        this.respond(message.id, true, undefined);
        return;
      }
      case "config.patch": {
        const { key, value } = message.payload as { key: ConfigPatchKey; value: unknown };
        // 与真 Host 同一口径：先整体过 Schema，非法就广播当前值（界面必须回到原样）。
        const next = { ...this.preferences, [key]: value } as ReaderPreferences;
        const accepted = validPreferences(next);
        const previousWidth = this.preferences.contentWidth;
        this.preferences = accepted ? next : this.preferences;
        // `application.ts` 的 onDidChange 监听是「先 broadcastTheme 再 broadcastConfig」，
        // 顺序与条数都得照抄：Webview 侧取色只认 `theme.update`（App.tsx 头注），
        // 少了这一条，弹层里改「主题模式」在这套 e2e 下就不落色 —— 绿灯会骗人。
        // 被拒的补丁不动主题：真 Host 在写配置之前就 throw，配置事件根本不会发生。
        if (accepted) {
          this.broadcastTheme();
        }
        // 这里的回显（把当前值再广播一次）是夹具替「非法值也要让界面落回确认值」造的
        // 便捷通路；生产侧的对应行为是不写配置、因而没有变更事件，界面停在原值上。
        this.deliver("config.update", { preferences: this.preferences });
        // 真 Host 的 broadcastConfig 在配置宽度变化时把它同步进会话并随
        // reader.viewState 下发；被拒的补丁不动宽度（同上，事件根本不会发生）。
        if (accepted) {
          this.syncWidthIfNeeded(previousWidth);
        }
        return;
      }
      default:
        // state.save / metrics.report / document.open / reader.error：只记录，
        // 由用例从 `messages(type)` 里读。
        return;
    }
  }
}

/**
 * 偏好复判。
 *
 * 直接复用 `ReaderPreferencesSchema`，与真 Host 的 `configuration-service.patchPreference`
 * 同一权威 —— 边界值写第二份就迟早会漂。
 */
function validPreferences(candidate: ReaderPreferences): boolean {
  return ReaderPreferencesSchema.safeParse(candidate).success;
}

const host = new ScriptedHost();

const container = document.getElementById("root");
if (!container) {
  throw new Error("Readora e2e fixture: #root container not found.");
}

window.__readora = host.controller;

createRoot(container).render(
  <ErrorBoundary bridge={host.bridge}>
    <App bridge={host.bridge} />
  </ErrorBoundary>
);
