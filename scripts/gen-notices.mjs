#!/usr/bin/env node
/**
 * 第三方许可证清单生成（IMP-003 §7.4「发布物附带第三方许可证声明」）。
 *
 * 产出 `apps/extension/resources/NOTICES.md`，随 vsix 一起分发；`pnpm verify` 会
 * 断言它在包里。清单本身是生成物，**不要手改**，改依赖后重跑 `pnpm notices`。
 *
 * 取数口径（两档，缺一档就是假清单）：
 * 1. **生产依赖图**：`pnpm ls --prod -r --depth 10 --json` 的全量传递闭包。
 *    这是 Host 包 `dist/extension.js` 与 Webview 包 `main.js` 在运行时真正会执行的
 *    第三方代码来源，逐包读 `node_modules/<pkg>/package.json` 的 license 字段，
 *    再读包内的 LICENSE 文件正文 —— 不采信 lockfile 里的字段，因为 pnpm 的
 *    lockfile 不记录 license。
 * 2. **被打包进产物的 devDependency**：Vite/esbuild 在构建期就把代码或字体二进制
 *    固化进产物，运行期依赖图上看不见它们，但分发义务恰恰落在这里。本仓的实际名单
 *    是三个 `@fontsource/*` 字族（woff2 随包分发，OFL 要求随字体提供许可全文）；
 *    `katex` 因为同时是 markdown-core 的 production dependency，走第一条通道采到。
 *    这份名单不靠记忆维护：`assertBundledListIsCurrent()` 会核对每一项确实不在生产
 *    依赖图上，并在 node_modules 里解析不到时判失败。
 *
 * 只列名字不算合规：MIT 要求各份拷贝都带上版权声明与许可条款，OFL/CC0 还额外要求
 * 随产物提供许可全文。所以每条 MIT 都把正文贴全，构建期工具（vite、typescript、
 * vitest、tailwind、eslint、esbuild、@vscode/vsce）不进清单，理由写在文件头。
 *
 * 输出是确定性的：同一棵 node_modules 树重复执行字节相同（不写时间戳、按包名排序），
 * 因此可以入库，也让 `pnpm verify` 能对「清单有没有跟着依赖变」较真。
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describeToolFailure, runTool } from "./lib/run-tool.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUTPUT = path.join(ROOT, "apps/extension/resources/NOTICES.md");

/**
 * 运行期依赖图上不可见、但字体二进制真的进了发布产物的包。
 *
 * 三个 `@fontsource/*` 在 `apps/webview` 里是 devDependency，Vite 把它们的 woff2
 * 当资源固化进 `dist/webview/assets/`，随包分发的就是这些字体文件本身 —— OFL 要求
 * 随字体提供许可全文，所以它们必须在清单里，尽管 `pnpm ls --prod` 看不见。
 *
 * `katex` 不在此列：它同时是 `packages/markdown-core` 的 production dependency，
 * 已经由生产依赖图采到。下面的 `assertBundledListIsCurrent()` 会把这类重复登记
 * 直接判失败，名单因此跟着 package.json 走，不靠记忆维护。
 */
const BUNDLED_DEV_DEPENDENCIES = [
  "@fontsource/geist",
  "@fontsource/jetbrains-mono",
  "@fontsource/newsreader"
];

/** 纯构建期/开发期工具：产物里不含其代码，不构成随包分发的第三方作品。 */
const BUILD_TIME_ONLY = [
  "@playwright/test",
  "@types/node",
  "@vscode/vsce",
  "esbuild",
  "eslint",
  "playwright",
  "tailwindcss",
  "typescript",
  "vite",
  "vitest"
];

