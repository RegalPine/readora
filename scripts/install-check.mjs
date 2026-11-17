#!/usr/bin/env node
/**
 * 安装验证与平台验证取证（IMP-003 §7.4 前四条，STORY-12-02）。
 *
 * 做三件事，都是**真实宿主**上的动作，不是模拟：
 * 1. `code --install-extension apps/extension/readora-<version>.vsix --force`；
 * 2. `code --list-extensions --show-versions` 里必须出现 `readora-dev.readora@<version>`，
 *    版本号与 manifest 完全一致才算「VSIX 可以正常安装」——装上了但装成旧版本，
 *    在这一步就会露出来（这也是 `pickCurrentVsix` 同一条决心的另一侧）；
 * 3. 把环境与结果写进 `reports/platform-verification.md`，Windows / Linux 没有环境，
 *    就照 §7.4 的口径如实记为未覆盖，同时列出必须人工目视的项。
 *
 * 退出码：装不上或版本不符 → 1；本机没有 VS Code CLI → 打 `SKIPPED` 并退 0，
 * 与 `pnpm visual:check`、`pnpm perf` 同一条口径（这一步依赖本机宿主，不进默认门禁链）。
 * 没有 CLI 时报告仍然会写，但结论列全部是「未执行」，不写成「通过」。
 *
 * 可用 `READORA_CODE_CLI` 指定 CLI 路径（`code` / `code-insiders` / `codium` 之外的
 * 自定义安装位置就走这里）。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { arch, platform, release } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { IS_WINDOWS, runTool } from "./lib/run-tool.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXTENSION_DIR = join(ROOT, "apps/extension");
const REPORT = join(ROOT, "reports/platform-verification.md");

/**
 * 本机在 §7.4 三平台里的身份。
 *
 * 这一段以前写死成「本机即 macOS」：脚本在 macOS 上写成，而它要回答的恰恰是
 * 「三个平台各自过没过」。拿到 Windows 上跑就会生成一份把 Windows 记为未覆盖、
 * 同时把本机叫作 macOS 的假结论 —— 验证工具自己先得不说胡话。
 */
const PLATFORM_NAMES = ["macOS", "Windows", "Linux"];
const HOST_PLATFORM =
  { darwin: "macOS", win32: "Windows", linux: "Linux" }[platform()] ?? platform();

/**
 * 依次探测的候选命令；`READORA_CODE_CLI` 优先，自定义安装位置不必改脚本。
 *
 * macOS 的 `code` 常常不在 PATH 里（没执行过 "Install 'code' command in PATH"），
 * 但 app 自带的 CLI 一直在那条固定路径上 —— 本机实测就是这种环境：只写命令名会
 * 让这一步在明明有 VS Code 的机器上输出「未执行」。Windows 的用户级安装同理可能
 * 不在 PATH（zip 包、装完没重开终端），标准位置是 `%LOCALAPPDATA%\Programs\…\bin`。
 * Linux 没有一个可信的固定路径（deb/rpm/snap/flatpak 各不相同），只靠 PATH 与
 * `READORA_CODE_CLI`；宁缺不猜。
 *
 * 绝对路径只在文件存在时才纳入，所以不会多探测一个不存在的命令。
 */
function bundledCliPaths() {
  const candidates =
    platform() === "darwin"
      ? [
          "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
          "/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code",
          "/Applications/VSCodium.app/Contents/Resources/app/bin/codium"
        ]
      : platform() === "win32" && process.env.LOCALAPPDATA
        ? [
            join(process.env.LOCALAPPDATA, "Programs", "Microsoft VS Code", "bin", "code.cmd"),
            join(
              process.env.LOCALAPPDATA,
              "Programs",
              "Microsoft VS Code Insiders",
              "bin",
              "code-insiders.cmd"
            ),
            join(process.env.LOCALAPPDATA, "Programs", "VSCodium", "bin", "codium.cmd")
          ]
        : [];
  return candidates.filter((entry) => existsSync(entry));
}

