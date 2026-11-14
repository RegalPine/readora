/**
 * 缩放与阅读进度的状态层取证（PRD-003 §10.5、§11.4；ARC-007 §7.5 的「无变化不 setState」）。
 *
 * `readingProgressOf` 与 `clampZoom` 都是纯函数：jsdom 里没有真实布局，
 * `scrollHeight` 恒为 0，滚动只能测到这个粒度，剩下的形态由 e2e 与性能脚本覆盖。
 */
import { afterEach, describe, expect, test } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import {
  PROGRESS_EPSILON,
  formatProgress,
  readingProgressOf,
  useReadingProgress
} from "../use-reading-progress";
import {
  ZOOM_MAX,
  ZOOM_MIN,
  ZOOM_RESET,
  ZOOM_STEP,
  clampZoom,
  formatZoom,
  useZoom,
  zoomBy
} from "../zoom";

afterEach(cleanup);

describe("clampZoom / zoomBy", () => {
  test("区间与步长是 §10.5 写死的 50%–200% / 10%", () => {
    expect([ZOOM_MIN, ZOOM_MAX, ZOOM_STEP, ZOOM_RESET]).toEqual([0.5, 2, 0.1, 1]);
  });

  test("端点夹住不外弹，越界值停在端点上", () => {
    expect(clampZoom(0.2)).toBe(ZOOM_MIN);
    expect(clampZoom(3)).toBe(ZOOM_MAX);
    expect(clampZoom(1)).toBe(1);
    expect(zoomBy(ZOOM_MAX, 1)).toBe(ZOOM_MAX);
    expect(zoomBy(ZOOM_MIN, -1)).toBe(ZOOM_MIN);
  });

  test("浮点漂移被量化吃掉：整段阶梯是精确的 0.5/0.6/…/2.0", () => {
    const ladder: number[] = [];
    let zoom = ZOOM_MIN;
    for (let index = 0; index < 15; index += 1) {
      zoom = zoomBy(zoom, 1);
      ladder.push(zoom);
    }
    expect(ladder).toEqual([0.6, 0.7, 0.8, 0.9, 1, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 2]);
    // 原路退回：`1.2 - 0.1` 这类减法同样不许留小数尾巴。
    let back = zoom;
    for (let index = 0; index < 5; index += 1) {
      back = zoomBy(back, -1);
    }
    expect(back).toBe(1.5);
    expect(formatZoom(1)).toBe("100%");
  });

  test("非有限值退回 100%，不产出 NaN%", () => {
    expect(clampZoom(Number.NaN)).toBe(ZOOM_RESET);
    expect(clampZoom(Number.POSITIVE_INFINITY)).toBe(ZOOM_RESET);
    expect(formatZoom(1.075)).toBe("108%");
  });
});

/** 把 hook 的结果挂到闭包上，用探针组件代替 renderHook（沿用本仓既有写法）。 */
function probeZoom(enabled: boolean) {
  let latest = { zoom: 0, display: "" };
  function Probe(): null {
    const api = useZoom(enabled);
    latest = { zoom: api.zoom, display: api.display };
    return null;
  }
  render(<Probe />);
  return () => latest;
}

function press(key: string, init: { metaKey?: boolean; ctrlKey?: boolean } = {}): void {
  act(() => {
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init })
    );
  });
}

describe("useZoom", () => {
  test("初始 100%，Alt 组合不接管（那是宿主的键位）", () => {
    const read = probeZoom(true);
    expect(read()).toEqual({ zoom: 1, display: "100%" });
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "=", metaKey: true, altKey: true, bubbles: true, cancelable: true })
      );
    });
    expect(read().zoom).toBe(1);
  });

  test("`=` 与 `+` 同义，`-` 与 `_` 同义，`0` 复位；meta 与 ctrl 都算", () => {
    const read = probeZoom(true);
    press("=", { metaKey: true });
    expect(read().zoom).toBe(1.1);
    press("+", { ctrlKey: true });
    expect(read().zoom).toBeCloseTo(1.2, 10);
    press("-", { metaKey: true });
    expect(read().zoom).toBeCloseTo(1.1, 10);
    press("_", { metaKey: true });
    expect(read().zoom).toBe(1);
    press("=", { metaKey: true });
    press("0", { ctrlKey: true });
    expect(read()).toEqual({ zoom: 1, display: "100%" });
  });

  test("画面没文档时不接管按键，也不 preventDefault", () => {
    const read = probeZoom(false);
    const event = new KeyboardEvent("keydown", { key: "=", metaKey: true, bubbles: true, cancelable: true });
    act(() => {
      document.dispatchEvent(event);
    });
    expect(read().zoom).toBe(1);
    expect(event.defaultPrevented).toBe(false);
  });

  test("宿主已处理的事件不抢（defaultPrevented 直接放行）", () => {
    const read = probeZoom(true);
    const event = new KeyboardEvent("keydown", { key: "0", metaKey: true, bubbles: true, cancelable: true });
    event.preventDefault();
    act(() => {
      document.dispatchEvent(event);
    });
    expect(read().zoom).toBe(1);
  });
});

