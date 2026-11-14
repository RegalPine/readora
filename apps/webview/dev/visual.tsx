/**
 * 视觉基线 dev 夹具（PRD-003 §14 / IMP-003 §4.6 交付物 8）。
 *
 * 只服务 `pnpm visual:check` / `visual:update`：由 Vite dev server 直接托管，
 * 不进 `build:webview` 的入口（入口只有 index.html），也不进 vsix（.vscodeignore 排除，
 * `scripts/verify-vsix.mjs` 反向校验）。
 *
 * 一次只渲染一档 palette，并且把主题属性与三个偏好变量写在 `<html>` 上——
 * 与 App 走的是同一条 `applyTheme(document.documentElement, …)` 路径、同一个作用域。
 * 早先把四种配色并排放进四个 div 里量，看着更省事，但会量出与生产不同的值：
 * `:root` 里派生的组件层 Token（`--readora-diagram-*` 等）是在声明它的那个元素上
 * 解析 `var()` 的，作用域收到 div 上就继承不到面板自己的配色，暗色档会记到亮色值。
 * 分档由 `?palette=` 选择，脚本逐档导航，采集与截图都是整屏真实形态。
 *
 * 夹具文档刻意不含图片与图表：两者都要 Host 参与资源解析（dev 环境没有 Host），
 * 拿到的会是降级形态，基线就成了「记录降级长什么样」。它们的表现由各自的单测与
 * M3/M4 的浏览器取证覆盖。
 */
import { useState } from "react";
import { createRoot } from "react-dom/client";
import type {
  DocumentLoadPayload,
  ReaderPreferences,
  ThemeState
} from "@readora/contracts";
import {
  DEFAULT_THEME_PRESET,
  DEFAULT_TYPOGRAPHY,
  isReaderTypography,
  isThemePreset
} from "@readora/contracts";
import type { OutlineItem } from "@readora/markdown-core";
import { OutlinePanel } from "../src/content/OutlinePanel";
import { SearchPanel } from "../src/content/SearchPanel";
import { QuickBar } from "../src/app/QuickBar";
import { ReadingCanvas, type CanvasBridge } from "../src/app/ReadingCanvas";
import { ReaderShell } from "../src/app/ReaderShell";
import { StatusBar } from "../src/app/StatusBar";
import { TopBar } from "../src/app/TopBar";
import { measureText } from "../src/app/text-metrics";
import type { ZoomApi } from "../src/app/zoom";
import { formatZoom } from "../src/app/zoom";
import { ThemeProvider, type ThemeContextValue } from "../src/app/theme-context";
import { applyTheme } from "../src/app/theme";
// 与 main.tsx 同一顺序：基线要看到的层叠顺序必须和生产一致。
// KaTeX 样式同样占最底第一格（IMP-001 §10.3 / PRD-003 §13.4 不变量）：
// 少了它，夹具里的公式量到的是「无样式 HTML」，基线就记成了与生产不同的排版。
import "katex/dist/katex.min.css";
import "../src/styles/fonts.css";
import "../src/styles/tokens.css";
import "../src/styles/tailwind.css";
import "../src/styles/base.css";
import "../src/styles/markdown.css";
import "../src/styles/components.css";
import "../src/styles/shell.css";
import "../src/styles/lightbox-search.css";
import "./visual.css";

const PREFERENCES: ReaderPreferences = {
  theme: "auto",
  fontSize: 17,
  lineHeight: 1.75,
  contentWidth: 820,
  showOutline: true,
  typography: "newsreader",
  themePreset: "default"
};