const CLI_CANDIDATES = [
  process.env.READORA_CODE_CLI,
  ...bundledCliPaths(),
  "code",
  "code-insiders",
  "codium"
].filter((entry) => typeof entry === "string" && entry.length > 0);

const manifest = JSON.parse(readFileSync(join(EXTENSION_DIR, "package.json"), "utf-8"));
const vsixName = `${manifest.name}-${manifest.version}.vsix`;
const vsixPath = join(EXTENSION_DIR, vsixName);
const extensionId = `${manifest.publisher}.${manifest.name}`;

function run(command, args) {
  const result = runTool(command, args, { encoding: "utf-8", maxBuffer: 16 * 1024 * 1024 });
  return {
    command: [command, ...args].join(" "),
    status: result.status,
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
    error: result.error ? String(result.error.message ?? result.error) : null
  };
}

/**
 * 报告里的命令去掉仓库根与开发者家目录前缀：公开发布不应带上本机绝对路径。
 *
 * 两种分隔符都要去：Windows 上 `ROOT` 是反斜杠形，而 `code --install-extension`
 * 的命令里跟着的就是这个形状；只拆 `${ROOT}/` 会把开发现场地址留在报告里。
 * 家目录也要去：候选 CLI 本身就是 `%LOCALAPPDATA%\...`，不去会把用户名写进公开报告。
 */
const HOME_DIR = process.env.HOME ?? process.env.USERPROFILE ?? "";
function redact(text) {
  return [`${ROOT}/`, `${ROOT}\\`, ROOT, `${HOME_DIR}/`, `${HOME_DIR}\\`, HOME_DIR]
    .filter((needle) => needle.length > 0)
    .reduce((value, needle) => value.split(needle).join(""), String(text));
}

/**
 * 把命令名解析成磁盘上的真实路径；解不出就返 null。
 *
 * Windows 用 `where`、POSIX 用 `which`：两边的输出都是「每行一个候选」，取第一行。
 * 这一步不是好奇：PATH 上的 `code` 到底属于哪个产品，只能从它的安装目录读。VS Code
 * 兼容 IDE（Qoder、Cursor 一类）也会往 PATH 里放一个叫 `code` 的入口，光看命令名看不出来。
 */
function resolveCommandPath(command) {
  if (command.includes("/") || command.includes("\\")) {
    return resolve(command);
  }
  const probe = runTool(IS_WINDOWS ? "where" : "which", [command], { encoding: "utf-8" });
  if (probe.status !== 0) {
    return null;
  }
  const first = (probe.stdout ?? "").split("\n")[0]?.trim() ?? "";
  return first.length > 0 ? first : null;
}

/**
 * CLI 所属的产品名（`nameLong`）；认不出返 null。
 *
 * VS Code 家族把 `product.json` 放在安装根的 `resources/app/` 下，但「安装根」与 CLI
 * 隔几层三个平台不一样：Windows 是 `<根>\bin\code.cmd` 再加一层**以 commit 命名**的目录
 * （`<根>\dcd3ad6e36\resources\app\product.json`）；Linux 是 `/usr/share/code/…` 直接一层；
 * macOS 的 app 布局里 CLI 自己就在 `Resources/app/bin`，与 product.json 只隔一层。
 * 所以逐层往上走，每层试三种位置，而不是把哪个平台的路径写死。
 */
function productFileFor(directory) {
  const underApp = join(directory, "resources", "app", "product.json");
  if (existsSync(underApp)) {
    return underApp;
  }
  // Windows：安装根下那一层 commit 目录。只扫直接子项，不递归。
  for (const child of readdirSync(directory, { withFileTypes: true })) {
    if (!child.isDirectory()) {
      continue;
    }
    const nested = join(directory, child.name, "resources", "app", "product.json");
    if (existsSync(nested)) {
      return nested;
    }
  }
  // 只认 `…/resources/app` 这一层的同目录 product.json：不限定层名会让任意一个
  // 带 product.json 的开发者目录被当成安装根，把真的 VS Code 拦在门外。
  if (basename(directory) === "app" && basename(dirname(directory)) === "resources") {
    const beside = join(directory, "product.json");
    if (existsSync(beside)) {
      return beside;
    }
  }
  return null;
}