function fail(message) {
  process.stderr.write(`[notices] FAILED: ${message}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------- 依赖图采集

/**
 * 跑 `pnpm ls --prod -r --depth 10 --json`；深度给足，否则只有一层就是假闭包。
 *
 * 走 `runTool` 而不是直接 `spawnSync("pnpm", ...)`：Windows 上 pnpm 是 `.cmd` 垫片，
 * 不经 shell 根起不来，于是这里只能看到一句「退出码 null」。
 */
function productionGraph() {
  const result = runTool(
    "pnpm",
    ["ls", "--prod", "-r", "--depth", "10", "--json"],
    { cwd: ROOT, encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 }
  );
  if (result.status !== 0) {
    fail(`pnpm ls ${describeToolFailure(result)}`);
  }
  let importers;
  try {
    importers = JSON.parse(result.stdout);
  } catch (error) {
    fail(`pnpm ls 输出不是 JSON：${String(error)}`);
  }
  const found = new Map();
  const visit = (node) => {
    for (const [name, dep] of Object.entries(node.dependencies ?? {})) {
      // workspace 链接是本项目自己的包，不是第三方。
      if (name.startsWith("@readora/")) {
        visit(dep);
        continue;
      }
      if (!found.has(name)) {
        found.set(name, { name, version: dep.version, directory: dep.path });
      }
      visit(dep);
    }
  };
  for (const importer of importers) {
    visit(importer);
  }
  return found;
}

/**
 * 依赖图采集完之后的自检，两条都失败即退出：
 * - 每个 devDependency 名单项在当前 node_modules 里解析得到（漏装 → 清单会缺一段）；
 * - 名单里的包确实**不在**生产依赖图上（在的话说明有人把它挪进了 dependencies，
 *   那这条登记就过期了，留着会让人以为清单在重复计数）。
 */
function assertBundledListIsCurrent(graph) {
  for (const name of BUNDLED_DEV_DEPENDENCIES) {
    if (graph.has(name)) {
      fail(
        `${name} 现在已经是生产依赖，BUNDLED_DEV_DEPENDENCIES 里的登记该删 —— ` +
          "否则清单会把同一个包算两次。"
      );
    }
    const entry = readPackage(name);
    if (!entry) {
      fail(`${name} 在 node_modules 里解析不到：先 pnpm install，再重跑 notices。`);
    }
  }
}

// ---------------------------------------------------------------- 包元数据读取

/**
 * 从仓库根按包名解析包目录。
 *
 * 生产依赖图自带 path，但 BUNDLED_DEV_DEPENDENCIES 那几个是 devDependency，
 * 只出现在 `apps/webview/node_modules/` 的软链下，所以两处都试。
 */
function readPackage(name) {
  const candidates = [
    path.join(ROOT, "node_modules", name),
    path.join(ROOT, "apps/webview/node_modules", name),
    path.join(ROOT, "apps/extension/node_modules", name)
  ];
  for (const directory of candidates) {
    const manifestFile = path.join(directory, "package.json");
    if (!existsSync(manifestFile)) {
      continue;
    }
    const manifest = JSON.parse(readFileSync(manifestFile, "utf-8"));
    return { name, version: manifest.version, directory, manifest };
  }
  return null;
}

/**
 * license 字段的三种形态都要认：SPDX 字符串、`{type}` 老写法、`licenses` 数组。
 * 认不出来就写 `SEE_LICENSE_FILE`，并在末尾的 UNRESOLVED 段落里点名 —— 让人去读
 * 包内正文，而不是让脚本替它编一个。
 */
function licenseId(manifest) {
  const { license, licenses } = manifest;
  if (typeof license === "string" && license.trim() !== "") {
    return license.trim();
  }
  if (license && typeof license === "object" && typeof license.type === "string") {
    return license.type.trim();
  }
  if (Array.isArray(licenses) && licenses.length > 0) {
    return licenses.map((entry) => entry.type ?? String(entry)).join(" OR ");
  }
  return "SEE_LICENSE_FILE";
}

/** 包内许可证正文：文件名在各生态里不统一，按候选顺序找第一个存在的。 */
function licenseText(directory) {
  const names = readdirSync(directory);
  const preferred = ["LICENSE", "LICENSE.md", "LICENSE.txt", "license", "Licence", "COPYING"];
  const pick =
    preferred.find((name) => names.includes(name)) ??
    names.find((name) => /^license/iu.test(name) || /^copying/iu.test(name));
  if (!pick) {
    return null;
  }
  return readFileSync(path.join(directory, pick), "utf-8").trim();
}

/**
 * 版权声明行：MIT 类条款的核心就是这一行，单独抽出来给汇总表用。
 *
 * 只认**行首**就是 Copyright/© 的行 —— 许可证正文里满是 "the above copyright
 * notice"、"copyright license to reproduce"（Apache 2.0 的定义句）、
 * "Copyright and Related Rights"（CC0 的权利名）这类指涉条款的句子，把它们当版权
 * 声明抄进表格等于自己造一份错的，所以再用一组黑名单把这些句式剔掉。OFL 的正文
 * 第一行恰好就是真正的持有者声明，行首规则正好命中。
 *
 * 行长只用于**筛选**（400 以内），汇总表里的展示宽度另由 `display()` 截断 ——
 * 全文就贴在下面一节，摘要列没必要把整条 OFL 文件清单拉进来。
 */
const COPYRIGHT_LINE = /^(?:copyright|©)\s*(?:\(?c\)?)?[\s<(]/iu;
const BOILERPLATE =
  /copyright (?:notice|owner|statement|holder|license|and related|rights|or moral|to )|the above copyright/iu;

function copyrightLines(text) {
  if (!text) {
    return [];
  }
  return text
    .split("\n")
    .map((line) => line.trim().replace(/\s+/gu, " "))
    .filter((line) => line.length <= 400 && COPYRIGHT_LINE.test(line) && !BOILERPLATE.test(line))
    .slice(0, 1);
}

/** 表格单元格：转义竖线、限制宽度，超出部分用省略号（全文在下一节）。 */
function display(value) {
  const text = value.replace(/\|/gu, "\\|");
  return text.length <= 140 ? text : `${text.slice(0, 139)}…`;
}

// ---------------------------------------------------------------- 渲染

function render(entries) {
  const lines = [
    "# Readora 第三方许可证声明",
    "",
    "> 本文件由 `node scripts/gen-notices.mjs` 生成，请勿手改；改依赖后重跑",
    "> `pnpm notices`（`pnpm package` 已把它排在 vsce 之前）。",
    "> 内容确定性生成：同一棵 node_modules 树重复执行字节相同，不含时间戳。",
    "",
    "## 范围",
    "",
    "- **生产依赖图**（`pnpm ls --prod -r --depth 10` 的全量传递闭包）：随",
    "  `dist/extension.js` 与 `dist/webview/assets/main.js` 分发的第三方代码。",
    "  按**依赖图**而不是按**字节归属**列：打包器的 tree-shaking 未必真的用到其中",
    "  每一个包（`commander` 就是 katex 命令行入口的依赖，不进浏览器包），",
    "  多列不违反任何义务，漏列才会。",
    "- **被打包进产物的 devDependency**：`" + BUNDLED_DEV_DEPENDENCIES.join("`、`") + "`。",
    "  它们在运行期依赖图上不可见，但 woff2 字体文件本身进了发布物（Vite 把",
    "  `@fontsource` 的资源固化进 `dist/webview/assets/`），分发义务跟着产物走。",
    `- **不含**纯构建期/开发期工具：${BUILD_TIME_ONLY.map((name) => `\`${name}\``).join("、")}。`,
    "  它们的代码不出现在发布物里，产物也不构成其衍生作品。",
    "",
    "本项目的源码采用 MIT 许可证，见仓库根 `LICENSE`。",
    "",
    "## 清单",
    "",
    "| 包 | 版本 | 许可证 | 版权声明 |",
    "| --- | --- | --- | --- |",
    ...entries.map(
      (entry) =>
        `| \`${entry.name}\` | ${entry.version} | ${entry.license} | ${
          entry.copyright.length > 0 ? display(entry.copyright[0]) : "—"
        } |`
    ),
    `| 合计 | ${entries.length} 个包 | ${distinctLicenseCount(entries)} 类许可证 | |`,
    "",
    "## 许可证正文",
    "",
    "每个包的完整条款原文如下（未作改写）。正文缺失的包在下一节点名，不猜测其条款。",
    ""
  ];

  const missing = entries.filter((entry) => !entry.text);
  for (const entry of entries) {
    lines.push(`### \`${entry.name}@${entry.version}\` — ${entry.license}`, "");
    if (entry.homepage) {
      lines.push(`上游地址：${entry.homepage}`, "");
    }
    if (entry.text) {
      lines.push("```", entry.text, "```", "");
    } else {
      lines.push("> **缺少许可证正文**：包目录内没有 LICENSE/COPYING 文件，需人工核实。", "");
    }
  }

  if (missing.length > 0) {
    lines.push(
      "## 待人工核实",
      "",
      ...missing.map((entry) => `- \`${entry.name}@${entry.version}\`：读不到许可证正文。`),
      ""
    );
  }
  return `${lines.join("\n")}\n`;
}

