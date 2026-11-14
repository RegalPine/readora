/**
 * 本机浏览器渲染（M11）。
 *
 * argv 快照是本文件的全部意义：Chrome 的 flag 一旦改名或被「顺手」去掉，
 * 产物会静默变成空白 PDF 或半屏 PNG，而退出码还是 0。因此逐条钉住，
 * 并且钉住「没有 --no-sandbox」这一条否定项 —— 它是安全承诺而不是性能选项。
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { EXPORT_BROWSER_TIMEOUT_MS, EXPORT_PNG_HEIGHT_FACTOR, EXPORT_PNG_MAX_HEIGHT_PX } from "../constants";
import {
  BROWSER_COMMON_ARGS,
  BROWSER_KILL_GRACE_MS,
  STDERR_TAIL_CHARS,
  buildPdfArgs,
  buildPngArgs,
  isPngHeightTruncated,
  pngViewportHeight,
  runBrowser,
  type BrowserChild,
  type BrowserSpawner
} from "../export/browser-runner";

function child(options: {
  code?: number | null;
  stderr?: string;
  /** 永不结束：用来走超时分支。 */
  hang?: boolean;
  /** kill 时回报的退出码（真实进程被 SIGKILL 后为 null）。 */
  killCode?: number | null;
}): BrowserChild & { killed: number } {
  const state = { killed: 0 };
  let resolveExit: (code: number | null) => void = () => undefined;
  const exited = new Promise<number | null>((resolve) => {
    resolveExit = resolve;
  });
  if (!options.hang) {
    resolveExit(options.code === undefined ? 0 : options.code);
  }
  return {
    exited,
    get killed(): number {
      return state.killed;
    },
    kill(): void {
      state.killed += 1;
      if (options.hang) {
        resolveExit(options.killCode === undefined ? null : options.killCode);
      }
    },
    stderrText: () => options.stderr ?? ""
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("buildPdfArgs", () => {
  test("公共 argv + print-to-pdf，URL 永远在末位", () => {
    expect(buildPdfArgs("file:///tmp/a.html", "/tmp/a.pdf")).toEqual([
      ...BROWSER_COMMON_ARGS,
      "--print-to-pdf=/tmp/a.pdf",
      "file:///tmp/a.html"
    ]);
  });

  test("不传页眉页脚 flag：新 headless 默认就没有", () => {
    const args = buildPdfArgs("file:///tmp/a.html", "/tmp/a.pdf");
    expect(args.some((arg) => arg.startsWith("--print-to-pdf-header"))).toBe(false);
    expect(args.some((arg) => arg.includes("header/footer"))).toBe(false);
  });

  test("公共 argv 里绝不含 --no-sandbox", () => {
    const all = [
      ...buildPdfArgs("file:///a.html", "/a.pdf"),
      ...buildPngArgs("file:///a.html", "/a.png", 800, 600)
    ];
    expect(all).not.toContain("--no-sandbox");
  });

  test("必需项成对存在：快进排版与同目录临时件读取都靠它们", () => {
    expect(BROWSER_COMMON_ARGS).toContain("--headless=new");
    expect(BROWSER_COMMON_ARGS).toContain("--virtual-time-budget=15000");
    expect(BROWSER_COMMON_ARGS).toContain("--allow-file-access-from-files");
    expect(BROWSER_COMMON_ARGS).toContain("--disable-gpu");
    expect(BROWSER_COMMON_ARGS).toContain("--no-first-run");
  });
});

describe("buildPngArgs", () => {
  test("截图三件套 + 视口尺寸取自 View 上报的画布宽", () => {
    expect(buildPngArgs("file:///tmp/a.html", "/tmp/a.png", 900, 1_200)).toEqual([
      ...BROWSER_COMMON_ARGS,
      "--screenshot=/tmp/a.png",
      "--hide-scrollbars",
      "--force-device-scale-factor=1",
      "--window-size=900,1200",
      "file:///tmp/a.html"
    ]);
  });

  test("尺寸取整并夹到至少 1 px：0 或负数不能让 Chrome 报参数错", () => {
    const windowSize = (widthPx: number, heightPx: number): string => {
      const args = buildPngArgs("file:///a.html", "/a.png", widthPx, heightPx);
      // 公共 argv 5 项 + screenshot / hide-scrollbars / scale = 第 8 项才是视口。
      return args[8] ?? "";
    };
    expect(windowSize(0, -50)).toBe("--window-size=1,1");
    expect(windowSize(801.6, 1.2)).toBe("--window-size=802,1");
  });
});

describe("pngViewportHeight", () => {
  test("加 8% 余量：字体换版与异步落位都要它兜", () => {
    expect(pngViewportHeight(1_000)).toBe(1_080);
  });

  test("触顶就剪到 16 384 px", () => {
    expect(pngViewportHeight(30_000)).toBe(EXPORT_PNG_MAX_HEIGHT_PX);
  });

  test("高度为 0 时也给 1 px，不写出 window-size=800,0", () => {
    expect(pngViewportHeight(0)).toBe(1);
    expect(pngViewportHeight(-8)).toBe(1);
  });

  test("触顶判据与剪高判据一致（通知里那句话必须说实话）", () => {
    expect(isPngHeightTruncated(1_000)).toBe(false);
    expect(isPngHeightTruncated(15_000)).toBe(false);
    expect(isPngHeightTruncated(16_000)).toBe(true);
    // 加完余量仍不超上限的最大内容高：再涨 1 px 就该在通知里明说“被截”。
    const boundary = Math.floor(EXPORT_PNG_MAX_HEIGHT_PX / EXPORT_PNG_HEIGHT_FACTOR);
    expect(pngViewportHeight(boundary)).toBe(EXPORT_PNG_MAX_HEIGHT_PX);
    expect(isPngHeightTruncated(boundary)).toBe(false);
    expect(isPngHeightTruncated(boundary + 1)).toBe(true);
  });
});

describe("runBrowser", () => {
  test("正常退出：退出码与 stderr 都带回", async () => {
    const spawn: BrowserSpawner = () => child({ code: 0, stderr: "warning: fonts slow\n" });
    const result = await runBrowser("/chrome", ["--headless=new"], 1_000, spawn);
    expect(result).toEqual({
      exitCode: 0,
      timedOut: false,
      stderrTail: "warning: fonts slow\n",
      spawnError: null
    });
  });

  test("非零退出码原样上报，不翻译成 0", async () => {
    const result = await runBrowser("/chrome", [], 1_000, () => child({ code: 21, stderr: "boom" }));
    expect(result.exitCode).toBe(21);
    expect(result.stderrTail).toBe("boom");
  });

  test("stderr 只留尾部：前段排版日志再长也不淹没定位信息", async () => {
    const noisy = `${"x".repeat(STDERR_TAIL_CHARS + 500)}TAIL`;
    const result = await runBrowser("/chrome", [], 1_000, () => child({ code: 1, stderr: noisy }));
    expect(result.stderrTail).toHaveLength(STDERR_TAIL_CHARS);
    expect(result.stderrTail.endsWith("TAIL")).toBe(true);
  });

  test("spawn 起不来：报 spawnError，不假装跑过", async () => {
    const spawn: BrowserSpawner = () => {
      throw new Error("ENOENT");
    };
    const result = await runBrowser("/missing", [], 1_000, spawn);
    expect(result.spawnError).toBe("ENOENT");
    expect(result.exitCode).toBe(null);
    expect(result.timedOut).toBe(false);
  });

  test("超时：kill 子进程并标记 timedOut", async () => {
    vi.useFakeTimers();
    const hung = child({ hang: true, stderr: "still laying out" });
    const spawn: BrowserSpawner = () => hung;
    const pending = runBrowser("/chrome", [], EXPORT_BROWSER_TIMEOUT_MS, spawn);
    await vi.advanceTimersByTimeAsync(EXPORT_BROWSER_TIMEOUT_MS + 1);
    const result = await pending;
    expect(result.timedOut).toBe(true);
    expect(hung.killed).toBe(1);
    expect(result.stderrTail).toBe("still laying out");
  });

  test("kill 后被杀进程自己回报了退出码：记下的码不比真实情况更乐观", async () => {
    vi.useFakeTimers();
    const hung = child({ hang: true, killCode: null });
    const pending = runBrowser("/chrome", [], 100, () => hung);
    await vi.advanceTimersByTimeAsync(101);
    const result = await pending;
    expect(result.exitCode).toBe(null);
    expect(result.timedOut).toBe(true);
  });

  test("kill 之后仍在收尾：宽限期到点就返回 null，不把导出挂死", async () => {
    vi.useFakeTimers();
    const never = child({ hang: true });
    // 让 kill 不做任何事，模拟「进程已经不在了但 close 不再触发」。
    const spawn: BrowserSpawner = () => ({
      exited: never.exited,
      kill: () => undefined,
      stderrText: () => ""
    });
    const pending = runBrowser("/chrome", [], 100, spawn);
    await vi.advanceTimersByTimeAsync(101);
    const settled = vi.advanceTimersByTimeAsync(BROWSER_KILL_GRACE_MS + 1);
    const result = await pending;
    await settled;
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(null);
  });
});