function productOfCli(command) {
  const resolved = resolveCommandPath(command);
  if (resolved === null) {
    return null;
  }
  let directory = dirname(resolved);
  for (let depth = 0; depth < 5; depth += 1) {
    const productFile = productFileFor(directory);
    if (productFile !== null) {
      try {
        const product = JSON.parse(readFileSync(productFile, "utf-8"));
        return typeof product.nameLong === "string" ? product.nameLong : null;
      } catch {
        return null;
      }
    }
    const parent = dirname(directory);
    if (parent === directory) {
      break;
    }
    directory = parent;
  }
  return null;
}

/** VS Code 家族的名字都带这些字串；其余产品（哪怕也提供一个 `code`）不算。 */
const VSCODE_FAMILY = /visual studio code|vs\.? code|vscodium|code ?- ?oss/iu;

/**
 * 探 CLI：能跑 `--version` 且**确实是 VS Code 家族**才算。
 *
 * 只查退出码会拿到假的：本机的 PATH 上 `code` 先命中另一个 IDE 的同名 CLI，
 * 它也能回一个版本号，于是「VS Code 版本」一栏会填上一个不相干产品的数字，
 * §7.4 的平台证据就失真了。认不出产品名的候选不拦（只是标不上名字），
 * 明确是别家的则往下找下一个候选。
 */
function detectCli() {
  for (const candidate of CLI_CANDIDATES) {
    const probe = run(candidate, ["--version"]);
    if (probe.status !== 0 || probe.stdout.length === 0) {
      continue;
    }
    const product = productOfCli(candidate);
    if (product !== null && !VSCODE_FAMILY.test(product)) {
      continue;
    }
    return { command: candidate, product, versionOutput: probe.stdout.split("\n") };
  }
  return null;
}

const environment = {
  os: `${HOST_PLATFORM}（${platform()} ${arch()}）`,
  kernel: release(),
  node: process.version,
  vscode: "未执行（本机没有 VS Code CLI）",
  vscodeCommit: "—",
  vscodeProduct: "—",
  cli: "—"
};

/** 第 3 节的平台表：只有本机那一行可能有实测结论，其余两行只能算未覆盖。 */
function platformTable(skipped) {
  return PLATFORM_NAMES.map((name) => {
    if (name !== HOST_PLATFORM) {
      return `| ${name} | **未覆盖** | 不是本机平台；本批不引入 CI，登记为人工待办 |`;
    }
    return `| ${name}（本机，${arch()}） | ${skipped ? "**未执行**" : "通过"} | ${
      skipped ? "本机缺 VS Code CLI" : `本机即 ${name}，见第 2 节实测结论`
    } |`;
  }).join("\n");
}

/** 第 5 节里三平台准入条的三行，口径与 `platformTable` 一致。 */
function platformGateRows(skipped) {
  return PLATFORM_NAMES.map((name) =>
    name === HOST_PLATFORM
      ? `| ${name} 验证通过 | 第 3 节 | ${skipped ? "未闭合（缺 CLI）" : "通过"} |`
      : `| ${name} 验证通过 | 第 3 节 | 未闭合（非本机） |`
  ).join("\n");
}

const ranAt = new Date().toISOString();
let outcome = { skipped: true, installed: null, listed: null, checks: [] };

const cli = detectCli();
/**
 * `--probe`：只回答「你会用哪个 CLI、把它认成什么产品」，不装东西也不写报告。
 * 这一步本身有副作用（真的会往本机编辑器装扩展），改探测逻辑时需要一条无副作用的路。
 */
