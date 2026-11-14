/**
 * VSIX 产物验证（IMP-001 §13.2 门禁最后一步）。
 *
 * 检查：VSIX 存在、入口与 Webview 固定产物齐全、源码未混入包内、Webview 产物
 * 确实带上 M3 图文渲染、M4 导航/搜索、M6 公式、M8 代码编辑器、M10 脚注、M11 导出
 * 菜单的实现，Host 产物带上 Chrome CLI 的 argv，M5 的主题 Token 与字体真的进了包、
 * main.js 与 main.css 各自不超过预算。
 * 任一缺失即失败退出，不做"看起来没问题"的宽松判断。
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const extensionDir = path.join(root, "apps/extension");

const WEBVIEW_MAIN_JS = "extension/dist/webview/assets/main.js";
const WEBVIEW_MAIN_CSS = "extension/dist/webview/assets/main.css";
/**
 * Webview 包体预算（IMP-001 §12 F11-001）。
 *
 * 1.2 MB 是本仓 M2 自算的数字，docs 从未给过绝对值；每次提预算都必须是硬的理由：
 * - M6 加 KaTeX：渲染引擎按自身设计不可 tree-shake（一套语法表 + 一份符号字体度量，
 *   任何公式都要用到），M5 基线 997 204 B → 实测 1 263 030 B（+265 826 B），提到 1.6 MB；
 * - M8 加 CodeMirror 6（代码块换用真正的编辑器组件：行号、折叠、只读选择）：
 *   0.7.0 基线 1 288 987 B → 实测 2 012 193 B（**+723 206 B**），其中 core
 *   （state + view + language + @lezer 运行时）约 250 kB，其余是 15 门语言的语法表。
 *   预算提到 2.2 MB：留 ~300 KB 余量的同时仍然夹得住下一次大跳跃 —— 本批的增量已经
 *   需要用户显式批准，不是「顺手放宽」。为什么不削减语言集：那样会让同一篇文档里
 *   有些块有行号、有些没有，两个视图（编辑器 / 搜索命中回显的静态视图）也会分色。
 *   实测的 esbuild 估数（+465 kB）比真实增量小得多 —— 打包器不同（rolldown vs esbuild），
 *   所以登记的一律是打包后从 vsix 里量出来的数字。
 *
 * MAIN_JS_BASELINE_BYTES 让增量在输出里可见，不是悄悄放行。
 */
const MAIN_JS_BUDGET_BYTES = 2.2 * 1024 * 1024;
/** M5 的实测基线，只用于把「本批 KaTeX 的真实代价」打印出来，不参与判定。 */
const MAIN_JS_BASELINE_BYTES = 997_204;
/**
 * M5 的 CSS 预算：基线 17 041 B（单文件 global.css），Tailwind utility 层 +
 * 三级 Token 之后实测约 38 KB，预算给到 4 倍余量（160 KB）。
 * 超预算的先处置顺序见 IMP-003 §4.6：减字体字重，而不是放宽预算。
 */
const MAIN_CSS_BUDGET_BYTES = 160 * 1024;
/**
 * 随包分发的字体子集数量：
 * 7 个 @fontsource latin（newsreader 400/500/600 + geist 400/500 + mono 400/500）
 * + 20 个 KaTeX（IMP-001 §10.3 要求 woff2 单格式，woff/ttf 由 vite 插件剥掉）。
 * 少一个就是有人删了字重或删了一条 @font-face 却没登记偏差。
 * KaTeX 那 20 个里最小的 Size3 只有 2 KB，会被 Vite 默认的 assetsInlineLimit
 * 转成 `url(data:font/woff2;base64,…)`，而 CSP 的 font-src 不含 data: ——
 * 所以 vite.config 显式禁止字体内联，这里同时校验「样式表的 url() 都能在归档内解析」。
 */
const EXPECTED_WOFF2 = 27;
/** 其中属于 KaTeX 的个数：低于这个数说明公式字体被整批剥掉了。 */
const EXPECTED_KATEX_WOFF2 = 20;

const vsixName = pickCurrentVsix();

/**
 * 必须校验「与当前扩展版本一致」的那一个产物：目录里可能还留着上一里程碑的
 * 旧 .vsix，按 readdir 顺序取第一个会把旧包当成门禁结果。
 */
