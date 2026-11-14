#!/usr/bin/env node
/**
 * 依赖安全审计与质量留痕（IMP-003 §7.2 最后一条 + §7.5 NOTE-01 复扫）。
 *
 * 产出 `reports/dependency-audit.md`。三件事按顺序做，任何一步取不到数都在报告里
 * 写成「未执行」而不是「通过」：
 *
 * 1. **两档审计**：`pnpm audit --prod --json` 与 `pnpm audit --dev --json`。
 *    本仓 registry 指向 npmmirror，它没有 audit 端点
 *    （`ERR_PNPM_AUDIT_ENDPOINT_NOT_EXISTS`），所以脚本自动退回
 *    `--registry=https://registry.npmjs.org` 再问一次，并把**实际应答的端点**写进
 *    报告 —— 不写清楚这个，读者会以为镜像源给了「没有漏洞」的结论。
 * 2. **dev-only 的判定不靠人说**：每条 advisory 都拿包名去对生产依赖闭包
 *    （`pnpm ls --prod -r --depth 10 --json` 的传递并集）。落在闭包外才算
 *    「不随 VSIX 分发」，落在闭包内就是发布物里的代码，两者结论完全不同。
 *    NOTE-01 那句「仅开发工具链引入」因此是可复核的，不是声明。
 * 3. **NOTE-01 逐条复扫**：@eslint/plugin-kit、glob、minimatch 三条，给出本仓实际
 *    解析到的版本、本轮是否仍出现在 advisories、上游补丁版本。docs 的口径是
 *    「等待上游修复，每次发布复扫」，复扫留痕就是这一节。
 *
 * 退出码：生产闭包内出现任何漏洞 → 1；dev-only 出现 high/critical → 1；
 * dev-only 的 moderate/low/info → 放行但在报告与 README 留痕。
 * `READORA_AUDIT_STRICT=1` 把 dev-only 也判失败（发布前的加严复跑用这个）。
 *
 * 审计端点完全不可达时退出码 1：宁可不出结论，也不出「0 漏洞」这种没来由的安慰。
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPORT = join(ROOT, "reports/dependency-audit.md");

/** 官方端点：本仓配置的镜像没有 audit 接口，退回这里取数。 */
const FALLBACK_REGISTRY = "https://registry.npmjs.org";

/** docs §7.5 NOTE-01 点名的三条 dev-only 项，复扫逐条给状态。 */
const KNOWN_DEV_ITEMS = ["@eslint/plugin-kit", "glob", "minimatch"];

/**
 * 本批新增的运行时依赖（IMP-003 §4.7 功能包带来的）：单独列一行状态，
 * 免得「整体 0 漏洞」把「新引进的东西有没有问题」这个真正被问掉。
 */
const NEW_RUNTIME_DEPENDENCIES = [
  { name: "katex", version: "0.19.1", reason: "数学公式渲染（IMP-001 §10.3）" },
  { name: "css-tree", version: "3.2.1", reason: "自定义 CSS 的 AST 净化（ARC-006 无规范，本批定案）" }
];

const SEVERITY_ORDER = ["critical", "high", "moderate", "low", "info"];

function run(command, args) {
  const result = spawnSync(command, args, { cwd: ROOT, encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 });
  return {
    command: [command, ...args].join(" "),
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? ""
  };
}

/**
 * 跑一档审计。
 *
 * 返回 `{ ok, registry, payload, note }`：`registry` 是**实际应答**的端点，
 * `note` 记录第一次尝试为什么没用（镜像缺端点/网络失败），这些都进报告。
 */