if (process.argv.includes("--probe")) {
  process.stdout.write(
    cli
      ? `[install-check] CLI：${redact(cli.command)}\n             产品：${cli.product ?? "未识别"}\n             版本：${cli.versionOutput.join(" | ")}\n`
      : "[install-check] 没有可用的 VS Code 家族 CLI\n"
  );
  process.exit(cli ? 0 : 1);
}
if (!cli) {
  process.stdout.write(
    "Readora install-check: SKIPPED（找不到 VS Code CLI；装一次 code 或用 READORA_CODE_CLI 指向它）\n" +
      "        报告仍会写出，结论列为「未执行」。\n"
  );
} else if (!existsSync(vsixPath)) {
  process.stderr.write(`Readora install-check: 缺少产物 ${vsixName}；先跑 pnpm package。\n`);
  process.exit(1);
} else {
  environment.cli = redact(cli.command);
  environment.vscodeProduct = cli.product ?? "未识别（按 VS Code 兼容 CLI 处理）";
  environment.vscode = cli.versionOutput[0];
  // `code --version` 的第二行是 commit，第三行是架构：STORY-12-02 要的就是
  // 「VS Code 版本」这一条证据，commit 让另一个人能复现到同一次构建。
  environment.vscodeCommit = cli.versionOutput[1] ?? "—";

  const install = run(cli.command, ["--install-extension", vsixPath, "--force"]);
  const list = run(cli.command, ["--list-extensions", "--show-versions"]);
  const installedLine = list.stdout
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.toLowerCase() === extensionId.toLowerCase() ||
      line.toLowerCase().startsWith(`${extensionId.toLowerCase()}@`));

  const checks = [
    {
      item: "VSIX 安装命令退出码为 0（§7.4「VSIX 可以正常安装」）",
      pass: install.status === 0,
      evidence: install.status === 0 ? install.stdout || "(无输出)" : `${install.stderr || install.stdout}`
    },
    {
      item: `扩展出现在已安装列表里（${extensionId}）`,
      pass: Boolean(installedLine),
      evidence:
        installedLine ??
        (list.stdout.split("\n").slice(0, 5).join(", ") || "(列表为空)")
    },
    {
      item: `已安装版本号与 manifest 完全一致（期望 ${manifest.version}）`,
      pass: installedLine === `${extensionId}@${manifest.version}`,
      evidence: installedLine ?? "未列出版本"
    },
    {
      item: "安装过程没有报出错误文本（退出码 0 但 stderr 有内容同样算异常）",
      pass: install.status === 0 && install.stderr.length === 0,
      evidence: install.stderr.length > 0 ? install.stderr.slice(0, 300) : "stderr 为空"
    }
  ];

  outcome = { skipped: false, installed: install, listed: list, checks };

  const failed = checks.filter((check) => !check.pass);
  process.stdout.write(
    checks
      .map((check) => `[install-check] ${check.pass ? "OK  " : "FAIL"} ${check.item}`)
      .join("\n") + `\n`
  );
  if (failed.length > 0) {
    process.stderr.write(
      failed.map((check) => `[install-check] FAIL ${check.item}\n             ${check.evidence}`).join("\n") + "\n"
    );
  }
}

// 公开仓库不分发 reports/ 目录（见 README 的开源整理说明），首次 clone 后直接跑
// 本命令会在 writeFileSync 处 ENOENT；和 perf-report.mjs 一样先建目录再写。
mkdirSync(dirname(REPORT), { recursive: true });
writeFileSync(REPORT, renderReport(outcome, environment, ranAt), "utf-8");
process.stdout.write(`报告：${REPORT.replace(`${ROOT}/`, "")}\n`);
process.exit(outcome.skipped ? 0 : outcome.checks.every((check) => check.pass) ? 0 : 1);

// ---------------------------------------------------------------- 报告

