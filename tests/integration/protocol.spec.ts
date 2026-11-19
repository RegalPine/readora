/**
 * 消息协议的端到端往返（ARC-004 §8.7 门控 / §8.3 消息表，IMP-003 §7.1）。
 *
 * 这一目录测的是**两条通道接起来之后**的行为，单测里两边各有一个替身，
 * 拼起来才有的三类失败在这里会被抓到：
 * 1. 时序：ready 之前的快照必须排队而不是丢掉；
 * 2. 回环：View 发 `config.patch`、Host 广播 `config.update`、界面才生效 ——
 *    View 若做乐观生效，配置被拒时界面就停在一个不存在的状态上；
 * 3. 上报：`metrics.report` 的去重键必须既能防重又能漏掉真实的第二次首帧。
 */
import { expect, test, type Page } from "@playwright/test";
import {
  FIXTURE_URL,
  RICH_DOC,
  hostMessage,
  openReader,
  viewMessages
} from "../helpers/reader";

interface PatchMessage {
  payload: { key: string; value: number | boolean | string };
}

interface ExportDataMessage {
  payload: {
    requestId: string;
    format: string;
    documentUri: string;
    version: number;
    bodyHtml: string;
    rootStyleText: string;
    canvasWidthPx: number;
    contentHeightPx: number;
  };
}

interface MetricMessage {
  payload: {
    blockCount: number;
    diagramCount: number;
    mathCount: number;
    charCount: number;
    renderDurationMs: number;
    firstPaintDurationMs: number;
  };
}

/**
 * 开页即挂起投递门控。
 *
 * 门控是**显式造的时序**，不靠「React 挂载 vs page.evaluate 谁先到」赌：
 * 那条赌局赢一次就把用例变成偶发红。
 */
async function openHeld(page: Page): Promise<void> {
  await page.goto(FIXTURE_URL);
  await page.waitForFunction(() => typeof window.__readora === "object");
  await page.evaluate(() => window.__readora.setGate("hold"));
}

test.describe("首帧门控", () => {
  test("门控期间的快照不落进 DOM，放行后首帧照常渲染（不丢帧）", async ({ page }) => {
    await openHeld(page);
    await page.evaluate(() => window.__readora.load({ text: "# Held\n\nQueued body." }));

    // 等一小段再断「还没有」：抢在投递之前读一次 DOM 什么也证明不了。
    await page.waitForTimeout(250);
    await expect(page.locator(".readora-document")).toHaveCount(0);
    // 没文档也不能白屏：占位空态在场（外壳要等第一份快照才有意义）。
    await expect(page.locator(".readora-loading")).toHaveText("Loading document…");

    await page.evaluate(() => window.__readora.setGate("open"));
    await expect(page.locator(".readora-document h1")).toHaveText("Held");
    // 排队的这一份必须被完整投递：正文保留内部版本，状态条只显示阅读字段。
    await expect(page.locator(".readora-document")).toHaveAttribute("data-readora-document-version", "1");
    await expect(page.locator('[data-readora-status="words"]')).toHaveText("3 words");
  });

  test("reader.ready 恰好一条，且是最早发出的 View→Host 消息", async ({ page }) => {
    await openReader(page);

    const ready = await viewMessages(page, "reader.ready");
    // StrictMode 关掉之后仍只有一条：多一条意味着订阅 effect 被挂了两次，
    // 真 Host 会把第二份快照也投一遍。
    expect(ready).toHaveLength(1);

    const all = await page.evaluate(() => window.__readora.messages().map((entry) => entry.type));
    expect(all[0]).toBe("reader.ready");
  });
});

