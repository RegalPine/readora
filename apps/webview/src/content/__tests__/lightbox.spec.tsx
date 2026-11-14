/**
 * Lightbox 组件测试（IMP-001 §14 Component Test，PRD-002 §9.2、STORY-08-02）。
 *
 * 断言的是覆盖层自身的口径：倍率区间、键盘指令、拖动位移、焦点陷阱与归还，
 * 不依赖图片真的解码出来（jsdom 里解码尺寸由夹具给出）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import type { ImageActivationRequest } from "../interactions";
import {
  LIGHTBOX_MAX_SCALE,
  LIGHTBOX_MIN_SCALE,
  LIGHTBOX_ZOOM_IN,
  LIGHTBOX_ZOOM_OUT,
  Lightbox
} from "../lightbox";

const REQUEST: ImageActivationRequest = {
  reference: "assets/logo.png",
  alt: "示意图",
  state: "ready",
  src: "https://stub.vscode-cdn.net/readora/assets/logo.png?v=1-1024",
  reason: null
};

interface View {
  dialog: HTMLElement;
  image: HTMLElement;
  onClose: ReturnType<typeof vi.fn>;
  request: ImageActivationRequest;
  tool(name: string): HTMLElement;
  scale(): string | null;
}

function mount(overrides: Partial<ImageActivationRequest> = {}): View {
  const onClose = vi.fn();
  const request = { ...REQUEST, ...overrides };
  render(<Lightbox request={request} onClose={onClose} />);
  const dialog = document.querySelector<HTMLElement>(".readora-lightbox");
  const image = document.querySelector<HTMLElement>(".readora-lightbox-image");
  if (!dialog || !image) {
    throw new Error("lightbox overlay missing");
  }
  return {
    dialog,
    image,
    onClose,
    request,
    tool: (name: string) => {
      const button = dialog.querySelector<HTMLElement>(`[data-readora-lightbox-action="${name}"]`);
      if (!button) {
        throw new Error(`lightbox tool ${name} missing`);
      }
      return button;
    },
    scale(): string | null {
      return dialog.querySelector(".readora-lightbox-scale")?.textContent ?? null;
    }
  };
}

/** 视口尺寸与解码尺寸在 jsdom 里恒为 0，夹具化后才能断言「适应窗口」的算式。 */
function stubMetrics(view: View, natural: { width: number; height: number }): void {
  Object.defineProperty(view.dialog, "clientWidth", { configurable: true, value: 832 });
  Object.defineProperty(view.dialog, "clientHeight", { configurable: true, value: 688 });
  Object.defineProperty(view.image, "naturalWidth", { configurable: true, value: natural.width });
  Object.defineProperty(view.image, "naturalHeight", { configurable: true, value: natural.height });
  fireEvent.load(view.image);
}

/**
 * transform 按数值断言：样式序列化会把省略的位移分量归一（translate(0px, 0px) → translate(0px)），
 * 直接比字符串会在不同 DOM 实现下漂移。
 */
