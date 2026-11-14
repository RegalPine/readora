/**
 * Host Bridge 单测：请求/响应关联、超时、订阅校验、dispose 清理。
 * 全部依赖注入，不依赖 DOM 与 vscode。
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createEnvelope, type MessageEnvelope } from "@readora/contracts";
import { HostBridge, REQUEST_TIMEOUT_MS } from "../host-bridge";
import type { VsCodeApi } from "../vscode-api";

class FakeApi implements VsCodeApi {
  readonly posted: unknown[] = [];

  postMessage(message: unknown): void {
    this.posted.push(message);
  }

  getState(): unknown {
    return undefined;
  }

  setState(): void {
    // no-op
  }
}

class FakeSource {
  private readonly listeners = new Set<(event: { data: unknown }) => void>();

  addEventListener(
    _type: "message",
    listener: (event: { data: unknown }) => void
  ): void {
    this.listeners.add(listener);
  }

  removeEventListener(
    _type: "message",
    listener: (event: { data: unknown }) => void
  ): void {
    this.listeners.delete(listener);
  }

  emit(data: unknown): void {
    for (const listener of [...this.listeners]) {
      listener({ data });
    }
  }

  get listenerCount(): number {
    return this.listeners.size;
  }
}

let api: FakeApi;
let source: FakeSource;
let bridge: HostBridge;

beforeEach(() => {
  api = new FakeApi();
  source = new FakeSource();
  bridge = new HostBridge(api, source);
});

afterEach(() => {
  bridge.dispose();
  vi.useRealTimers();
});

function lastPosted(): MessageEnvelope {
  const message = api.posted[api.posted.length - 1];
  if (typeof message !== "object" || message === null) {
    throw new Error("no envelope posted");
  }
  return message as MessageEnvelope;
}

describe("notify", () => {
  test("发送符合协议的信封", () => {
    bridge.notify("reader.ready", {});
    const envelope = lastPosted();
    expect(envelope.type).toBe("reader.ready");
    expect(envelope.version).toBe(1);
    expect(envelope.payload).toEqual({});
    expect(envelope.id.length).toBeGreaterThan(0);
  });
});

describe("request", () => {
  test("成功响应按 id 关联并解析 payload", async () => {
    const promise = bridge.request<boolean>("document.open", {
      uri: "https://example.com"
    });
    const envelope = lastPosted();
    source.emit({ id: envelope.id, success: true, payload: true });
    await expect(promise).resolves.toBe(true);
  });

  test("失败响应拒绝并携带错误码", async () => {
    const promise = bridge.request<boolean>("document.open", {
      uri: "file:///etc/passwd"
    });
    const envelope = lastPosted();
    source.emit({
      id: envelope.id,
      success: false,
      error: { code: "readora.link.rejected", message: "blocked" }
    });
    await expect(promise).rejects.toThrow("readora.link.rejected");
  });

  test("无关 id 的响应不影响等待中的请求", async () => {
    vi.useFakeTimers();
    const promise = bridge.request<boolean>("document.open", {
      uri: "https://example.com"
    });
    source.emit({ id: "someone-else", success: true, payload: false });
    const envelope = lastPosted();
    source.emit({ id: envelope.id, success: true, payload: true });
    await expect(promise).resolves.toBe(true);
  });

  test("超时拒绝", async () => {
    vi.useFakeTimers();
    const promise = bridge.request<boolean>("document.open", {
      uri: "https://example.com"
    });
    vi.advanceTimersByTime(REQUEST_TIMEOUT_MS + 1);
    await expect(promise).rejects.toThrow("timed out");
  });
});

describe("subscribe", () => {
  test("接收合法 host-to-view 消息", () => {
    const received: unknown[] = [];
    bridge.subscribe("theme.update", (payload) => {
      received.push(payload);
    });
    source.emit(createEnvelope("theme.update", { theme: "dark", source: "product" }));
    expect(received).toEqual([{ theme: "dark", source: "product" }]);
  });

  test("非法信封被丢弃", () => {
    const received: unknown[] = [];
    bridge.subscribe("theme.update", (payload) => {
      received.push(payload);
    });
    source.emit({ garbage: true });
    source.emit(createEnvelope("theme.update", { theme: "neon", source: "product" }));
    // 只报明暗不报来源：两轴都是必填（ARC-006 §7.3），缺一即丢。
    source.emit(createEnvelope("theme.update", { theme: "dark" }));
    source.emit(
      createEnvelope("theme.update", { theme: "vscode", source: "vscode" })
    );
    source.emit({
      ...createEnvelope("theme.update", { theme: "dark", source: "product" }),
      version: 2
    });
    expect(received).toHaveLength(0);
  });

  test("view-to-host 方向的消息被丢弃", () => {
    const received: unknown[] = [];
    bridge.subscribe("reader.ready", (payload) => {
      received.push(payload);
    });
    source.emit(createEnvelope("reader.ready", {}));
    expect(received).toHaveLength(0);
  });

  test("取消订阅后不再接收", () => {
    const received: unknown[] = [];
    const unsubscribe = bridge.subscribe("theme.update", (payload) => {
      received.push(payload);
    });
    unsubscribe();
    source.emit(createEnvelope("theme.update", { theme: "light", source: "system" }));
    expect(received).toHaveLength(0);
  });
});

describe("dispose", () => {
  test("移除监听、拒绝等待中的请求", async () => {
    const promise = bridge.request<boolean>("document.open", {
      uri: "https://example.com"
    });
    bridge.dispose();
    await expect(promise).rejects.toThrow("disposed");
    expect(source.listenerCount).toBe(0);
    source.emit(createEnvelope("theme.update", { theme: "dark", source: "product" }));
  });
});