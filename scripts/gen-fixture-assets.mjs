#!/usr/bin/env node
/**
 * 图文测试夹具生成器（M3 测试计划 §fixtures）。
 *
 * 为什么要有这个脚本：图片相关断言必须跑在**真图**上 —— 假的 `src` 字符串
 * 只能证明代码写了什么，证明不了浏览器能不能解码。因此这里产出：
 *
 * - `tests/fixtures/assets/*.{png,jpg,gif,webp,svg}`：五种策略白名单 MIME 各一张，
 *   PNG / SVG 有实际尺寸（供浏览器取证量 naturalWidth），
 *   JPEG / GIF / WebP 用业界公知的最小合法文件（只证明解码器接受该 MIME）；
 * - `tests/fixtures/assets/中文 标志.png`：空格 + 非 ASCII 文件名的解析样本；
 * - `tests/fixtures/outside/secret.png`：授权根之外的样本（必须被 boundary 拒掉）；
 * - `tests/fixtures/assets/escape-link.png`：指向上一行的符号链接，
 *   用来证「realpath 二次校验」不是纸面约束（非 POSIX 平台自动跳过）；
 * - `tests/fixtures/diagrams-over-limit.md`：> 50 000 字符的图表源码（F04-058）。
 *   这一份是纯机器文本，因此不进 git，由根 `test` / `fixtures` 脚本先产出。
 *
 * 零依赖：PNG 用 node:zlib 现编，其余格式内嵌公知字节；脚本可重复执行。
 * 用法：`node scripts/gen-fixture-assets.mjs`（或 `pnpm fixtures`）。
 */
import { deflateSync } from "node:zlib";
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES = join(ROOT, "tests", "fixtures");
const ASSETS = join(FIXTURES, "assets");
const OUTSIDE = join(FIXTURES, "outside");

// ‰PNG\r\n\x1a\n —— 8 字节缺一不可，少一个就是一张解不开的图。
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb8_8320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

/**
 * 8 位真彩色 PNG，每行 filter 0（None）：不追求压缩率，只追求可读与确定性。
 * pixel 返回 [r, g, b]，同一输入永远得到同一字节串（夹具必须可复现）。
 */
function encodePng(width, height, pixel) {
  const stride = width * 3;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y += 1) {
    const row = y * (stride + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = pixel(x, y);
      raw[row + 1 + x * 3] = r;
      raw[row + 2 + x * 3] = g;
      raw[row + 3 + x * 3] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

/** 品牌色块 + 45° 条纹：截图里一眼能看出「这是解析出来的本地图」，且尺寸非 1。 */
function logoPng() {
  return encodePng(320, 200, (x, y) => {
    if (y < 40) {
      return [37, 99, 235];
    }
    if (x % 24 + (y % 24) >= 24) {
      return [226, 232, 240];
    }
    return [248, 250, 252];
  });
}

function markPng(color) {
  return encodePng(64, 64, (x, y) => {
    if (x < 8 || y < 8 || x >= 56 || y >= 56) {
      return color;
    }
    return [255, 255, 255];
  });
}

/**
 * 内嵌的公知最小合法文件（均为 1×1，已用 macOS sips 复核可解码）：
 * 只用来验证「扩展名 → MIME → 解码器接受」这条链，
 * 不承担视觉样本（那是 logo.png / flow.svg 的活）。
 */
const MINIMAL_JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a" +
    "HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA" +
    "AAAAAAAAAAAAAv/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==",
  "base64"
);

const MINIMAL_GIF = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
  "base64"
);

const MINIMAL_WEBP = Buffer.from(
  "UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAwA0JaQAA3AA/vuUAAA=",
  "base64"
);

/** 本地 SVG：内嵌脚本探针 —— `<img>` 语境下不得执行（ARC-008 §9.4 纵深防御）。 */
const FLOW_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200" viewBox="0 0 320 200" role="img">
  <rect width="320" height="200" fill="#f8fafc" stroke="#cbd5e1"/>
  <rect x="24" y="24" width="120" height="48" rx="6" fill="#2563eb"/>
  <text x="36" y="54" font-family="sans-serif" font-size="16" fill="#ffffff">开始节点</text>
  <rect x="176" y="120" width="120" height="48" rx="6" fill="#0f172a"/>
  <text x="188" y="150" font-family="sans-serif" font-size="16" fill="#ffffff">结束节点</text>
  <path d="M144 48 H200 V120" fill="none" stroke="#64748b" stroke-width="3" marker-end="url(#arrow)"/>
  <script><![CDATA[window.__readoraSvgScriptRan = true;]]></script>