test.describe("config.patch 往返", () => {
  test("弹层改动 → config.patch → Host 广播 → 变量生效（Webview 不做乐观生效）", async ({ page }) => {
    await openReader(page);
    await page.getByRole("button", { name: "Reader settings" }).click();

    const slider = page.locator("#readora-settings-font-size");
    // 边界写死在 input 上：越界值进不到 Host，Schema 是第二道而不是唯一一道。
    await expect(slider).toHaveAttribute("min", "8");
    await expect(slider).toHaveAttribute("max", "32");

    await slider.fill("20");

    await expect.poll(async () => {
      const patches = await viewMessages<PatchMessage>(page, "config.patch");
      return patches.filter((entry) => entry.payload.key === "fontSize").at(-1)?.payload.value;
    }).toBe(20);

    // 生效的判据是广播回来之后：夹具与真 Host 同一口径 —— 先整体过 Schema 再 config.update。
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            getComputedStyle(document.documentElement)
              .getPropertyValue("--readora-font-size")
              .trim()
        )
      )
      .toBe("20px");
    expect(await page.evaluate(() => window.__readora.preferences().fontSize)).toBe(20);
    // 状态条字号字段没这个概念，但正文的 computed 字号必须跟着走。
    await expect
      .poll(() =>
        page.evaluate(() => {
          const heading = document.querySelector(".readora-document h1");
          return heading ? getComputedStyle(heading).fontSize : "";
        })
      )
      .not.toBe("");
  });

  test("Host 拒绝非法补丁时广播的是当前值，界面回到原样", async ({ page }) => {
    await openReader(page);
    const before = await page.evaluate(
      () =>
        getComputedStyle(document.documentElement)
          .getPropertyValue("--readora-line-height")
          .trim()
    );

    // 信封形状合法（`MessageEnvelopeSchema` 是 strictObject，多一个键就会被信封
    // 校验先丢），所以这条真正撞的是 Webview 入站的 payload 复判：行高 99 过不了
    // `ReaderPreferencesSchema`，整条广播作废，界面必须停在原值上，而不是先跳过去
    // 再等人退回来。非法载荷被拒的完整矩阵在 tests/security 的入站校验用例里。
    await page.evaluate(
      (message) => window.__readora.postRaw(message),
      hostMessage("config.update", {
        preferences: {
          theme: "light",
          fontSize: 16,
          // 行高 99 过不了 Schema：这条广播整体作废才是正确行为
          lineHeight: 99,
          contentWidth: 720,
          showOutline: true,
          typography: "newsreader",
          themePreset: "default"
        }
      })
    );

    await page.waitForTimeout(150);
    const after = await page.evaluate(
      () =>
        getComputedStyle(document.documentElement)
          .getPropertyValue("--readora-line-height")
          .trim()
    );
    expect(after).toBe(before);
    // 视图没被非法广播打崩：正文与外壳都还在。
    await expect(page.locator(".readora-document")).toBeVisible();
  });
});

test.describe("metrics.report 上报（F11-014）", () => {
  test("一份快照只报一次，时长同锚点且非负", async ({ page }) => {
    await openReader(page);
    await expect
      .poll(async () => (await viewMessages(page, "metrics.report")).length)
      .toBe(1);

    const [entry] = await viewMessages<MetricMessage>(page, "metrics.report");
    const payload = entry?.payload;
    expect(payload).toBeDefined();
    expect(payload?.blockCount).toBeGreaterThan(0);
    expect(payload?.charCount).toBe(RICH_DOC.length);
    // 两个时长同一个起点（收到快照那一刻），终点相差一帧，因此可减、可比较。
    expect(payload?.renderDurationMs).toBeGreaterThanOrEqual(0);
    expect(payload?.firstPaintDurationMs).toBeGreaterThanOrEqual(payload?.renderDurationMs ?? 0);

    // 同一 (documentUri, version) 再投一次：去重键命中，不该有第二条。
    await page.evaluate((text) => {
      window.__readora.load({ text });
    }, RICH_DOC.slice(0, 40));
    await page.waitForTimeout(200);
    expect(await viewMessages(page, "metrics.report")).toHaveLength(1);
  });

  test("跨文档跳回同一版本也要重报：去重键含文档身份", async ({ page }) => {
    await openReader(page, { text: "# A\n\nAlpha body.", documentUri: "file:///vault/a.md" });
    await expect.poll(async () => (await viewMessages(page, "metrics.report")).length).toBe(1);

    await page.evaluate(() =>
      window.__readora.load({ text: "# B\n\nBravo body.", documentUri: "file:///vault/b.md", version: 1 })
    );
    await expect.poll(async () => (await viewMessages(page, "metrics.report")).length).toBe(2);

    // 回到 A 的同一个 v1：按版本号去重会漏掉这次真实首帧，所以标记必须随换文档清掉。
    await page.evaluate(() =>
      window.__readora.load({ text: "# A\n\nAlpha body.", documentUri: "file:///vault/a.md", version: 1 })
    );
    await expect.poll(async () => (await viewMessages(page, "metrics.report")).length).toBe(3);
    await expect(page.locator(".readora-document h1")).toHaveText("A");
  });
});

