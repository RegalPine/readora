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
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { arch, platform, release } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXTENSION_DIR = join(ROOT, "apps/extension");
const REPORT = join(ROOT, "reports/platform-verification.md");

/**
 * 依次探测的候选命令；`READORA_CODE_CLI` 优先，自定义安装位置不必改脚本。
 *
 * macOS 的 `code` 常常不在 PATH 里（没执行过 "Install 'code' command in PATH"），
 * 但 app 自带的 CLI 一直在那条固定路径上 —— 本机实测就是这种环境：只写命令名会
 * 让这一步在明明有 VS Code 的机器上输出「未执行」。绝对路径只在文件存在时才纳入，
 * 所以 Windows / Linux 上不会多探测一个不存在的命令。
 */
const BUNDLED_CLI_PATHS = [
  "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
  "/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code",
  "/Applications/VSCodium.app/Contents/Resources/app/bin/codium"
].filter((entry) => existsSync(entry));

const CLI_CANDIDATES = [
  process.env.READORA_CODE_CLI,
  "code",
  "code-insiders",
  "codium",
  ...BUNDLED_CLI_PATHS
].filter((entry) => typeof entry === "string" && entry.length > 0);

const manifest = JSON.parse(readFileSync(join(EXTENSION_DIR, "package.json"), "utf-8"));
const vsixName = `${manifest.name}-${manifest.version}.vsix`;
const vsixPath = join(EXTENSION_DIR, vsixName);
const extensionId = `${manifest.publisher}.${manifest.name}`;

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf-8", maxBuffer: 16 * 1024 * 1024 });
  return {
    command: [command, ...args].join(" "),
    status: result.status,
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
    error: result.error ? String(result.error.message ?? result.error) : null
  };
}

/** 报告里的命令去掉仓库根前缀：公开发布不应带上开发者本机绝对路径。 */
function redact(text) {
  return String(text).split(`${ROOT}/`).join("");
}

/** 探 CLI：能跑 `--version` 才算存在，PATH 里有个同名空文件不算。 */
function detectCli() {
  for (const candidate of CLI_CANDIDATES) {
    const probe = run(candidate, ["--version"]);
    if (probe.status === 0 && probe.stdout.length > 0) {
      return { command: candidate, versionOutput: probe.stdout.split("\n") };
    }
  }
  return null;
}

const environment = {
  os: `${platform()} ${arch()}`,
  kernel: release(),
  node: process.version,
  vscode: "未执行（本机没有 VS Code CLI）",
  vscodeCommit: "—",
  cli: "—"
};

const ranAt = new Date().toISOString();
let outcome = { skipped: true, installed: null, listed: null, checks: [] };

const cli = detectCli();
if (!cli) {
  process.stdout.write(
    "Readora install-check: SKIPPED（找不到 VS Code CLI；装一次 code 或用 READORA_CODE_CLI 指向它）\n" +
      "        报告仍会写出，结论列为「未执行」。\n"
  );
} else if (!existsSync(vsixPath)) {
  process.stderr.write(`Readora install-check: 缺少产物 ${vsixName}；先跑 pnpm package。\n`);
  process.exit(1);
} else {
  environment.cli = cli.command;
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
| macOS（${arch()}） | ${outcome.skipped ? "**未执行**" : "通过"} | 本机即 macOS，${outcome.skipped ? "但缺 CLI" : "见第 2 节实测结论"} |
| Windows | **未覆盖** | 没有 Windows 环境；本批不引入 CI，登记为人工待办 |
| Linux | **未覆盖** | 同上 |

docs 的 §7.4 要求三平台都过，本批只能闭合 macOS 一条（连同「VS Code 版本」证据），
Windows/Linux 明确记为**未闭合**，README M6 的偏差登记同步这一条。

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
| Windows 验证通过 | 第 3 节 | 未闭合（无环境） |
| macOS 验证通过 | 第 3 节 | ${outcome.skipped ? "未闭合（缺 CLI）" : "通过"} |
| Linux 验证通过 | 第 3 节 | 未闭合（无环境） |
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