const DOCUMENT = [
  "---",
  "title: Visual Baseline",
  "description: 基线夹具的摘要字段，随卡片一起呈现",
  "tags: [baseline, math, wikilink]",
  "words: 842",
  "draft: false",
  "updated: 2024-05-01",
  "---",
  "",
  "# Visual Baseline",
  "",
  "正文段落用来核对字号、行高与段落间距：" +
    "Reading preferences live on three CSS variables, so the body text and every em-based heading follow along.",
  "",
  "## Lists and links",
  "",
  "- 无序列表第一项",
  "- 第二项带 [一个链接](https://example.com) 和 `inline code`",
  "  - 嵌套项",
  "",
  "1. 有序列表",
  "2. 第二项",
  "",
  "## Code and quote",
  "",
  "```ts",
  'export const LABEL = "syntax"; // 关键字、字符串与注释各有自己的语法色',
  "export function applyTheme(root: HTMLElement, mode: string): void {",
  "  root.dataset.readoraScheme = mode;",
  "}",
  "```",
  "",
  "> 引用块：左侧强调轨与柔和底色，暗色下必须同样成立。",
  ">",
  "> Nested quote line.",
  "",
  "## Table",
  "",
  "| Token | Light | Dark |",
  "| --- | --- | --- |",
  "| canvas | #f8f9ff | #10141a |",
  "| text-primary | #0b1c30 | #dfe2eb |",
  "",
  "## Math and wikilink",
  "",
  // M6 新增的两类内容必须在基线里可见：KaTeX 的块级间距、降级源码样式，
  // 以及 Wiki Link 的下划线形态（无 href，纯 data 属性驱动）。
  "行内公式 $E = mc^2$ 与块级公式：",
  "",
  "$$",
  "\\int_{-\\infty}^{\\infty} e^{-x^2}\\,dx = \\sqrt{\\pi}",
  "$$",
  "",
  "交叉引用 [[相邻笔记|另一个笔记]] 与不存在的 [[缺失笔记]]。",
  "",
  "### 三级标题",
  "",
  "收尾段落，确保面板底部还有内容参与测量。",
  ""
].join("\n");

/**
 * 四档待测状态：产品亮/暗两档，宿主两档（宿主 palette 由明暗轴决定 fallback 板）。
 *
 * 键名同时是 `?palette=` 的取值与基线文件里的条目名，脚本导航后会断言页面上的
 * `data-visual-palette` 与请求的那一档一致，所以名字写错是硬失败而不是静默少测。
 */
const PALETTES: Readonly<Record<string, ThemeState>> = {
  light: { mode: "light", source: "product" },
  dark: { mode: "dark", source: "product" },
  "vscode-light": { mode: "light", source: "vscode" },
  "vscode-dark": { mode: "dark", source: "vscode" }
};

/** 没有 Host：通知丢弃，请求一律失败，于是夹具只用不依赖 Host 的正文能力。 */
const bridge: CanvasBridge = {
  notify: () => undefined,
  request: async <T,>(): Promise<T> => {
    throw new Error("visual fixture: no Host in dev server");
  }
};

const query = new URLSearchParams(window.location.search);
const label = query.get("palette") ?? "light";

/** 取不到档位就是硬错误：宁可在控制台炸掉，也不悄悄退到 light 让基线少测一档。 */
function paletteFor(name: string): ThemeState {
  const state = PALETTES[name];
  if (!state) {
    throw new Error(`visual fixture: unknown palette ${name}（可选：${Object.keys(PALETTES).join(", ")}）`);
  }
  return state;
}

/**
 * 预设与字族两个维度：缺省走默认档，取值非法同样硬失败。
 *
 * 与 palette 同一口径 —— 基线脚本传错键名时必须炸，不能退到默认档，
 * 否则「4 palette × 预设」的清单里其实有一档在偷偷重复默认值。
 */
function dimension<T extends string>(
  name: string,
  raw: string | null,
  fallback: T,
  guard: (value: unknown) => value is T
): T {
  if (raw === null || raw.length === 0) {
    return fallback;
  }
  if (!guard(raw)) {
    throw new Error(`visual fixture: unknown ${name} ${raw}`);
  }
  return raw;
}

const preset = dimension("preset", query.get("preset"), DEFAULT_THEME_PRESET, isThemePreset);
const typography = dimension(
  "typography",
  query.get("typography"),
  DEFAULT_TYPOGRAPHY,
  isReaderTypography
);

const state = paletteFor(label);

const FIXTURE_PREFERENCES: ReaderPreferences = {
  ...PREFERENCES,
  themePreset: preset,
  typography
};

// 生产同款调用与同款作用域：palette/scheme/preset/typography 属性 + 三个偏好变量都落在 <html>。
applyTheme(document.documentElement, state, FIXTURE_PREFERENCES);
document.documentElement.dataset.visualPalette = label;

/**
 * 基线一律 100%：缩放是会话内状态（PRD-003 §11.4），带进基线就变成每次采集都要
 * 重新对一遍的数字。这里给的是常量替身，只为让顶栏缩放组与状态条渲染出生产形态。
 */