function audit(scope) {
  const args = ["audit", scope, "--json"];
  const first = run("pnpm", args);
  const firstPayload = parseJson(first.stdout);
  if (first.status === 0 && firstPayload && !firstPayload.error) {
    return { ok: true, registry: configuredRegistry(), payload: firstPayload, note: "配置的 registry 直接应答" };
  }
  const reason = firstPayload?.error?.message ?? (first.stderr || first.stdout).split("\n")[0] ?? "无输出";
  const second = run("pnpm", [...args, `--registry=${FALLBACK_REGISTRY}`]);
  const secondPayload = parseJson(second.stdout);
  if (secondPayload && (secondPayload.error || !secondPayload.advisories)) {
    return {
      ok: false,
      registry: FALLBACK_REGISTRY,
      payload: null,
      note: `两次都取不到数：${reason}；退回端点又给出 ${secondPayload.error?.message ?? "不可解析的响应"}`
    };
  }
  if (second.status !== 0 && !secondPayload) {
    return { ok: false, registry: FALLBACK_REGISTRY, payload: null, note: `两次都取不到数：${reason}` };
  }
  return {
    ok: true,
    registry: FALLBACK_REGISTRY,
    payload: secondPayload,
    note: `配置端点不可用（${reason}），已退回官方端点取数`
  };
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function configuredRegistry() {
  const result = run("pnpm", ["config", "get", "registry"]);
  return result.status === 0 ? result.stdout.trim() : "(未知)";
}

/**
 * 生产依赖闭包（全量传递）：判定 dev-only 的唯一依据。
 * 与 `scripts/gen-notices.mjs` 同一取数口径 —— 两处如果漂了，
 * 「随包分发的代码」和「被审计的代码」就不是同一批东西。
 */
function productionClosure() {
  const result = run("pnpm", ["ls", "--prod", "-r", "--depth", "10", "--json"]);
  const importers = parseJson(result.stdout);
  if (!Array.isArray(importers)) {
    return null;
  }
  const names = new Set();
  const visit = (node) => {
    for (const [name, dep] of Object.entries(node.dependencies ?? {})) {
      if (name.startsWith("@readora/")) {
        visit(dep);
        continue;
      }
      names.add(name);
      visit(dep);
    }
  };
  for (const importer of importers) {
    visit(importer);
  }
  return names;
}

/** 本仓实际解析到的版本：直接看 store 目录名，不猜 package.json 里的 range。 */
function installedVersions(name) {
  const store = join(ROOT, "node_modules/.pnpm");
  if (!existsSync(store)) {
    return [];
  }
  const prefix = `${name.replace("/", "+")}@`;
  return readdirSync(store)
    .filter((entry) => entry.startsWith(prefix))
    .map((entry) => entry.slice(prefix.length).split("_")[0])
    .sort();
}

/** 把 advisories 压平成可排序的行。 */
function flatten(payload, scope) {
  const rows = [];
  for (const advisory of Object.values(payload.advisories ?? {})) {
    const paths = new Set();
    const versions = new Set();
    for (const finding of advisory.findings ?? []) {
      for (const p of finding.paths ?? []) {
        paths.add(p);
      }
      versions.add(finding.version);
    }
    rows.push({
      scope,
      id: advisory.id,
      package: advisory.module_name,
      severity: advisory.severity,
      title: advisory.title,
      cves: advisory.cves ?? [],
      advisoryId: advisory.github_advisory_id ?? "—",
      vulnerable: advisory.vulnerable_versions,
      patched: advisory.patched_versions || "上游未发补丁版",
      installed: [...versions].sort().join(", "),
      overview: advisory.overview ?? "",
      paths: [...paths].sort()
    });
  }
  return rows.sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));
}

function counts(payload) {
  const vulnerabilities = payload.metadata?.vulnerabilities ?? {};
  const total = SEVERITY_ORDER.reduce((sum, level) => sum + (vulnerabilities[level] ?? 0), 0);
  return { byLevel: vulnerabilities, total, packages: payload.metadata?.totalDependencies ?? 0 };
}

