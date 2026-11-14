/**
 * 视图侧的消息收发替身（真实 HostBridge + 假 vscode-api）。
 *
 * 唯一一份能同时验证「View 发出的信封」与「View 收到的信封」的测试入口：
 * `emit` 走 `createEnvelope` + `HostBridge` 的入站校验，`sent` 读的是 `postMessage`
 * 收到的原始信封。用手搓的假 bridge 测不出 payload 不合 Schema 这类错误，
 * 而协议类断言（M6 的 `config.patch` / `metrics.report`）要的正是这层校验。
 *
 * 放在 `__tests__/` 但不是 `*.spec.*`：vitest 的 include 只收 spec，助手文件不会被当成用例。
 */
import { createEnvelope, type MessageType } from "@readora/contracts";
import { HostBridge, type MessageSource } from "../bridge/host-bridge";
import type { VsCodeApi } from "../bridge/vscode-api";

export interface Posted {
  type: MessageType;
  payload: unknown;
}

export interface BridgeHarness {
  bridge: HostBridge;
  /** 模拟 Host 下发：经信封与 payload 校验，与真实链路同一入口。 */
  emit(type: MessageType, payload: unknown): void;
  /** 取 View 发出的某类消息的 payload 列表（按发送顺序）。 */
  sent(type: MessageType): unknown[];
  posted: Posted[];
  dispose(): void;
}

export function createBridgeHarness(): BridgeHarness {
  const posted: Posted[] = [];
  const listeners: Array<(event: { data: unknown }) => void> = [];
  const api: VsCodeApi = {
    postMessage: (message: unknown) => {
      posted.push(message as Posted);
    },
    getState: () => undefined,
    setState: () => undefined
  };
  const source: MessageSource = {
    addEventListener: (_type, listener) => {
      listeners.push(listener);
    },
    removeEventListener: (_type, listener) => {
      const index = listeners.indexOf(listener);
      if (index >= 0) {
        listeners.splice(index, 1);
      }
    }
  };
  const bridge = new HostBridge(api, source);
  return {
    bridge,
    emit(type, payload) {
      const envelope = createEnvelope(type, payload);
      for (const listener of [...listeners]) {
        listener({ data: envelope });
      }
    },
    sent(type) {
      return posted.filter((entry) => entry.type === type).map((entry) => entry.payload);
    },
    posted,
    dispose() {
      bridge.dispose();
    }
  };
}