function pickCurrentVsix() {
  const manifestVersion = JSON.parse(
    readFileSync(path.join(extensionDir, "package.json"), "utf8")
  ).version;
  const expected = `readora-${manifestVersion}.vsix`;
  const candidates = readdirSync(extensionDir).filter((name) => name.endsWith(".vsix"));
  if (!candidates.includes(expected)) {
    console.error(`[verify] No VSIX for current version ${expected}. Run \`pnpm package\` first.`);
    process.exit(1);
  }
  const stale = candidates.filter((name) => name !== expected);
  if (stale.length > 0) {
    console.log(`[verify] NOTE ignoring stale artifacts: ${stale.join(", ")}`);
  }
  return expected;
}

const vsixPath = path.join(extensionDir, vsixName);
// 逐行拿条目名而不是 `unzip -l` 的表格：子串匹配会让 "extension/src/" 这类前缀检查
// 与体积列一起命中，也会让「要求的入口」漏掉路径拼错的情况。
const entries = execFileSync("unzip", ["-Z1", vsixPath], { encoding: "utf-8" })
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line.length > 0);

const requiredEntries = [
  "extension/package.json",
  "extension/dist/extension.js",
  WEBVIEW_MAIN_JS,
  WEBVIEW_MAIN_CSS
];

let failed = false;
for (const entry of requiredEntries) {
  if (entries.includes(entry)) {
    console.log(`[verify] OK   ${entry}`);
  } else {
    console.error(`[verify] MISS ${entry}`);
    failed = true;
  }
}

/**
 * 发布元数据（IMP-003 §7.4）：许可证与图标必须真的在包里，而不只是写在 manifest 上。
 *
 * 名字要兼容几种形态：vsce 会把打包目录里无扩展名的 `LICENSE` 收进
 * `extension/LICENSE.txt`（实测 0.6.0 就是这个名；早期假设的 `.md` 没出现过，
 * 但不同 vsce 版本是否改名不可假设），所以这里按前缀找而不是写死一个后缀。
 * 图标反过来只认 `extension/resources/icon.png` 这一个确切路径 —— Marketplace 的
 * logo 是按 manifest 里 `icon` 的相对路径去包里取的，路径错一位就是发布后没图。
 */
const licenseEntries = entries.filter((entry) =>
  /^extension\/LICENSE(?:\.(?:md|txt))?$/u.test(entry)
);
if (licenseEntries.length === 0) {
  console.error("[verify] MISS no LICENSE in the package (root LICENSE must be shipped, IMP-003 §7.4)");
  failed = true;
} else {
  const licenseText = execFileSync("unzip", ["-p", vsixPath, licenseEntries[0]], { encoding: "utf-8" });
  // 判 MIT 而不是判文件存在：manifest 的 `license` 字段与实际文本对不上，
  // Marketplace 展示的是字段值，用户装到的是另一套条款。
  const declared = JSON.parse(
    execFileSync("unzip", ["-p", vsixPath, "extension/package.json"], { encoding: "utf-8" })
  ).license;
  const textMatched = /\bMIT License\b/iu.test(licenseText);
  if (declared === "MIT" && textMatched) {
    console.log(`[verify] OK   ${licenseEntries[0]} (${declared})`);
  } else {
    console.error(
      `[verify] FAIL license metadata: manifest says ${JSON.stringify(declared)}, ` +
        `file header matched MIT = ${textMatched}`
    );
    failed = true;
  }
}

const ICON_ENTRY = "extension/resources/icon.png";
if (!entries.includes(ICON_ENTRY)) {
  console.error(`[verify] MISS ${ICON_ENTRY} (manifest icon must resolve inside the package)`);
  failed = true;
} else {
  const icon = execFileSync("unzip", ["-p", vsixPath, ICON_ENTRY], { encoding: "buffer" });
  const width = icon.readUInt32BE(16);
  const height = icon.readUInt32BE(20);
  if (icon.subarray(0, 8).toString("hex") === "89504e470d0a1a0a" && width >= 128 && height >= 128) {
    console.log(`[verify] OK   ${ICON_ENTRY} ${width}x${height}, ${(icon.byteLength / 1024).toFixed(1)} kB`);
  } else {
    console.error(`[verify] FAIL ${ICON_ENTRY} is not a >=128x128 PNG (got ${width}x${height})`);
    failed = true;
  }
}

// 第三方许可证清单：随包分发的运行时依赖（katex、css-tree、@fontsource、mermaid…）
// 都有各自的版权条款，`pnpm notices` 生成后必须进包，否则发布物缺一份合规文件。
const NOTICES_ENTRY = "extension/resources/NOTICES.md";
if (entries.includes(NOTICES_ENTRY)) {
  console.log(`[verify] OK   ${NOTICES_ENTRY}`);
} else {
  console.error(`[verify] MISS ${NOTICES_ENTRY}; run \`pnpm notices\` before \`pnpm package\`.`);
  failed = true;
}

