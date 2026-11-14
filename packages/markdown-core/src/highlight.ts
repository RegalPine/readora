/**
 * 语法高亮（ARC-002 §8 / IMP-001 §3.5）。
 *
 * 只注册阅读器常用语言子集，禁止引入 highlight.js 全量语言包（F11-001 包体要求）。
 * highlight.js 仅输出 `<span class="hljs-*">`，不含 eval / Worker / 远程资产，
 * 符合 CSP 基线（IMP-001 §3.5 选型说明）。
 */
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import go from "highlight.js/lib/languages/go";
import html from "highlight.js/lib/languages/xml";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import scss from "highlight.js/lib/languages/scss";
import shell from "highlight.js/lib/languages/shell";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import yaml from "highlight.js/lib/languages/yaml";

/** 无后缀语法（plain）不视为「不支持语言」，不产生 warning。 */
export const PLAIN_TEXT_LANGUAGES = new Set(["text", "plaintext", "plain", "txt"]);

export function registerLanguages(): void {
  hljs.registerLanguage("javascript", javascript);
  hljs.registerLanguage("typescript", typescript);
  hljs.registerLanguage("json", json);
  hljs.registerLanguage("python", python);
  hljs.registerLanguage("bash", bash);
  hljs.registerLanguage("shell", shell);
  hljs.registerLanguage("yaml", yaml);
  hljs.registerLanguage("markdown", markdown);
  hljs.registerLanguage("css", css);
  hljs.registerLanguage("scss", scss);
  hljs.registerLanguage("html", html);
  hljs.registerLanguage("diff", diff);
  hljs.registerLanguage("sql", sql);
  hljs.registerLanguage("rust", rust);
  hljs.registerLanguage("go", go);
}

registerLanguages();

/** 已注册语言（含别名由 highlight.js 自身解析），用于诚实判定「支持 / 不支持」。 */
export function supportedLanguages(): string[] {
  return [...hljs.listLanguages()].sort();
}

export function isLanguageRegistered(language: string): boolean {
  return hljs.getLanguage(language.toLowerCase()) !== undefined;
}

export interface HighlightOutcome {
  /** 已转义的高亮 HTML（或降级用的转义纯文本）。 */
  html: string;
  kind: "highlighted" | "plain" | "unsupported" | "failed";
  language: string;
}

export function highlightCode(code: string, rawLanguage: string | undefined): HighlightOutcome {
  const language = (rawLanguage ?? "").trim().toLowerCase();

  if (language === "") {
    return { html: escapeText(code), kind: "plain", language };
  }
  if (PLAIN_TEXT_LANGUAGES.has(language)) {
    return { html: escapeText(code), kind: "plain", language };
  }
  try {
    // getLanguage 本身也可能抛错：语言定义损坏时同样按高亮失败降级（§8.3 第 1 条）。
    if (!isLanguageRegistered(language)) {
      return { html: escapeText(code), kind: "unsupported", language };
    }
    return {
      html: hljs.highlight(code, { language, ignoreIllegals: true }).value,
      kind: "highlighted",
      language
    };
  } catch {
    // §8.3 第 1 条：高亮失败退化为普通代码块。
    return { html: escapeText(code), kind: "failed", language };
  }
}

function escapeText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