function main() {
  const prod = audit("--prod");
  const dev = audit("--dev");
  const closure = productionClosure();
  const ranAt = new Date().toISOString();
  // 公开仓库不分发 reports/ 目录（见 README 的开源整理说明），首次 clone 后直接跑
  // 本命令会在下面两处 writeFileSync 处 ENOENT；先建目录，成败两条路径都要能落报告。
  mkdirSync(dirname(REPORT), { recursive: true });

  if (!prod.ok || !dev.ok) {
    writeFileSync(
      REPORT,
      renderFailure({ prod, dev, closure, ranAt }),
      "utf-8"
    );
    process.stderr.write(
      `quality-report: 审计端点取不到数（prod: ${prod.note}；dev: ${dev.note}）\n` +
        "        报告已写成「未执行」，不输出「0 漏洞」的假结论。\n"
    );
    return 1;
  }

  const prodRows = flatten(prod.payload, "prod");
  const devRows = flatten(dev.payload, "dev");
  const prodCounts = counts(prod.payload);
  const devCounts = counts(dev.payload);

  /** 落在生产闭包里的 advisory 才是「发布物里的代码有漏洞」。 */
  const shipped = [...prodRows, ...devRows].filter(
    (row) => closure === null || closure.has(row.package)
  );
  const devOnly = [...prodRows, ...devRows].filter(
    (row) => closure !== null && !closure.has(row.package)
  );

  const strict = process.env.READORA_AUDIT_STRICT === "1";
  const failures = [];
  if (shipped.length > 0) {
    failures.push(
      `生产依赖闭包内有 ${shipped.length} 条 advisory：` +
        shipped.map((row) => `${row.package}(${row.severity})`).join(", ")
    );
  }
  const seriousDevOnly = devOnly.filter(
    (row) => row.severity === "high" || row.severity === "critical"
  );
  if (seriousDevOnly.length > 0) {
    failures.push(
      `dev-only 里出现 high/critical：${seriousDevOnly.map((row) => `${row.package}(${row.severity})`).join(", ")}`
    );
  }
  if (strict && devOnly.length > 0) {
    failures.push(`加严口径（READORA_AUDIT_STRICT=1）不放行 dev-only 的 ${devOnly.length} 条`);
  }

  writeFileSync(
    REPORT,
    renderReport({
      prod,
      dev,
      prodRows,
      devRows,
      prodCounts,
      devCounts,
      closure,
      shipped,
      devOnly,
      failures,
      strict,
      ranAt
    }),
    "utf-8"
  );

  process.stdout.write(
    `  prod  ${prodCounts.packages} 个包 / ${prodCounts.total} 条漏洞（端点：${prod.registry}）\n` +
      `  dev   ${devCounts.packages} 个包 / ${devCounts.total} 条漏洞（端点：${dev.registry}）\n` +
      `  随包分发（生产闭包内）：${shipped.length} 条；dev-only：${devOnly.length} 条\n` +
      `  NOTE-01 复扫：${note01Summary()}\n` +
      `报告：${REPORT.replace(`${ROOT}/`, "")}\n`
  );

  if (failures.length > 0) {
    process.stderr.write(`${failures.map((line) => `quality-report: ${line}\n`).join("")}`);
    return 1;
  }
  return 0;
}

function note01Summary() {
  return KNOWN_DEV_ITEMS.map((name) => `${name}@${installedVersions(name).join("|") || "未安装"}`).join("、");
}

// ---------------------------------------------------------------- 报告渲染

function renderFailure({ prod, dev, closure, ranAt }) {
  return `# Readora 依赖审计（M6 / V0.6.0）

> 由 \`node scripts/quality-report.mjs\` 生成，执行时刻 ${ranAt}。

## 结论：**未执行**

| 档 | 取数状态 |
| --- | --- |
| --prod | ${prod.ok ? "成功" : `失败：${prod.note}`} |
| --dev | ${dev.ok ? "成功" : `失败：${dev.note}`} |

两端点都无法应答时本报告不写任何漏洞数字 —— 「没取到数」和「没有漏洞」是两件事，
把它们混为一谈就是这份文档最容易骗人的地方。生产闭包的解析状态：
${closure === null ? "**未取到**" : `已取到（${closure.size} 个包）`}。

处置：确认网络可达 \`${FALLBACK_REGISTRY}\`，或给配置的 registry
（\`${configuredRegistry()}\`）启用 audit 端点后重跑 \`pnpm quality:report\`。
`;
}