// M3：图文渲染必须真的进到 Webview 产物里——只看文件名会漏掉「构建静默产出旧包」。
const mainJs = execFileSync("unzip", ["-p", vsixPath, WEBVIEW_MAIN_JS], {
  encoding: "buffer",
  maxBuffer: 64 * 1024 * 1024
});

for (const marker of [
  "readora-diagram-container",
  "data-readora-image-state",
  // M4：导航与搜索同样必须真的进到 Webview 产物里（稳定 class 取自新增组件）
  "readora-outline-panel",
  "readora-search-panel",
  // M6：公式容器类名取自渲染器，缺它说明 KaTeX 通道没接进管线
  "readora-math",
  // M8：代码编辑器接管层的状态属性，缺它说明正文里的块还是静态 `<pre>`
  "data-readora-code-editor-state",
  // CodeMirror 的外壳类名：接管层在但引擎被 tree-shake 掉也会留一个空壳
  "cm-editor",
  // M10：脚注区容器 class 取自渲染器。它不在包里，就等于「脚注」这项能力
  // 只在源码里存在而用户拿不到 —— 旧版那两条内容损坏的用例也就没人重新跑过。
  "readora-footnotes",
  // M11：导出菜单的两枚稳定标识。触发器的 data 属性与菜单面板的 class 都写成
  // 字符串字面量（`EXPORT_MENU_ATTRIBUTE` / `EXPORT_MENU_CLASS`），属性名不参与
  // mangle，因此这两条是「菜单真的进了管线」的可判定证据：缺任一条，用户面对的
  // 就是一个不渲染的顶栏按钮，而导出命令仍然全绿。
  "data-readora-export-menu",
  "readora-export-menu"
]) {
  if (mainJs.includes(marker)) {
    console.log(`[verify] OK   main.js contains ${marker}`);
  } else {
    console.error(`[verify] MISS main.js does not contain ${marker}`);
    failed = true;
  }
}

const vsixBytes = statSync(vsixPath).size;
console.log(
  `[verify] SIZE vsix ${(vsixBytes / 1024).toFixed(1)} kB, main.js ${(mainJs.byteLength / 1024).toFixed(1)} kB ` +
    `(budget ${(MAIN_JS_BUDGET_BYTES / 1024).toFixed(0)} kB, ` +
    `M5 baseline ${MAIN_JS_BASELINE_BYTES} B, delta since M5 +${mainJs.byteLength - MAIN_JS_BASELINE_BYTES} B)`
);
if (mainJs.byteLength > MAIN_JS_BUDGET_BYTES) {
  console.error(
    `[verify] OVER BUDGET main.js exceeds ${MAIN_JS_BUDGET_BYTES} bytes (IMP-001 §12 F11-001); ` +
      "shrink the registered diagram set, or raise the budget with the measured delta recorded in README."
  );
  failed = true;
}

// M5：主题 Token 与字体必须真的进到 CSS 产物里。只查文件名会放过「Tailwind 插件没生效、
// tokens.css 未被 import」这类静默降级——两端的 Primitive 名同时出现才算三层结构进了包。
const mainCss = execFileSync("unzip", ["-p", vsixPath, WEBVIEW_MAIN_CSS], {
  encoding: "buffer",
  maxBuffer: 16 * 1024 * 1024
});

for (const marker of ["--readora-palette-light-canvas", "--readora-palette-dark-accent"]) {
  if (mainCss.includes(marker)) {
    console.log(`[verify] OK   main.css contains ${marker}`);
  } else {
    console.error(`[verify] MISS main.css does not contain ${marker}`);
    failed = true;
  }
}

// 字体子集：@fontsource 的 latin woff2 与 KaTeX 的公式字体都应由 Vite 落到 assets/
// 并被样式表引用。数量按 EXPECTED_WOFF2 硬卡，少一个就是有人删了字重却没登记偏差。
const woff2 = entries.filter((entry) => entry.endsWith(".woff2"));
const katexWoff2 = woff2.filter((entry) => path.basename(entry).startsWith("KaTeX_"));
console.log(`[verify] SIZE main.css ${(mainCss.byteLength / 1024).toFixed(1)} kB ` +
  `(budget ${(MAIN_CSS_BUDGET_BYTES / 1024).toFixed(0)} kB), ` +
  `fonts ${woff2.length} woff2 (${katexWoff2.length} KaTeX)`);
