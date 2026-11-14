/**
 * 代码编辑器语言表（ARC-002 §8 的编辑器接管面）。
 *
 * 口径只有一条：**markdown-core 静态高亮支持的语言，编辑器必须同样支持**。
 * 否则同一个块在「搜索命中时回显的静态视图」与「编辑器视图」之间切换会出现
 * 有色 / 无色的分裂（这两种视图共用同一份源码，见 code-editor-layer 与
 * markdown.css 的 `:has()` 那条）。表项齐全性由
 * `code-editor-theme.spec.ts` 与 `supportedLanguages()` 双向锁定。
 *
 * 体积：打包后实测 main.js 从 1 288 987 B（0.7.0）跳到 2 012 193 B（+723 206 B，
 * 已抬预算并登记在 README M8）。这张语法表是增量里的大头：重叠依赖
 * （lang-html 自带 css / javascript 语法）使逐个量出来的数字不可相加，
 * 所以只能整组看。表覆盖 hljs 实际注册的 15 个语言名。
 */
import { LanguageSupport, StreamLanguage } from "@codemirror/language";
import { css } from "@codemirror/lang-css";
import { go } from "@codemirror/lang-go";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { rust } from "@codemirror/lang-rust";
import { sass } from "@codemirror/lang-sass";
import { sql } from "@codemirror/lang-sql";
import { xml } from "@codemirror/lang-xml";
import { yaml } from "@codemirror/lang-yaml";
import { diff as diffMode } from "@codemirror/legacy-modes/mode/diff";
import { shell as shellMode } from "@codemirror/legacy-modes/mode/shell";

/**
 * highlight.js 侧注册的规范语言名（`supportedLanguages()` 的清单）。
 *
 * 无后缀族（text/plain/…）不算「有语法」：编辑器仍以纯文本挂载，
 * 只是不给 grammar —— 与 markdown-core 的 `PLAIN_TEXT_LANGUAGES` 同一判断。
 */
export const EDITOR_GRAMMAR_LANGUAGES: readonly string[] = [
  "bash",
  "css",
  "diff",
  "go",
  "html",
  "javascript",
  "json",
  "markdown",
  "python",
  "rust",
  "scss",
  "shell",
  "sql",
  "typescript",
  "yaml"
];

/**
 * 写法名 → 语法工厂。
 *
 * 键同时收 hljs 的规范名与读者实际会写进围栏的别名：围栏语言位是文档作者手写的，
 * `js`、`py`、`sh`、`yml` 这类写法的出现频率远高于规范名，静态视图靠 hljs 的
 * 别名表能吃下，接管层也必须吃下，否则同一篇文档在两个视图间降级。
 */
const GRAMMARS: Readonly<Record<string, () => LanguageSupport>> = {
  // lang-javascript 一个包覆盖 js/ts/jsx/tsx 四种（官方形态，无需第二个包）。
  javascript: () => javascript(),
  js: () => javascript(),
  jsx: () => javascript({ jsx: true }),
  typescript: () => javascript({ typescript: true }),
  ts: () => javascript({ typescript: true }),
  tsx: () => javascript({ typescript: true, jsx: true }),
  mjs: () => javascript(),
  cjs: () => javascript(),

  html: () => html(),
  htm: () => html(),
  // 官方没有 lang-xml 之外的「xml 高亮」诉求时，xml() 是纯标签着色，比 html() 更贴。
  xml: () => xml(),
  svg: () => xml(),

  css: () => css(),
  scss: () => sass(),
  sass: () => sass(),

  json: () => json(),
  jsonc: () => json(),
  json5: () => json(),

  python: () => python(),
  py: () => python(),
  python3: () => python(),

  markdown: () => markdown(),
  md: () => markdown(),

  sql: () => sql(),
  yaml: () => yaml(),
  yml: () => yaml(),
  rust: () => rust(),
  rs: () => rust(),
  go: () => go(),
  golang: () => go(),

  // shell / diff 没有官方语法包，走 legacy-modes 的流式语法（实测两个合计 2.9 kB）。
  shell: () => new LanguageSupport(StreamLanguage.define(shellMode)),
  bash: () => new LanguageSupport(StreamLanguage.define(shellMode)),
  sh: () => new LanguageSupport(StreamLanguage.define(shellMode)),
  zsh: () => new LanguageSupport(StreamLanguage.define(shellMode)),
  console: () => new LanguageSupport(StreamLanguage.define(shellMode)),
  diff: () => new LanguageSupport(StreamLanguage.define(diffMode)),
  patch: () => new LanguageSupport(StreamLanguage.define(diffMode))
};

/** 已构造过的语法按名字复用：LanguageSupport 无实例状态，重复创建只是白花时间。 */
const instances = new Map<string, LanguageSupport>();

/**
 * 取某个围栏语言对应的编辑器语法；没有语法（纯文本或未收录语言）返回 null。
 *
 * 返回 null 不是失败：块照样挂成编辑器（有行号、可选中、可复制），只是不着色 ——
 * 与 markdown-core 对 `unsupported` 的处理口径一致（ARC-002 §8.3 第 1 条不报 error）。
 */
export function grammarFor(language: string | null | undefined): LanguageSupport | null {
  const name = (language ?? "").trim().toLowerCase();
  if (name === "") {
    return null;
  }
  const cached = instances.get(name);
  if (cached) {
    return cached;
  }
  const factory = GRAMMARS[name];
  if (!factory) {
    return null;
  }
  const created = factory();
  instances.set(name, created);
  return created;
}

/** 表里全部可识别写法（单测据此核对「每个 hljs 已注册语言都能被编辑器认出」）。 */
export function editorGrammarNames(): string[] {
  return Object.keys(GRAMMARS).sort();
}