function transformOf(view: View): { x: number; y: number; scale: number } {
  const raw = view.image.style.transform;
  const parts = (raw.match(/translate\(([^)]*)\)/)?.[1] ?? "")
    .split(",")
    .map((part) => Number.parseFloat(part.trim()) || 0);
  return {
    x: parts[0] ?? 0,
    // 单参数 translate 的 y 缺省为 0（与 CSS 规范一致）
    y: parts.length >= 2 ? (parts[1] ?? 0) : 0,
    scale: Number.parseFloat(raw.match(/scale\(([^)]*)\)/)?.[1] ?? "1") || 1
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("结构与初始状态", () => {
  it("对话框语义、标题与说明文字齐备，倍率从 100% 起", () => {
    const view = mount();
    expect(view.dialog.getAttribute("role")).toBe("dialog");
    expect(view.dialog.getAttribute("aria-modal")).toBe("true");
    expect(view.dialog.getAttribute("aria-label")).toBe("示意图");
    expect(view.dialog.getAttribute("data-readora-lightbox-state")).toBe("open");
    expect(view.image.getAttribute("src")).toBe(view.request.src);
    expect(view.image.getAttribute("alt")).toBe("示意图");
    expect(view.dialog.querySelector(".readora-lightbox-caption")?.textContent).toBe("assets/logo.png");
    expect(view.scale()).toBe("100%");
    expect(view.image.getAttribute("data-readora-lightbox-scale")).toBe("1");
  });

  it("无 alt 时用通用标题，说明文字仍显示原引用", () => {
    const view = mount({ alt: "" });
    expect(view.dialog.getAttribute("aria-label")).toBe("Image viewer");
    expect(view.dialog.querySelector(".readora-lightbox-caption")?.textContent).toBe("assets/logo.png");
  });

  it("工具栏四件套按序齐全，关闭按钮独占末位；1:1 已下掉", () => {
    const view = mount();
    const actions = Array.from(
      view.dialog.querySelectorAll<HTMLElement>("[data-readora-lightbox-action]")
    ).map((button) => button.getAttribute("data-readora-lightbox-action"));
    expect(actions).toEqual(["zoom-in", "zoom-out", "fit", "close"]);
    // Fit 与 1:1 在满屏预览里只差“适配窗口”与“原始像素”，产品只要前者；
    // 回到 100% 仍可用键盘 `0`，所以下面那条键盘用例是这件事唯一的证据。
    expect(view.dialog.querySelector('[data-readora-lightbox-action="reset"]')).toBeNull();
    expect(view.tool("close").classList.contains("readora-lightbox-close")).toBe(true);
  });
});