if (woff2.length < EXPECTED_WOFF2) {
  console.error(
    `[verify] MISS expected ${EXPECTED_WOFF2} .woff2 subsets in the package, found ${woff2.length}` +
      (woff2.length > 0 ? ` (${woff2.map((entry) => path.basename(entry)).join(", ")})` : "")
  );
  failed = true;
}

// KaTeX 的 20 个公式字体单独卡数：整体 27 达标但 KaTeX 只有 3 个，同样说明
// 构建把大部分 @font-face 剥掉了（例如样式表没被 import，只剩几个被别处引用到的）。
if (katexWoff2.length < EXPECTED_KATEX_WOFF2) {
  console.error(
    `[verify] MISS expected ${EXPECTED_KATEX_WOFF2} KaTeX .woff2 subsets in the package, ` +
      `found ${katexWoff2.length} (of ${woff2.length} total woff2)`
  );
  failed = true;
}

// woff / ttf 必须一个都不在包里：它们的存在意味着 woff2Only() 被绕过，
// 而那正是 IMP-001 §10.3「只保留 woff2」的唯一可核查形态。
const legacyFonts = entries.filter((entry) => /\.(?:woff|ttf|otf|eot)$/u.test(entry));
if (legacyFonts.length > 0) {
  console.error(
    `[verify] FAIL package carries ${legacyFonts.length} non-woff2 font asset(s): ` +
      legacyFonts.map((entry) => path.basename(entry)).join(", ")
  );
  failed = true;
} else {
  console.log(`[verify] OK   no woff/ttf fallbacks in the package`);
}