</svg>
`;

/**
 * 超限图表夹具（F04-058 资源耗尽防护）。
 *
 * 断言只需要「源码长度 > 50 000 且类型仍可识别」，因此用规整的 flowchart 边表
 * 堆长度最省：机器拼出来的 5 万字符塞进 diagrams.md 只会让人读不动，单独成文。
 */
const OVER_LIMIT_EDGES = 5000;

function overLimitFixture() {
  const lines = ["flowchart LR"];
  for (let index = 0; index < OVER_LIMIT_EDGES; index += 1) {
    lines.push(`  N${index} -->|第 ${index} 条边| M${index}`);
  }
  const source = lines.join("\n");
  return [
    "# 超限图表夹具（自动生成，勿手改）",
    "",
    "本文件由 `node scripts/gen-fixture-assets.mjs` 生成：",
    `围栏内源码共 ${source.length} 个字符，超过 MAX_DIAGRAM_SOURCE_CHARACTERS = 50 000。`,
    "预期行为是「进引擎之前」被规模闸门拒掉，落 over-limit 错误卡，不做任何解析。",
    "",
    "## over-limit",
    "",
    "```mermaid",
    source,
    "```",
    "",
    `<!-- generated-by: scripts/gen-fixture-assets.mjs; edges=${OVER_LIMIT_EDGES}; length=${source.length} -->`,
    ""
  ].join("\n");
}

/**
 * 性能夹具三档（IMP-001 §15.1「测试条件必须记录文档大小 / 图表数量 / 图片数量」，
 * IMP-003 §7.3 性能准入）。
 *
 * 档位是**内容形状**的约定，不是随手凑字节数：
 * - `small`（≈4 KB）：普通 Markdown —— 标题、段落、列表、一处行内代码；
 * - `medium`（≈120 KB）：混排文档 —— 表格、代码块、公式、图片同时出现，
 *   这才对应 IMP-001 说的「中型文档」（只堆段落会让表格与公式的成本看不见）；
 * - `large`（≈400 KB）：长文档 —— 数百个小节 + 图表，用来量「没有明显卡顿」那条。
 *
 * 与 `diagrams-over-limit.md` 同理：纯机器文本，不进 git，由脚本先产出，
 * 所以 `pnpm perf` 每次现场生成，数字永远对得上当前源码。
 */
const PERF_TARGETS = { small: 4 * 1024, medium: 120 * 1024, large: 400 * 1024 };

const PERF_LOREM =
  "渲染管线要穿过解析、AST 处理、序列化与净化四段，任何一段的额外拷贝都会按文档规模线性放大。" +
  "这一段的存在只为让段落数量与源码长度同时上去，读起来仍是合法的自然语言句子。";

/** 一小节：标题 + 段落 + 列表 +（可选）表格、代码、公式、图片。 */
function perfSection(index, { table, code, math, image }) {
  const lines = [
    `## 第 ${index} 节 · 段落与列表`,
    "",
    `${PERF_LOREM}，编号 ${index}。`,
    "",
    `- 条目一：加粗 **强调** 与行内 \`code-${index}\``,
    `- 条目二：链接 [站内](./sibling.md#${index}) 与 <span class="readora-flag">内联 HTML</span>`,
    `- 条目三：嵌套`,
    `  - 更深的条目 ${index}-a`,
    `  - 更深的条目 ${index}-b`,
    ""
  ];
  if (table) {
    lines.push(
      "| 字段 | 类型 | 说明 |",
      "| --- | --- | --- |",
      `| id | string | 第 ${index} 行的主键 |`,
      `| count | number | 观测值 ${index * 3} |`,
      `| note | string | 变长文本，用来撑表格宽度 ${PERF_LOREM.slice(0, 40)} |`,
      ""
    );
  }
  if (code) {
    lines.push(
      "```ts",
      `export function sample${index}(input: readonly string[]): number {`,
      "  return input",
      `    .filter((line) => line.length > ${index})`,
      "    .reduce((total, line) => total + line.charCodeAt(0), 0);",
      "}",
      "```",
      ""
    );
  }
  if (math) {
    lines.push(
      `行内公式 $\\int_0^{${index}} x^2\\,dx = \\frac{${index}^3}{3}$，块级公式：`,
      "",
      `$$\\sum_{k=1}^{${index + 1}} \\frac{1}{k^2} = \\frac{\\pi^2}{6} + O\\!\\left(${index}^{-1}\\right)$$`,
      ""
    );
  }
  if (image) {
    lines.push(`![第 ${index} 节的配图](./assets/logo.png)`, "");
  }
  return lines.join("\n");
}

