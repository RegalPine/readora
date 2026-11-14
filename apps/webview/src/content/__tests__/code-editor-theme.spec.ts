/**
 * 代码编辑器语法表与配色表的两条硬约束（M8）。
 *
 * 1. **不能比静态视图少语言**：markdown-core 认得的每个语言名，编辑器必须也认得，
 *    否则同一块在「编辑器视图」与「搜索命中回显的静态视图」之间会跳色。
 *    这条拿 `supportedLanguages()`（真实注册表）来对，不拿手抄清单 ——
 *    两边各自维护清单正是图表层 PELE_TOKEN_MAP 当初要双向锁定的原因。
 * 2. **一个色值都不许写死**：CodeMirror 的主题活在 JS 对象里，绕过了
 *    `no-hardcoded-color.spec.ts` 对 CSS 文件的扫描，所以这里补一道同源检查：
 *    结构化地看着色表与主题对象里的每个颜色，必须都是 `var(--readora-*)`，
 *    而且这些名字在 tokens.css 里真实声明过。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { PLAIN_TEXT_LANGUAGES, supportedLanguages } from "@readora/markdown-core";
import { editorGrammarNames, grammarFor } from "../code-editor/languages";
import {
  EDITOR_COLOR_TOKENS,
  EDITOR_THEME_SPEC,
  readoraEditorTheme,
  readoraHighlightStyle
} from "../code-editor/theme";
import { stripComments } from "../../styles/__tests__/css-tokens";

/** 被扫源文件：新增编辑器文件时加进来，别让配色绕过护栏。 */
const SOURCES = [
  "apps/webview/src/content/code-editor/theme.ts",
  "apps/webview/src/content/code-editor/languages.ts",
  "apps/webview/src/content/code-editor/code-editor-layer.ts"
];

const COLOR_LITERAL = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/gu;
const VAR_COLOR = /^var\(--readora-[\w-]+\)$/u;
/** 主题对象里要看做颜色的属性名（大小写不敏感，含 border / outline 简写）。 */
const COLOR_PROPERTY = /^(background|color|border|outline|caret|selection)/iu;

function sourceOf(file: string): string {
  // vitest 的工作目录是 apps/webview，`../..` 回到仓库根。
  return stripComments(readFileSync(resolve(process.cwd(), "../..", file), "utf8"));
}

function declaredTokenNames(): Set<string> {
  const names = new Set<string>();
  for (const match of sourceOf("apps/webview/src/styles/tokens.css").matchAll(
    /(--readora-[\w-]+)\s*:/gu
  )) {
    const [, name = ""] = match;
    names.add(name);
  }
  return names;
}

describe("语法表与 markdown-core 的注册表对齐", () => {
  it("hljs 认得的每个语言名，编辑器都拿得到语法", () => {
    const missing = supportedLanguages().filter((name) => grammarFor(name) === null);
    expect(missing, `这些语言在编辑器里没有语法：${missing.join(", ")}`).toStrictEqual([]);
  });

  it("无后缀族仍然没有语法，而且不算缺失", () => {
    for (const name of PLAIN_TEXT_LANGUAGES) {
      expect(grammarFor(name)).toBeNull();
    }
    // 静态视图对 plain 也不报「不支持语言」，两边同一判断。
    expect(supportedLanguages().some((name) => PLAIN_TEXT_LANGUAGES.has(name))).toBe(false);
  });

  it("读者手写的别名照样认得（围栏语言位是文档作者写的）", () => {
    const aliases = [
      "js",
      "ts",
      "tsx",
      "jsx",
      "py",
      "sh",
      "zsh",
      "yml",
      "md",
      "golang",
      "rs",
      "jsonc",
      "patch",
      "console",
      "svg",
      "htm"
    ];
    for (const alias of aliases) {
      expect(grammarFor(alias), `${alias} 应该命中语法`).not.toBeNull();
    }
  });

  it("大小写与空格写法和未收录语言都退得干净", () => {
    expect(grammarFor("TypeScript")).not.toBeNull();
    expect(grammarFor("  bash  ")).not.toBeNull();
    expect(grammarFor("")).toBeNull();
    expect(grammarFor(null)).toBeNull();
    expect(grammarFor(undefined)).toBeNull();
    expect(grammarFor("brainfuck")).toBeNull();
  });

  it("同一写法复用同一个 LanguageSupport 实例（重复建实例只是白花时间）", () => {
    expect(grammarFor("javascript")).toBe(grammarFor("javascript"));
    // 别名让写法数严格多于注册表条目数，否则上面的别名用例是空跑。
    expect(editorGrammarNames().length).toBeGreaterThan(supportedLanguages().length);
  });
});

