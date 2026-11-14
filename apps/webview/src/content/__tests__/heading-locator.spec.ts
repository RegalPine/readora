/**
 * 标题定位测试（ARC-007 §5.3 / §5.4 / §12，STORY-07-02）。
 *
 * 断言的是导航层三条契约：默认平滑、reduced-motion 降级即时、
 * 找不到元素时只返回 false（不抛，正文保持可用）。
 */
import { beforeEach, describe, expect, test } from "vitest";
import { createHeadingLocator, headingLocator, prefersReducedMotion } from "../heading-locator";

interface ScrollCall {
  options: ScrollIntoViewOptions | undefined;
}

let calls: ScrollCall[] = [];

beforeEach(() => {
  calls = [];
  HTMLElement.prototype.scrollIntoView = function (options?: ScrollIntoViewOptions): void {
    calls.push({ options });
  } as unknown as typeof HTMLElement.prototype.scrollIntoView;
});

function fixture(): void {
  document.body.innerHTML = `
    <div class="readora-document">
      <h2 id="overview" class="readora-heading" data-readora-heading="overview">Overview</h2>
      <h2 data-readora-heading="images">Images（id 被 DOMPurify 剥离）</h2>
    </div>`;
}

function winWith(matches: boolean | "missing"): Window {
  if (matches === "missing") {
    return { matchMedia: undefined } as unknown as Window;
  }
  return {
    matchMedia: () => ({ matches })
  } as unknown as Window;
}

describe("navigateTo", () => {
  test("默认平滑滚动到标题顶部（§5.3）", () => {
    fixture();
    const locator = createHeadingLocator(document, winWith(false));
    expect(locator.navigateTo("overview")).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.options).toEqual({ behavior: "smooth", block: "start" });
  });

  test("prefers-reduced-motion 下降级为即时（§5.3 第 3 条）", () => {
    fixture();
    const locator = createHeadingLocator(document, winWith(true));
    expect(locator.navigateTo("overview")).toBe(true);
    expect(calls[0]?.options?.behavior).toBe("auto");
  });

  test("显式传入的 behavior 优先于偏好探测", () => {
    fixture();
    const locator = createHeadingLocator(document, winWith(false));
    locator.navigateTo("overview", { behavior: "auto", block: "center" });
    expect(calls[0]?.options).toEqual({ behavior: "auto", block: "center" });
  });

  test("id 被剥离时回退 data-readora-heading 镜像（与正文锚点同一口径）", () => {
    fixture();
    const locator = createHeadingLocator(document, winWith(false));
    expect(locator.has("images")).toBe(true);
    expect(locator.navigateTo("images")).toBe(true);
    expect(calls).toHaveLength(1);
  });

  test("标题不存在时返回 false 且不滚动（§12「取消定位」）", () => {
    fixture();
    const locator = createHeadingLocator(document, winWith(false));
    expect(locator.navigateTo("gone")).toBe(false);
    expect(locator.navigateTo("")).toBe(false);
    expect(calls).toHaveLength(0);
  });

  test("元素不支持 scrollIntoView 时同样只返回 false", () => {
    fixture();
    const target = document.getElementById("overview");
    if (!target) {
      throw new Error("fixture missing");
    }
    Object.defineProperty(target, "scrollIntoView", {
      value: undefined,
      configurable: true
    });
    const locator = createHeadingLocator(document, winWith(false));
    expect(locator.has("overview")).toBe(true);
    expect(locator.navigateTo("overview")).toBe(false);
  });

  test("matchMedia 缺失或抛错都按「不减弱」处理", () => {
    expect(prefersReducedMotion(undefined)).toBe(false);
    expect(prefersReducedMotion(winWith("missing"))).toBe(false);
    expect(prefersReducedMotion(winWith(true))).toBe(true);
    expect(
      prefersReducedMotion({
        matchMedia: () => {
          throw new Error("no media queries");
        }
      } as unknown as Window)
    ).toBe(false);
  });

  test("定位只消费渲染产物里的锚点，不生成第二套 slug（ADR-007-02）", () => {
    fixture();
    const locator = createHeadingLocator(document, winWith(false));
    // 中文标题没有被转写成拼音或 hash，导航层也不接受自己拼出来的 id。
    expect(locator.has("overview-x")).toBe(false);
    expect(locator.has("images")).toBe(true);
  });
});

describe("共享定位器", () => {
  test("headingLocator() 复用同一实例", () => {
    expect(headingLocator()).toBe(headingLocator());
  });
});