/** 按目标字节数堆小节，形状随档位开关（越小的档越少花活）。 */
function perfFixture(tier, target) {
  const shape = {
    small: { table: false, code: false, math: false, image: false },
    medium: { table: true, code: true, math: true, image: true },
    large: { table: true, code: true, math: true, image: true }
  }[tier];
  const parts = [
    "---",
    `title: Readora 性能夹具 · ${tier}`,
    `generated_by: scripts/gen-fixture-assets.mjs`,
    "tags: [perf, fixture, auto-generated]",
    "---",
    "",
    `# 性能夹具（${tier}，自动生成，勿手改）`,
    "",
    `目标体积 ≈ ${target} 字节；实际体积以本文件字节数为准，报告里读的是实测值。`,
    "",
    perfSection(0, shape)
  ];
  if (tier === "large") {
    // 顶部这一处**在首帧的可视区里**：懒观察器一加载就有资格点亮它，所以它在
    // 首帧普查里仍停在 pending，说的才是「渲染排在首帧之后」这句话本身。
    parts.push(perfDiagram(0, ["flowchart LR", "  A0[开始] --> B0[处理] --> C0[结束]"]));
  }
  let index = 1;
  // 按**字节**逼近目标：正文是中文，`.length`（码点数）只有实际体积的一半不到，
  // 拿它当体积会让三档夹具全部超一倍，「≈4 KB / 120 KB / 400 KB」就成了假口径。
  while (Buffer.byteLength(parts.join("\n"), "utf8") < target) {
    parts.push(perfSection(index, shape));
    index += 1;
  }
  if (tier === "large") {
    // 图表只在最大档出现：异步渲染塞进中档会让「中型文档」的口径漂移。
    // 折叠线以下这二批用来证明收尾时会被补完（不是永久留白），并且与顶部那一批
    // 数量不同，普查才分得出「首帧时全部待渲染」与「只渲染了可视区」这两种说法。
    parts.push(
      "## 附录 · 图表",
      "",
      perfDiagram(index, [
        "sequenceDiagram",
        "  participant U as 用户",
        "  participant H as Host",
        "  participant W as Webview",
        "  U->>H: 打开文档",
        "  H->>W: document.load",
        "  W-->>H: reader.ready"
      ]),
      perfDiagram(index + 1, [
        "stateDiagram-v2",
        "  [*] --> 空闲",
        "  空闲 --> 渲染中: 收到快照",
        "  渲染中 --> 空闲: 首帧完成"
      ])
    );
  }
  const body = parts.join("\n");
  return `<!-- generated-by: scripts/gen-fixture-assets.mjs; tier=${tier}; target=${target}; sections=${index} -->\n${body}`;
}

/** 一段 mermaid 围栏：标题 + 围栏 + 空行，保证它自己就是一个可定位的小节。 */
function perfDiagram(id, lines) {
  return [`### 图 ${id}`, "", "```mermaid", ...lines, "```", ""].join("\n");
}

const report = [];

function write(relativePath, data) {
  const target = join(ROOT, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, data);
  report.push(`${relativePath} (${data.length} B)`);
}

mkdirSync(ASSETS, { recursive: true });
mkdirSync(OUTSIDE, { recursive: true });

write("tests/fixtures/assets/logo.png", logoPng());
write("tests/fixtures/assets/中文 标志.png", markPng([16, 185, 129]));
// 文件名与扩展名都大写：MIME 判定必须忽略扩展名大小写，且不能在大小写敏感的
// 文件系统上「碰巧」命中——所以这里连文件名一起大写。
write("tests/fixtures/assets/CAPITAL.PNG", markPng([239, 68, 68]));
write("tests/fixtures/outside/secret.png", markPng([129, 68, 239]));
write("tests/fixtures/assets/photo.jpg", MINIMAL_JPEG);
write("tests/fixtures/assets/diagram.gif", MINIMAL_GIF);
write("tests/fixtures/assets/icon.webp", MINIMAL_WEBP);
write("tests/fixtures/assets/flow.svg", Buffer.from(FLOW_SVG, "utf8"));
write("tests/fixtures/diagrams-over-limit.md", Buffer.from(overLimitFixture(), "utf8"));

// 性能夹具三档：先删干净再写，避免档位调整后残留上一代的文件被当成基准。
rmSync(join(FIXTURES, "perf"), { recursive: true, force: true });
for (const [tier, target] of Object.entries(PERF_TARGETS)) {
  write(`tests/fixtures/perf/${tier}.md`, Buffer.from(perfFixture(tier, target), "utf8"));
}

/**
 * 符号链接逃逸样本：POSIX 上必然可建；Windows 无权限时降级为「不产出」，
 * 对应 spec 探测 lstat 后整条跳过（skip），而不是让整个测试链变红。
 */
const link = join(ASSETS, "escape-link.png");
rmSync(link, { force: true });
let symlinked;
try {
  symlinkSync(relative(ASSETS, join(OUTSIDE, "secret.png")), link);
  symlinked = existsSync(link);
} catch {
  symlinked = false;
}

process.stdout.write(
  `${report.join("\n")}\n${symlinked ? "tests/fixtures/assets/escape-link.png -> ../outside/secret.png\n" : "tests/fixtures/assets/escape-link.png SKIPPED (需要 POSIX 符号链接权限)\n"}`
);