const BASE_ZOOM: ZoomApi = {
  zoom: 1,
  display: formatZoom(1),
  canZoomIn: true,
  canZoomOut: false,
  zoomIn: () => undefined,
  zoomOut: () => undefined,
  reset: () => undefined
};

/**
 * 快速条的进度读数同理：滚动位置是会话态，但百分比要在基线里看得见形态，
 * 所以取一个固定的中位读数（0 会让「有这一段但空」与「这一段没做」看起来一样）。
 * 大纲面板不再显示进度，这里只供 QuickBar。
 */
const BASE_PROGRESS = 0.35;

function Fixture() {
  const [outline, setOutline] = useState<readonly OutlineItem[]>([]);
  const context: ThemeContextValue = {
    theme: state.mode,
    source: state.source,
    preferences: FIXTURE_PREFERENCES
  };
  const payload: DocumentLoadPayload = {
    documentUri: "file:///vault/visual/baseline.md",
    languageId: "markdown",
    version: 1,
    text: DOCUMENT,
    preferences: FIXTURE_PREFERENCES
  };
  const metrics = measureText(DOCUMENT);
  return (
    <>
      {/* 角标只为截图取证能一眼认出是哪一档，不参与任何测量。 */}
      <p className="readora-visual-label" data-visual-palette={label}>
        {`${label}${preset === "default" ? "" : " · high-contrast"}${
          typography === "newsreader" ? "" : ` · ${typography}`
        }`}
      </p>
      <ThemeProvider value={context}>
        <ReaderShell
          outlineVisible
          focusMode={false}
          toolbar={
            <TopBar
              outlineVisible
              focusMode={false}
              searchOpen={false}
              settingsOpen={false}
              exportOpen={false}
              documentUri={payload.documentUri}
              zoom={BASE_ZOOM}
              onToggleOutline={() => undefined}
              onToggleFocusMode={() => undefined}
              onToggleSearch={() => undefined}
              onToggleSettings={() => undefined}
              onToggleExport={() => undefined}
              onCloseExport={() => undefined}
              onExport={() => undefined}
            />
          }
          /*
           * 搜索带在基线里必须出现一次：M6 把外壳改成四段栅格，
           * `.readora-searchbar` 的高度与它是「随内容」而非固定 44px 这条口径，
           * 只有真实渲染时才被量到。面板自身只挂不查（没有输入就没有高亮），
           * 所以这一档记录的是「打开搜索条但还没搜」的生产形态。
           */
          searchbar={
            <SearchPanel
              getRoot={() => document.querySelector<HTMLElement>(".readora-document")}
              documentId={payload.documentUri}
              documentVersion={payload.version}
              onClose={() => undefined}
            />
          }
          outline={
            <OutlinePanel
              items={outline}
              activeHeadingId={outline[1]?.anchor ?? null}
              collapsedIds={new Set<string>()}
              text={DOCUMENT}
              onToggleCollapse={() => undefined}
              onCollapsedChange={() => undefined}
              onSelect={() => undefined}
            />
          }
          statusbar={
            /* 夹具里没有 Host，但这一段量的是「文档已载入时的状态条形态」：
             * 有正文可看就意味着 document.load 到过，于是 bridge 记已连接。 */
            <StatusBar
              sectionCount={outline.length}
              wordCount={metrics.units}
              metrics={metrics}
              focusMode={false}
              documentVersion={payload.version}
              zoom={BASE_ZOOM.zoom}
              theme={state.mode}
              bridgeConnected
            />
          }
        >
          <ReadingCanvas payload={payload} bridge={bridge} theme={state.mode} onOutline={setOutline} />
          {/* 快速条是 sticky 在状态条上方的一段，M6 起也属于要量的外壳。 */}
          <QuickBar
            activeHeadingTitle={outline[1]?.title ?? null}
            progress={BASE_PROGRESS}
            focusMode={false}
            outlineExpanded={false}
            onToggleOutline={() => undefined}
          />
        </ReaderShell>
      </ThemeProvider>
    </>
  );
}

const container = document.getElementById("root");
if (!container) {
  throw new Error("Readora visual fixture: #root container not found.");
}

createRoot(container).render(<Fixture />);
