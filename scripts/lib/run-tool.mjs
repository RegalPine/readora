/**
 * 外部命令调用的跨平台口径（IMP-001 §2 支持 Windows / macOS / Linux）。
 *
 * 为什么要有这一个文件：macOS 与 Linux 上 `pnpm` / `npm` / `code` 是带 shebang 的
 * 真文件，`spawnSync("pnpm", args)` 直接能跑；Windows 上它们是 `pnpm.cmd` 这类批处理
 * 垫片，而 Node 自 CVE-2024-27980 起**拒绝**不经 shell 启动 `.cmd` / `.bat`，于是
 * `status` 回来是 `null`、`error` 是 `ENOENT`——脚本只会说「退出码 null」，看上去像
 * 依赖图坏了，其实是命令压根没启动。初始版本在 macOS 上开发，这条差异没有任何信号。
 *
 * 用法边界：`process.execPath` 与 `.exe` 绝对路径（Chrome、VS Code 的 exe）不必走这里，
 * 它们本来就能直接 spawn；这里管的是「靠 PATH 找一个可能是垫片的东西」。
 */
import { spawn, spawnSync } from "node:child_process";

/** 调用方需要分平台选写法时（`where` / `which`）用这一条，不要再自己读 `process.platform`。 */
export const IS_WINDOWS = process.platform === "win32";

/** cmd.exe 会把空格与这些元字符当语法解析，参数里出现就必须引号包裹。 */
const WINDOWS_NEEDS_QUOTES = /[\s"^&<>|()%!@{}]/u;

/**
 * Windows 引号规则：cmd.exe 先切词，被引号包裹后交还给目标程序的 MSVCRT argv 解析。
 *
 * 两处不能想当然：内嵌 `"` 要写成 `\"`（否则 cmd 把它当字面量、程序把它当结束引号），
 * 而**结尾的反斜杠串必须加倍**——`"C:\path\"` 里那个 `\"` 会被解析成转义引号，
 * 引号因此关不上，后面半个命令行都会掉进字符串里。带空格的路径在 Windows 上是常态
 * （`C:\Program Files\…`），这两条不处理就是「在我机器上好好的」。
 */
export function quoteWindowsArgument(value) {
  if (!WINDOWS_NEEDS_QUOTES.test(value)) {
    return value;
  }
  const escaped = value
    .replace(/(\\*)"/gu, "$1$1\\\"")
    .replace(/(\\+)$/gu, "$1$1");
  return `"${escaped}"`;
}

/** 拼出 cmd.exe 能正确切词的命令行（仅在 Windows 上用）。 */
export function toWindowsCommandLine(command, args) {
  return [command, ...args].map((part) => quoteWindowsArgument(String(part))).join(" ");
}

/**
 * `spawnSync` 的跨平台替身：Windows 走 `shell: true` 并交出自拼的命令行，
 * POSIX 保持原来的 argv 直调（不多一层 shell，也不引入 `/bin/sh -c` 的语义差异）。
 *
 * 传单个字符串而不是 `[command, ...args]` 给 shell 是刻意的：Node 对「shell + args」
 * 只拼接不转义（DEP0190），转义交给自己做才不会既告警又不安全。
 */
export function runTool(command, args = [], options = {}) {
  if (!IS_WINDOWS) {
    return spawnSync(command, args.map(String), options);
  }
  return spawnSync(toWindowsCommandLine(command, args), { ...options, shell: true });
}

/**
 * `spawn` 的异步版：给「起了进程接着干别的」（等端口、退出时收摊）的调用方。
 *
 * 平台差异同上。
 */
export function spawnTool(command, args = [], options = {}) {
  if (!IS_WINDOWS) {
    return spawn(command, args.map(String), options);
  }
  return spawn(toWindowsCommandLine(command, args), { ...options, shell: true });
}

/**
 * 收掉一个子进程和它的全部子孙。
 *
 * 两边的语义不是一回事：POSIX 上 `detached: true` 起的进程自己是一个进程组组长，
 * `kill(-pid)` 一发覆整棵树；Windows 没有负 pid 这个写法，只认 `taskkill /T`。
 * 照搬 POSIX 那行在 Windows 上会抛 `ERR_INVALID_ARG_VALUE`，于是 dev server 的
 * vite 进程泄漏在后台，下一次跑取证又换一个端口。
 */
export function killToolTree(child) {
  if (child.pid === undefined) {
    return;
  }
  try {
    if (IS_WINDOWS) {
      // taskkill 是 System32 里的真 exe，不必绕 shell；/F 因为等不了优雅退出。
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      return;
    }
    process.kill(-child.pid, "SIGTERM");
  } catch {
    /* 已经自己退了 */
  }
}

/**
 * 把「没启动」「被信号杀掉」「非零退出」三种失败说成不同的话。
 *
 * 三者含义完全不同：前者是环境缺工具，中间那个是超时或 OOM，最后才是命令自己报错。
 * 混成一句「退出码 null」会让人去查错方向。
 */
export function describeToolFailure(result, outputLimit = 400) {
  if (result.error) {
    return `命令未能启动：${result.error.message}`;
  }
  if (result.signal) {
    return `进程被信号 ${result.signal} 终止（超时或被系统干掉，不是命令自己报错）`;
  }
  const output = `${result.stderr ?? ""}${result.stdout ?? ""}`.trim();
  return `退出码 ${result.status}${
    output.length > 0 ? `：${output.slice(0, outputLimit)}` : "（无任何输出）"
  }`;
}
