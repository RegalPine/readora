/**
 * Chromium 可执行文件探测（M11 · PDF / PNG 的本机渲染器）。
 *
 * 顺序就是承诺（计划锁定口径）：
 * 1. `readora.export.chromePath`：用户显式指定，唯一一条「指哪打哪」的通道。
 *    给了却不存在时**仍然继续走完后面的候选**：一处配错（旧版本残留、换机器）就让
 *    导出不可用，比让本机现有的 Chrome 干活更糟。但「全部落空」时 `configuredMissing`
 *    会告诉调用方：该说的是「你配的那个路径不存在」而不是「本机没有 Chrome」。
 * 2. `CHROME_PATH`：同一目的的通用环境变量（CI 与绿色版安装常见）。
 * 3. 该系统的已知安装位置。
 * 4. `PATH` 扫描：包管理器与自定义前缀。
 *
 * 全部落空返回 `null`，由 ExportService 报 `readora.export.browserNotFound`：
 * HTML 通道不依赖浏览器，用户仍能用它，因此这里不猜「也许在某个没见过的路径」。
 *
 * 只做存在性判断（`existsSync`），不执行、不读内容，探测本身零副作用。
 */

/** 常见环境变量集合：测试传对象即可，不需要真的改 `process.env`。 */
export type Environment = Readonly<Record<string, string | undefined>>;

export interface ChromiumProbe {
  env: Environment;
  existsSync(path: string): boolean;
  /** 默认取 `process.platform`：注入它才能让三种系统的分支都被单测走到。 */
  platform?: string | undefined;
}

/** 非 Windows 上能在 `PATH` 里出现的浏览器命令名。 */
const POSIX_PATH_NAMES = [
  "chrome",
  "google-chrome",
  "google-chrome-stable",
  "chromium",
  "chromium-browser",
  "microsoft-edge",
  "msedge"
] as const;

/** macOS 的三种 bundle：Chrome / Chromium / Edge 都在 `.app/Contents/MacOS/` 下。 */
const MACOS_BUNDLES = [
  ["Google Chrome.app", "Google Chrome"],
  ["Chromium.app", "Chromium"],
  ["Microsoft Edge.app", "Microsoft Edge"]
] as const;

const MACOS_ROOT = "/Applications";

function macCandidates(): string[] {
  return MACOS_BUNDLES.map(
    ([bundle, binary]) => `${MACOS_ROOT}/${bundle}/Contents/MacOS/${binary}`
  );
}

/** Linux：snap 与发行版包管理器的固定落点，其余交给 PATH 扫描。 */
function linuxCandidates(): string[] {
  return ["/snap/bin/chromium", "/usr/bin/chromium-browser"];
}

/** Windows：`Program Files*` 两枚 + `LOCALAPPDATA`，环境变量缺失时退回默认盘位。 */
function windowsCandidates(env: Environment): string[] {
  const relative = ["Google", "Chrome", "Application", "chrome.exe"];
  const roots = [
    env.PROGRAMFILES ?? "C:\\Program Files",
    env["PROGRAMFILES(X86)"] ?? env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
    env.LOCALAPPDATA
  ];
  const paths: string[] = [];
  for (const root of roots) {
    const trimmed = (root ?? "").replace(/[\\/]+$/u, "");
    if (trimmed === "") {
      continue;
    }
    paths.push([trimmed, ...relative].join("\\"));
  }
  return paths;
}

function searchPathEntries(searchPath: string, platform: string): string[] {
  if (searchPath === "") {
    return [];
  }
  const names = platform === "win32" ? ["chrome.exe", "msedge.exe"] : POSIX_PATH_NAMES;
  const delimiter = platform === "win32" ? ";" : ":";
  return searchPath
    .split(delimiter)
    .filter((directory) => directory !== "")
    .flatMap((directory) => {
      const base = directory.replace(/[\\/]+$/u, "");
      const separator = platform === "win32" ? "\\" : "/";
      return names.map((name) => `${base}${separator}${name}`);
    });
}

/**
 * 完整候选序列（已按优先级排好，可单独断言）。
 *
 * 显式指定的路径排在最前；它不存在时 `findChromium` 会走完整个序列再报
 * `configuredMissing`，于是错误消息能说清「你配的那个不存在」而不是
 * 「本机没有 Chrome」。
 */
export function chromiumCandidates(
  configuredPath: string,
  env: Environment,
  platform: string
): string[] {
  const configured = configuredPath.trim();
  const fromEnvironment = (env.CHROME_PATH ?? "").trim();
  const osSpecific =
    platform === "darwin"
      ? macCandidates()
      : platform === "win32"
        ? windowsCandidates(env)
        : linuxCandidates();
  const fromPath = searchPathEntries(
    (env.PATH ?? env.Path ?? env.path ?? "").trim(),
    platform
  );
  const head: string[] = configured === "" ? [] : [configured];
  if (fromEnvironment !== "") {
    head.push(fromEnvironment);
  }
  return [...head, ...osSpecific, ...fromPath];
}

export interface ChromiumLookup {
  readonly exe: string | null;
  /** 配置给了路径但哪儿都没命中：错误消息要说的是那条配置。 */
  readonly configuredMissing: boolean;
}

/**
 * 按顺序取第一个存在的候选。
 *
 * 「存在」在这里只到 `existsSync`：真实宿主里判可执行位要引 `fs.access`，
 * 而 spawn 失败本来就有 stderr 进输出通道，多这一道判断换来的收益是负的。
 */
export function findChromium(configuredPath: string, probe: ChromiumProbe): ChromiumLookup {
  const platform = probe.platform ?? process.platform;
  for (const candidate of chromiumCandidates(configuredPath, probe.env, platform)) {
    if (probe.existsSync(candidate)) {
      return { exe: candidate, configuredMissing: false };
    }
  }
  return { exe: null, configuredMissing: configuredPath.trim() !== "" };
}