function distinctLicenseCount(entries) {
  return new Set(entries.map((entry) => entry.license)).size;
}

// ---------------------------------------------------------------- 主流程

const graph = productionGraph();
assertBundledListIsCurrent(graph);

/** name -> entry；生产图与打包名单合并，同名以生产图那条为准（版本已在上一步自检分开）。 */
const collected = new Map();
for (const { name, version, directory } of graph.values()) {
  collected.set(name, { name, version, directory });
}
for (const name of BUNDLED_DEV_DEPENDENCIES) {
  const entry = readPackage(name);
  if (entry && !collected.has(name)) {
    collected.set(name, entry);
  }
}

const entries = [...collected.values()]
  .map((entry) => {
    const manifest = JSON.parse(readFileSync(path.join(entry.directory, "package.json"), "utf-8"));
    const text = licenseText(entry.directory);
    const repository =
      typeof manifest.repository === "string"
        ? manifest.repository
        : manifest.repository?.url;
    return {
      name: entry.name,
      version: manifest.version ?? entry.version,
      license: licenseId(manifest),
      text,
      copyright: copyrightLines(text),
      homepage: manifest.homepage ?? repository ?? null
    };
  })
  .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

if (entries.length === 0) {
  fail("一个第三方包都没采到：node_modules 树可能没装好。");
}

writeFileSync(OUTPUT, render(entries), "utf-8");
process.stdout.write(
  `[notices] 写入 ${path.relative(ROOT, OUTPUT)}：${entries.length} 个包、` +
    `${distinctLicenseCount(entries)} 类许可证、` +
    `${entries.filter((entry) => !entry.text).length} 个缺正文\n`
);
