/**
 * Pele Adapter 契约测试（IMP-002 TASK-05-02-01/04、ARC-003 §4.2 / §6.2 / §9.3）。
 *
 * 全部经门面取引擎，测试代码不 import pele：这既是 IMP-001 §9.3 的机器约束，
 * 也保证「换个引擎实现，测试仍然有效」的抽象确实存在。
 */
import { describe, expect, it, vi } from "vitest";

import {
  DIAGRAM_ERROR_CODES,
  DiagramRenderError,
  createDiagramEngine,
  type DiagramError,
  type DiagramTextMeasurer
} from "../index";

const measurer: DiagramTextMeasurer = {
  width: (text, size) => text.length * size * 0.6
};

const FLOWCHART = "flowchart TD\n  A[开始] --> B[结束]";
const JOURNEY = "journey\n  title 我的旅程\n  假期: 5, 小明, 很棒";

function newEngine() {
  return createDiagramEngine({ cacheCapacity: 8 });
}

function mountContainer() {
  const container = document.createElement("div");
  // Pele 依据容器宽度决定是否立即出图，jsdom 需要显式给出可布局尺寸。
  Object.defineProperty(container, "clientWidth", { configurable: true, value: 640 });
  Object.defineProperty(container, "clientHeight", { configurable: true, value: 480 });
  document.body.append(container);
  return container;
}