test.describe("export 三步式（M11）", () => {
  /** 等一次取帧真正落为 `export.data`。 */
  async function exported(page: Page): Promise<ExportDataMessage[]> {
    await expect
      .poll(async () => (await viewMessages(page, "export.data")).length, { timeout: 10_000 })
      .toBeGreaterThan(0);
    return viewMessages<ExportDataMessage>(page, "export.data");
  }

  test("export.capture 可路由：换来的那一帧带齐 schema 的八个字段", async ({ page }) => {
    await openReader(page, { text: RICH_DOC, version: 4 });
    await page.evaluate(() => window.__readora.exportCapture("req-9", "html"));

    const [frame] = await exported(page);
    const payload = frame?.payload;
    expect(payload?.requestId).toBe("req-9");
    expect(payload?.format).toBe("html");
    expect(payload?.documentUri).toBe("file:///vault/e2e/reader.md");
    // 版本号与正文同源：Host 拿它跟在途会话比对，陈旧帧直接丢。
    expect(payload?.version).toBe(4);
    expect(payload?.bodyHtml).toContain("Reader Guide");
    expect(payload?.rootStyleText).toContain("--readora-font-size");
    expect(payload?.canvasWidthPx).toBeGreaterThan(0);
    expect(payload?.contentHeightPx).toBeGreaterThan(0);
  });

  test("载荷不合契约的 export.capture 被丢：不序列化，也不弄坏界面", async ({ page }) => {
    await openReader(page);

    // 四个非法变体：缺字段、多未知键、requestId 空串（超 Schema 的 1–64 字符），
    // 以及方向错的信封（`export.request` 是 view-to-host，Host 不该能把它投给 View）。
    // 信封本身是 strictObject，所以这里写的都是四键完整的信封 —— 否则测的是信封护栏。
    const rejects: { type: string; payload: unknown }[] = [
      { type: "export.capture", payload: { requestId: "req-a" } },
      { type: "export.capture", payload: { requestId: "req-b", format: "html", extra: true } },
      { type: "export.capture", payload: { requestId: "", format: "html" } },
      { type: "export.request", payload: { format: "html" } }
    ];
    for (const entry of rejects) {
      await page.evaluate(
        (message) => window.__readora.postRaw(message),
        hostMessage(entry.type, entry.payload)
      );
    }

    await page.waitForTimeout(200);
    expect(await viewMessages(page, "export.data")).toHaveLength(0);
    await expect(page.locator(".readora-document")).toBeVisible();
  });

  test("门控期间的 export.capture 只排队不投递，放行后才有序列化", async ({ page }) => {
    await openReader(page);
    await page.evaluate(() => window.__readora.setGate("hold"));
    await page.evaluate(() => window.__readora.exportCapture("req-held", "html"));

    // 抢在放行之前读一次什么也证明不了：等一小段再断「还没有」。
    await page.waitForTimeout(200);
    expect(await viewMessages(page, "export.data")).toHaveLength(0);

    await page.evaluate(() => window.__readora.setGate("open"));
    const frames = await exported(page);
    expect(frames).toHaveLength(1);
    expect(frames[0]?.payload.requestId).toBe("req-held");
  });
});
