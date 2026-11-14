/**
 * 能力判定与限额（IMP-002 TASK-05-01-02、ARC-003 §4.3 / §9.2、F04-058）。
 *
 * 探针注入而非真引擎：判定顺序（长度 → 识别 → 注册）必须能被确定性断言，
 * 不该依赖第三方解析器的行为。
 */
import { describe, expect, it, vi } from "vitest";

import { capabilityError, resolveCapability, type DiagramCapabilityProbe } from "../capability";
import { DIAGRAM_ERROR_CODES } from "../errors";
import {
  ALLOWED_IMAGE_SCHEMES,
  ALLOWED_LINK_SCHEMES,
  DIAGRAM_ID_PREFIX,
  DIAGRAM_LINK_REL,
  MAX_DIAGRAM_EDGES,
  MAX_DIAGRAM_SOURCE_CHARACTERS,
  MAX_SVG_OUTPUT_CHARACTERS,
  OVER_LIMIT_MESSAGE
} from "../limits";

function probeFor(type: string | null, registered: string[] = []): DiagramCapabilityProbe {
  return {
    detectType: vi.fn(() => type),
    isRegistered: vi.fn((input: string) => registered.includes(input))
  };
}

describe("resolveCapability 判定顺序", () => {
  it("先做长度闸门，再谈识别", () => {
    const probe = probeFor("flowchart", ["flowchart"]);
    const oversized = "flowchart TD\n" + "A".repeat(MAX_DIAGRAM_SOURCE_CHARACTERS + 1);
    const result = resolveCapability(oversized, probe);
    expect(result.status).toBe("over-limit");
    // 超限源码不该再消耗引擎：探针的 detectType 必须没被调用。
    expect(probe.detectType).not.toHaveBeenCalled();
  });

  it("边界值 50 000 字符仍然放行", () => {
    const probe = probeFor("flowchart", ["flowchart"]);
    const source = "x".repeat(MAX_DIAGRAM_SOURCE_CHARACTERS);
    expect(resolveCapability(source, probe).status).toBe("ready");
  });

  it("识别失败 → unknown-syntax", () => {
    const probe = probeFor(null);
    const result = resolveCapability("就是一段普通文字", probe);
    expect(result.status).toBe("unknown-syntax");
    expect(result.diagramType).toBeNull();
    expect(probe.isRegistered).not.toHaveBeenCalled();
  });

  it("识别成功但未注册 → type-not-registered", () => {
    const probe = probeFor("journey", ["flowchart"]);
    const source = "journey\n  title x";
    const result = resolveCapability(source, probe);
    expect(result).toEqual({
      status: "type-not-registered",
      diagramType: "journey",
      sourceLength: source.length
    });
  });

  it("识别并注册 → ready", () => {
    const source = "flowchart TD\n  A --> B";
    const result = resolveCapability(source, probeFor("flowchart", ["flowchart"]));
    expect(result.status).toBe("ready");
    expect(result.sourceLength).toBe(source.length);
  });

  it("判定时按去空白后的源码识别", () => {
    const probe = probeFor("flowchart", ["flowchart"]);
    resolveCapability("   \n  flowchart TD\n  A --> B  \n ", probe);
    expect(probe.detectType).toHaveBeenCalledWith("flowchart TD\n  A --> B");
  });
});

describe("capabilityError 展示口径", () => {
  it("ready 不产生错误", () => {
    expect(
      capabilityError({ status: "ready", diagramType: "flowchart", sourceLength: 10 })
    ).toBeNull();
  });

  it("每种失败都有稳定错误码", () => {
    expect(
      capabilityError({ status: "over-limit", diagramType: null, sourceLength: 1 })?.code
    ).toBe(DIAGRAM_ERROR_CODES.OVER_LIMIT);
    expect(
      capabilityError({ status: "unknown-syntax", diagramType: null, sourceLength: 1 })?.code
    ).toBe(DIAGRAM_ERROR_CODES.UNSUPPORTED);
    expect(
      capabilityError({ status: "type-not-registered", diagramType: "journey", sourceLength: 1 })
        ?.code
    ).toBe(DIAGRAM_ERROR_CODES.NOT_REGISTERED);
  });

  it("未注册提示里带出类型名，便于用户改文档", () => {
    const error = capabilityError({
      status: "type-not-registered",
      diagramType: "journey",
      sourceLength: 1
    });
    expect(error?.message).toContain("journey");
    expect(error?.kind).toBe("unsupported");
  });
});

describe("安全限额常量", () => {
  it("输入上限即 F04-058 的 50 000 字符", () => {
    expect(MAX_DIAGRAM_SOURCE_CHARACTERS).toBe(50_000);
    expect(OVER_LIMIT_MESSAGE).toContain("50000");
  });

  it("scheme 白名单：链接只放行 http/https，图片一律不放行", () => {
    expect(ALLOWED_LINK_SCHEMES).toEqual(["http", "https"]);
    expect(ALLOWED_IMAGE_SCHEMES).toHaveLength(0);
  });

  it("输出与边数上限为正数，rel / id 前缀符合约定", () => {
    expect(MAX_SVG_OUTPUT_CHARACTERS).toBeGreaterThan(MAX_DIAGRAM_SOURCE_CHARACTERS);
    expect(MAX_DIAGRAM_EDGES).toBeGreaterThan(0);
    expect(DIAGRAM_LINK_REL.split(" ").sort()).toEqual(["nofollow", "noopener", "noreferrer"]);
    expect(DIAGRAM_ID_PREFIX).toBe("readora-diagram-");
  });
});