describe("倍率指令", () => {
  it("工具栏放大 / 缩小走同一组倍率常量", () => {
    // 一档放大后一档缩回原比例：两个常量必须互为倒数，否则缩放会漂移
    expect(LIGHTBOX_ZOOM_OUT).toBeCloseTo(1 / LIGHTBOX_ZOOM_IN, 6);
    const view = mount();
    fireEvent.click(view.tool("zoom-in"));
    expect(transformOf(view)).toEqual({ x: 0, y: 0, scale: LIGHTBOX_ZOOM_IN });
    expect(view.scale()).toBe("125%");
    fireEvent.click(view.tool("zoom-out"));
    expect(view.image.getAttribute("data-readora-lightbox-scale")).toBe("1");
    expect(view.scale()).toBe("100%");
  });

  it("键盘 + / - / 0 与工具栏等价，0 复位同时清位移", () => {
    const view = mount();
    fireEvent.keyDown(window, { key: "+" });
    expect(view.scale()).toBe("125%");
    fireEvent.keyDown(window, { key: "-" });
    expect(view.scale()).toBe("100%");
    fireEvent.pointerDown(view.image, { pointerId: 1, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(view.image, { pointerId: 1, clientX: 12, clientY: 9 });
    fireEvent.pointerUp(view.image, { pointerId: 1 });
    expect(transformOf(view)).toEqual({ x: 12, y: 9, scale: 1 });
    fireEvent.keyDown(window, { key: "0" });
    expect(transformOf(view)).toEqual({ x: 0, y: 0, scale: 1 });
  });

  it("倍率有上下限，连点不越界", () => {
    const view = mount();
    for (let index = 0; index < 20; index += 1) {
      fireEvent.click(view.tool("zoom-in"));
    }
    expect(view.scale()).toBe(`${Math.round(LIGHTBOX_MAX_SCALE * 100)}%`);
    for (let index = 0; index < 40; index += 1) {
      fireEvent.click(view.tool("zoom-out"));
    }
    expect(view.scale()).toBe(`${Math.round(LIGHTBOX_MIN_SCALE * 100)}%`);
  });

  it("适应窗口只缩不放：大图按视口算比例", () => {
    const view = mount();
    stubMetrics(view, { width: 3000, height: 2000 });
    fireEvent.click(view.tool("fit"));
    // (832-32)/3000 = 0.266…，(688-88)/2000 = 0.3 → 取更小者，且只缩不放大
    expect(view.image.getAttribute("data-readora-lightbox-scale")).toBe(String(800 / 3000));
    const fitted = transformOf(view);
    expect(fitted.x).toBe(0);
    expect(fitted.y).toBe(0);
    expect(fitted.scale).toBeCloseTo(800 / 3000, 5);
  });

  it("适应窗口不把小图拉大", () => {
    const view = mount();
    stubMetrics(view, { width: 400, height: 300 });
    fireEvent.click(view.tool("zoom-in"));
    fireEvent.click(view.tool("fit"));
    expect(view.image.getAttribute("data-readora-lightbox-scale")).toBe("1");
  });

  it("解码尺寸未知时适应窗口退回原始比例，不做瞎猜的缩放", () => {
    const view = mount();
    fireEvent.click(view.tool("zoom-in"));
    fireEvent.click(view.tool("fit"));
    expect(view.image.getAttribute("data-readora-lightbox-scale")).toBe("1");
    expect(transformOf(view)).toEqual({ x: 0, y: 0, scale: 1 });
  });
});

describe("拖动", () => {
  it("pointer 位移写进 transform，抬起后仍保持", () => {
    const view = mount();
    fireEvent.pointerDown(view.image, { pointerId: 7, clientX: 100, clientY: 50 });
    fireEvent.pointerMove(view.image, { pointerId: 7, clientX: 140, clientY: 30 });
    expect(transformOf(view)).toEqual({ x: 40, y: -20, scale: 1 });
    fireEvent.pointerUp(view.image, { pointerId: 7 });
    fireEvent.pointerMove(view.image, { pointerId: 7, clientX: 400, clientY: 400 });
    expect(transformOf(view)).toEqual({ x: 40, y: -20, scale: 1 });
  });

  it("另一路指针（多点触控）不得改写拖动结果", () => {
    const view = mount();
    fireEvent.pointerDown(view.image, { pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(view.image, { pointerId: 2, clientX: 90, clientY: 90 });
    expect(transformOf(view)).toEqual({ x: 0, y: 0, scale: 1 });
    fireEvent.pointerMove(view.image, { pointerId: 1, clientX: 25, clientY: 10 });
    expect(transformOf(view)).toEqual({ x: 15, y: 0, scale: 1 });
  });

  it("pointerCancel 收尾后不再跟随移动", () => {
    const view = mount();
    fireEvent.pointerDown(view.image, { pointerId: 3, clientX: 5, clientY: 5 });
    fireEvent.pointerMove(view.image, { pointerId: 3, clientX: 15, clientY: 5 });
    fireEvent.pointerCancel(view.image, { pointerId: 3 });
    fireEvent.pointerMove(view.image, { pointerId: 3, clientX: 80, clientY: 5 });
    expect(transformOf(view)).toEqual({ x: 10, y: 0, scale: 1 });
  });
});

describe("关闭与焦点", () => {
  it("Esc / 关闭按钮 / 点遮罩都能关闭，点图片本身不误关", () => {
    const view = mount();
    fireEvent.click(view.image);
    expect(view.onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(view.onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(view.tool("close"));
    expect(view.onClose).toHaveBeenCalledTimes(2);
    fireEvent.click(view.dialog);
    expect(view.onClose).toHaveBeenCalledTimes(3);
  });

  it("打开即聚焦关闭按钮，卸载后焦点归还触发元素", () => {
    const trigger = document.createElement("button");
    document.body.append(trigger);
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    const view = mount();
    expect(document.activeElement).toBe(view.tool("close"));

    cleanup();
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it("Tab 在层内循环，焦点不掉回背景正文", () => {
    const outside = document.createElement("button");
    document.body.append(outside);
    const view = mount();
    const buttons = Array.from(view.dialog.querySelectorAll<HTMLElement>("button"));
    const first = buttons[0] as HTMLElement;
    const last = buttons[buttons.length - 1] as HTMLElement;

    outside.focus();
    fireEvent.keyDown(window, { key: "Tab" });
    expect(document.activeElement).toBe(first);

    last.focus();
    fireEvent.keyDown(window, { key: "Tab" });
    expect(document.activeElement).toBe(first);

    first.focus();
    fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
    outside.remove();
  });

  it("无关按键不触发覆盖层动作", () => {
    const view = mount();
    fireEvent.keyDown(window, { key: "ArrowRight" });
    fireEvent.keyDown(window, { key: "Enter" });
    expect(view.onClose).not.toHaveBeenCalled();
    expect(view.scale()).toBe("100%");
  });
});
