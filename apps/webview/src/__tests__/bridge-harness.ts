/**
 * 视图侧的消息收发替身（真实 HostBridge + 假 vscode-api）。
 *
 * 唯一一份能同时验证「View 发出的信封」与「View 收到的信封」的测试入口：
 * `emit` 走 `createEnvelope` + `HostBridge` 的入站校验，`sent` 读的是 `postMessage`
 * 收到的原始信封。用手搓的假 bridge 测不出 payload 不合 Schema 这类错误，
 * 而协议类断言（M6 的 `config.patch` / `metrics.report`）要的正是这层校验。
 *
 * `respondTo` 让用例能回复一条 View 发起的**请求**（带信封 id，走 `createSuccessResponse`
 * / `createErrorResponse`）：`resource.resolve`、`document.navigate` 这类 request→response
 * 通道要观察响应到达后的界面变化，只记录请求不回话就会卡在 10s 超时上。
 *
 * 放在 `__tests__/` 但不是 `*.spec.*`：vitest 的 include 只收 spec，助手文件不会被当成用例。
 */
import {
  createEnvelope,
  createErrorResponse,
  createSuccessResponse,
  type MessageType
} from "@readora/contracts";
import { HostBridge, type MessageSource } from "../bridge/host-bridge";
import type { VsCodeApi } from "../bridge/vscode-api";

export interface Posted {
  id: string;
  type: MessageType;
  payload: unknown;
}

export interface BridgeHarness {
  bridge: HostBridge;
  /** 模拟 Host 下发：经信封与 payload 校验，与真实链路同一入口。 */
  emit(type: MessageType, payload: unknown): void;
  /** 取 View 发出的某类消息的 payload 列表（按发送顺序）。 */
  sent(type: MessageType): unknown[];
  /**
   * 回复最近一条该类型的请求：`result` 作为成功载荷经响应信封投递回 View。
   * 找不到对应请求（View 还没发）时返回 false，用例据此判断时序。
   */
  respondTo(type: MessageType, result: unknown): boolean;
  /** 以错误响应回复最近一条该类型的请求。 */
  respondToError(type: MessageType, code: string, message: string): boolean;
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
  const dispatch = (message: unknown): void => {
    for (const listener of [...listeners]) {
      listener({ data: message });
    }
  };
  const lastRequestId = (type: MessageType): string | null => {
    for (let index = posted.length - 1; index >= 0; index -= 1) {
      const entry = posted[index];
      if (entry && entry.type === type) {
        return entry.id;
      }
    }
    return null;
  };
  return {
    bridge,
    emit(type, payload) {
      dispatch(createEnvelope(type, payload));
    },
    sent(type) {
      return posted.filter((entry) => entry.type === type).map((entry) => entry.payload);
    },
    respondTo(type, result) {
      const id = lastRequestId(type);
      if (id === null) {
        return false;
      }
      dispatch(createSuccessResponse(id, result));
      return true;
    },
    respondToError(type, code, message) {
      const id = lastRequestId(type);
      if (id === null) {
        return false;
      }
      dispatch(createErrorResponse(id, code, message));
      return true;
    },
    dispose() {
      bridge.dispose();
    },
    posted
  };
}