describe("readingProgressOf", () => {
  test("线性推进：到底 100%，中间按比例", () => {
    expect(readingProgressOf(0, 2_000, 800)).toBe(0);
    expect(readingProgressOf(600, 2_000, 800)).toBeCloseTo(0.5, 10);
    expect(readingProgressOf(1_200, 2_000, 800)).toBe(1);
  });

  test("文档不足一屏时是 0 而不是 100%：「放得下」不等于「读完了」", () => {
    expect(readingProgressOf(0, 600, 800)).toBe(0);
    expect(readingProgressOf(0, 800, 800)).toBe(0);
  });

  test("越界与异常输入夹回 [0,1]", () => {
    expect(readingProgressOf(5_000, 2_000, 800)).toBe(1);
    expect(readingProgressOf(-100, 2_000, 800)).toBe(0);
    expect(readingProgressOf(Number.NaN, 2_000, 800)).toBe(0);
  });

  test("百分比文案取整，100% 只在真到底时出现", () => {
    expect(formatProgress(0.4234)).toBe("42%");
    expect(formatProgress(0.999)).toBe("100%");
    expect(formatProgress(0.98)).toBe("98%");
    expect(PROGRESS_EPSILON).toBe(0.001);
  });
});

/**
 * 监听器与帧句柄都记在普通数组里：断言要能说出「挂在哪、用什么选项挂的、
 * 取消的是哪一帧」，而不是从 mock.calls 里按位置猜。
 */
interface RecordedListener {
  readonly type: string;
  readonly handler: () => void;
  readonly init?: unknown;
}

interface ProgressProbe {
  readonly read: () => number;
  readonly added: RecordedListener[];
  readonly removedTypes: string[];
  readonly cancelledHandles: number[];
  readonly fire: (type: string) => void;
}

describe("useReadingProgress", () => {
  function progressProbe(options: {
    scrollY: number;
    scrollHeight: number;
    innerHeight: number;
    revision?: number;
    raf?: (callback: () => void) => number;
  }): ProgressProbe {
    let latest = -1;
    const doc = {
      scrollingElement: { scrollHeight: options.scrollHeight },
      documentElement: { scrollHeight: options.scrollHeight }
    } as unknown as Document;
    const added: RecordedListener[] = [];
    const removedTypes: string[] = [];
    const cancelledHandles: number[] = [];
    const win = {
      scrollY: options.scrollY,
      innerHeight: options.innerHeight,
      addEventListener: (type: string, handler: () => void, init?: unknown): void => {
        added.push({ type, handler, init });
      },
      removeEventListener: (type: string): void => {
        removedTypes.push(type);
      },
      requestAnimationFrame: (callback: () => void): number => {
        callback();
        return 1;
      },
      cancelAnimationFrame: (handle: number): void => {
        cancelledHandles.push(handle);
      }
    } as unknown as Window;

    function Probe(): null {
      // 不传 raf 时让钩子走 win.requestAnimationFrame：两种节流路径都要有人走。
      const { progress } = useReadingProgress(
        "architecture",
        options.revision ?? 1,
        options.raf ? { doc, win, raf: options.raf } : { doc, win }
      );
      latest = progress;
      return null;
    }
    render(<Probe />);
    return {
      read: () => latest,
      added,
      removedTypes,
      cancelledHandles,
      fire: (type: string): void => {
        for (const entry of added.filter((item) => item.type === type)) {
          entry.handler();
        }
      }
    };
  }

  test("挂载即测一次，滚动与 resize 都挂监听", () => {
    const probe = progressProbe({ scrollY: 600, scrollHeight: 2_000, innerHeight: 800 });
    expect(probe.read()).toBeCloseTo(0.5, 10);
    expect(probe.added.map((entry) => entry.type)).toEqual(["scroll", "resize"]);
    // 滚动监听必须是 passive：进度条不该有资格阻塞滚动合成。
    expect(probe.added[0]?.init).toEqual({ passive: true });
  });

  test("一帧内多次事件只测一次（rAF 节流）", () => {
    const queued: Array<() => void> = [];
    let scheduled = 0;
    const probe = progressProbe({
      scrollY: 0,
      scrollHeight: 2_000,
      innerHeight: 800,
      raf: (): number => {
        scheduled += 1;
        queued.push(() => undefined);
        return queued.length;
      }
    });
    expect(probe.read()).toBe(0);
    expect(scheduled).toBe(1);
    act(() => {
      probe.fire("scroll");
      probe.fire("scroll");
      probe.fire("scroll");
    });
    // 三次事件只排一帧：后续的被 frame 句柄挡住。
    expect(scheduled).toBe(1);
  });

  test("监听在卸载时摘掉，未跑的那帧取消掉", () => {
    const probe = progressProbe({
      scrollY: 0,
      scrollHeight: 2_000,
      innerHeight: 800,
      // 不执行回调，句柄就还挂在 frame 上：卸载必须把它取消掉。
      raf: () => 7
    });
    cleanup();
    expect(probe.removedTypes).toEqual(["scroll", "resize"]);
    expect(probe.cancelledHandles).toEqual([7]);
  });

  test("版本推进（revision）触发重测，换文档不留旧进度", () => {
    const probe = progressProbe({ scrollY: 600, scrollHeight: 2_000, innerHeight: 800, revision: 1 });
    expect(probe.read()).toBeCloseTo(0.5, 10);
    const next = progressProbe({
      scrollY: 0,
      scrollHeight: 2_000,
      innerHeight: 800,
      revision: 2
    });
    expect(next.read()).toBe(0);
  });
});
