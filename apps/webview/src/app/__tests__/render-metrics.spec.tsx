/**
 * 渲染指标（PRD-001 F11-014，M6 补设的 `metrics.report`）。
 *
 * 两条线一起测：
 * - 纯函数层：`toMetricsReport` 的时长夹区间、`countRenderedBlocks` 的 DOM 口径；
 * - 装配层：真实 HostBridge + 真实渲染管线跑完后，View 侧确实发出了一条能过
 *   `MetricsReportPayloadSchema` 的消息。只测纯函数的话，有人删掉 `bridge.notify`
 *   那行照样全绿，而 F11-014 要的就是 OutputChannel 里那行日志有来源。
 *
 * **本文件全程用真实计时器，且不与用 fake timers 的用例同文件**：jsdom 的帧循环由
 * 首次 `requestAnimationFrame` 时捕获的定时器驱动，一旦那个回调排在被丢弃的假时钟里，
 * 同一文件后续的真实 rAF 就永远等不到帧（实测在假时钟文件里追加本组用例会整组超时）。
 */
import { afterEach, describe, expect, test } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import {
  DEFAULT_READER_PREFERENCES,
  parsePayload,
  type DocumentLoadPayload
} from "@readora/contracts";
import { createBridgeHarness, type BridgeHarness } from "../../__tests__/bridge-harness";
import { App } from "../App";
import {
  arrivalKey,
  countRenderedBlocks,
  monotonicNow,
  recordArrival,
  toMetricsReport
} from "../render-metrics";

const DOC_URI = "file:///vault/notes/metrics.md";
const TEXT = "# Overview\n\nBody paragraph.\n\n## Details\n\nMore prose.\n";

function payloadFor(overrides: Partial<DocumentLoadPayload> = {}): DocumentLoadPayload {
  return {
    documentUri: DOC_URI,
    languageId: "markdown",
    version: 1,
    text: TEXT,
    preferences: DEFAULT_READER_PREFERENCES,
    ...overrides
  };
}

/** 等浏览器给出下一帧：`reportRender` 的上报就排在这一帧的回调里。 */
function nextFrame(): Promise<void> {
  return new Promise<void>((resolve) => {
    requestAnimationFrame(() => {
      resolve();
    });
  });
}

function reports(host: BridgeHarness): Array<Record<string, unknown>> {
  return host.sent("metrics.report") as Array<Record<string, unknown>>;
}

let host: BridgeHarness | undefined;
let view: ReturnType<typeof render> | undefined;

afterEach(() => {
  view?.unmount();
  view = undefined;
  host?.dispose();
  host = undefined;
  cleanup();
  document.body.replaceChildren();
  document.documentElement.removeAttribute("style");
});

describe("metrics.report 载荷组装（纯函数）", () => {
  test("起点相同的两个时长：负数归零，超上限截断", () => {
    const payload = payloadFor();
    const counts = { blockCount: 0, diagramCount: 0, mathCount: 0 };
    const clamped = toMetricsReport({
      payload,
      receivedAt: 1_000,
      renderedAt: 900,
      paintedAt: 700_000,
      counts
    });
    expect(clamped.renderDurationMs).toBe(0);
    expect(clamped.firstPaintDurationMs).toBe(600_000);
  });

  test("毫秒差四舍五入到整数，字符数取快照文本长度", () => {
    const report = toMetricsReport({
      payload: payloadFor({ text: "12345" }),
      receivedAt: 0,
      renderedAt: 12.4,
      paintedAt: 37.6,
      counts: { blockCount: 2, diagramCount: 0, mathCount: 0 }
    });
    expect(report.renderDurationMs).toBe(12);
    expect(report.firstPaintDurationMs).toBe(38);
    expect(report.charCount).toBe(5);
    expect(parsePayload("metrics.report", report).ok).toBe(true);
  });

  test("到达记账与快照同键：换文档或换版本都会改变键", () => {
    const first = recordArrival(payloadFor(), 10);
    expect(first).toEqual({ key: `${DOC_URI}#1`, at: 10 });
    expect(arrivalKey(payloadFor({ version: 2 }))).not.toBe(first.key);
    expect(arrivalKey(payloadFor({ documentUri: "file:///other.md" }))).not.toBe(first.key);
  });

  test("规模从 DOM 数：降级成源码的公式与图表仍算节点，容器缺失一律 0", () => {
    const container = document.createElement("div");
    container.innerHTML =
      `<div class="readora-document">` +
      `<h1 class="readora-heading">t</h1>` +
      `<p class="readora-paragraph"><span class="readora-math readora-math--inline" data-readora-math-status="ok">x</span></p>` +
      `<pre class="readora-math readora-math--block" data-readora-math-status="error">bad</pre>` +
      `<div class="readora-diagram" data-readora-diagram-state="pending"></div>` +
      `</div>`;
    document.body.append(container);
    expect(countRenderedBlocks(container)).toEqual({
      blockCount: 4,
      diagramCount: 1,
      mathCount: 2
    });
    // 首帧前与卸载后没有正文容器：宁可报 0，也不把上一次的规模当成这一次。
    expect(countRenderedBlocks(null)).toEqual({
      blockCount: 0,
      diagramCount: 0,
      mathCount: 0
    });
  });

  test("单调时钟可用且非递减", () => {
    const a = monotonicNow();
    expect(monotonicNow()).toBeGreaterThanOrEqual(a);
  });
});