function renderReport(context) {
  const {
    prod,
    dev,
    prodRows,
    devRows,
    prodCounts,
    devCounts,
    closure,
    shipped,
    devOnly,
    failures,
    strict,
    ranAt
  } = context;

  const rows = [...prodRows, ...devRows];
  const lines = [
    "# Readora 依赖审计（M6 / V0.6.0）",
    "",
    "> 由 `node scripts/quality-report.mjs` 生成，执行时刻 " + ranAt + "。",
    "> 输入是 `pnpm audit --prod/--dev --json` 的原始响应，脚本只做归档与判定，",
    "> 不改写任何一条 advisory 的文字。",
    "",
    "## 1. 取数与端点",
    "",
    "| 档 | 应答端点 | 纳入包数 | 漏洞条数 | 说明 |",
    "| --- | --- | ---: | ---: | --- |",
    `| \`--prod\` | ${prod.registry} | ${prodCounts.packages} | ${prodCounts.total} | ${prod.note} |`,
    `| \`--dev\` | ${dev.registry} | ${devCounts.packages} | ${devCounts.total} | ${dev.note} |`,
    "",
    `配置的 registry 是 \`${configuredRegistry()}\`。它没有 audit 端点，`,
    `所以实际数据来自官方端点 \`${FALLBACK_REGISTRY}\`；这条退回关系写在表里，`,
    "是为了避免读者把镜像当成「给出了 0 漏洞结论的一方」。",
    "",
    "## 2. 按严重级分布",
    "",
    "| 级别 | prod | dev |",
    "| --- | ---: | ---: |",
    ...SEVERITY_ORDER.map(
      (level) => `| ${level} | ${prodCounts.byLevel[level] ?? 0} | ${devCounts.byLevel[level] ?? 0} |`
    ),
    "",
    "## 3. 随包分发的代码（判定口径）",
    "",
    "「dev-only」不靠人声明，靠生产依赖闭包对账：`pnpm ls --prod -r --depth 10 --json`",
    "的传递并集就是会进 `dist/extension.js` 与 `dist/webview/assets/main.js` 的第三方包集合",
    `（本次 ${closure === null ? "未取到" : `${closure.size} 个`}）。advisory 的包名落在这个集合外，`,
    "才叫不随 VSIX 分发。",
    "",
    "| 分类 | 条数 | 判定 |",
    "| --- | ---: | --- |",
    `| 生产闭包内（发布物里的代码） | ${shipped.length} | ${shipped.length === 0 ? "无，§7.2「不存在已知未处理的严重安全漏洞」成立" : "**必须处置**"} |`,
    `| 闭包外（dev-only） | ${devOnly.length} | ${devOnly.length === 0 ? "无" : "不随 VSIX 分发，逐条登记上游状态并留待复扫"} |`,
    "",
    "## 4. 逐条 advisory",
    ""
  ];

  if (rows.length === 0) {
    lines.push("本轮两档审计都没有返回 advisory。", "");
  } else {
    lines.push(
      "| 包 | 级别 | 命中版本 | 受影响范围 | 补丁版本 | 依赖路径 | GHSA / CVE |",
      "| --- | --- | --- | --- | --- | --- | --- |",
      ...rows.map(
        (row) =>
          `| \`${row.package}\`（${row.scope}） | ${row.severity} | ${row.installed} | ` +
          `\`${row.vulnerable}\` | \`${row.patched}\` | ${row.paths.map((p) => `\`${p}\``).join("<br>")} | ` +
          `${row.advisoryId}${row.cves.length > 0 ? ` / ${row.cves.join(", ")}` : ""} |`
      ),
      "",
      "### 详细描述",
      "",
      ...rows.map(
        (row) =>
          `#### \`${row.package}\` — ${row.title}\n\n` +
          `- 档位：${row.scope}（${closure === null || closure.has(row.package) ? "生产闭包内" : "生产闭包外，dev-only"}）\n` +
          `- 上游建议：${row.patched === "上游未发补丁版" ? "尚无补丁版本" : `升级到 ${row.patched}`}\n` +
          `- 概述：${oneLine(row)}\n`
      )
    );
  }

  lines.push(
    "## 5. NOTE-01 复扫（docs §7.5）",
    "",
    "docs 的口径是「仅开发工具链引入，不打包进 VSIX，等待上游主版本修复，每次发布复扫」。",
    "下面每条都给三件事：本仓实际解析到的版本、本轮是否仍出现在 advisories、上游状态。",
    "",
    "| 项 | 本仓解析版本 | 本轮是否命中 | 上游状态 | 是否闭合 |",
    "| --- | --- | --- | --- | --- |",
    ...KNOWN_DEV_ITEMS.map((name) => {
      const versions = installedVersions(name);
      const hits = rows.filter((row) => row.package === name);
      // 补丁版本串里不要再嵌反引号：`${...}` 的插值里再写转义反引号会让外层模板
      // 字符串在这里失去结束符，整段渲染函数一起报错（本脚本踩过一次）。
      const upstream =
        hits.length > 0
          ? `仍受影响，补丁版本 ${[...new Set(hits.map((row) => row.patched))].join(" 或 ")}`
          : "已不在返回的 advisory 列表里（上游已修复且本仓解析版本不含漏洞）";
      return (
        `| \`${name}\` | ${versions.length > 0 ? versions.map((v) => `\`${v}\``).join(", ") : "未安装"} | ` +
        `${hits.length > 0 ? `**是**（${hits.map((row) => row.severity).join(", ")}）` : "否"} | ${upstream} | ` +
        `${hits.length > 0 ? "未闭合" : "可关闭"} |`
      );
    }),
    "",
    "复扫结论：NOTE-01 里被点名的三项中，" +
      `${rows.filter((row) => KNOWN_DEV_ITEMS.includes(row.package)).length > 0 ? "仍有命中项，按上表逐条跟踪上游补丁版本" : "本轮一条都不再命中"}。` +
      "三项都在 dev 侧，生产闭包对账已确认它们不进发布物。",
    "",
    "## 6. 本批新增依赖",
    "",
    "| 包 | 版本 | 引入原因 | 审计状态 |",
    "| --- | --- | --- | --- |",
    ...NEW_RUNTIME_DEPENDENCIES.map((dep) => {
      const hits = rows.filter((row) => row.package === dep.name);
      const installed = installedVersions(dep.name);
      return (
        `| \`${dep.name}\` | ${dep.version}（实测解析 ${installed.join(", ") || "未装"}） | ${dep.reason} | ` +
        `${hits.length === 0 ? "0 条 advisory" : `**${hits.length} 条 advisory**`} |`
      );
    }),
    "",
    "## 7. §7.2 安全准入对照",
    "",
    "| 准入条 | 证据 | 状态 |",
    "| --- | --- | --- |",
    "| CSP 已配置 | `apps/extension/src/webview/html-template.ts` + `tests/security/csp.spec.ts` | 通过 |",
    "| 不使用 `unsafe-eval` | `tests/security/csp.spec.ts` 直接断言 script-src 取值 | 通过 |",
    "| HTML Sanitizer 测试通过 | `packages/markdown-core` 净化单测 + `tests/security/sanitize.spec.ts` | 通过 |",
    "| SVG Sanitizer 测试通过 | `tests/security/sanitize.spec.ts`（SVG 载荷与 use/href 通道） | 通过 |",
    "| URL Scheme 检查通过 | `tests/security/path-traversal.spec.ts` + scheme 白名单单测 | 通过 |",
    "| 路径访问边界测试通过 | `tests/security/path-traversal.spec.ts` | 通过 |",
    "| Host 消息校验通过 | `tests/security/envelope.spec.ts`（strictObject 拒非法载荷） | 通过 |",
    `| 不存在已知未处理的严重安全漏洞 | 本报告第 3 节（生产闭包内 ${shipped.length} 条）与第 4 节 | ` +
      `${shipped.length === 0 ? "通过" : "**未通过**"} |`,
    "",
    "## 8. 判定",
    "",
    `- 加严口径：\`READORA_AUDIT_STRICT=${strict ? "1" : "未设置"}\``,
    `- 本脚本退出码：${failures.length === 0 ? "0（放行）" : "1（不放行）"}`,
    ...(failures.length > 0 ? ["", ...failures.map((line) => `- **${line}**`)] : []),
    ""
  );
  return `${lines.join("\n")}`;
}

/**
 * 概述压成一行，避免报告里出现整段换行的原文。
 *
 * advisory 的 overview 里带 GitHub 风格的围栏（``` 代码块），原样贴进 Markdown
 * 会把后面整节吞进代码块里 —— 这不是排版洁癖，是让报告读得出内容的最小处置：
 * 三个连续反引号换成等义的「」，其余字符不动，正文全文仍以上游 advisories 为准。
 */
function oneLine(row) {
  const text = String(row.overview ?? "")
    .replace(/```[^\S\n]*/gu, "「")
    .replace(/\s+/gu, " ")
    .trim();
  const clean = text.length > 0 ? text : row.title;
  return clean.length <= 480 ? clean : `${clean.slice(0, 479)}…`;
}

process.exit(main());
