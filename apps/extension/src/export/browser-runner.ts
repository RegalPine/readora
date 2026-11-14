/**
 * 本机浏览器渲染（M11 · PDF / PNG）。
 *
 * 走 Chrome 的 headless CLI 而不是 puppeteer / playwright：后者明确落在「不可照搬」
 * 清单里（与 VSIX 离线分发、包体预算、`connect-src 'none'` 三重冲突），而本机 Chrome
 * 已经具备同一能力的零依赖子集。代价是版本差异要自己认：`--headless=new` 需要 109+，
 * 因此公共 argv 只放与版本无关的稳定项，任何异常都有 stderr 尾部进输出通道。
 *
 * **不加 `--no-sandbox`**：导出的是用户自己的文档，没有理由为了省事关掉沙箱；
 * snap 版 Chrome 因此可能失败，那条路径的报错由 stderr 承载，不做静默重试。
 * `--allow-file-access-from-files` 是必需的：临时 HTML 与它引用的资源同目录，
 * 新 headless 默认按跨源处理，缺这个 flag 会得到一份空白 PDF。
 */
import { EXPORT_PNG_HEIGHT_FACTOR, EXPORT_PNG_MAX_HEIGHT_PX } from "../constants";

/** 快进排版与字体加载的时间预算：异步图片落位也要它算完（Risk 5）。 */
export const BROWSER_VIRTUAL_TIME_BUDGET_MS = 15_000;

/** 公共 argv：两种格式共用，顺序固定，便于逐条断言。 */
export const BROWSER_COMMON_ARGS = [
  "--headless=new",
  "--disable-gpu",
  "--no-first-run",
  `--virtual-time-budget=${BROWSER_VIRTUAL_TIME_BUDGET_MS}`,
  "--allow-file-access-from-files"
] as const;

/** stderr 只保留尾部：一次失败的排版日志前段全是无用信息，能定位问题的在末尾。 */
export const STDERR_TAIL_CHARS = 2_000;

/** kill 之后给它自己收尾的时间；超了就当它已经没了。 */
export const BROWSER_KILL_GRACE_MS = 2_000;

/**
 * 端口最小面：起一个子进程，把 stderr 解码成文本，给出退出码与 kill。
 *
 * 真机实现在 `vscode-ports.ts`（不进覆盖率分母）：那里只做 `child_process.spawn`
 * 的转译。超时与 kill 的判断留在本模块 —— 那是行为，不是转译。
 */
export interface BrowserChild {
  readonly exited: Promise<number | null>;
  kill(): void;
  /** 已累积的 stderr 文本（本模块负责截尾）。 */
  stderrText(): string;
}

export type BrowserSpawner = (exe: string, args: readonly string[]) => BrowserChild;

export interface BrowserRunResult {
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly stderrTail: string;
  /** spawn 本身失败（可执行文件不可用、权限不足）。 */
  readonly spawnError: string | null;
}

/** 临时件与输出路径都以 `file:` URI 交给 Chrome，位置参数永远是最后一个。 */
function commonArgs(outFlag: string): string[] {
  return [...BROWSER_COMMON_ARGS, outFlag];
}

export function buildPdfArgs(htmlFileUri: string, outPath: string): string[] {
  return [...commonArgs(`--print-to-pdf=${outPath}`), htmlFileUri];
}

/**
 * 截图宽度用 View 上报的画布宽（`.readora-canvas` 的 `offsetWidth`），
 * 不用 `contentWidth`：两者不一致时按 contentWidth 出图会带出一条留白带。
 */
export function buildPngArgs(
  htmlFileUri: string,
  outPath: string,
  widthPx: number,
  heightPx: number
): string[] {
  const width = Math.max(1, Math.round(widthPx));
  const height = Math.max(1, Math.round(heightPx));
  return [
    ...commonArgs(`--screenshot=${outPath}`),
    "--hide-scrollbars",
    "--force-device-scale-factor=1",
    `--window-size=${width.toString()},${height.toString()}`,
    htmlFileUri
  ];
}

/** 未触顶时的截图高：量到的内容高度加一点余量（字体换版、异步落位都要它兜）。 */
export function pngViewportHeight(contentHeightPx: number): number {
  const withMargin = Math.ceil(Math.max(0, contentHeightPx) * EXPORT_PNG_HEIGHT_FACTOR);
  return Math.max(1, Math.min(withMargin, EXPORT_PNG_MAX_HEIGHT_PX));
}

/** 是否被上限剪过：服务要用它在通知里明说「文档过长，PNG 已截到 16384 px」。 */
export function isPngHeightTruncated(contentHeightPx: number): boolean {
  return Math.ceil(Math.max(0, contentHeightPx) * EXPORT_PNG_HEIGHT_FACTOR) > EXPORT_PNG_MAX_HEIGHT_PX;
}

function tail(text: string): string {
  return text.length <= STDERR_TAIL_CHARS ? text : text.slice(-STDERR_TAIL_CHARS);
}

/** 带让路超时的等待：kill 之后子进程若不再回报，也不能把导出挂在这里。 */
async function settleExited(
  exited: Promise<number | null>,
  graceMs: number
): Promise<number | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const grace = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), graceMs);
  });
  try {
    return await Promise.race([exited, grace]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 跑一次 headless 渲染。
 *
 * 三条出口的分工：超时（kill 并标记 `timedOut`）、spawn 起不来（`spawnError`）、
 * 非零退出码（`exitCode` + stderr 尾部）。调用方一律要拿到 stderr 尾部，
 * 因为「本机 Chrome 版本不支持 --headless=new」这类问题只有它说得清。
 */
export async function runBrowser(
  exe: string,
  args: readonly string[],
  timeoutMs: number,
  spawn: BrowserSpawner
): Promise<BrowserRunResult> {
  let child: BrowserChild;
  try {
    child = spawn(exe, args);
  } catch (error) {
    return {
      exitCode: null,
      timedOut: false,
      stderrTail: "",
      spawnError: error instanceof Error ? error.message : String(error)
    };
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  const settled = await Promise.race([
    child.exited.then((code) => ({ code, kind: "exit" as const })),
    timeout.then(() => ({ code: null, kind: "timeout" as const }))
  ]);
  clearTimeout(timer);
  if (settled.kind === "timeout") {
    child.kill();
    // kill 之后仍取一次退出码：端口里的进程可能刚好自己结束了，
    // 记下的 exitCode 因此不会比真实情况更乐观。
    const code = await settleExited(child.exited, BROWSER_KILL_GRACE_MS);
    return {
      exitCode: code,
      timedOut: true,
      stderrTail: tail(child.stderrText()),
      spawnError: null
    };
  }
  return {
    exitCode: settled.code,
    timedOut: false,
    stderrTail: tail(child.stderrText()),
    spawnError: null
  };
}