describe("渲染完成后上报 metrics.report", () => {
  test("首帧后恰好一条，载荷过 Schema 且规模来自真实产物", async () => {
    host = createBridgeHarness();
    view = render(<App bridge={host.bridge} />);
    act(() => {
      host?.emit("document.load", payloadFor());
    });
    await nextFrame();

    const sent = reports(host);
    expect(sent).toHaveLength(1);
    expect(parsePayload("metrics.report", sent[0]).ok).toBe(true);
    expect(sent[0]).toMatchObject({
      documentUri: DOC_URI,
      version: 1,
      charCount: TEXT.length,
      // 真实渲染产物：2 个标题 + 2 个段落，无图表无公式。
      blockCount: 4,
      diagramCount: 0,
      mathCount: 0
    });
  });

  test("两个时长同起点，首帧不早于 DOM 写入", async () => {
    host = createBridgeHarness();
    view = render(<App bridge={host.bridge} />);
    act(() => {
      host?.emit("document.load", payloadFor());
    });
    await nextFrame();

    const [report] = reports(host);
    const renderedMs = Number(report?.renderDurationMs);
    const paintedMs = Number(report?.firstPaintDurationMs);
    expect(Number.isFinite(renderedMs) && renderedMs >= 0).toBe(true);
    // 取错时刻（例如把绘制时刻当写入时刻）会直接表现为 paint < render。
    expect(paintedMs).toBeGreaterThanOrEqual(renderedMs);
  });

  test("公式与图表按 DOM 节点计入规模", async () => {
    host = createBridgeHarness();
    view = render(<App bridge={host.bridge} />);
    act(() => {
      host?.emit(
        "document.load",
        payloadFor({
          text:
            "# Math\n\n行内 $E = mc^2$ 与块级：\n\n$$\\int_0^1 x\\,dx$$\n\n```mermaid\ngraph TD;A-->B;\n```\n"
        })
      );
    });
    await nextFrame();

    const [report] = reports(host);
    expect(parsePayload("metrics.report", report).ok).toBe(true);
    expect(report?.mathCount).toBe(2);
    expect(report?.diagramCount).toBe(1);
  });

  test("换版本再报一条，被护栏拦下的旧快照不追加", async () => {
    host = createBridgeHarness();
    view = render(<App bridge={host.bridge} />);
    act(() => {
      host?.emit("document.load", payloadFor({ version: 3 }));
    });
    await nextFrame();
    act(() => {
      host?.emit("document.load", payloadFor({ version: 4, text: `${TEXT}\nExtra line.\n` }));
    });
    await nextFrame();
    expect(reports(host).map((report) => report.version)).toEqual([3, 4]);

    // 旧快照既不重绘也不该留下「第 3 版又渲染了一次」的假指标。
    act(() => {
      host?.emit("document.load", payloadFor({ version: 3 }));
    });
    await nextFrame();
    expect(reports(host)).toHaveLength(2);
  });

  test("跨文档跳回同一版本要重新上报：去重键不能只认版本号", async () => {
    host = createBridgeHarness();
    view = render(<App bridge={host.bridge} />);
    act(() => {
      host?.emit("document.load", payloadFor());
    });
    await nextFrame();
    act(() => {
      host?.emit("document.load", payloadFor({ documentUri: "file:///vault/notes/other.md" }));
    });
    await nextFrame();
    act(() => {
      host?.emit("document.load", payloadFor());
    });
    await nextFrame();

    expect(
      reports(host).map((report) => `${report.documentUri}@${report.version}`)
    ).toEqual([`${DOC_URI}@1`, "file:///vault/notes/other.md@1", `${DOC_URI}@1`]);
  });

  test("仅偏好或主题下发不产生新的指标（没有重绘就没有新的一次渲染）", async () => {
    host = createBridgeHarness();
    view = render(<App bridge={host.bridge} />);
    act(() => {
      host?.emit("document.load", payloadFor());
    });
    await nextFrame();
    expect(reports(host)).toHaveLength(1);

    act(() => {
      host?.emit("theme.update", { theme: "dark", source: "product" });
      host?.emit("config.update", {
        preferences: { ...DEFAULT_READER_PREFERENCES, fontSize: 20 }
      });
    });
    await nextFrame();
    expect(reports(host)).toHaveLength(1);
  });
});