describe("编辑器配色不写死色值", () => {
  const declared = declaredTokenNames();

  it("八路语法色 + 六路界面色都登记在清单里", () => {
    // 语法色只有 8 路是既有事实（PRD-003 §8.6），本批不为编辑器扩表；
    // 少一路就意味着有人删了映射，编辑器会静默掉色。
    expect(EDITOR_COLOR_TOKENS.filter((name) => name.startsWith("--readora-syntax-"))).toHaveLength(
      8
    );
    for (const token of EDITOR_COLOR_TOKENS) {
      expect(declared.has(token), `${token} 不在 tokens.css 里`).toBe(true);
    }
  });

  it("着色表里每个颜色都是 var(--readora-*) 引用", () => {
    const specs = readoraHighlightStyle().specs;
    expect(specs.length).toBeGreaterThan(0);
    const used = new Set<string>();
    for (const spec of specs) {
      for (const key of ["color", "background"] as const) {
        const value = spec[key];
        if (typeof value !== "string") {
          continue;
        }
        expect(value, `不是 var() 引用的颜色：${value}`).toMatch(VAR_COLOR);
        used.add(value.slice(4, -1));
      }
    }
    // 8 路语法色全部要真被用到（deletion 只在 diff/strikethrough 里出现，容易漏）。
    for (const token of EDITOR_COLOR_TOKENS.filter((name) =>
      name.startsWith("--readora-syntax-")
    )) {
      expect(used.has(token), `${token} 没出现在任何一条映射里`).toBe(true);
    }
  });

  it("主题对象的每条颜色声明都是 var() 引用，且名字已登记", () => {
    // 扫源码那种断言本身很脆（`varOf("--x")` 这种调用形式认不出来），
    // 所以主题规格导成了普通对象：这里结构化地逐条查，看的是运行时的值。
    const offenders: string[] = [];
    const referenced = new Set<string>();
    const walk = (node: Record<string, unknown>): void => {
      for (const [property, value] of Object.entries(node)) {
        if (value !== null && typeof value === "object") {
          walk(value as Record<string, unknown>);
          continue;
        }
        if (typeof value !== "string") {
          continue;
        }
        for (const match of value.matchAll(/var\((--readora-[\w-]+)\)/gu)) {
          const [, name = ""] = match;
          referenced.add(name);
        }
        if (!COLOR_PROPERTY.test(property)) {
          continue;
        }
        if (value.match(COLOR_LITERAL) !== null) {
          // 全局正则用 match 而不是 test：test 会带上 lastIndex，同一字符串第二次漏检。
          offenders.push(`${property}: ${value}`);
        }
        // 允许的非 Token 写法只有 transparent / none：铺面色一律要走 Token。
        if (value !== "transparent" && value !== "none" && !value.includes("var(--readora-")) {
          offenders.push(`${property}: ${value} 没有引用 Token`);
        }
      }
    };
    walk(EDITOR_THEME_SPEC as unknown as Record<string, unknown>);
    expect(offenders, `主题里有绕过 Token 的颜色：\n${offenders.join("\n")}`).toStrictEqual([]);
    // 清单双向核对：主题引用的名字必须都在清单里（漏登记就是绕过了 varOf 的护栏）。
    const undeclared = [...referenced].filter((name) => !EDITOR_COLOR_TOKENS.includes(name));
    expect(undeclared, `主题引用了未登记的 Token：${undeclared.join(", ")}`).toStrictEqual([]);
    const unknown = [...referenced].filter((name) => !declared.has(name));
    expect(unknown, `这些 Token 没在 tokens.css 声明：${unknown.join(", ")}`).toStrictEqual([]);
  });

  it("编辑器外壳与当前行都不铺底色（用户对代码块定下的硬口径）", () => {
    // 0.7.0 把 --readora-code-background 改成 canvas 之后，编辑器接管也不能把灰底带回来：
    // 外壳、当前行、gutter 三处都是 transparent，底色由所在画布提供。
    const spec = EDITOR_THEME_SPEC as unknown as Record<string, Record<string, unknown>>;
    expect(spec["&"]?.background).toBe("transparent");
    expect(spec[".cm-activeLine, .cm-activeLineGutter"]?.background).toBe("transparent");
    expect(spec[".cm-gutters"]?.background).toBe("transparent");
    // 编辑器外壳里唯一被引用的底色 Token 不能是「代码块底色」那一类实色：
    // 只有 accent-soft（选中面）与 surface-subtle（折叠占位）这种小面积叠加允许。
    const backgrounds = Object.values(spec).flatMap((rules) =>
      Object.entries(rules).flatMap(([property, value]) =>
        property === "background" && typeof value === "string" ? [value] : []
      )
    );
    expect(
      backgrounds.filter((value) => value.includes("var(") && !value.includes("accent-soft"))
    ).toStrictEqual(["var(--readora-color-surface-subtle)"]);
  });

  for (const file of SOURCES) {
    it(`${file} 没有字面色值`, () => {
      expect(sourceOf(file), "出现字面色值").not.toMatch(COLOR_LITERAL);
    });
  }

  it("theme.ts 引用的 --readora-* 名字全部真实存在", () => {
    const referenced = [
      ...new Set(
        [...sourceOf("apps/webview/src/content/code-editor/theme.ts").matchAll(/--readora-[\w-]+/gu)].map(
          (match) => match[0]
        )
      )
    ];
    expect(referenced.length).toBeGreaterThan(0);
    const unknown = referenced.filter((name) => !declared.has(name));
    expect(unknown, `这些 Token 没在 tokens.css 声明：${unknown.join(", ")}`).toStrictEqual([]);
  });

  it("构造主题与着色表不抛错（var() 串原样交给 CodeMirror，不做颜色解析）", () => {
    expect(readoraEditorTheme()).toBeDefined();
    expect(readoraHighlightStyle().module).toBeTypeOf("object");
  });
});