// 样式表里的每个 url() 都必须在归档内解析得到：断掉的引用在浏览器里只是静默
// 回退字体，看不出来，所以只能在这里当场对账（含 Size3 那类小字体被内联的情形）。
const cssText = mainCss.toString("utf8");
const assetDir = path.dirname(WEBVIEW_MAIN_CSS);
const referenced = new Set(
  [...cssText.matchAll(/url\(\s*(['"]?)([^'"())]+)\1\s*\)/gu)]
    .map((match) => match[2])
    // data: 内联在这里是允许的（图片占位等），字体是否被内联由上面那条 font-src 口径单独盯
    .filter((target) => !target.startsWith("data:") && !target.startsWith("http"))
    .map((target) => path.posix.normalize(path.posix.join(assetDir, target)))
);
const unresolvable = [...referenced].filter((target) => !entries.includes(target));
if (unresolvable.length > 0) {
  console.error(
    `[verify] MISS main.css references ${unresolvable.length} asset(s) absent from the package: ` +
      unresolvable.join(", ")
  );
  failed = true;
} else {
  console.log(`[verify] OK   all ${referenced.size} main.css url() references resolve in the package`);
}

if (mainCss.byteLength > MAIN_CSS_BUDGET_BYTES) {
  console.error(
    `[verify] OVER BUDGET main.css exceeds ${MAIN_CSS_BUDGET_BYTES} bytes; ` +
      "per IMP-003 §4.6 drop font weights/subsets rather than raising the budget."
  );
  failed = true;
}

// coverage/ 里是源码的 HTML 报告，与 src/ 同级敏感：一旦跑过 pnpm coverage 就会被
// vsce 收进包，所以既靠 .vscodeignore 排除，也在门禁里再兜一层。
const forbiddenPrefixes = ["extension/src/", "extension/node_modules/", "extension/coverage/"];
for (const prefix of forbiddenPrefixes) {
  if (entries.some((entry) => entry.startsWith(prefix))) {
    console.error(`[verify] LEAK ${prefix} must not be packaged`);
    failed = true;
  }
}

// source map 会把手写源码带进发布包；dev 夹具（M5 视觉基线 `apps/webview/dev/visual.tsx`
// 与 M6 Playwright 的 `apps/webview/dev/e2e.tsx`）只在仓库里有用，都不该出现在 vsix 内。
const forbiddenSuffixes = [
  ".map",
  "visual.html",
  "visual.tsx",
  "visual.css",
  "e2e.html",
  "e2e.tsx"
];
for (const suffix of forbiddenSuffixes) {
  const leaked = entries.filter((entry) => entry.endsWith(suffix));
  if (leaked.length > 0) {
    console.error(`[verify] LEAK ${suffix} must not be packaged: ${leaked.join(", ")}`);
    failed = true;
  }
}
if (entries.some((entry) => entry.startsWith("extension/dist/webview/dev/"))) {
  console.error("[verify] LEAK dev fixture directory must not be packaged");
  failed = true;
}

/**
 * M11：PDF/PNG 的 Chrome CLI argv 必须真的进到 extension.js。
 *
 * 这三个 flag 是导出唯一的渲染通道，被 tree-shake 掉的话现象恰好全绿：命令
 * 仍在、对话框仍弹、临时 HTML 仍写盘、Chrome 也能拉起来 —— 只是 argv 不认识，
 * 用户拿到一个空白 PDF。静态源码看起来没问题不算证据，得从产物字节里读。
 *
 * 用字面 indexOf 而不是 RegExp：这些串里有 `=` 与 `-`，正则化只会让断言本身出错；
 * 而它们在源码里是模板字符串的静态部分，打包器不会改写字符串内容。
 */
const extensionJs = execFileSync("unzip", ["-p", vsixPath, "extension/dist/extension.js"], {
  encoding: "buffer",
  maxBuffer: 64 * 1024 * 1024
});
for (const flag of ["--print-to-pdf", "--headless=new", "--screenshot"]) {
  if (extensionJs.indexOf(flag, "utf8") !== -1) {
    console.log(`[verify] OK   extension.js contains ${flag}`);
  } else {
    console.error(`[verify] MISS extension.js does not contain ${flag}`);
    failed = true;
  }
}

/**
 * 产物激活冒烟：把 vsix 内的 extension.js 与 package.json 解到 test-results/ 下，
 * 交给 host-activation-smoke.mjs 按宿主的方式加载并跑一次 activate()。
 *
 * 为什么静态清单不够：0.6.0 曾出现「构建全绿 + 本脚本全绿，用户右键却得到
 * command 'readora.openReader' not found」。css-tree 的 ESM 入口靠
 * `createRequire(import.meta.url)` 读同包 JSON，单文件 CJS 产物里 import.meta
 * 是空对象，扩展加载当场抛 TypeError → 命令一条都没注册，而菜单项照旧显示。
 * 「文件在不在」判不出「扩展能不能激活」，所以激活这一步必须真跑一次。
 */
if (!failed) {
  const smokePkgDir = path.join(root, "test-results", "host-activation-smoke", "extension");
  mkdirSync(path.join(smokePkgDir, "dist"), { recursive: true });
  writeFileSync(
    path.join(smokePkgDir, "dist", "extension.js"),
    extensionJs
  );
  writeFileSync(
    path.join(smokePkgDir, "package.json"),
    execFileSync("unzip", ["-p", vsixPath, "extension/package.json"], { encoding: "buffer" })
  );
  const smoke = spawnSync(
    process.execPath,
    [
      path.join(root, "scripts/host-activation-smoke.mjs"),
      path.join(smokePkgDir, "dist", "extension.js")
    ],
    { encoding: "utf-8" }
  );
  const smokeOutput = `${smoke.stdout ?? ""}${smoke.stderr ?? ""}`.trim();
  if (smoke.status !== 0) {
    console.error("[verify] FAIL packaged extension.js cannot activate:");
    console.error(smokeOutput);
    failed = true;
  } else {
    console.log(`[verify] OK   ${smokeOutput}`);
  }
}

if (failed) {
  process.exit(1);
}
console.log(`[verify] ${vsixName} passed.`);
console.log(
  "[verify] NOTE: publisher 'readora-dev' is a placeholder; register the real publisher before release (IMP-003 stage 4)."
);
// repository 写错地址照样能通过打包，Marketplace 却会把「源码地址」指到别处去，
// 所以这里回读包内实际产物而不是源码 manifest，缺件才继续提醒。
const shippedManifest = JSON.parse(
  execFileSync("unzip", ["-p", vsixPath, "extension/package.json"], { encoding: "utf-8" })
);
if (shippedManifest.repository?.url && shippedManifest.repository?.directory) {
  console.log(
    `[verify] OK   repository metadata: ${shippedManifest.repository.url} ` +
      `(${shippedManifest.repository.directory})`
  );
} else {
  console.log(
    "[verify] NOTE: no repository field yet (docs DEFER-02 still open); fill it with the real " +
      "source URL before publishing, the marketplace 'Repository' column stays empty until then."
  );
}
console.log(
  "[verify] NOTE: LICENSE (MIT) and resources/icon.png (128x128) are this milestone's chosen " +
    "release metadata, not upstream decisions; both are recorded as open items in README M6."
);