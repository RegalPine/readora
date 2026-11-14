/**
 * webview 测试共用替身（IMP-001 §14）。
 *
 * 正文交互契约有四个通道（外链 / 跳转 / 图片 / 资源解析），逐个 spec 里手写
 * 字面量既啰嗦又容易漏项；这里收口成一处，测试按需覆盖单个通道。
 */
import { vi } from "vitest";
import { READORA_ERROR_CODES, type ResourceResolveResult } from "@readora/contracts";
import type {
  DiagramEngine,
  DiagramError,
  DiagramMountOptions,
  DiagramState,
  DiagramZoomControls,
  MountedDiagram
} from "@readora/diagram-core";
import type { CanvasBridge } from "../../app/ReadingCanvas";
import type { ContentInteractionHandlers } from "../interactions";
import type { ResourceEntry } from "../resource-cache";

export function okResult(
  reference: string,
  overrides: Partial<ResourceResolveResult> = {}
): ResourceResolveResult {
  return {
    resourceId: `res-${reference.slice(-6)}`,
    webviewUri: `https://stub.vscode-cdn.net/readora/${encodeURIComponent(reference)}`,
    mimeType: "image/png",
    kind: "image",
    byteSize: 1024,
    version: "1-1024",
    ...overrides
  };
}

export function okResource(
  reference: string,
  overrides: Partial<ResourceResolveResult> = {}
): ResourceEntry {
  return { ok: true, result: okResult(reference, overrides) };
}

export function failedResource(code: string = READORA_ERROR_CODES.RESOURCE_NOT_FOUND): ResourceEntry {
  return { ok: false, code, message: "stubbed failure" };
}

export function fakeHandlers(
  overrides: Partial<ContentInteractionHandlers> = {}
): ContentInteractionHandlers {
  return {
    openExternal: vi.fn(),
    navigate: vi.fn(async () => true),
    openImage: vi.fn(),
    resolveResource: vi.fn(async () => okResource("default.png")),
    ...overrides
  };
}

/** 画布用的假 bridge：记录通知与请求，按 type 返回预置响应或抛出。 */
export function fakeBridge(
  responses: Record<string, unknown | Error> = {}
): CanvasBridge & { notifications: Array<[string, unknown]>; requests: Array<[string, unknown]> } {
  const notifications: Array<[string, unknown]> = [];
  const requests: Array<[string, unknown]> = [];
  return {
    notifications,
    requests,
    notify: (type, payload) => {
      notifications.push([type, payload]);
    },
    async request<T>(type: string, payload: unknown): Promise<T> {
      requests.push([type, payload]);
      const entry = responses[type];
      if (entry instanceof Error) {
        throw entry;
      }
      return (entry ?? {}) as T;
    }
  };
}

/**
 * 图表引擎替身。
 *
 * diagram-core 的 Adapter 契约已有单测覆盖，webview 侧要证的是「挂载层怎么用引擎」：
 * 挂载次数、update / destroy 调用、错误回调、状态写回、缩放指令转发。
 * 这些都必须由确定性替身来断言，不能依赖真实 Pele 在 jsdom 下的布局结果。
 */
export interface FakeMounted extends MountedDiagram {
  readonly container: HTMLElement;
  readonly source: string;
  readonly mounts: number;
  readonly updates: number;
  readonly refreshes: number;
  readonly destroys: number;
}

export interface FakeEngineOptions {
  /** 挂载即失败：挂载层应收到 onError 并落到 failed 态。 */
  failWith?: DiagramError;
  /** 推迟出图（真实环境里容器宽度为 0 时引擎的行为）。 */
  pending?: boolean;
}

export function fakeDiagramEngine(options: FakeEngineOptions = {}) {
  const instances: FakeMounted[] = [];
  const mountCalls: Array<{
    container: HTMLElement;
    source: string;
    options: DiagramMountOptions | undefined;
  }> = [];

  const engine: DiagramEngine = {
    id: "fake-engine",
    version: "0-test",
    supports: () => true,
    inspect: () => ({ detectedType: "flowchart", registered: true }),
    render: async () => ({ svg: "<svg></svg>", width: 12, height: 12, type: "flowchart" }),
    mount: (container, source, mountOptions) => {
      mountCalls.push({ container, source, options: mountOptions });
      let state: DiagramState = options.failWith ? "failed" : options.pending ? "mounting" : "rendered";
      let error: DiagramError | undefined = options.failWith;
      let counts = { updates: 0, refreshes: 0, destroys: 0 };
      let scale = 1;

      if (options.failWith) {
        mountOptions?.onError?.(options.failWith);
      }
      if (state === "rendered") {
        const svg = container.ownerDocument.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.setAttribute("data-readora-fake-svg", "mounted");
        container.replaceChildren(svg);
      }

      const zoom: DiagramZoomControls = {
        get available(): boolean {
          return state === "rendered";
        },
        get scale(): number {
          return scale;
        },
        zoomBy: (factor: number) => {
          scale = Number((scale * factor).toFixed(4));
        },
        fit: () => {
          scale = 0.5;
        },
        reset: () => {
          scale = 1;
        }
      };

      const instance: FakeMounted = {
        get container(): HTMLElement {
          return container;
        },
        get source(): string {
          return source;
        },
        get state(): DiagramState {
          return state;
        },
        get error(): DiagramError | undefined {
          return error;
        },
        get mounts(): number {
          return mountCalls.length;
        },
        get updates(): number {
          return counts.updates;
        },
        get refreshes(): number {
          return counts.refreshes;
        },
        get destroys(): number {
          return counts.destroys;
        },
        zoom,
        update: (next: string) => {
          counts = { ...counts, updates: counts.updates + 1 };
          source = next;
          state = options.failWith ? "failed" : "rendered";
          error = options.failWith;
        },
        refresh: () => {
          counts = { ...counts, refreshes: counts.refreshes + 1 };
          if (state === "mounting") {
            state = "rendered";
          }
        },
        destroy: () => {
          counts = { ...counts, destroys: counts.destroys + 1 };
          state = "destroyed";
          container.replaceChildren();
        }
      };
      instances.push(instance);
      return instance;
    }
  };

  return { engine, instances, mountCalls };
}