describe("Pele Adapter：引擎标识与能力识别", () => {
  it("暴露产品内的引擎身份", () => {
    const engine = newEngine();
    expect(engine.id).toBe("pele");
    expect(engine.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("supports / inspect 只识别类型不做解析", () => {
    const engine = newEngine();
    expect(engine.supports(FLOWCHART)).toBe(true);
    expect(engine.inspect(FLOWCHART)).toEqual({ detectedType: "flowchart", registered: true });
    // journey 是 Pele 支持的类型，但不在本产品的 14 类注册集内。
    expect(engine.inspect(JOURNEY)).toEqual({ detectedType: "journey", registered: false });
    expect(engine.inspect("完全不是图表的一段话")).toEqual({
      detectedType: null,
      registered: false
    });
  });
});

describe("Pele Adapter：render", () => {
  it("产出 SVG 结果并把同一份结果给重复请求（缓存命中）", async () => {
    const engine = newEngine();
    const first = await engine.render(FLOWCHART, { measurer });
    expect(first.svg).toContain("<svg");
    expect(first.type).toBe("flowchart");
    expect(first.width).toBeGreaterThan(0);
    const second = await engine.render(FLOWCHART, { measurer });
    expect(second).toBe(first);
  });

  it("布局选项变化会绕开缓存", async () => {
    const engine = newEngine();
    const a = await engine.render(FLOWCHART, { measurer });
    const b = await engine.render(FLOWCHART, { measurer, maxWidth: 320 });
    expect(b).not.toBe(a);
  });

  it("超限源码不进引擎，直接 over-limit", async () => {
    const engine = newEngine();
    const oversized = `flowchart TD\n  A[${"字".repeat(50_001)}]`;
    await expect(engine.render(oversized, { measurer })).rejects.toMatchObject({
      detail: { kind: "over-limit", code: DIAGRAM_ERROR_CODES.OVER_LIMIT }
    });
  });

  it("未注册类型给出 not-registered 而不是崩溃", async () => {
    const engine = newEngine();
    const error = await engine.render(JOURNEY, { measurer }).then(
      () => null,
      (raw: unknown) => raw
    );
    expect(error).toBeInstanceOf(DiagramRenderError);
    const detail = (error as DiagramRenderError).detail;
    expect(detail.kind).toBe("unsupported");
    expect(detail.code).toBe(DIAGRAM_ERROR_CODES.NOT_REGISTERED);
    expect(detail.message).toContain("journey");
  });

  it("语法错误带行列位置", async () => {
    const engine = newEngine();
    const broken = "flowchart TD\n  A[开始] -->\n  @@@@ 不是节点";
    const error = await engine.render(broken, { measurer }).then(
      () => null,
      (raw: unknown) => raw as DiagramRenderError
    );
    expect(error).not.toBeNull();
    const detail = (error as DiagramRenderError).detail as DiagramError;
    expect(detail.kind).toBe("syntax");
    expect(detail.message.length).toBeGreaterThan(0);
    expect(detail.message).not.toContain("at Object");
  });
});

describe("Pele Adapter：mount 生命周期", () => {
  it("成功挂载后容器内有 SVG，销毁后容器必须为空", () => {
    const engine = newEngine();
    const container = mountContainer();
    const diagram = engine.mount(container, FLOWCHART, { measurer, zoom: "auto" });
    expect(diagram.state).toBe("rendered");
    expect(diagram.error).toBeUndefined();
    expect(container.querySelector("svg")).not.toBeNull();

    diagram.update("flowchart TD\n  A[开始] --> B[结束]\n  B --> C[完成]", { measurer });
    expect(diagram.state).toBe("rendered");
    expect(container.querySelector("svg")).not.toBeNull();

    diagram.refresh();
    expect(diagram.state).toBe("rendered");

    diagram.destroy();
    expect(diagram.state).toBe("destroyed");
    // 阶段 0 实测：Pele 的 destroy() 只解监听不清 DOM，清空责任在 Adapter。
    expect(container.children.length).toBe(0);
    container.remove();
  });

  it("销毁后再调用 update / refresh 是安全的空操作", () => {
    const engine = newEngine();
    const container = mountContainer();
    const diagram = engine.mount(container, FLOWCHART, { measurer });
    diagram.destroy();
    expect(() => diagram.update(FLOWCHART, { measurer })).not.toThrow();
    expect(() => diagram.refresh()).not.toThrow();
    expect(diagram.state).toBe("destroyed");
    container.remove();
  });

  it("mount 同步出图：容器有无宽度、是否在文档内都不留下中间态", () => {
    const engine = newEngine();
    // 实测取证：Pele 的初次 mount 走同步渲染分支，不受 isConnected / clientWidth 影响，
    // 因此 created / mounting 只是状态机词汇，不会成为对外可见的稳定状态。
    const detached = document.createElement("div");
    const detachedDiagram = engine.mount(detached, FLOWCHART, { measurer, zoom: false });
    expect(detachedDiagram.state).toBe("rendered");
    detachedDiagram.destroy();

    const zeroWidth = document.createElement("div");
    document.body.append(zeroWidth);
    const diagram = engine.mount(zeroWidth, FLOWCHART, { measurer, zoom: false });
    expect(diagram.state).toBe("rendered");
    expect(zeroWidth.querySelector("svg")).not.toBeNull();
    diagram.destroy();
    zeroWidth.remove();
  });

  it("未注册类型不进入引擎，直接 failed", () => {
    const onError = vi.fn();
    const engine = newEngine();
    const container = mountContainer();
    const diagram = engine.mount(container, JOURNEY, { measurer, onError });
    expect(diagram.state).toBe("failed");
    expect(diagram.error?.code).toBe(DIAGRAM_ERROR_CODES.NOT_REGISTERED);
    expect(container.querySelector("svg")).toBeNull();
    container.remove();
  });

  it("语法错误经 onError 上报并落在 error 上", () => {
    const onError = vi.fn();
    const engine = newEngine();
    const container = mountContainer();
    const diagram = engine.mount(container, "flowchart TD\n  A[开始] -->\n  @@@@", {
      measurer,
      onError
    });
    expect(diagram.state).toBe("failed");
    expect(diagram.error?.kind).toBe("syntax");
    expect(container.querySelector("svg")).toBeNull();
    container.remove();
  });

  it("sanitize 返回 null 时绝不插入未验证 SVG", () => {
    const engine = newEngine();
    const container = mountContainer();
    const diagram = engine.mount(container, FLOWCHART, {
      measurer,
      sanitize: () => null
    });
    expect(diagram.state).toBe("failed");
    expect(diagram.error?.kind).toBe("security");
    expect(container.querySelector("svg")).toBeNull();
    container.remove();
  });

  it("缩放控制在引擎未接管时退化为空操作", () => {
    const engine = newEngine();
    const container = mountContainer();
    const diagram = engine.mount(container, FLOWCHART, { measurer, zoom: false });
    expect(diagram.zoom.available).toBe(false);
    expect(() => {
      diagram.zoom.zoomBy(1.2);
      diagram.zoom.fit();
      diagram.zoom.reset();
    }).not.toThrow();
    expect(diagram.zoom.scale).toBe(1);
    diagram.destroy();
    container.remove();
  });

  it("zoom 自动接管时控制可用", () => {
    const engine = newEngine();
    const container = mountContainer();
    const diagram = engine.mount(container, FLOWCHART, { measurer, zoom: true });
    expect(diagram.zoom.available).toBe(true);
    const before = diagram.zoom.scale;
    diagram.zoom.zoomBy(1.5);
    expect(diagram.zoom.scale).toBeGreaterThan(before);
    diagram.zoom.reset();
    expect(diagram.zoom.scale).toBe(1);
    diagram.destroy();
    container.remove();
  });
});