function renderReport(outcome, environment, stamp) {
  const rows = outcome.checks.length > 0
    ? outcome.checks.map(
        (check) =>
          `| ${check.item} | ${check.pass ? "通过" : "**未通过**"} | ${cell(check.evidence)} |`
      )
    : ["| 安装命令 | 未执行 | 本机没有 VS Code CLI |",
       "| 版本一致性 | 未执行 | 本机没有 VS Code CLI |",
       "| 列表可见性 | 未执行 | 本机没有 VS Code CLI |"];

  return `# Readora 平台验证报告（M6 / V0.6.0）

> 由 \`node scripts/install-check.mjs\` 生成。这一步依赖本机 VS Code CLI，
> 不进默认门禁链；CLI 缺失时脚本退 0 并把结论写成「未执行」，不写成「通过」。

## 1. 环境

| 项 | 值 |
| --- | --- |
| 操作系统 | ${environment.os}（${environment.kernel}） |
| Node.js | ${environment.node} |
| VS Code CLI | ${environment.cli} |
| CLI 所属产品 | ${environment.vscodeProduct} |
| VS Code 版本 | ${environment.vscode} |
| 构建 commit | ${environment.vscodeCommit} |
| 被验证产物 | \`apps/extension/${vsixName}\` |
| 执行时刻 | ${stamp} |

## 2. 安装结果

| 判据 | 结论 | 取证 |
| --- | --- | --- |
${rows.join("\n")}

${
  outcome.skipped
    ? "本次**未执行**：没有本机 VS Code CLI。补齐后重跑 `pnpm install:check`，" +
      "本报告会自动换成实测结论。"
    : `实测命令：\`${redact(outcome.installed.command)}\`（退出码 ${outcome.installed.status}）；` +
      `随后 \`${redact(outcome.listed.command)}\`。`
}

安装后的「激活」不是这一步能证明的：CLI 只能证明包被登记进扩展目录，
真正的 \`readora.openReader\` 起得来、Webview 出得来，属下面第 4 节的人工目视项。

## 3. 平台覆盖（IMP-003 §7.4 前三条 / STORY-12-02）

| 平台 | 状态 | 说明 |
| --- | --- | --- |
${platformTable(outcome.skipped)}

docs 的 §7.4 要求三平台都过，本机只能闭合 ${HOST_PLATFORM} 一条（连同「VS Code 版本」证据），
其余平台明确记为**未闭合**，README M6 的偏差登记同步这一条。

## 4. 必须人工目视的项（脚本证明不了，不声称已验证）

- 真实宿主里 \`--vscode-*\` Token 的实际取值是否与 \`packages/design-tokens\` 的假设一致；
- 高对比主题与 \`high-contrast\` 预设叠加时的边界（ARC-006 §13.1）；
- 扩展图标在 Extensions 面板里的观感（128×128 是规格下限，不是审美结论）；
- Reader Settings 弹层在真实宿主焦点管理下的表现（键盘 Tab 收拢、\`Escape\` 归位）；
- 跨面板多次开合后 OutputChannel 是否有异常累积（第 6 节 \`performance-report.md\`
  只覆盖页面内的 DOM/堆，Host 侧 dispose 计数不在这里）。

## 5. §7.4 发布准入十条对照

| 准入条 | 证据 | 状态 |
| --- | --- | --- |
| VSIX 可以正常安装 | 本报告第 2 节${outcome.skipped ? "（未执行）" : "（实测）"} | ${outcome.skipped ? "未闭合" : "通过"} |
${platformGateRows(outcome.skipped)}
| 扩展 Manifest 信息完整 | \`pnpm verify\` + \`manifest.spec.ts\`（license/icon/配置项/键位） | 通过 |
| README 完整 | README 里程碑章节 M1–M6 + 偏差登记 | 通过 |
| License 文件完整 | 根 \`LICENSE\` + \`pnpm verify\` 断言随包分发 | 通过 |
| 第三方依赖许可证信息完整 | \`apps/extension/resources/NOTICES.md\`（\`pnpm notices\` 生成） | 通过 |
| Release Notes 完成 | \`reports/release-notes-${manifest.version}.md\` | 通过 |
| Git Tag 创建完成 | 本批约定不 commit、不打 tag（见 README 执行约定） | 未闭合 |

## 6. 关联报告

- 测试：\`reports/test-report.md\`
- 安全：\`reports/security-report.md\`
- 性能：\`reports/performance-report.md\`
- 依赖审计：\`reports/dependency-audit.md\`
- 发布说明：\`reports/release-notes-${manifest.version}.md\`
`;
}

/** 表格单元格：多行取证压成一行，竖线转义，过长截断。 */
function cell(value) {
  const text = String(value ?? "").replace(/\s*\n\s*/gu, " / ").replace(/\|/gu, "\\|");
  return text.length <= 180 ? text : `${text.slice(0, 179)}…`;
}
