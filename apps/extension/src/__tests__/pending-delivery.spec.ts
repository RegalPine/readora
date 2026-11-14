import { describe, expect, test } from "vitest";
import { PendingDeliveries } from "../webview/pending-delivery";

describe("PendingDeliveries", () => {
  test("stage 后 peek 可见、size 计数", () => {
    const pending = new PendingDeliveries<string>();
    pending.stage("s1", "payload-1");
    expect(pending.size).toBe(1);
    expect(pending.peek("s1")).toBe("payload-1");
    expect(pending.size).toBe(1);
  });

  test("deliver 取出即删，重复 deliver 返回 undefined", () => {
    const pending = new PendingDeliveries<string>();
    pending.stage("s1", "payload-1");
    expect(pending.deliver("s1")).toBe("payload-1");
    expect(pending.deliver("s1")).toBeUndefined();
    expect(pending.size).toBe(0);
  });

  test("discard 只清除指定键", () => {
    const pending = new PendingDeliveries<string>();
    pending.stage("s1", "a");
    pending.stage("s2", "b");
    pending.discard("s1");
    expect(pending.deliver("s1")).toBeUndefined();
    expect(pending.deliver("s2")).toBe("b");
  });

  test("clear 清空全部", () => {
    const pending = new PendingDeliveries<string>();
    pending.stage("s1", "a");
    pending.stage("s2", "b");
    pending.clear();
    expect(pending.size).toBe(0);
  });

  test("同键重复 stage 覆盖旧载荷", () => {
    const pending = new PendingDeliveries<string>();
    pending.stage("s1", "old");
    pending.stage("s1", "new");
    expect(pending.deliver("s1")).toBe("new");
  });
});